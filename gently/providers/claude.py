"""Claude provider — reads ~/.claude/projects/**/*.jsonl session files and
~/.claude/history.jsonl for authoritative summaries.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..util import (
    CLAUDE_DIR,
    coerce_ts,
    iter_jsonl,
    safe_id,
    short,
    stat_mtime,
)


def _content_text(content: Any) -> str:
    """Flatten a Claude `message.content` payload to plain text for summaries."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        t = item.get("type")
        if t == "text" and item.get("text"):
            parts.append(str(item["text"]))
        elif t == "tool_result" and item.get("content"):
            c = item["content"]
            parts.append(c if isinstance(c, str) else json.dumps(c, ensure_ascii=False))
    return "\n\n".join(p for p in parts if p)


_card_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _card(path: Path) -> dict[str, Any] | None:
    mtime = stat_mtime(path)
    if not mtime:
        return None
    key = str(path)
    hit = _card_cache.get(key)
    if hit and hit[0] == mtime:
        return hit[1]

    session_id = path.stem
    summary = ""
    project = ""
    ts = 0.0
    count = 0
    for entry in iter_jsonl(path):
        count += 1
        if not project:
            cwd = entry.get("cwd")
            if isinstance(cwd, str) and cwd.strip():
                project = cwd.strip()
        ts = max(ts, coerce_ts(entry.get("timestamp")))
        if not summary and entry.get("type") == "user":
            msg = entry.get("message")
            if isinstance(msg, dict):
                text = _content_text(msg.get("content"))
                if text and not text.lstrip().startswith("<"):
                    summary = short(text)
    if count == 0:
        return None

    card = {
        "session_id": session_id,
        "type": "claude",
        "summary": summary or session_id,
        "project": project,
        "ts": ts or mtime,
        "mtime": mtime,
        "count": count,
        "path": str(path),
    }
    _card_cache[key] = (mtime, card)
    return card


def _apply_history_overrides(cards: dict[str, dict[str, Any]]) -> None:
    """Prefer the human-entered prompt from history.jsonl when present — the
    rollout file's first user message is often an `<environment_context>` wrap."""
    latest: dict[str, tuple[float, str]] = {}
    for entry in iter_jsonl(CLAUDE_DIR / "history.jsonl"):
        sid = str(entry.get("sessionId") or "").strip()
        if not sid or sid not in cards:
            continue
        display = str(entry.get("display") or "").strip()
        if not display or display.startswith("/"):
            continue
        ts = coerce_ts(entry.get("timestamp"))
        prev = latest.get(sid)
        if prev is None or ts > prev[0]:
            latest[sid] = (ts, display)
    for sid, (_, display) in latest.items():
        cards[sid]["summary"] = short(display)


def scan() -> list[dict[str, Any]]:
    projects_dir = CLAUDE_DIR / "projects"
    if not projects_dir.exists():
        return []
    cards: dict[str, dict[str, Any]] = {}
    for path in projects_dir.rglob("*.jsonl"):
        card = _card(path)
        if card:
            cards[card["session_id"]] = card
    _apply_history_overrides(cards)
    return list(cards.values())


def path_for(sid: str) -> Path | None:
    """Locate the JSONL file backing a given session id."""
    if not safe_id(sid):
        return None
    projects_dir = CLAUDE_DIR / "projects"
    if not projects_dir.exists():
        return None
    for p in projects_dir.rglob(f"{sid}.jsonl"):
        return p
    return None


def get(sid: str, limit: int | None, before: int | None) -> dict[str, Any] | None:
    path = path_for(sid)
    if path is None:
        return None
    items = list(iter_jsonl(path))
    total = len(items)
    end = total if before is None else max(0, min(before, total))
    start = 0 if (limit is None or limit <= 0) else max(0, end - limit)
    card = _card(path) or {}
    # An empty file isn't a 404 — it's a session that exists but hasn't
    # logged anything (or got truncated). Return a valid payload so the
    # UI shows "no messages yet" instead of the generic load failure.
    return {
        "session_id": sid,
        "type": "claude",
        "project": card.get("project", ""),
        "summary": card.get("summary", ""),
        "total": total,
        "start": start,
        "end": end,
        "items": items[start:end],
    }


def delta(sid: str, offset: int) -> dict[str, Any] | None:
    path = path_for(sid)
    if path is None:
        return None
    items = list(iter_jsonl(path))
    total = len(items)
    offset = max(0, int(offset or 0))
    if offset > total:
        return {"items": [], "total": total, "reset": True, "type": "claude"}
    return {"items": items[offset:], "total": total, "reset": False, "type": "claude"}
