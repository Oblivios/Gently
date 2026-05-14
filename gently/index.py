"""Cross-session full-text search index (SQLite FTS5).

Keeps one row per session with the concatenated message text, and rebuilds
each row lazily when the source's mtime moves past the row's recorded mtime.
Only the search path uses this — the sidebar list itself is still driven by
the per-provider `scan()` cards. The trade is: the bytes-on-disk grep used
to take a noticeable beat for 500 sessions; FTS5 does the same query in a
few milliseconds.

Index lives at `~/.config/gently/index.sqlite` (next to the workspaces dir
that `workspaces.py` already manages). Stdlib only — no external deps.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable

from .util import iter_jsonl, OPENCODE_DB

_XDG = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
INDEX_PATH = Path(
    os.environ.get("GENTLY_INDEX_DB")
    or Path(_XDG) / "gently" / "index.sqlite"
)

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _connect() -> sqlite3.Connection:
    global _conn
    if _conn is not None:
        return _conn
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(INDEX_PATH, check_same_thread=False, timeout=5.0)
    conn.row_factory = sqlite3.Row
    # WAL keeps reads from blocking when a write is happening — important
    # because `refresh()` may run on the request thread that handles search.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS documents (
            provider   TEXT NOT NULL,
            session_id TEXT NOT NULL,
            mtime      REAL NOT NULL,
            PRIMARY KEY (provider, session_id)
        )
    """)
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
            provider   UNINDEXED,
            session_id UNINDEXED,
            text,
            tokenize='porter unicode61'
        )
    """)
    _conn = conn
    return conn


# ---- per-provider text extractors -----------------------------------------
# Goal: keep the indexed body to message-ish text only, not the JSON
# scaffolding around it. False positives in search ("type":"text") are
# annoying enough to be worth a few extra lines per provider.

def _extract_claude(path: Path) -> str:
    parts: list[str] = []
    for entry in iter_jsonl(path):
        msg = entry.get("message") if isinstance(entry, dict) else None
        content = msg.get("content") if isinstance(msg, dict) else entry.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for b in content:
                if not isinstance(b, dict):
                    continue
                t = b.get("type")
                if t == "text" and b.get("text"):
                    parts.append(str(b["text"]))
                elif t == "tool_use":
                    parts.append(str(b.get("name", "")))
                    inp = b.get("input")
                    if inp:
                        parts.append(json.dumps(inp, ensure_ascii=False))
                elif t == "tool_result":
                    c = b.get("content")
                    if isinstance(c, str):
                        parts.append(c)
                    elif isinstance(c, list):
                        for cc in c:
                            if isinstance(cc, dict) and cc.get("text"):
                                parts.append(str(cc["text"]))
                elif t == "thinking" and b.get("thinking"):
                    parts.append(str(b["thinking"]))
    return "\n".join(p for p in parts if p)


def _extract_codex(path: Path) -> str:
    parts: list[str] = []
    for entry in iter_jsonl(path):
        if not isinstance(entry, dict):
            continue
        p = entry.get("payload") if isinstance(entry.get("payload"), dict) else entry
        pt = p.get("type")
        if pt == "message":
            content = p.get("content") or []
            if isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("text"):
                        parts.append(str(c["text"]))
        elif pt in ("function_call", "custom_tool_call"):
            parts.append(str(p.get("name", "")))
            args = p.get("arguments") or p.get("input")
            if args:
                parts.append(args if isinstance(args, str) else json.dumps(args, ensure_ascii=False))
        elif pt in ("function_call_output", "custom_tool_call_output"):
            out = p.get("output")
            if isinstance(out, str):
                parts.append(out)
            elif isinstance(out, dict):
                parts.append(out.get("output") or out.get("stdout") or out.get("error") or "")
        elif pt == "reasoning":
            for s in (p.get("summary") or []):
                if isinstance(s, dict) and s.get("text"):
                    parts.append(str(s["text"]))
    return "\n".join(p for p in parts if p)


def _extract_gemini(path: Path) -> str:
    # Gemini uses two on-disk formats (single-doc .json + JSONL .jsonl);
    # the provider's loader normalises both.
    from .providers.gemini import _load_session
    _, messages = _load_session(path)
    parts: list[str] = []
    for entry in messages:
        if not isinstance(entry, dict):
            continue
        c = entry.get("content")
        if isinstance(c, str):
            parts.append(c)
        elif isinstance(c, list):
            for cc in c:
                if isinstance(cc, dict) and cc.get("text"):
                    parts.append(str(cc["text"]))
        for th in (entry.get("thoughts") or []):
            if isinstance(th, dict):
                parts.append(str(th.get("subject") or ""))
                parts.append(str(th.get("description") or ""))
        for tc in (entry.get("toolCalls") or []):
            if isinstance(tc, dict):
                parts.append(str(tc.get("name") or ""))
                if tc.get("args"):
                    parts.append(json.dumps(tc["args"], ensure_ascii=False))
    return "\n".join(p for p in parts if p)


def _extract_opencode(sid: str) -> str:
    if not OPENCODE_DB.exists():
        return ""
    try:
        conn = sqlite3.connect(f"file:{OPENCODE_DB}?mode=ro", uri=True, timeout=2.0)
    except sqlite3.Error:
        return ""
    try:
        rows = conn.execute(
            "SELECT data FROM part WHERE session_id = ? ORDER BY time_created",
            (sid,),
        ).fetchall()
    finally:
        conn.close()
    parts: list[str] = []
    for (data,) in rows:
        try:
            doc = json.loads(data)
        except (TypeError, ValueError):
            continue
        if not isinstance(doc, dict):
            continue
        t = doc.get("type")
        if t in ("text", "reasoning") and doc.get("text"):
            parts.append(str(doc["text"]))
        elif t == "tool":
            parts.append(str(doc.get("tool", "")))
            state = doc.get("state") or {}
            if state.get("input"):
                parts.append(json.dumps(state["input"], ensure_ascii=False))
            out = state.get("output")
            if isinstance(out, str):
                parts.append(out)
    return "\n".join(p for p in parts if p)


def _text_for(provider: str, card: dict[str, Any]) -> str:
    sid = card["session_id"]
    path_str = card.get("path") or ""
    path = Path(path_str) if path_str else None
    try:
        if provider == "claude" and path:
            return _extract_claude(path)
        if provider == "codex" and path:
            return _extract_codex(path)
        if provider == "gemini" and path:
            return _extract_gemini(path)
        if provider == "opencode":
            return _extract_opencode(sid)
    except OSError:
        return ""
    return ""


# ---- public ops -----------------------------------------------------------

def refresh(cards: Iterable[dict[str, Any]]) -> int:
    """Re-index any session whose mtime is newer than the indexed copy.
    Returns the number of rows that were rewritten."""
    cards_list = list(cards)
    if not cards_list:
        return 0
    with _lock:
        conn = _connect()
        existing = {
            (r["provider"], r["session_id"]): float(r["mtime"])
            for r in conn.execute("SELECT provider, session_id, mtime FROM documents")
        }
        # Drop stale rows for sessions that disappeared (file deleted, opencode
        # session removed). Otherwise the FTS table grows forever.
        live = {(c["type"], c["session_id"]) for c in cards_list}
        gone = [k for k in existing if k not in live]
        for prov, sid in gone:
            conn.execute("DELETE FROM messages WHERE provider=? AND session_id=?", (prov, sid))
            conn.execute("DELETE FROM documents WHERE provider=? AND session_id=?", (prov, sid))

        changed = 0
        for c in cards_list:
            provider = c["type"]
            sid = c["session_id"]
            mtime = float(c.get("mtime") or c.get("ts") or 0)
            cur = existing.get((provider, sid))
            if cur is not None and cur >= mtime:
                continue
            text = _text_for(provider, c)
            conn.execute("DELETE FROM messages WHERE provider=? AND session_id=?", (provider, sid))
            if text.strip():
                conn.execute(
                    "INSERT INTO messages(provider, session_id, text) VALUES (?, ?, ?)",
                    (provider, sid, text),
                )
            # Always upsert the documents row so an extraction that yields no
            # text doesn't get retried on every search. Next mtime bump
            # invalidates this and we re-extract.
            conn.execute(
                "INSERT OR REPLACE INTO documents(provider, session_id, mtime) "
                "VALUES (?, ?, ?)",
                (provider, sid, mtime),
            )
            changed += 1
        conn.commit()
        return changed


def _to_match_query(q: str) -> str:
    """Build an FTS5 MATCH expression.

    Single token → prefix match (`foo*`), so partial typing in the sidebar
    still finds longer words.

    Multiple tokens → phrase query (`"foo bar baz"`), which only matches
    documents containing those tokens in that order. The previous
    `foo* AND bar* AND baz*` behaviour over-matched: short tokens like
    `in` and `it` made `in*`/`it*` hit nearly every document. Phrase mode
    lets a typed sentence behave like a typed sentence.

    Punctuation is stripped because FTS5 treats characters like `:`/`-`
    as operators."""
    tokens = [t for t in (
        "".join(ch if (ch.isalnum() or ch == "_") else " " for ch in q).split()
    ) if t]
    if not tokens:
        return ""
    if len(tokens) == 1:
        return f"{tokens[0]}*"
    # Phrase query — order-sensitive, contiguous after the tokenizer's
    # stemming/normalisation pass.
    return '"' + " ".join(tokens) + '"'


def search(query: str, providers: set[str], limit: int = 500) -> set[tuple[str, str]]:
    """Return the set of (provider, session_id) pairs whose indexed text
    matches `query`. Caller filters/ranks against the cards list."""
    q = (query or "").strip()
    if not q or not providers:
        return set()
    match = _to_match_query(q)
    if not match:
        return set()
    with _lock:
        conn = _connect()
        placeholders = ",".join(["?"] * len(providers))
        rows = conn.execute(
            f"SELECT provider, session_id FROM messages "
            f"WHERE messages MATCH ? AND provider IN ({placeholders}) "
            f"ORDER BY rank LIMIT ?",
            (match, *providers, limit),
        ).fetchall()
    return {(r["provider"], r["session_id"]) for r in rows}
