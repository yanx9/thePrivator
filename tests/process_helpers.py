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


def wait_for_document(client, url: str) -> None:
    """Page.navigate acknowledges navigation before document-start scripts run."""
    from theprivator_sidecar.cdp import runtime_evaluate
    from theprivator_sidecar.protocol import SidecarError

    deadline = time.monotonic() + 5
    state = None
    while time.monotonic() < deadline:
        try:
            state = runtime_evaluate(client, '({url:location.href,ready:document.readyState})', timeout_seconds=1)
            if state == {'url': url, 'ready': 'complete'}:
                return
        except SidecarError:
            # The previous execution context can disappear during navigation.
            pass
        time.sleep(0.01)
    raise AssertionError(f'Navigation did not finish within 5 seconds: {state}')
