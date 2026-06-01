"""HTTP server — routing + static serving + argparse entrypoint.

All route handlers live on the `Handler` class; behaviour is deliberately flat
so there's only one dispatch table to scan when changing URLs. Streaming routes
(SSE) stay open in the request thread — `ThreadingHTTPServer` gives us a thread
per connection, which is good enough for local use.
"""

from __future__ import annotations

import argparse
import base64
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
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

# ---- remote access control -----------------------------------------------

# Configured by --view-only / --view-all / --trust flags. "trust" = full
# access (default, backwards-compatible). Changed by main() before serving.
_remote_level: str = "trust"  # "view-only" | "view-all" | "trust"

# Shared view: the owner's currently-open sessions, pushed by their browser.
# Consumed by view-only clients so they see exactly what the owner has open.
# In-memory only — lost on server restart.
_shared_view: dict = {}
_shared_view_lock = threading.Lock()
_shared_view_ts: float = 0.0


def _own_ips() -> frozenset[str]:
    """All IP addresses that belong to this machine (cached on first call)."""
    ips: set[str] = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}

    # All IPs the OS has registered for this hostname.
    try:
        _, _, addrs = socket.gethostbyname_ex(socket.gethostname())
        ips.update(addrs)
    except OSError:
        pass

    # Outbound interface trick: find the LAN IP used to reach the internet
    # without actually sending any packets.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ips.add(s.getsockname()[0])
    except OSError:
        pass

    return frozenset(ips)


_OWN_IPS: frozenset[str] = _own_ips()

# ---- owner auth cookie -------------------------------------------------------
# When access control is active (--view-only / --view-all), we issue a
# persistent cookie to the operator so they keep owner-level access regardless
# of which IP their browser connects from. This is the only reliable way to
# distinguish "the person who started Gently on WSL2 and opened it via their
# Windows browser through localhost port-forwarding" from "a phone on the LAN".
#
# The token is 48 hex chars stored in ~/.config/gently/owner.key (mode 0o600).
# It is never sent to remote clients; they only get it via the /?_auth= URL
# shown in the TUI. Requests with a valid gently_auth cookie are treated as
# owner regardless of IP.

_COOKIE_NAME = "gently_auth"
_OWNER_TOKEN: str = ""   # empty = access control inactive; set by serve()


def _token_path() -> Path:
    cfg = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")))
    return cfg / "gently" / "owner.key"


def _load_or_create_token() -> str:
    tp = _token_path()
    try:
        t = tp.read_text().strip()
        if len(t) == 48:
            return t
    except OSError:
        pass
    t = secrets.token_hex(24)
    try:
        tp.parent.mkdir(parents=True, exist_ok=True)
        tp.write_text(t)
        tp.chmod(0o600)
    except OSError:
        pass
    return t


def _client_level(client_ip: str) -> str:
    """'owner', 'view-only', 'view-all', or 'trust' based on requesting IP.

    Localhost AND the machine's own LAN IP(s) are always treated as owner so
    the person running Gently never loses access when they open the UI via the
    LAN address (e.g. http://192.168.x.x:8765) alongside --view-only / --view-all.
    """
    try:
        if ipaddress.ip_address(client_ip).is_loopback:
            return "owner"
    except ValueError:
        pass
    if client_ip in _OWN_IPS:
        return "owner"
    return _remote_level


def _request_level(handler: BaseHTTPRequestHandler) -> str:
    """Return the access level for an incoming request.

    Cookie check takes priority over IP so that the operator's browser (which
    may connect through WSL2 port-forwarding or a VPN and thus appear as a
    non-loopback IP) is always recognised as owner after the one-time auth
    URL visit.
    """
    if _OWNER_TOKEN:
        cookie_header = handler.headers.get("Cookie", "")
        for part in cookie_header.split(";"):
            name, _, val = part.strip().partition("=")
            if name.strip() == _COOKIE_NAME and val.strip() == _OWNER_TOKEN:
                return "owner"
    return _client_level(handler.client_address[0])


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

            # ---- owner auth handshake ----------------------------------------
            # Opening /?_auth=<token> in any browser sets the owner cookie and
            # redirects to / — lets the operator authenticate from any device.
            if path in ("", "/") and qs.get("_auth"):
                candidate = (qs["_auth"][0] or "").strip()
                if _OWNER_TOKEN and candidate == _OWNER_TOKEN:
                    body = b"Redirecting..."
                    self.send_response(302)
                    self.send_header("Location", "/")
                    self.send_header(
                        "Set-Cookie",
                        f"{_COOKIE_NAME}={_OWNER_TOKEN}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax",
                    )
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                # Wrong token — just serve the page normally (no silent error).

            if path == "/api/access":
                level = _request_level(self)
                return _json(self, 200, {"level": level})

            if path == "/api/shared-view":
                with _shared_view_lock:
                    return _json(self, 200, {
                        "sessions": _shared_view.get("sessions", []),
                        "ts": _shared_view_ts,
                    })

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
                level = _request_level(self)
                if level == "view-only":
                    # Return only the sessions currently open in the owner's workspace.
                    with _shared_view_lock:
                        results = list(_shared_view.get("sessions", []))
                    q = (qs.get("q", [""])[0] or "").strip().lower()
                    if q:
                        results = [
                            s for s in results
                            if q in (s.get("summary") or "").lower()
                            or q in (s.get("session_id") or "").lower()
                        ]
                    return _json(self, 200, {"results": results})
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

            level = _request_level(self)
            # view-only and view-all users may not perform any write operations.
            # The /api/shared-view POST is owner-only and handled further down.
            if level in ("view-only", "view-all") and path != "/api/shared-view":
                return _json(self, 403, {"error": "read_only"})

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

            if path == "/api/shared-view":
                # Only the owner may push the shared view.
                if _request_level(self) != "owner":
                    return _json(self, 403, {"error": "owner_only"})
                global _shared_view, _shared_view_ts
                sessions = data.get("sessions")
                if not isinstance(sessions, list):
                    return _json(self, 400, {"error": "sessions_must_be_list"})
                with _shared_view_lock:
                    _shared_view = {"sessions": sessions}
                    _shared_view_ts = time.time()
                return _json(self, 200, {"ok": True})

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


def serve(host: str, port: int, open_browser: bool, use_tui: bool, remote_level: str = "trust") -> None:
    global _remote_level, _OWNER_TOKEN
    _remote_level = remote_level
    tmux_manager.recover()
    server = ThreadingHTTPServer((host, port), Handler)
    base_url = f"http://{host if host != '0.0.0.0' else '127.0.0.1'}:{port}"

    # Load (or create) the owner token whenever access control is active so
    # the operator can authenticate from any device via the /?_auth= URL.
    auth_url: str | None = None
    if remote_level != "trust":
        _OWNER_TOKEN = _load_or_create_token()
        auth_url = f"{base_url}/?_auth={_OWNER_TOKEN}"

    open_url = auth_url or base_url

    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open_new_tab(open_url)).start()

    if use_tui:
        # Serve in a daemon thread so the TUI can own the foreground. Daemon
        # threads die when main exits, which is what we want on Ctrl+C — we
        # skip `server.shutdown()` because it would block on any long-lived
        # SSE handlers (e.g. an open tmux terminal).
        from .tui import run as run_tui
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        try:
            run_tui(base_url, auth_url=auth_url)
        finally:
            try:
                server.server_close()
            except Exception:
                pass
        return

    _print_plain_banner(base_url)
    if auth_url:
        print(f"\n  Owner auth URL (open once to stay authenticated):\n  {auth_url}\n")
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
    remote_group = parser.add_mutually_exclusive_group()
    remote_group.add_argument(
        "--view-only", action="store_true",
        help="Remote (non-localhost) users get view-only access to currently-open sessions",
    )
    remote_group.add_argument(
        "--view-all", action="store_true",
        help="Remote users can browse all sessions read-only but cannot interact",
    )
    remote_group.add_argument(
        "--trust", action="store_true",
        help="Remote users get full access (default when no flag is given)",
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

    if args.view_only:
        remote_level = "view-only"
    elif args.view_all:
        remote_level = "view-all"
    else:
        remote_level = "trust"  # default: full access (backwards-compatible)

    serve(args.host, args.port, open_browser=args.open, use_tui=args.tui, remote_level=remote_level)
    return 0


if __name__ == "__main__":
    sys.exit(main())
