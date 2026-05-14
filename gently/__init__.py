"""Gently — zero-dependency local console for Claude/Codex/Gemini session history.

Public surface lives in submodules:
    gently.server    — HTTP handler, static serving, entrypoint (`main`)
    gently.tmux      — TmuxManager + `tmux_manager` singleton
    gently.providers — per-provider scanners/getters + shared PROVIDERS dict
    gently.util      — shared filesystem/json helpers
"""
