"""Gently — a zero-dependency local console for agent session history.

This file is a launcher; the implementation lives in the `gently` package:

    gently.server    — HTTP handler + entrypoint (`main`)
    gently.tmux      — tmux bridge (spawn agents, stream logs, send input)
    gently.providers — per-provider scanners/getters (claude, codex, gemini)
    gently.util      — shared filesystem/json helpers

Run: `python3 app.py` then open http://127.0.0.1:8765.
(`--open` to auto-open the browser, `--port N` to pick a different port.)
"""

from __future__ import annotations

import sys

from gently.server import main

if __name__ == "__main__":
    sys.exit(main())
