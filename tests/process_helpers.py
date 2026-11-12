"""Bounded synchronization for tests that launch a separate browser stub."""

import json
from pathlib import Path
import time


def read_captured_argv(path: Path) -> list[str]:
    deadline = time.monotonic() + 5
    while True:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            if time.monotonic() >= deadline:
                raise AssertionError("Browser stub did not capture its arguments in 5 seconds")
            time.sleep(0.01)
