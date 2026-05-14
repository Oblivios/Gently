"""Server-side named workspace store.

Frontend persists its "active" pane layout to localStorage so it survives a
browser reload. This module adds a second tier: named snapshots on disk, so
the user can save/load/delete whole layouts and survive things localStorage
doesn't (cleared browser data, switching profiles, different machine with
the same gently checkout).

Files live at `~/.config/gently/workspaces/<name>.json`. Names are locked to
a small character set so an HTTP client can't use the name to traverse out
of the workspaces directory.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

# XDG_CONFIG_HOME if set, otherwise ~/.config — matches other local-tool
# conventions on Linux/macOS. Falls back cleanly on Windows too.
_XDG = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
WORKSPACES_DIR = Path(
    os.environ.get("GENTLY_WORKSPACES_DIR")
    or Path(_XDG) / "gently" / "workspaces"
)

# Letters / digits / space / dash / underscore, 1–64 chars, doesn't start
# with a space or dot (the latter would hide the file on unix).
_SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _-]{0,63}")


def safe_name(name: str) -> bool:
    return isinstance(name, str) and bool(_SAFE_NAME.fullmatch(name))


def _path_for(name: str) -> Path | None:
    if not safe_name(name):
        return None
    try:
        WORKSPACES_DIR.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    return WORKSPACES_DIR / f"{name}.json"


def list_workspaces() -> list[dict[str, Any]]:
    if not WORKSPACES_DIR.exists():
        return []
    out: list[dict[str, Any]] = []
    for p in sorted(WORKSPACES_DIR.glob("*.json")):
        try:
            stat = p.stat()
        except OSError:
            continue
        # Peek the tab count so the UI can show "3 tabs" without fetching
        # the whole file.
        tabs = 0
        try:
            with p.open("r", encoding="utf-8") as f:
                data = json.load(f)
            tabs = _count_tabs(data.get("root") if isinstance(data, dict) else None)
        except Exception:
            pass
        out.append({
            "name": p.stem,
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "tabs": tabs,
        })
    # Newest-first feels natural for a "recent workspaces" list.
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out


def _count_tabs(node: Any) -> int:
    if not isinstance(node, dict):
        return 0
    if node.get("type") == "pane":
        return len(node.get("tabs") or [])
    if node.get("type") == "split":
        return _count_tabs(node.get("a")) + _count_tabs(node.get("b"))
    return 0


def read_workspace(name: str) -> dict[str, Any] | None:
    p = _path_for(name)
    if p is None or not p.exists():
        return None
    try:
        with p.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def write_workspace(name: str, data: dict[str, Any]) -> bool:
    p = _path_for(name)
    if p is None:
        return False
    try:
        # Write to a temp file and rename — atomic enough to survive a
        # crash mid-save without leaving a truncated workspace file.
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        tmp.replace(p)
        return True
    except OSError:
        return False


def delete_workspace(name: str) -> bool:
    p = _path_for(name)
    if p is None or not p.exists():
        return False
    try:
        p.unlink()
        return True
    except OSError:
        return False
