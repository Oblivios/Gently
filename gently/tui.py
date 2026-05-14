"""Foreground terminal dashboard.

Runs in the TTY where `python3 app.py` was invoked. Repaints every couple of
seconds with per-provider session counts + recent activity, running tmux jobs,
and HTTP counters. Pure ANSI, stdlib only — no curses, no external deps.

Design notes:
- We redraw from cursor-home (`\\033[H`) every frame, with `\\033[K` per line
  to clear any leftover from the previous frame. No full `\\033[2J` except on
  entry, so there's zero flicker.
- Provider scans are already mtime-cached per-file (see providers/*.py), so
  the repeated scans are effectively free after the first render.
- Bounded to the first ~100 columns so the layout stays tidy in wide terms.
"""

from __future__ import annotations

import os
import select
import sys
import termios
import time
import tty

from . import claude_usage
from . import workspaces as ws_store
from .providers import PROVIDERS
from .stats import uptime_seconds
from .tmux import tmux_manager

# ---- ANSI ------------------------------------------------------------------

_RESET = "\033[0m"
_DIM = "\033[2m"
_BOLD = "\033[1m"
_CYAN = "\033[36m"
_GREEN = "\033[32m"
_YELLOW = "\033[33m"
_RED = "\033[31m"
_BLUE = "\033[34m"
_MAGENTA = "\033[35m"
_GRAY = "\033[90m"

_CLS = "\033[2J"
_HOME = "\033[H"
_CLREOL = "\033[K"
_HIDE_CURSOR = "\033[?25l"
_SHOW_CURSOR = "\033[?25h"

# Per-provider accent colors that mirror the web UI's role colors.
_PROVIDER_COLOR = {
    "claude":   _YELLOW,
    "codex":    _CYAN,
    "gemini":   _GREEN,
    "opencode": _MAGENTA,
}


# ---- helpers ---------------------------------------------------------------

def _term_size(default=(100, 30)) -> tuple[int, int]:
    try:
        sz = os.get_terminal_size()
        return sz.columns, sz.lines
    except OSError:
        return default


def _rel(ts: float) -> str:
    """Compact human-readable "N ago" for a unix-seconds timestamp."""
    if not ts:
        return "—"
    diff = time.time() - float(ts)
    if diff < 0:
        return "just now"
    if diff < 60:
        return f"{int(diff)}s ago"
    if diff < 3600:
        return f"{int(diff / 60)}m ago"
    if diff < 86_400:
        return f"{int(diff / 3600)}h ago"
    if diff < 86_400 * 365:
        return f"{int(diff / 86_400)}d ago"
    return f"{int(diff / (86_400 * 365))}y ago"


def _uptime(sec: float) -> str:
    s = int(sec)
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60}s"
    if s < 86_400:
        h, rem = divmod(s, 3600)
        return f"{h}h {rem // 60}m"
    d, rem = divmod(s, 86_400)
    return f"{d}d {rem // 3600}h"


def _provider_stats(name: str) -> tuple[int, int, float, bool]:
    """→ (session_count, total_messages, latest_ts, dir_exists)"""
    impl = PROVIDERS[name]
    cards = impl["scan"]()
    count = len(cards)
    total_msgs = sum(int(c.get("count") or 0) for c in cards)
    latest_ts = max((c.get("ts") or 0) for c in cards) if cards else 0.0
    exists = impl["dir"].exists()
    return count, total_msgs, latest_ts, exists


# ---- frame construction ----------------------------------------------------

def _build_frame(url: str, width: int) -> list[str]:
    """Return a list of already-ANSI-formatted lines. One list entry per
    terminal row. Width is used only for the horizontal rules."""
    lines: list[str] = []
    w = max(48, min(width, 100))

    # Header
    lines.append(f"{_BOLD}Gently{_RESET}{_DIM} · local agent console{_RESET}")
    lines.append(
        f"  {_CYAN}{url}{_RESET}  "
        f"{_DIM}· uptime {_uptime(uptime_seconds())}{_RESET}"
    )
    lines.append(f"{_DIM}{'─' * w}{_RESET}")

    # Per-provider block
    lines.append(f"{_BOLD}Providers{_RESET}")
    total_sessions = 0
    total_msgs = 0
    for name in ("claude", "codex", "gemini", "opencode"):
        color = _PROVIDER_COLOR.get(name, "")
        try:
            count, msgs, latest, exists = _provider_stats(name)
        except Exception as e:
            lines.append(
                f"  {_RED}!{_RESET} {color}{name:<9}{_RESET} "
                f"{_DIM}error: {e}{_RESET}"
            )
            continue
        total_sessions += count
        total_msgs += msgs
        marker = f"{_GREEN}●{_RESET}" if exists else f"{_DIM}○{_RESET}"
        last = _rel(latest) if latest else f"{_DIM}no activity{_RESET}"
        lines.append(
            f"  {marker} {color}{name:<9}{_RESET} "
            f"{count:>5} sessions · {msgs:>8,} messages · "
            f"last {last}"
        )
    lines.append(
        f"  {_DIM}├─ total  {total_sessions:>5} sessions · "
        f"{total_msgs:>8,} messages{_RESET}"
    )
    lines.append("")

    # Claude usage — hits Anthropic's /api/oauth/usage with the OAuth token
    # from ~/.claude/.credentials.json. User-triggered refresh only (press R).
    usage = claude_usage.snapshot()
    header_bits = [f"{_BOLD}Claude usage{_RESET}"]
    if usage.get("fetching"):
        header_bits.append(f"{_YELLOW}refreshing…{_RESET}")
    elif usage.get("updated_ts"):
        header_bits.append(f"{_DIM}fetched {_rel(usage['updated_ts'])}{_RESET}")
    else:
        header_bits.append(f"{_DIM}not fetched yet{_RESET}")
    lines.append("  ".join(header_bits))

    err = (usage.get("error") or "").strip()
    buckets = usage.get("buckets") or []
    if err and not buckets:
        lines.append(f"  {_RED}!{_RESET} {_DIM}{err}{_RESET}")
    elif not buckets and not usage.get("updated_ts"):
        lines.append(f"  {_DIM}press [R] to refresh{_RESET}")
    else:
        # Right-align percent column at a fixed width so the labels and
        # reset-in strings line up across rows even with 3-digit percentages.
        for b in buckets:
            pct = float(b.get("percent") or 0)
            pct_color = _GREEN if pct < 50 else (_YELLOW if pct < 85 else _RED)
            pct_str = f"{pct:>5.0f}%" if pct == int(pct) else f"{pct:>5.1f}%"
            resets = claude_usage.resets_in(b.get("resets_at"))
            resets_str = f"{_DIM}resets {resets}{_RESET}" if resets else ""
            label = str(b.get("label") or b.get("bucket") or "")
            lines.append(
                f"  {pct_color}{pct_str}{_RESET}  {label:<24}  {resets_str}"
            )
        if err:
            lines.append(f"  {_DIM}(last refresh: {err}){_RESET}")
    lines.append("")

    # Tmux jobs
    jobs = tmux_manager.list_jobs()
    running = sum(1 for j in jobs if j.get("status") == "running")
    lines.append(
        f"{_BOLD}Tmux jobs{_RESET}  "
        f"{_DIM}{running} running / {len(jobs)} total{_RESET}"
    )
    if not jobs:
        lines.append(f"  {_DIM}none running{_RESET}")
    else:
        # Newest first, cap to 8 so the dashboard doesn't blow past the viewport.
        jobs_sorted = sorted(jobs, key=lambda j: j.get("started_ts") or 0, reverse=True)
        for j in jobs_sorted[:8]:
            status = j.get("status") or "?"
            color = _GREEN if status == "running" else _DIM
            provider = j.get("provider") or "?"
            pcolor = _PROVIDER_COLOR.get(provider, "")
            sess = j.get("session", "")
            # Trim over-long session names so we don't wrap.
            max_sess = max(16, w - 32)
            if len(sess) > max_sess:
                sess = sess[: max_sess - 1] + "…"
            started = j.get("started_ts") or 0
            lines.append(
                f"  {color}●{_RESET} {color}{status:<7}{_RESET} "
                f"{pcolor}{provider:<7}{_RESET} {sess}  "
                f"{_DIM}{_rel(started)}{_RESET}"
            )
    lines.append("")

    # Saved workspaces (read-only listing — saving/loading/deleting lives in
    # the web UI; this is here purely for visibility of what's on disk).
    try:
        saved = ws_store.list_workspaces()
    except Exception:
        saved = []
    lines.append(
        f"{_BOLD}Saved workspaces{_RESET}  "
        f"{_DIM}{len(saved)} · {ws_store.WORKSPACES_DIR}{_RESET}"
    )
    if not saved:
        lines.append(f"  {_DIM}none — use the sidebar's Workspaces button to save one{_RESET}")
    else:
        for item in saved[:6]:
            name = str(item.get("name") or "")
            tabs = int(item.get("tabs") or 0)
            mtime = float(item.get("mtime") or 0)
            lines.append(
                f"  {name:<24} "
                f"{_DIM}{tabs:>2} tab{'s' if tabs != 1 else ' '} · "
                f"{_rel(mtime)}{_RESET}"
            )
        if len(saved) > 6:
            lines.append(f"  {_DIM}…and {len(saved) - 6} more{_RESET}")
    lines.append("")

    # Footer
    lines.append(
        f"{_DIM}{_RESET}[{_BOLD}R{_RESET}]{_DIM} refresh Claude usage · "
        f"Ctrl+C to quit · panel refreshes every 2s{_RESET}"
    )
    return lines


# ---- loop ------------------------------------------------------------------

def _draw(url: str, prev_line_count: int) -> int:
    width, height = _term_size()
    lines = _build_frame(url, width)
    out = [_HOME]
    for line in lines:
        out.append(_CLREOL)
        out.append(line)
        out.append("\n")
    # If the previous frame was taller, blank out the leftover rows so we
    # don't see stale text under the new frame.
    leftover = max(0, prev_line_count - len(lines))
    for _ in range(leftover):
        out.append(_CLREOL)
        out.append("\n")
    sys.stdout.write("".join(out))
    sys.stdout.flush()
    return len(lines)


def _warm_caches() -> None:
    """Drive one scan per provider so the mtime cache in each provider module
    is populated. Cold rglob over a few hundred session files can take several
    seconds; we'd rather eat that once with a splash than stutter the first
    painted frame."""
    for name in PROVIDERS:
        try:
            PROVIDERS[name]["scan"]()
        except Exception:
            pass


def _enter_cbreak() -> list | None:
    """Put stdin into cbreak mode so single keystrokes arrive without waiting
    for Enter, while keeping Ctrl+C working (raw mode would swallow signals).
    Returns the previous termios attrs for restoration, or None if stdin
    isn't a TTY."""
    if not sys.stdin.isatty():
        return None
    try:
        old = termios.tcgetattr(sys.stdin)
        tty.setcbreak(sys.stdin.fileno())
        return old
    except (termios.error, OSError):
        return None


def _restore_tty(old: list | None) -> None:
    if old is None:
        return
    try:
        termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old)
    except (termios.error, OSError):
        pass


def _read_key() -> str | None:
    """Non-blocking single-char read. Returns None if nothing is buffered."""
    try:
        r, _, _ = select.select([sys.stdin], [], [], 0)
        if not r:
            return None
        ch = sys.stdin.read(1)
        return ch or None
    except (OSError, ValueError):
        return None


def run(url: str, refresh_s: float = 2.0) -> None:
    """Blocking TUI loop. Returns on KeyboardInterrupt.

    Draws on a timer, but polls stdin every 100ms so [R] is responsive.
    Claude usage is fetched once at boot and then only on explicit [R]
    keypress — no background timer for that panel.
    """
    prev = 0
    old_tty = _enter_cbreak()
    try:
        # Splash: immediate visual feedback before the (potentially slow)
        # first scan and the HTTP round-trip for Claude usage.
        sys.stdout.write(
            _HIDE_CURSOR + _CLS + _HOME
            + f"{_BOLD}Gently{_RESET}{_DIM} · local agent console{_RESET}\n"
            + f"  {_CYAN}{url}{_RESET}\n\n"
            + f"{_DIM}Building session index…{_RESET}\n"
        )
        sys.stdout.flush()
        _warm_caches()
        # Kick the initial Claude-usage fetch off the main thread so we don't
        # block the first paint behind a (possibly slow) HTTPS round-trip.
        claude_usage.refresh(blocking=False)
        sys.stdout.write(_CLS + _HOME)
        sys.stdout.flush()

        last_draw = 0.0
        while True:
            now = time.time()
            if now - last_draw >= refresh_s:
                prev = _draw(url, prev)
                last_draw = now

            ch = _read_key()
            if ch in ("r", "R"):
                # Fire-and-forget so the UI stays responsive during the
                # HTTP round-trip; the panel shows "refreshing…" in the
                # meantime thanks to `fetching=True` in the snapshot.
                claude_usage.refresh(blocking=False)
                # Force an immediate redraw so the "refreshing…" state
                # shows up without waiting for the next 2s tick.
                prev = _draw(url, prev)
                last_draw = time.time()

            # Sleep in small chunks so keypresses stay responsive without
            # spamming CPU between draws.
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    finally:
        _restore_tty(old_tty)
        sys.stdout.write(_SHOW_CURSOR + "\n")
        sys.stdout.flush()
