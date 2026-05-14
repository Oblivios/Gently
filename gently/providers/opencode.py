"""OpenCode provider — reads from ~/.local/share/opencode/opencode.db (SQLite).

Schema we care about (drizzle-managed):
  session(id, project_id, slug, directory, title, time_created, time_updated, ...)
  message(id, session_id, time_created, data)   -- data is JSON: {role, agent, model, ...}
  part(id, message_id, session_id, time_created, data)
                                                -- data is JSON: {type, ...}
                                                   types: text | reasoning | tool |
                                                          step-start | step-finish

We expose the same `scan / get / delta / path_for` quartet as the file-backed
providers. `path_for` returns None — the parts live in SQLite, not on disk —
and callers that need the cwd ask `cwd_for_session()` instead.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from ..util import OPENCODE_DB, safe_id


def _connect() -> sqlite3.Connection | None:
    """Read-only connection. We use immutable=0 so we still see writes from
    the live opencode process, but mode=ro keeps us from accidentally taking
    a write lock that would block the editor."""
    if not OPENCODE_DB.exists():
        return None
    try:
        return sqlite3.connect(
            f"file:{OPENCODE_DB}?mode=ro", uri=True, timeout=2.0,
        )
    except sqlite3.Error:
        return None


def scan() -> list[dict[str, Any]]:
    conn = _connect()
    if conn is None:
        return []
    try:
        rows = conn.execute(
            """
            SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
                   (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS cnt
            FROM session s
            ORDER BY s.time_updated DESC
            """
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        conn.close()
    cards: list[dict[str, Any]] = []
    for sid, title, directory, t_created, t_updated, cnt in rows:
        ts = (t_updated or t_created or 0) / 1000.0
        cards.append({
            "session_id": str(sid),
            "type": "opencode",
            "summary": (title or sid or "").strip(),
            "project": (directory or "").strip(),
            "ts": ts,
            "mtime": ts,
            "count": int(cnt or 0),
            # No on-disk path — kept here so the cross-provider search code
            # in providers/__init__.py can treat it uniformly with the others.
            "path": "",
        })
    return cards


def cwd_for_session(sid: str) -> str | None:
    if not safe_id(sid):
        return None
    conn = _connect()
    if conn is None:
        return None
    try:
        row = conn.execute(
            "SELECT directory FROM session WHERE id = ?", (sid,),
        ).fetchone()
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    if not row:
        return None
    d = row[0] or ""
    return d.strip() or None


def path_for(sid: str):  # noqa: ARG001 — interface parity with file-based providers
    """SQLite-backed; there is no per-session file path."""
    return None


def _gather_items(conn: sqlite3.Connection, sid: str) -> list[dict[str, Any]]:
    """Build the chronological item list for a session.

    Each opencode message can contain text, reasoning, and tool-use parts in a
    single bubble; we keep that grouping intact and inline the parts on the
    message dict. The frontend parser is responsible for splitting it into the
    right number of UI bubbles (text/thinking on the message's own role, tool
    results re-attributed to the synthetic "tool" role).
    """
    msgs = conn.execute(
        "SELECT id, time_created, data FROM message "
        "WHERE session_id = ? ORDER BY time_created, id",
        (sid,),
    ).fetchall()
    parts = conn.execute(
        "SELECT id, message_id, time_created, data FROM part "
        "WHERE session_id = ? ORDER BY time_created, id",
        (sid,),
    ).fetchall()
    parts_by_msg: dict[str, list[dict[str, Any]]] = {}
    for pid, mid, p_ts, p_data in parts:
        try:
            pdoc = json.loads(p_data)
        except (TypeError, ValueError):
            continue
        if not isinstance(pdoc, dict):
            continue
        pdoc["_id"] = str(pid)
        pdoc["_time"] = (p_ts or 0) / 1000.0
        parts_by_msg.setdefault(str(mid), []).append(pdoc)

    items: list[dict[str, Any]] = []
    for mid, m_ts, m_data in msgs:
        try:
            mdoc = json.loads(m_data)
        except (TypeError, ValueError):
            continue
        if not isinstance(mdoc, dict):
            continue
        items.append({
            "type": "opencode_message",
            "id": str(mid),
            "role": str(mdoc.get("role") or "unknown"),
            "agent": mdoc.get("agent"),
            "model": mdoc.get("model") or {
                "providerID": mdoc.get("providerID"),
                "modelID":    mdoc.get("modelID"),
            },
            "time": (m_ts or 0) / 1000.0,
            "parts": parts_by_msg.get(str(mid), []),
        })
    return items


def get(sid: str, limit: int | None, before: int | None) -> dict[str, Any] | None:
    if not safe_id(sid):
        return None
    conn = _connect()
    if conn is None:
        return None
    try:
        srow = conn.execute(
            "SELECT title, directory FROM session WHERE id = ?", (sid,),
        ).fetchone()
        if not srow:
            return None
        items = _gather_items(conn, sid)
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    total = len(items)
    end = total if before is None else max(0, min(before, total))
    start = 0 if (limit is None or limit <= 0) else max(0, end - limit)
    return {
        "session_id": sid,
        "type": "opencode",
        "project": (srow[1] or "").strip(),
        "summary": (srow[0] or "").strip(),
        "total": total,
        "start": start,
        "end": end,
        "items": items[start:end],
    }


def delta(sid: str, offset: int) -> dict[str, Any] | None:
    if not safe_id(sid):
        return None
    conn = _connect()
    if conn is None:
        return None
    try:
        items = _gather_items(conn, sid)
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    total = len(items)
    offset = max(0, int(offset or 0))
    if offset > total:
        return {"items": [], "total": total, "reset": True, "type": "opencode"}
    return {"items": items[offset:], "total": total, "reset": False, "type": "opencode"}
