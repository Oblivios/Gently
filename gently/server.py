"""HTTP server — routing + static serving + argparse entrypoint.

All route handlers live on the `Handler` class; behaviour is deliberately flat
so there's only one dispatch table to scan when changing URLs. Streaming routes
(SSE) stay open in the request thread — `ThreadingHTTPServer` gives us a thread
per connection, which is good enough for local use.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from . import workspaces as ws_store
from .providers import PROVIDERS, search_sessions
from .tmux import _SAFE_SESSION, tmux_manager
from .util import safe_id

# Repo root (the folder that contains `app.py`, `static/`, `gently/`).
ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"


def _json(handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
    # Session JSONL files occasionally contain lone surrogates (unpaired
    # \uD800-\uDFFF code points, typically from a truncated/corrupted write
    # mid-emoji). Python str tolerates them; UTF-8 does not — the default
    # strict encode raises UnicodeEncodeError and we used to 500 the whole
    # response for one bad character. errors="replace" substitutes a "?"
    # for the unpairable surrogate so one mangled byte can't take down the
    # rest of the conversation.
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8", errors="replace")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _serve_static(handler: BaseHTTPRequestHandler, rel: str) -> None:
    safe = (STATIC_DIR / rel.lstrip("/")).resolve()
    try:
        safe.relative_to(STATIC_DIR.resolve())
    except ValueError:
        handler.send_error(403)
        return
    if not safe.exists() or not safe.is_file():
        handler.send_error(404)
        return
    mime, _ = mimetypes.guess_type(str(safe))
    data = safe.read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", mime or "application/octet-stream")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-cache")
    handler.end_headers()
    handler.wfile.write(data)


def _parse_providers(qs: dict[str, list[str]]) -> set[str]:
    raw = qs.get("providers", ["claude,codex,gemini"])[0]
    requested = {p.strip().lower() for p in raw.split(",") if p.strip()}
    return requested & PROVIDERS.keys()


class Handler(BaseHTTPRequestHandler):
    server_version = "Gently/0.3"

    def log_message(self, fmt: str, *args: Any) -> None:
        if os.environ.get("GENTLY_VERBOSE"):
            super().log_message(fmt, *args)

    # ---- GET ---------------------------------------------------------------

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        try:
            if path == "/api/tmux/jobs":
                return _json(self, 200, {"jobs": tmux_manager.list_jobs()})
            if path == "/api/tmux/stream":
                return self._tmux_stream(qs)

            if path == "/api/workspaces":
                return _json(self, 200, {"workspaces": ws_store.list_workspaces()})
            m = re.fullmatch(r"/api/workspaces/([^/]+)", path)
            if m:
                # urlparse leaves %-escapes in place; the name must be
                # decoded before it reaches the safe-name check.
                name = unquote(m.group(1))
                if not ws_store.safe_name(name):
                    return _json(self, 400, {"error": "invalid_name"})
                data = ws_store.read_workspace(name)
                if data is None:
                    return _json(self, 404, {"error": "not_found"})
                return _json(self, 200, data)

            if path == "/api/sessions":
                q = (qs.get("q", [""])[0] or "").strip()
                providers = _parse_providers(qs) or set(PROVIDERS.keys())
                return _json(self, 200, {"results": search_sessions(q, providers)})

            m = re.fullmatch(r"/api/sessions/([a-z]+)/([A-Za-z0-9._-]+)", path)
            if m:
                provider, sid = m.group(1), m.group(2)
                impl = PROVIDERS.get(provider)
                if not impl:
                    return _json(self, 404, {"error": "unknown_provider"})
                try:
                    limit = int(qs.get("limit", ["500"])[0])
                except ValueError:
                    limit = 500
                before_raw = qs.get("before", [None])[0]
                before = int(before_raw) if before_raw and before_raw.isdigit() else None
                data = impl["get"](sid, limit, before)
                if data is None:
                    return _json(self, 404, {"error": "not_found"})
                return _json(self, 200, data)

            m = re.fullmatch(r"/api/sessions/([a-z]+)/([A-Za-z0-9._-]+)/delta", path)
            if m:
                provider, sid = m.group(1), m.group(2)
                impl = PROVIDERS.get(provider)
                if not impl:
                    return _json(self, 404, {"error": "unknown_provider"})
                try:
                    offset = int(qs.get("offset", ["0"])[0])
                except ValueError:
                    offset = 0
                data = impl["delta"](sid, offset)
                if data is None:
                    return _json(self, 404, {"error": "not_found"})
                return _json(self, 200, data)

            if path in ("", "/"):
                return _serve_static(self, "index.html")
            if path.startswith("/static/"):
                return _serve_static(self, path[len("/static/"):])
            return _serve_static(self, path)
        except BrokenPipeError:
            return
        except Exception as e:
            try:
                _json(self, 500, {"error": str(e)})
            except Exception:
                pass

    # ---- POST --------------------------------------------------------------

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        body = self.rfile.read(length) if length > 0 else b""

        try:
            data: dict[str, Any] = {}
            if body:
                try:
                    data = json.loads(body.decode("utf-8"))
                except Exception:
                    return _json(self, 400, {"error": "invalid_json"})

            if path == "/api/tmux/start":
                provider = str(data.get("provider") or "").strip().lower()
                sid = str(data.get("session_id") or "").strip()
                # Claude-only: `--dangerously-skip-permissions`. Default is
                # true to match the user's existing workflow; the browser
                # will prompt before each fresh spawn and pass the chosen
                # value here.
                bypass = bool(data.get("bypass_permissions", True))
                try:
                    job = tmux_manager.start_job(
                        provider, sid, bypass_permissions=bypass,
                    )
                except ValueError as e:
                    return _json(self, 400, {"error": str(e)})
                except Exception as e:
                    return _json(self, 500, {"error": str(e)})
                return _json(self, 200, {"job": asdict(job)})

            if path == "/api/open-code":
                provider = str(data.get("provider") or "").strip().lower()
                sid = str(data.get("session_id") or "").strip()
                if provider not in {"claude", "codex", "gemini", "opencode"}:
                    return _json(self, 400, {"error": "unknown_provider"})
                if not safe_id(sid):
                    return _json(self, 400, {"error": "invalid_session_id"})
                workdir = tmux_manager.cwd_for(provider, sid)
                if not workdir:
                    return _json(self, 404, {"error": "no_workdir"})
                code_cli = shutil.which("code")
                if code_cli is None:
                    return _json(self, 500, {"error": "code_cli_not_in_path"})
                try:
                    # Detach so the server doesn't hang on the spawned editor.
                    subprocess.Popen(
                        [code_cli, workdir],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        start_new_session=True,
                    )
                except OSError as e:
                    return _json(self, 500, {"error": f"spawn_failed: {e}"})
                return _json(self, 200, {"ok": True, "workdir": workdir})

            if path == "/api/tmux/start-new":
                provider = str(data.get("provider") or "").strip().lower()
                mode = str(data.get("mode") or "").strip().lower()
                bypass = bool(data.get("bypass_permissions", False))
                if mode == "temp":
                    workdir = tmux_manager.make_temp_workdir()
                elif mode == "open":
                    workdir = str(data.get("workdir") or "").strip()
                    if not workdir:
                        return _json(self, 400, {"error": "missing_workdir"})
                else:
                    return _json(self, 400, {"error": "invalid_mode"})
                try:
                    job = tmux_manager.start_new_job(
                        provider, workdir, bypass_permissions=bypass,
                    )
                except ValueError as e:
                    return _json(self, 400, {"error": str(e)})
                except Exception as e:
                    return _json(self, 500, {"error": str(e)})
                return _json(self, 200, {"job": asdict(job)})

            if path == "/api/tmux/stop":
                session = str(data.get("session") or "").strip()
                if not session:
                    return _json(self, 400, {"error": "missing_session"})
                ok = tmux_manager.kill_job(session)
                return _json(self, 200, {"ok": ok})

            if path == "/api/tmux/input":
                session = str(data.get("session") or "").strip()
                text = data.get("text", "")
                if not isinstance(text, str):
                    return _json(self, 400, {"error": "text_must_be_string"})
                if not session:
                    return _json(self, 400, {"error": "missing_session"})
                ok = tmux_manager.send_input(session, text)
                return _json(self, 200, {"ok": ok})

            if path == "/api/tmux/resize":
                session = str(data.get("session") or "").strip()
                try:
                    cols = int(data.get("cols") or 0)
                    rows = int(data.get("rows") or 0)
                except (TypeError, ValueError):
                    return _json(self, 400, {"error": "invalid_dims"})
                if not session or cols < 1 or rows < 1:
                    return _json(self, 400, {"error": "missing_session_or_dims"})
                ok = tmux_manager.resize_session(session, cols, rows)
                return _json(self, 200, {"ok": ok})

            if path == "/api/workspaces/save":
                name = str(data.get("name") or "").strip()
                payload = data.get("data")
                if not ws_store.safe_name(name):
                    return _json(self, 400, {"error": "invalid_name"})
                if not isinstance(payload, dict) or "root" not in payload:
                    return _json(self, 400, {"error": "invalid_payload"})
                if not ws_store.write_workspace(name, payload):
                    return _json(self, 500, {"error": "write_failed"})
                return _json(self, 200, {"ok": True, "name": name})

            if path == "/api/workspaces/delete":
                name = str(data.get("name") or "").strip()
                if not ws_store.safe_name(name):
                    return _json(self, 400, {"error": "invalid_name"})
                ok = ws_store.delete_workspace(name)
                return _json(self, 200 if ok else 404, {"ok": ok})

            return _json(self, 404, {"error": "not_found"})
        except BrokenPipeError:
            return
        except Exception as e:
            try:
                _json(self, 500, {"error": str(e)})
            except Exception:
                pass

    # ---- SSE: tmux pane log stream -----------------------------------------

    def _tmux_stream(self, qs: dict[str, list[str]]) -> None:
        """Stream a tmux session's log file over Server-Sent Events.

        The client opens this with `new EventSource(...)` and receives
        `data: {"data": <base64>, "offset": N}` frames as new bytes arrive,
        plus periodic `: ping` comments to keep proxies from closing the
        connection. When the tmux session dies we emit a final
        `data: {"done": true}` frame and return.
        """
        session = (qs.get("session", [""])[0] or "").strip()
        try:
            offset = max(0, int(qs.get("offset", ["0"])[0] or 0))
        except ValueError:
            offset = 0
        if not _SAFE_SESSION.fullmatch(session):
            return _json(self, 400, {"error": "invalid_session"})

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        last_ping = time.time()
        # `has_session` shells out to tmux — calling it on every idle tick
        # was 6+ forks/sec just to confirm liveness. Throttle it to ~once
        # per second when there's no log activity.
        last_alive_check = 0.0
        idle_sleep = 0.05   # 50 ms when nothing's happening
        active_sleep = 0.02 # 20 ms while bytes are still arriving
        try:
            while True:
                data, new_offset = tmux_manager.read_log(session, offset)
                if data:
                    payload = json.dumps({
                        "data": base64.b64encode(data).decode("ascii"),
                        "offset": new_offset,
                    })
                    self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    offset = new_offset
                    # Tighter loop while output is flowing — keeps echo
                    # latency on rapid typing under ~30 ms.
                    time.sleep(active_sleep)
                    continue
                now = time.time()
                if now - last_ping > 15:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = now
                if now - last_alive_check > 1.0:
                    last_alive_check = now
                    if not tmux_manager.has_session(session):
                        payload = json.dumps({"done": True})
                        self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                        self.wfile.flush()
                        return
                time.sleep(idle_sleep)
        except (BrokenPipeError, ConnectionResetError):
            return


# ---- entrypoint --------------------------------------------------------------


def _print_plain_banner(url: str) -> None:
    print(f"  gently  →  {url}")
    for name, impl in PROVIDERS.items():
        d: Path = impl["dir"]
        marker = "✓" if d.exists() else "·"
        print(f"  {marker} {name:<7} {d}")


def serve(host: str, port: int, open_browser: bool, use_tui: bool) -> None:
    tmux_manager.recover()
    server = ThreadingHTTPServer((host, port), Handler)
    url = f"http://{host if host != '0.0.0.0' else '127.0.0.1'}:{port}"

    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open_new_tab(url)).start()

    if use_tui:
        # Serve in a daemon thread so the TUI can own the foreground. Daemon
        # threads die when main exits, which is what we want on Ctrl+C — we
        # skip `server.shutdown()` because it would block on any long-lived
        # SSE handlers (e.g. an open tmux terminal).
        from .tui import run as run_tui
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        try:
            run_tui(url)
        finally:
            try:
                server.server_close()
            except Exception:
                pass
        return

    _print_plain_banner(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye.")
    finally:
        server.server_close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Local viewer for Claude/Codex/Gemini session history."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("GENTLY_PORT", "8765")))
    parser.add_argument("--open", action="store_true", help="auto-open the browser (off by default)")
    tui_group = parser.add_mutually_exclusive_group()
    tui_group.add_argument(
        "--tui", dest="tui", action="store_true", default=None,
        help="force the foreground dashboard on (default when stdout is a TTY)",
    )
    tui_group.add_argument(
        "--no-tui", dest="tui", action="store_false",
        help="print a plain banner and stream request logs instead",
    )
    parser.add_argument(
        "--tmux-reset", action="store_true",
        help="kill every gently_* tmux session + clean up logs/sidecars, then exit",
    )
    args = parser.parse_args(argv)

    if args.tmux_reset:
        # One-time cleanup: nuke every gently-owned tmux session so old
        # orphans (e.g. from before the meta-sidecar fix) don't accumulate
        # forever in the dashboard and on disk.
        r = tmux_manager._run(["list-sessions", "-F", "#{session_name}"])
        names = [n.strip() for n in (r.stdout or "").splitlines() if n.strip()]
        gently_names = [n for n in names if n.startswith("gently_")]
        for n in gently_names:
            tmux_manager.kill_job(n)
        # Also scrub any leftover meta/log files whose session is already gone.
        try:
            from .tmux import TMUX_LOG_ROOT
            for p in TMUX_LOG_ROOT.glob("gently_*.*"):
                try: p.unlink()
                except OSError: pass
        except Exception:
            pass
        print(f"killed {len(gently_names)} gently_* tmux session(s)")
        return 0

    if args.tui is None:
        # Default: dashboard ON when stdout is a real terminal; plain banner
        # otherwise (pipes, redirects, docker logs, CI, ...).
        args.tui = sys.stdout.isatty()

    serve(args.host, args.port, open_browser=args.open, use_tui=args.tui)
    return 0


if __name__ == "__main__":
    sys.exit(main())
