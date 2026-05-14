"""Minimal tmux bridge.

Spawns `claude -r <id>` / `codex resume <id>` / `gemini -r <id>` inside a
detached tmux session, pipes its pane output to a log file, and lets the
HTTP layer stream that log back over SSE while sending keystrokes over
POSTs. No FastAPI, no websockets — subprocess + stdlib HTTP.

Session naming is locked to `gently_<provider>_<sid8>_<ts>`. All public
methods validate against `_SAFE_SESSION`, so the HTTP surface can't be
tricked into touching unrelated tmux sessions on the host.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .providers import PROVIDERS
from .providers import opencode as opencode_provider
from .providers import gemini as gemini_provider
from .util import iter_jsonl, safe_id

TMUX_LOG_ROOT = Path(os.environ.get("GENTLY_TMUX_LOG_DIR", "/tmp/gently_tmux_logs"))
_SAFE_SESSION = re.compile(r"^gently_[A-Za-z0-9_-]+$")

# Where each agent's CLI tends to install itself when it isn't on $PATH. We
# fall back to these so a fresh shell launched under the desktop session
# (which often has a stripped-down PATH) can still find e.g. `opencode`.
# bash -lc loads the user's profile inside tmux, so this only matters for our
# own `shutil.which` precheck.
_CLI_FALLBACK_PATHS = {
    "opencode": [Path.home() / ".opencode" / "bin" / "opencode"],
    "claude":   [Path.home() / ".claude" / "local" / "claude"],
    "codex":    [],
    "gemini":   [],
}


def _resolve_cli(provider: str) -> str | None:
    """Look up the CLI binary for `provider`, falling back to a few well-known
    install paths when $PATH doesn't include them. Returns the absolute path
    or None if nothing was found."""
    found = shutil.which(provider)
    if found:
        return found
    for cand in _CLI_FALLBACK_PATHS.get(provider, []):
        try:
            if cand.is_file() and os.access(cand, os.X_OK):
                return str(cand)
        except OSError:
            continue
    return None


@dataclass
class TmuxJob:
    session: str
    provider: str
    session_id: str
    workdir: str
    started_ts: float
    status: str = "running"  # running | done
    error: str = ""


class TmuxManager:
    def __init__(self) -> None:
        self.jobs: dict[str, TmuxJob] = {}
        self._lock = threading.Lock()
        try:
            TMUX_LOG_ROOT.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass

    # ---- low-level tmux wrappers --------------------------------------------

    def _run(self, args: list[str], timeout: float = 10.0) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["tmux", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )

    def has_session(self, name: str) -> bool:
        if not _SAFE_SESSION.fullmatch(name):
            return False
        try:
            r = self._run(["has-session", "-t", name])
            return r.returncode == 0
        except Exception:
            return False

    # ---- sidecar metadata ---------------------------------------------------
    # Each live tmux session gets a small JSON file next to its log so we can
    # reconstruct the full job across server restarts — the tmux session name
    # alone only carries an 8-char prefix of the conversation id + timestamp,
    # which isn't enough to know which conversation a session belongs to.

    def _meta_path(self, session: str) -> Path:
        return TMUX_LOG_ROOT / f"{session}.meta.json"

    def _write_meta(self, job: TmuxJob) -> None:
        try:
            self._meta_path(job.session).write_text(
                json.dumps({
                    "session_id": job.session_id,
                    "provider":   job.provider,
                    "workdir":    job.workdir,
                    "started_ts": job.started_ts,
                }),
                encoding="utf-8",
            )
        except OSError:
            pass

    def _read_meta(self, session: str) -> dict[str, Any]:
        try:
            with self._meta_path(session).open("r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _remove_sidecar_files(self, session: str) -> None:
        for p in (self._meta_path(session), TMUX_LOG_ROOT / f"{session}.log"):
            try:
                p.unlink()
            except OSError:
                pass

    def find_running(self, provider: str, session_id: str) -> TmuxJob | None:
        """Find a live tmux session for this (provider, session_id). Drops
        stale entries whose tmux session has since died."""
        with self._lock:
            candidates = [
                j for j in self.jobs.values()
                if j.provider == provider and j.session_id == session_id
            ]
        for j in candidates:
            if self.has_session(j.session):
                # Promote status back to "running" in case list_jobs had
                # previously marked it "done" during a transient check.
                j.status = "running"
                return j
            # Session is gone from tmux — drop from our in-memory registry
            # and clean up its disk state.
            with self._lock:
                self.jobs.pop(j.session, None)
            self._remove_sidecar_files(j.session)
        return None

    # ---- cwd resolution (per provider) --------------------------------------

    def cwd_for(self, provider: str, sid: str) -> str | None:
        """Walk the session's own JSONL to find a usable `cwd`. Gemini doesn't
        reliably record one — fall back to $HOME at the call site."""
        impl = PROVIDERS.get(provider)
        if not impl:
            return None

        # opencode stores cwd directly on the session row, no JSONL to walk.
        if provider == "opencode":
            return opencode_provider.cwd_for_session(sid)
        # gemini needs the *original* project worktree (its `--resume` only
        # finds sessions whose chats dir hashes to the cwd). The provider
        # already has the reverse lookup baked in.
        if provider == "gemini":
            return gemini_provider.cwd_for_session(sid)

        path = impl["path"](sid)
        if path is None:
            return None

        if provider == "claude":
            for entry in iter_jsonl(path):
                cwd = entry.get("cwd")
                if isinstance(cwd, str) and cwd and Path(cwd).is_dir():
                    return cwd
            return None

        if provider == "codex":
            for entry in iter_jsonl(path):
                payload = entry.get("payload") if isinstance(entry, dict) else None
                if isinstance(payload, dict):
                    cwd = payload.get("cwd")
                    if isinstance(cwd, str) and cwd and Path(cwd).is_dir():
                        return cwd
                cwd = entry.get("cwd") if isinstance(entry, dict) else None
                if isinstance(cwd, str) and cwd and Path(cwd).is_dir():
                    return cwd
            return None

        # gemini: projects.json doesn't cleanly invert. Best effort = None.
        return None

    # ---- public ops ---------------------------------------------------------

    def start_job(
        self,
        provider: str,
        session_id: str,
        *,
        bypass_permissions: bool = True,
    ) -> TmuxJob:
        if provider not in {"claude", "codex", "gemini", "opencode"}:
            raise ValueError(f"unknown provider: {provider}")
        if not safe_id(session_id):
            raise ValueError("invalid session_id")
        if shutil.which("tmux") is None:
            raise RuntimeError("tmux is not installed on this machine")

        # Reuse an existing running tmux session for this conversation so
        # repeated clicks of the terminal button don't accumulate new
        # sessions. This is the whole point of persisting meta sidecars:
        # after a server restart we can still match (provider, session_id)
        # against a long-running tmux session.
        existing = self.find_running(provider, session_id)
        if existing is not None:
            return existing

        cli = _resolve_cli(provider)
        if cli is None:
            raise RuntimeError(f"{provider} CLI not found in PATH")

        workdir = self.cwd_for(provider, session_id)
        if provider == "gemini" and not workdir:
            # Gemini's resume can only find a session when launched inside the
            # original project worktree. If the folder is gone we can't fake
            # one, so bail out with a clear message instead of spawning the
            # CLI in $HOME and letting it print "Invalid session identifier".
            raise RuntimeError(
                "gemini resume needs the original project folder, but it "
                "couldn't be resolved or no longer exists on disk"
            )
        if not workdir:
            workdir = str(Path.home())
        if provider == "claude":
            cmd = [cli, "-r", session_id]
            # `bypass_permissions` only applies to Claude; the others don't
            # expose an equivalent flag. User is prompted before the fetch
            # in the browser.
            if bypass_permissions:
                cmd.append("--dangerously-skip-permissions")
        elif provider == "codex":
            cmd = [cli, "resume", session_id]
        elif provider == "opencode":
            # `opencode -s ses_…` resumes the session printed in its banner.
            cmd = [cli, "-s", session_id]
        else:  # gemini
            cmd = [cli, "-r", session_id]

        ts = int(time.time())
        short = re.sub(r"[^A-Za-z0-9]", "", session_id)[:8] or "x"
        session = f"gently_{provider}_{short}_{ts}"
        if not _SAFE_SESSION.fullmatch(session):
            raise RuntimeError("constructed an unsafe session name")

        log_file = TMUX_LOG_ROOT / f"{session}.log"
        try:
            log_file.touch()
        except OSError as e:
            raise RuntimeError(f"cannot create log file: {e}") from e

        tool_cmd = " ".join(shlex.quote(c) for c in cmd)
        sentinel = (
            f'printf "\\n__GENTLY_DONE__:%s\\n" "$?" '
            f">> {shlex.quote(str(log_file))}"
        )
        bash_cmd = (
            f"cd {shlex.quote(workdir)} && {tool_cmd}; {sentinel}; "
            "read -p 'Press enter to close…' || sleep 10"
        )

        # `-x/-y` set the detached session's initial terminal dimensions.
        # Without these, tmux defaults to 80×24 — so even when xterm renders
        # huge in the browser, `pipe-pane` only streams an 80-col wide chunk,
        # making the terminal look like a tiny box inside the pane. The
        # browser will dial the real size in via /api/tmux/resize once
        # FitAddon has measured the host; these are just the generous
        # defaults for the first render.
        r = self._run([
            "new-session", "-d", "-s", session,
            "-x", "220", "-y", "60",
            f"bash -lc {shlex.quote(bash_cmd)}",
        ])
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout or "tmux new-session failed").strip())

        # Tee pane output to the log file. `-o` = append (don't overwrite).
        self._run([
            "pipe-pane", "-o", "-t", session,
            f"cat >> {shlex.quote(str(log_file))}",
        ])

        job = TmuxJob(
            session=session,
            provider=provider,
            session_id=session_id,
            workdir=workdir,
            started_ts=time.time(),
            status="running",
        )
        with self._lock:
            self.jobs[session] = job
        self._write_meta(job)
        return job

    def start_new_job(
        self,
        provider: str,
        workdir: str,
        *,
        bypass_permissions: bool = False,
    ) -> TmuxJob:
        """Spawn a fresh agent (no -r/resume) inside `workdir`. Returns the
        new TmuxJob. Unlike `start_job` we always create — there's no prior
        conversation to reuse."""
        if provider not in {"claude", "codex", "gemini", "opencode"}:
            raise ValueError(f"unknown provider: {provider}")
        if shutil.which("tmux") is None:
            raise RuntimeError("tmux is not installed on this machine")

        wd = Path(workdir).expanduser()
        if not wd.is_dir():
            raise ValueError(f"not a directory: {workdir}")

        cli = _resolve_cli(provider)
        if cli is None:
            raise RuntimeError(f"{provider} CLI not found in PATH")

        if provider == "claude":
            cmd = [cli]
            if bypass_permissions:
                cmd.append("--dangerously-skip-permissions")
        else:
            # Codex, Gemini, and opencode all start fresh on a bare invocation.
            cmd = [cli]

        ts = int(time.time())
        session = f"gently_{provider}_new_{ts}"
        if not _SAFE_SESSION.fullmatch(session):
            raise RuntimeError("constructed an unsafe session name")

        log_file = TMUX_LOG_ROOT / f"{session}.log"
        try:
            log_file.touch()
        except OSError as e:
            raise RuntimeError(f"cannot create log file: {e}") from e

        tool_cmd = " ".join(shlex.quote(c) for c in cmd)
        sentinel = (
            f'printf "\\n__GENTLY_DONE__:%s\\n" "$?" '
            f">> {shlex.quote(str(log_file))}"
        )
        bash_cmd = (
            f"cd {shlex.quote(str(wd))} && {tool_cmd}; {sentinel}; "
            "read -p 'Press enter to close…' || sleep 10"
        )

        r = self._run([
            "new-session", "-d", "-s", session,
            "-x", "220", "-y", "60",
            f"bash -lc {shlex.quote(bash_cmd)}",
        ])
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout or "tmux new-session failed").strip())

        self._run([
            "pipe-pane", "-o", "-t", session,
            f"cat >> {shlex.quote(str(log_file))}",
        ])

        job = TmuxJob(
            session=session,
            provider=provider,
            session_id="",  # No agent session id yet — agent will mint one.
            workdir=str(wd),
            started_ts=time.time(),
            status="running",
        )
        with self._lock:
            self.jobs[session] = job
        self._write_meta(job)
        return job

    @staticmethod
    def make_temp_workdir() -> str:
        """Create a fresh scratch directory for a new conversation. We don't
        clean up on session end — the user may want to inspect what the agent
        wrote there."""
        return tempfile.mkdtemp(prefix="gently_")

    def list_jobs(self) -> list[dict[str, Any]]:
        with self._lock:
            jobs = list(self.jobs.values())
        out: list[dict[str, Any]] = []
        for j in jobs:
            if j.status == "running" and not self.has_session(j.session):
                j.status = "done"
            out.append(asdict(j))
        return out

    def kill_job(self, session: str) -> bool:
        if not _SAFE_SESSION.fullmatch(session):
            return False
        self._run(["kill-session", "-t", session])
        with self._lock:
            self.jobs.pop(session, None)
        # Remove the log + meta sidecar so the log dir doesn't accumulate
        # files forever and a future `recover()` doesn't resurrect a dead
        # entry from a leftover meta.
        self._remove_sidecar_files(session)
        return True

    def read_log(self, session: str, offset: int) -> tuple[bytes, int]:
        if not _SAFE_SESSION.fullmatch(session):
            return b"", offset
        log_file = TMUX_LOG_ROOT / f"{session}.log"
        try:
            size = log_file.stat().st_size
        except OSError:
            return b"", offset
        # Fast path: nothing new since last read. Skip open+seek so the
        # SSE loop's idle tick is just a stat() + a sleep.
        if offset == size:
            return b"", offset
        if offset > size:
            # File was truncated/rotated; start over.
            offset = 0
        try:
            with log_file.open("rb") as f:
                f.seek(offset)
                data = f.read()
        except OSError:
            return b"", offset
        return data, offset + len(data)

    def resize_session(self, session: str, cols: int, rows: int) -> bool:
        """Resize the window (and therefore the lone pane) inside a detached
        session so its rendered output matches the browser-side xterm size.
        Without this call, tmux keeps rendering at whatever dimensions it was
        created with — which is why the terminal looked like a small box
        inside a larger pane."""
        if not _SAFE_SESSION.fullmatch(session):
            return False
        try:
            c = max(20, min(int(cols), 500))
            r = max(5, min(int(rows), 200))
        except (TypeError, ValueError):
            return False
        res = self._run(["resize-window", "-t", session, "-x", str(c), "-y", str(r)])
        return res.returncode == 0

    def send_input(self, session: str, text: str) -> bool:
        if not _SAFE_SESSION.fullmatch(session):
            return False
        if not text:
            return True
        # Map common xterm escape sequences to tmux key names so arrows/ctrl
        # keys don't get typed as literal garbage into the pane.
        mapping = {
            "\r": "Enter", "\n": "Enter", "\t": "Tab",
            "\x7f": "BSpace", "\x08": "BSpace",
            "\x1b": "Escape",
            "\x1b[A": "Up", "\x1b[B": "Down",
            "\x1b[C": "Right", "\x1b[D": "Left",
            "\x1b[H": "Home", "\x1b[F": "End",
            "\x1b[3~": "DC",
            "\x1b[5~": "PPage", "\x1b[6~": "NPage",
            "\x01": "C-a", "\x03": "C-c", "\x04": "C-d",
            "\x05": "C-e", "\x0c": "C-l", "\x1a": "C-z",
        }
        if text in mapping:
            args = ["send-keys", "-t", session, mapping[text]]
        else:
            args = ["send-keys", "-t", session, "-l", text]
        r = self._run(args)
        return r.returncode == 0

    def recover(self) -> None:
        """Reconstruct self.jobs from already-running tmux sessions that match
        our naming scheme, so the UI can reattach after a server restart."""
        try:
            r = self._run(["list-sessions", "-F", "#{session_name}"])
        except Exception:
            return
        if r.returncode != 0:
            return
        for name in r.stdout.splitlines():
            name = name.strip()
            if not _SAFE_SESSION.fullmatch(name):
                continue
            parts = name.split("_")
            name_provider = parts[1] if len(parts) >= 2 else ""
            if name_provider not in {"claude", "codex", "gemini", "opencode"}:
                continue
            meta = self._read_meta(name)
            # Meta is the source of truth; the session name is just a hint.
            provider = str(meta.get("provider") or name_provider)
            session_id = str(meta.get("session_id") or "")
            workdir = str(meta.get("workdir") or "")
            try:
                started_ts = float(meta.get("started_ts") or time.time())
            except (TypeError, ValueError):
                started_ts = time.time()
            with self._lock:
                if name in self.jobs:
                    continue
                self.jobs[name] = TmuxJob(
                    session=name,
                    provider=provider,
                    session_id=session_id,
                    workdir=workdir,
                    started_ts=started_ts,
                    status="running",
                )


tmux_manager = TmuxManager()
