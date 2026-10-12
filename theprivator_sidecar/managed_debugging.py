"""Discover human-operated managed browsers on a private, nonzero CDP port."""

from __future__ import annotations

import os
from pathlib import Path
import tempfile
import time
from urllib.parse import urlsplit

import psutil
import requests

from .cdp import CdpEndpoint, DEVTOOLS_ACTIVE_PORT_FILE, _validate_loopback_browser_ws_url
from .protocol import IDENTITY_CDP_FAILED, SidecarError


def _owns_listener(process: psutil.Process, port: int) -> bool:
    """A port reservation can race; never attach to another program's socket."""
    if not process.is_running():
        return False
    try:
        candidates = [process, *process.children(recursive=True)]
    except psutil.NoSuchProcess:
        return False
    for candidate in candidates:
        try:
            # connections() supports the declared psutil >=5.9 dependency too.
            connections = getattr(candidate, "net_connections", candidate.connections)(kind="tcp")
            if any(
                connection.status == psutil.CONN_LISTEN
                and connection.laddr.port == port
                and connection.laddr.ip == "127.0.0.1"
                for connection in connections
            ):
                return True
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return False


def discover_managed_endpoint(
    user_data_dir: str | Path,
    *,
    debugging_port: int,
    browser_pid: int,
    timeout_seconds: float = 10.0,
) -> CdpEndpoint:
    """Validate ownership, then publish the usual profile-scoped discovery file.

    Chromium only writes DevToolsActivePort when started with port zero. Keep
    the existing discovery contract for later audits/automation attachments,
    without setting the automation launch flag for an ordinary desktop launch.
    No fallback to an unverified listener or automation flags is permitted.
    """
    temporary: str | None = None
    try:
        if type(debugging_port) is not int or not 1 <= debugging_port <= 65535:
            raise ValueError("invalid port")
        process = psutil.Process(browser_pid)
        deadline = time.monotonic() + timeout_seconds
        with requests.Session() as http:
            http.trust_env = False
            while True:
                if not process.is_running():
                    raise ValueError("browser exited")
                if _owns_listener(process, debugging_port):
                    try:
                        response = http.get(
                            f"http://127.0.0.1:{debugging_port}/json/version",
                            timeout=max(0.001, min(1.0, deadline - time.monotonic())),
                            allow_redirects=False,
                        )
                        if response.status_code != 200:
                            raise ValueError("unexpected status")
                        payload = response.json()
                        url = payload["webSocketDebuggerUrl"]
                        _validate_loopback_browser_ws_url(url, expected_port=debugging_port)
                        parsed = urlsplit(url)
                        if parsed.query or parsed.fragment or parsed.hostname != "127.0.0.1":
                            raise ValueError("unexpected endpoint")
                        if not _owns_listener(process, debugging_port):
                            raise ValueError("listener ownership changed")
                        endpoint = CdpEndpoint(debugging_port, parsed.path, url)
                        break
                    except requests.RequestException:
                        pass
                if time.monotonic() >= deadline:
                    raise TimeoutError("browser listener not ready")
                time.sleep(0.05)

        descriptor, temporary = tempfile.mkstemp(prefix=".DevToolsActivePort-", dir=user_data_dir)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(f"{endpoint.port}\n{endpoint.browser_target_path}\n")
        os.replace(temporary, Path(user_data_dir) / DEVTOOLS_ACTIVE_PORT_FILE)
        temporary = None
        return endpoint
    except Exception as exc:
        raise SidecarError(code=IDENTITY_CDP_FAILED, message="Identity CDP operation failed.") from exc
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)
