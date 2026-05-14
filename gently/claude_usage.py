"""Claude Code usage/quota reader.

Mirrors the approach used by Claude Code's own statusline (see
https://codelynx.dev/posts/claude-code-usage-limits-statusline): read the
OAuth access token from `~/.claude/.credentials.json`, call the undocumented
`/api/oauth/usage` endpoint, and cache the result.

Refresh is user-triggered only — there is no background timer. The TUI kicks
an initial fetch at boot and then re-fetches when the user presses R.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
_UA = "claude-code/2.0.32"
_BETA = "oauth-2025-04-20"

# ~/.claude/.credentials.json — respects the CLAUDE_DIR env override so users
# who relocate their config keep working.
_CREDS_PATH = Path(os.environ.get("CLAUDE_DIR", Path.home() / ".claude")) / ".credentials.json"


@dataclass
class UsageBucket:
    bucket: str                  # raw api key, e.g. "five_hour"
    label: str                   # human name, e.g. "5-hour limit"
    percent: float               # 0-100, may be fractional
    resets_at: str | None = None # ISO-8601 or null


@dataclass
class UsageSnapshot:
    buckets: list[UsageBucket] = field(default_factory=list)
    updated_ts: float = 0.0
    error: str = ""
    fetching: bool = False       # true while a refresh is in flight


_LOCK = threading.Lock()
_SNAPSHOT = UsageSnapshot()

# Key → label. Anything unknown is surfaced verbatim so we don't hide new
# buckets Anthropic ships in the future.
_LABELS = {
    "five_hour":             "5-hour limit",
    "seven_day":             "Weekly · all models",
    # Anthropic has renamed the "Claude Design" bucket at least twice (seen
    # as `seven_day_oauth_apps`, `iguana_necktie`, `seven_day_omelette`).
    # Map all known codenames to the same display label.
    "seven_day_oauth_apps":  "Weekly · Claude Design",
    "iguana_necktie":        "Weekly · Claude Design",
    "seven_day_omelette":    "Weekly · Claude Design",
    "seven_day_opus":        "Opus only",
    "seven_day_sonnet":      "Sonnet only",
    "extra_usage":           "Extra usage",
}
# Preferred order for known buckets; unknowns are appended after.
_ORDER = [
    "five_hour",
    "seven_day",
    "seven_day_oauth_apps",
    "iguana_necktie",
    "seven_day_omelette",
    "seven_day_sonnet",
    "seven_day_opus",
    "extra_usage",
]


def snapshot() -> dict[str, Any]:
    with _LOCK:
        return asdict(_SNAPSHOT)


def _read_token() -> str | None:
    try:
        with _CREDS_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return str(data["claudeAiOauth"]["accessToken"])
    except Exception:
        return None


def _parse_response(data: dict[str, Any]) -> list[UsageBucket]:
    """Response shape (from the article + observed):
        {
          "five_hour":           {"utilization": 6.0, "resets_at": "2025-..."},
          "seven_day":           {"utilization": 35.0, "resets_at": "2025-..."},
          "seven_day_oauth_apps": null,
          "seven_day_opus":      {"utilization": 0.0, "resets_at": null},
          ...
        }
    Top-level keys can be null; nested utilization can be 0."""
    out: list[UsageBucket] = []
    seen: set[str] = set()
    for key in _ORDER:
        val = data.get(key)
        if not isinstance(val, dict):
            continue
        out.append(_to_bucket(key, val))
        seen.add(key)
    # Forward-compat: surface any new keys the server adds.
    for key, val in data.items():
        if key in seen or not isinstance(val, dict):
            continue
        out.append(_to_bucket(key, val))
    return out


def _to_bucket(key: str, val: dict[str, Any]) -> UsageBucket:
    try:
        pct = float(val.get("utilization", 0))
    except (TypeError, ValueError):
        pct = 0.0
    resets = val.get("resets_at")
    return UsageBucket(
        bucket=key,
        label=_LABELS.get(key, key),
        percent=pct,
        resets_at=str(resets) if resets else None,
    )


def _fetch() -> tuple[list[UsageBucket], str]:
    token = _read_token()
    if not token:
        return [], f"no token at {_CREDS_PATH}"
    req = urllib.request.Request(_USAGE_URL, headers={
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": _UA,
        "Authorization": f"Bearer {token}",
        "anthropic-beta": _BETA,
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:80]
        except Exception:
            pass
        return [], f"HTTP {e.code}" + (f" — {body}" if body else "")
    except Exception as e:
        return [], f"{type(e).__name__}: {e}"[:120]

    if not isinstance(data, dict):
        return [], "unexpected response shape"
    return _parse_response(data), ""


def refresh(blocking: bool = False) -> None:
    """Trigger a refresh. If blocking=False, runs in a daemon thread so the
    caller (TUI) isn't frozen during the HTTP round-trip."""
    def _run() -> None:
        with _LOCK:
            _SNAPSHOT.fetching = True
        buckets, err = _fetch()
        with _LOCK:
            _SNAPSHOT.buckets = buckets
            _SNAPSHOT.error = err
            _SNAPSHOT.updated_ts = time.time()
            _SNAPSHOT.fetching = False

    if blocking:
        _run()
    else:
        threading.Thread(target=_run, name="gently-usage-refresh", daemon=True).start()


def resets_in(resets_at: str | None) -> str:
    """"2025-11-04T04:59:59.943648+00:00" → "2h", "16h", "45m"; "" if unknown."""
    if not resets_at:
        return ""
    try:
        dt = datetime.fromisoformat(resets_at.replace("Z", "+00:00"))
        diff = (dt - datetime.now(timezone.utc)).total_seconds()
    except Exception:
        return ""
    if diff <= 0:
        return "now"
    if diff < 3600:
        return f"{int(diff / 60)}m"
    if diff < 86_400:
        return f"{int(diff / 3600)}h"
    return f"{int(diff / 86_400)}d"
