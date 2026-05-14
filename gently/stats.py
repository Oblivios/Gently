"""Process-level telemetry. Currently only tracks the server's start time for
uptime display in the TUI."""

from __future__ import annotations

import time

_STARTED = time.time()


def uptime_seconds() -> float:
    return max(0.0, time.time() - _STARTED)
