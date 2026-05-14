"""Shared filesystem / JSON helpers used by every provider and the tmux layer.

Kept deliberately dependency-free: stdlib only.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

# Per-provider session directories (env overrides are handy for tests and for
# users who keep their CLI data somewhere non-default).
CLAUDE_DIR = Path(os.environ.get("CLAUDE_DIR", Path.home() / ".claude"))
CODEX_DIR = Path(os.environ.get("CODEX_DIR", Path.home() / ".codex"))
GEMINI_DIR = Path(os.environ.get("GEMINI_DIR", Path.home() / ".gemini"))
# opencode keeps everything in a single SQLite db, not per-session JSONL files,
# so the "dir" we expose to callers is the file's parent (used for the TUI's
# "exists" indicator and nothing else).
OPENCODE_DB = Path(os.environ.get("OPENCODE_DB", Path.home() / ".local/share/opencode/opencode.db"))
OPENCODE_DIR = OPENCODE_DB.parent


def iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    """Yield dict entries from a JSONL file, skipping malformed / non-dict lines."""
    if not path.exists():
        return
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if isinstance(obj, dict):
                    yield obj
    except OSError:
        return


def coerce_ts(value: Any) -> float:
    """Best-effort normalizer from int/float/ISO-string to unix seconds."""
    if isinstance(value, (int, float)):
        ts = float(value)
        return ts / 1000.0 if ts > 10_000_000_000 else ts
    if isinstance(value, str) and value.strip():
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except Exception:
            return 0.0
    return 0.0


def short(text: str, limit: int = 200) -> str:
    """Collapse whitespace and truncate with an ellipsis."""
    clean = re.sub(r"\s+", " ", text or "").strip()
    return clean[:limit] + ("…" if len(clean) > limit else "")


def stat_mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


_SAFE_ID = re.compile(r"[A-Za-z0-9._-]+")


def safe_id(sid: str) -> bool:
    """True if `sid` is a plausible session id (the characters each provider
    actually uses). Used as a path-traversal guard in lookup helpers."""
    return bool(sid) and bool(_SAFE_ID.fullmatch(sid))
