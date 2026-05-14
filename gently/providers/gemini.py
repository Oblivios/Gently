"""Gemini provider — reads ~/.gemini/tmp/<projectDirname>/chats/session-*
and uses ~/.gemini/projects.json to reverse-lookup the real project path.

Two on-disk formats coexist (Gemini CLI changed shape around 0.39):
  - old: a single JSON document `{ sessionId, messages: [...], ... }`
         in a file with extension `.json`
  - new: JSONL where line 1 is the header `{ sessionId, projectHash, ... }`,
         each subsequent line is either a message dict or a `{"$set": {...}}`
         patch that updates header metadata. Extension is `.jsonl`.

`_load_session` normalises both back into (header, messages) so the rest
of the provider stays format-agnostic.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..util import (
    GEMINI_DIR,
    coerce_ts,
    iter_jsonl,  # noqa: F401  (re-exported for parity, not used here)
    safe_id,
    short,
    stat_mtime,
)


def _iter_session_files(tmp_dir: Path):
    """Yield every Gemini session file under tmp_dir, both old `.json` and
    new `.jsonl`. We glob both explicitly rather than `session-*.*` because
    that would also pick up unrelated dotfiles like `.bak` exports."""
    yield from tmp_dir.glob("*/chats/session-*.json")
    yield from tmp_dir.glob("*/chats/session-*.jsonl")


def _load_session(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Return `(header, messages)` for either Gemini on-disk shape."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return {}, []
    if not text:
        return {}, []

    # Old format: one JSON document.
    try:
        doc = json.loads(text)
        if isinstance(doc, dict) and isinstance(doc.get("messages"), list):
            header = {k: v for k, v in doc.items() if k != "messages"}
            return header, list(doc["messages"])
    except ValueError:
        pass

    # New format: JSONL. First line is the header, then messages and
    # `$set` mutation patches. We fold $set into the header so callers
    # don't need to know.
    header: dict[str, Any] = {}
    messages: list[dict[str, Any]] = []
    for i, line in enumerate(text.split("\n")):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if not isinstance(obj, dict):
            continue
        if "$set" in obj and isinstance(obj["$set"], dict):
            header.update(obj["$set"])
            continue
        if i == 0 or (not header and "sessionId" in obj):
            header.update(obj)
            continue
        # Anything with a type/id is a message bubble.
        if "type" in obj or "id" in obj:
            messages.append(obj)
    return header, messages

_card_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_project_reverse_cache: tuple[float, dict[str, str]] | None = None


def _project_reverse() -> dict[str, str]:
    """dirname → absolute-path map from ~/.gemini/projects.json."""
    global _project_reverse_cache
    f = GEMINI_DIR / "projects.json"
    mtime = stat_mtime(f)
    if _project_reverse_cache and _project_reverse_cache[0] == mtime:
        return _project_reverse_cache[1]
    mapping: dict[str, str] = {}
    try:
        with f.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        for abspath, dirname in (data.get("projects") or {}).items():
            if isinstance(abspath, str) and isinstance(dirname, str):
                mapping[dirname] = abspath
    except Exception:
        pass
    _project_reverse_cache = (mtime, mapping)
    return mapping


def _card(path: Path) -> dict[str, Any] | None:
    mtime = stat_mtime(path)
    if not mtime:
        return None
    key = str(path)
    hit = _card_cache.get(key)
    if hit and hit[0] == mtime:
        return hit[1]

    header, messages = _load_session(path)
    sid = str(header.get("sessionId") or "").strip()
    if not sid:
        return None

    count = len(messages)

    # Summary = first user message text (prefer ones that aren't slash-commands).
    summary = ""
    for m in messages:
        if not isinstance(m, dict) or m.get("type") != "user":
            continue
        content = m.get("content")
        text = ""
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            parts = [c.get("text", "") for c in content if isinstance(c, dict)]
            text = "\n\n".join(p for p in parts if p)
        text = (text or "").strip()
        if text and not text.startswith("/"):
            summary = short(text)
            break
        if text:
            summary = short(text)

    # Project: reverse-lookup the parent's parent dir name (.../tmp/<dir>/chats/<file>).
    project = ""
    try:
        dirname = path.parent.parent.name
    except Exception:
        dirname = ""
    if dirname:
        project = _project_reverse().get(dirname, "")

    ts = coerce_ts(header.get("lastUpdated") or header.get("startTime")) or mtime

    card = {
        "session_id": sid,
        "type": "gemini",
        "summary": summary or sid,
        "project": project,
        "ts": ts,
        "mtime": mtime,
        "count": count,
        "path": str(path),
    }
    _card_cache[key] = (mtime, card)
    return card


def scan() -> list[dict[str, Any]]:
    tmp_dir = GEMINI_DIR / "tmp"
    if not tmp_dir.exists():
        return []
    cards: dict[str, dict[str, Any]] = {}
    for path in _iter_session_files(tmp_dir):
        card = _card(path)
        if card:
            # Prefer the newest file per sessionId (rare, but can happen if
            # a session was migrated between project dirs, or rewritten in
            # the new .jsonl format alongside an old .json).
            prev = cards.get(card["session_id"])
            if prev is None or card["mtime"] > prev.get("mtime", 0):
                cards[card["session_id"]] = card
    return list(cards.values())


def cwd_for_session(sid: str) -> str | None:
    """Resolve the original project worktree for `sid` via projects.json.
    Gemini's `--resume <uuid>` only finds sessions whose chat directory
    matches the cwd's project hash, so we have to launch the CLI inside
    the original project — `$HOME` doesn't work."""
    p = path_for(sid)
    if p is None:
        return None
    card = _card(p) or {}
    project = card.get("project") or ""
    if not project:
        return None
    if not Path(project).is_dir():
        # Original folder has been deleted; surface that to the caller
        # rather than silently launching in a wrong cwd that resume can't
        # match.
        return None
    return project


def path_for(sid: str) -> Path | None:
    """Always-fresh sid → path lookup (see codex.path_for for the rationale)."""
    if not safe_id(sid):
        return None
    tmp_dir = GEMINI_DIR / "tmp"
    if not tmp_dir.exists():
        return None
    candidate: Path | None = None
    candidate_mtime = -1.0
    for p in _iter_session_files(tmp_dir):
        card = _card(p)
        if not card or card["session_id"] != sid:
            continue
        m = stat_mtime(p)
        if m > candidate_mtime:
            candidate = p
            candidate_mtime = m
    return candidate


def get(sid: str, limit: int | None, before: int | None) -> dict[str, Any] | None:
    path = path_for(sid)
    if path is None:
        return None
    _, messages = _load_session(path)
    total = len(messages)
    end = total if before is None else max(0, min(before, total))
    start = 0 if (limit is None or limit <= 0) else max(0, end - limit)

    card = _card(path) or {}
    return {
        "session_id": sid,
        "type": "gemini",
        "project": card.get("project", ""),
        "summary": card.get("summary", ""),
        "total": total,
        "start": start,
        "end": end,
        "items": messages[start:end],
    }


def delta(sid: str, offset: int) -> dict[str, Any] | None:
    path = path_for(sid)
    if path is None:
        return None
    _, messages = _load_session(path)
    total = len(messages)
    offset = max(0, int(offset or 0))
    if offset > total:
        return {"items": [], "total": total, "reset": True, "type": "gemini"}
    return {"items": messages[offset:], "total": total, "reset": False, "type": "gemini"}
