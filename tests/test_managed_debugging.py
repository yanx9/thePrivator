"""Listener ownership and real desktop launch regressions (no external accounts)."""
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from theprivator_sidecar import managed_debugging as debugging
from theprivator_sidecar.protocol import SidecarError


class Process:
    def is_running(self):
        return True


def test_discovery_never_contacts_an_unowned_listener(tmp_path, monkeypatch):
    monkeypatch.setattr(debugging.psutil, "Process", lambda pid: Process())
    monkeypatch.setattr(debugging, "_owns_listener", lambda *args: False)
    def unexpected(*args, **kwargs):
        pytest.fail("must not contact a listener owned by another process")
    monkeypatch.setattr(debugging.requests.Session, "get", unexpected)
    with pytest.raises(SidecarError) as error:
        debugging.discover_managed_endpoint(tmp_path, debugging_port=23456, browser_pid=123, timeout_seconds=0)
    assert error.value.code == "IDENTITY_CDP_FAILED"
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("url", ["ws://127.0.0.1:23456/devtools/browser/test", "ws://example.com:23456/devtools/browser/test"])
def test_discovery_validates_and_publishes_only_loopback_endpoint(tmp_path, monkeypatch, url):
    monkeypatch.setattr(debugging.psutil, "Process", lambda pid: Process())
    monkeypatch.setattr(debugging, "_owns_listener", lambda *args: True)
    def get(session, address, **kwargs):
        assert session.trust_env is False
        assert kwargs["allow_redirects"] is False
        return SimpleNamespace(status_code=200, json=lambda: {"webSocketDebuggerUrl": url})
    monkeypatch.setattr(debugging.requests.Session, "get", get)
    if "example.com" in url:
        with pytest.raises(SidecarError):
            debugging.discover_managed_endpoint(tmp_path, debugging_port=23456, browser_pid=123)
        assert not list(tmp_path.iterdir())
    else:
        endpoint = debugging.discover_managed_endpoint(tmp_path, debugging_port=23456, browser_pid=123)
        assert endpoint.web_socket_debugger_url == url
        assert (tmp_path / "DevToolsActivePort").read_text() == "23456\n/devtools/browser/test\n"


def test_user_cannot_supply_debugging_port():
    from theprivator_sidecar.launch_args import validate_user_launch_args
    with pytest.raises(SidecarError):
        validate_user_launch_args(["--remote-debugging-port=9222"])


@pytest.mark.skipif(
    not os.environ.get("THEPRIVATOR_TEST_HEADED_CHROMIUM"),
    reason="requires explicit headed Chromium and a display",
)
@pytest.mark.parametrize("preset", ["windows-10-chrome-120", "macos-ventura-chrome-120"])
def test_desktop_generated_launch_preserves_identity_without_automation_flag(tmp_path, preset):
    from theprivator_sidecar import chromium
    from theprivator_sidecar.profiles import ProfileStore
    from theprivator_sidecar.identity import curated_preset
    from theprivator_sidecar.cdp import (
        CdpClient, discover_devtools_endpoint, discover_page_target_endpoint,
        create_page_target_endpoint, runtime_evaluate, page_navigate,
    )
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            if self.path.startswith("/child"):
                content = "<script>parent.postMessage({webdriver:navigator.webdriver,platform:navigator.platform},'*')</script>"
            else:
                content = f"<script>window.childResult=null;addEventListener('message',e=>childResult=e.data)</script><iframe src='http://localhost:{self.server.server_port}/child'></iframe>"
            self.wfile.write(content.encode())
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    store = ProfileStore(tmp_path)
    profile = store.create("Generated launch regression")["profile"]
    identity = curated_preset(preset)
    # Match API generation: retain the generated surfaces, replace UA/version.
    identity["presetId"] = None
    identity["browser"]["userAgent"] = identity["browser"]["userAgent"].replace("Chrome/120.", "Chrome/141.")
    store.update_identity(profile["id"], identity)
    environment = dict(os.environ, THEPRIVATOR_CHROMIUM_PATH=os.environ["THEPRIVATOR_TEST_HEADED_CHROMIUM"])
    binary = os.environ.get("THEPRIVATOR_TEST_IDENTITY_BINARY")
    command = [binary] if binary else [sys.executable, "-m", "theprivator_sidecar"]
    request = {"id": "headed-regression", "method": "chromium.launch", "params": {"storeRoot": str(tmp_path), "profileId": profile["id"]}}
    try:
        completed = subprocess.run(command, input=json.dumps(request) + "\n", text=True, capture_output=True, env=environment, timeout=30)
        assert completed.returncode == 0
        response = json.loads(completed.stdout)
        assert "error" not in response, response
        endpoint = discover_devtools_endpoint(tmp_path / profile["storage"]["userDataDir"])
        for target in [discover_page_target_endpoint(endpoint), create_page_target_endpoint(endpoint)]:
            with CdpClient(target.web_socket_debugger_url) as client:
                for suffix in ["/", "/?reload"]:
                    page_navigate(client, f"http://127.0.0.1:{server.server_port}{suffix}")
                    observed = runtime_evaluate(client, "({webdriver:navigator.webdriver,platform:navigator.platform,ua:navigator.userAgent})")
                    assert observed == {"webdriver": False, "platform": identity["navigator"]["platform"], "ua": identity["browser"]["userAgent"]}
                    child = runtime_evaluate(client, "new Promise(resolve=>{if(window.childResult)return resolve(childResult);addEventListener('message',e=>resolve(e.data),{once:true});setTimeout(()=>resolve(null),3000)})")
                    assert child == {"webdriver": False, "platform": identity["navigator"]["platform"]}
                    assert chromium.status(tmp_path)["runningCount"] == 1
        assert store.get(profile["id"]).identity == identity
    finally:
        chromium.stop(tmp_path, profile["id"])
        server.shutdown()
        server.server_close()
