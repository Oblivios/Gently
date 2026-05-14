"""Per-provider registry + cross-provider search.

Each submodule exposes the same quartet: `scan`, `get`, `delta`, `path_for`.
We wrap them in the `PROVIDERS` dict so the HTTP handler can dispatch by name.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Callable

from ..util import CLAUDE_DIR, CODEX_DIR, GEMINI_DIR, OPENCODE_DIR
from . import claude, codex, gemini, opencode

Scan = Callable[[], list[dict[str, Any]]]
Get = Callable[[str, "int | None", "int | None"], "dict[str, Any] | None"]
Delta = Callable[[str, int], "dict[str, Any] | None"]

PROVIDERS: dict[str, dict[str, Any]] = {
    "claude": {
        "scan": claude.scan, "get": claude.get, "delta": claude.delta,
        "path": claude.path_for, "dir": CLAUDE_DIR,
    },
    "codex": {
        "scan": codex.scan, "get": codex.get, "delta": codex.delta,
        "path": codex.path_for, "dir": CODEX_DIR,
    },
    "gemini": {
        "scan": gemini.scan, "get": gemini.get, "delta": gemini.delta,
        "path": gemini.path_for, "dir": GEMINI_DIR,
    },
    "opencode": {
        "scan": opencode.scan, "get": opencode.get, "delta": opencode.delta,
        "path": opencode.path_for, "dir": OPENCODE_DIR,
    },
}


def build_index(enabled: set[str]) -> list[dict[str, Any]]:
    cards: list[dict[str, Any]] = []
    for name, impl in PROVIDERS.items():
        if name not in enabled:
            continue
        try:
            cards.extend(impl["scan"]())
        except Exception as e:
            sys.stderr.write(f"[{name}] scan error: {e}\n")
    cards.sort(key=lambda c: c.get("ts", 0), reverse=True)
    return cards


def search_sessions(query: str, enabled: set[str]) -> list[dict[str, Any]]:
    """Cross-provider search.

    Empty query → cards sorted by recency.
    Non-empty   → union of (a) substring match on summary/project/id (cheap,
                  catches typos and partial words) and (b) FTS5 hit against
                  the indexed message bodies. Results stay sorted by ts so
                  the most recent matches surface first."""
    cards = build_index(enabled)
    q = (query or "").lower().strip()
    if not q:
        return cards

    fast_ids = {
        c["session_id"]
        for c in cards
        if q in c["summary"].lower()
        or q in c["project"].lower()
        or q in c["session_id"].lower()
    }

    # Lazy index refresh: only on a real query, never on the empty-list path.
    # `refresh` no-ops on already-current rows so the steady-state cost is
    # just one tiny SELECT per session.
    from .. import index as fts_index
    try:
        fts_index.refresh(cards)
        fts_hits = fts_index.search(query, set(enabled))
    except Exception as e:
        sys.stderr.write(f"[index] {e}\n")
        fts_hits = set()

    matched_ids = fast_ids | {sid for (_, sid) in fts_hits}
    return [c for c in cards if c["session_id"] in matched_ids]
