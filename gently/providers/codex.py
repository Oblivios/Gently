"""Codex provider — reads rollout files under ~/.codex/sessions/YYYY/MM/DD/ and
merges authoritative summaries from ~/.codex/history.jsonl.

Rollout file shape: each line is a dict with a `type` field. Interesting types
are `session_meta`, `turn_context`, `event_msg`, and `response_item` (whose
`payload.type` can be `message`, `reasoning`, `function_call`,
`function_call_output`, `custom_tool_call`, etc.).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from ..util import (
    CODEX_DIR,
    coerce_ts,
    iter_jsonl,
    safe_id,
    short,
    stat_mtime,
)

_SID_IN_FILENAME = re.compile(
    r"rollout-\d{4}-\d{2}-\d{2}T[\d-]+-(?P<sid>[A-Za-z0-9-]+)\.jsonl$"
)

_card_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _sid_from_path(path: Path) -> str | None:
    m = _SID_IN_FILENAME.search(path.name)
    return m.group("sid") if m else None


def _user_text_from_entry(entry: dict[str, Any]) -> str:
    if entry.get("type") != "response_item":
        return ""
    payload = entry.get("payload") or {}
    if payload.get("type") != "message" or payload.get("role") != "user":
        return ""
    content = payload.get("content") or []
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for b in content:
        if isinstance(b, dict) and b.get("text"):
            parts.append(str(b["text"]))
    text = "\n\n".join(parts)
    # Codex wraps the real prompt with <environment_context>… and sometimes
    # <user_instructions>…; strip those so the summary is the user's own words.
    text = re.sub(r"<environment_context>[\s\S]*?</environment_context>", "", text, flags=re.I)
    text = re.sub(r"<user_instructions>[\s\S]*?</user_instructions>", "", text, flags=re.I)
    return text.strip()


def _card(path: Path) -> dict[str, Any] | None:
    mtime = stat_mtime(path)
    if not mtime:
        return None
    key = str(path)
    hit = _card_cache.get(key)
    if hit and hit[0] == mtime:
        return hit[1]

    sid = _sid_from_path(path)
    if not sid:
        return None

    summary = ""
    project = ""
    ts = 0.0
    count = 0
    for entry in iter_jsonl(path):
        count += 1
        ts = max(ts, coerce_ts(entry.get("timestamp")))
        if not project and entry.get("type") == "session_meta":
            payload = entry.get("payload") or {}
            cwd = payload.get("cwd")
            if isinstance(cwd, str) and cwd.strip():
                project = cwd.strip()
        if not summary:
            text = _user_text_from_entry(entry)
            if text:
                summary = short(text)

    if count == 0:
        return None

    card = {
        "session_id": sid,
        "type": "codex",
        "summary": summary or sid,
        "project": project,
        "ts": ts or mtime,
        "mtime": mtime,
        "count": count,
        "path": str(path),
    }
    _card_cache[key] = (mtime, card)
    return card


def _apply_history_overrides(cards: dict[str, dict[str, Any]]) -> None:
    """Always prefer history.jsonl's first user text — it's the literal prompt."""
    seen: dict[str, tuple[float, str]] = {}
    for entry in iter_jsonl(CODEX_DIR / "history.jsonl"):
        sid = str(entry.get("session_id") or "").strip()
        if not sid or sid not in cards:
            continue
        text = str(entry.get("text") or "").strip()
        if not text:
            continue
        ts = coerce_ts(entry.get("ts"))
        prev = seen.get(sid)
        if prev is None or ts < prev[0]:  # earliest wins → opening prompt
            seen[sid] = (ts, text)
    for sid, (_, text) in seen.items():
        cards[sid]["summary"] = short(text)


def scan() -> list[dict[str, Any]]:
    sessions_dir = CODEX_DIR / "sessions"
    if not sessions_dir.exists():
        return []
    cards: dict[str, dict[str, Any]] = {}
    for path in sessions_dir.rglob("rollout-*.jsonl"):
        card = _card(path)
        if card:
            cards[card["session_id"]] = card
    _apply_history_overrides(cards)
    return list(cards.values())


def path_for(sid: str) -> Path | None:
    """Always-fresh sid → path lookup.

    We don't cache the index here because Codex creates new daily subdirs
    (`sessions/YYYY/MM/DD/`), so the top-level `sessions/` mtime doesn't change
    when a new session file appears under an existing year. The rglob is
    microseconds for a few hundred files — not worth the staleness risk.
    """
    if not safe_id(sid):
        return None
    sessions_dir = CODEX_DIR / "sessions"
    if not sessions_dir.exists():
        return None
    for p in sessions_dir.rglob("rollout-*.jsonl"):
        if _sid_from_path(p) == sid:
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
    return {
        "session_id": sid,
        "type": "codex",
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
        return {"items": [], "total": total, "reset": True, "type": "codex"}
    return {"items": items[offset:], "total": total, "reset": False, "type": "codex"}
