import json
import os
import subprocess
from pathlib import Path

import pytest

from theprivator_sidecar.identity_session import IdentitySession, start_identity_session, emulation_commands
from theprivator_sidecar.protocol import SidecarError


class Socket:
    def __init__(self):
        self.sent = []
    def send(self, value):
        self.sent.append(json.loads(value))


def test_new_target_resumes_only_after_all_overrides_are_acknowledged():
    socket = Socket()
    ready = []
    session = IdentitySession(socket, {'timezone': {'timezoneId': 'Pacific/Honolulu'}}, lambda: ready.append(True))
    session.auto_attach()
    session.handle({'id': 1, 'result': {}})
    session.handle({'method': 'Target.attachedToTarget', 'params': {'sessionId': 'page'}})
    assert [item['method'] for item in socket.sent] == ['Target.setAutoAttach', 'Emulation.setTimezoneOverride', 'Target.setAutoAttach']
    session.handle({'id': 2, 'result': {}})
    assert not ready
    session.handle({'id': 3, 'result': {}})
    assert socket.sent[-1]['method'] == 'Runtime.runIfWaitingForDebugger'
    session.handle({'id': 4, 'result': {}})
    assert ready == [True]
    session.handle({'method': 'Target.attachedToTarget', 'params': {'sessionId': 'popup'}})
    assert socket.sent[-2]['sessionId'] == 'popup'
    assert socket.sent[-2]['method'] == 'Emulation.setTimezoneOverride'


def test_iframe_inherits_top_level_viewport_but_keeps_other_overrides():
    overrides = {'deviceMetrics': {'width': 1280}, 'timezone': {'timezoneId': 'Pacific/Honolulu'}}
    assert ('Emulation.setDeviceMetricsOverride', overrides['deviceMetrics']) in emulation_commands(overrides, 'page')
    assert emulation_commands(overrides, 'iframe') == [('Emulation.setTimezoneOverride', overrides['timezone'])]
    socket = Socket()
    session = IdentitySession(socket, overrides, lambda: None)
    session.handle({'method': 'Target.attachedToTarget', 'params': {'sessionId': 'frame', 'targetInfo': {'type': 'iframe'}}})
    assert all(item['method'] != 'Emulation.setDeviceMetricsOverride' for item in socket.sent)


def test_closed_target_does_not_poison_remaining_sessions():
    socket = Socket()
    session = IdentitySession(socket, {'locale': {'locale': 'en-US'}}, lambda: None)
    session.handle({'method': 'Target.attachedToTarget', 'params': {'sessionId': 'closed'}})
    session.handle({'method': 'Target.detachedFromTarget', 'params': {'sessionId': 'closed'}})
    session.handle({'id': 1, 'error': {'message': 'target closed'}})
    assert not session.pending


def test_emulation_error_fails_instead_of_resuming_inconsistent_identity():
    socket = Socket()
    session = IdentitySession(socket, {'timezone': {'timezoneId': 'invalid'}}, lambda: None)
    session.handle({'method': 'Target.attachedToTarget', 'params': {'sessionId': 'page'}})
    with pytest.raises(SidecarError):
        session.handle({'id': 1, 'error': {'message': 'invalid timezone'}})
    assert all(item['method'] != 'Runtime.runIfWaitingForDebugger' for item in socket.sent)


@pytest.mark.skipif(not os.environ.get('THEPRIVATOR_TEST_CHROMIUM_PATH'), reason='requires explicit local Chromium integration test')
def test_real_chromium_retains_generated_identity_across_tabs_and_http(tmp_path, monkeypatch):
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from theprivator_sidecar.cdp import discover_devtools_endpoint, discover_page_target_endpoint, create_page_target_endpoint, CdpClient, runtime_evaluate, page_navigate
    from theprivator_sidecar.identity import curated_preset
    from theprivator_sidecar.identity_runtime import build_identity_runtime_plan
    from theprivator_sidecar.identity_extension import generate_identity_extension
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(dict(self.headers.items()))
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            if self.path == '/child':
                body = "<script>parent.postMessage({platform:navigator.platform,tz:Intl.DateTimeFormat().resolvedOptions().timeZone}, '*')</script>"
            else:
                body = f"<script>window.frameResult=null;addEventListener('message',e=>window.frameResult=e.data)</script><iframe src='http://localhost:{self.server.server_port}/child'></iframe>"
            self.wfile.write(body.encode())
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_port}/'
    identity = curated_preset('windows-10-chrome-120')
    plan = build_identity_runtime_plan(identity)
    extension = generate_identity_extension(tmp_path / 'extensions', 'test', plan)
    browser = subprocess.Popen([os.environ['THEPRIVATOR_TEST_CHROMIUM_PATH'], '--headless=new', '--no-sandbox', '--site-per-process', '--remote-debugging-port=0', '--remote-allow-origins=*', f'--user-data-dir={tmp_path / "browser"}', f'--load-extension={extension.extension_dir}', f'--disable-extensions-except={extension.extension_dir}', *plan.launch_flags, 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        endpoint = discover_devtools_endpoint(tmp_path / 'browser', timeout_seconds=10)
        with monkeypatch.context() as worker_environment:
            binary = os.environ.get('THEPRIVATOR_TEST_IDENTITY_BINARY')
            if binary:
                import sys
                worker_environment.setattr(sys, 'frozen', True, raising=False)
                worker_environment.setattr(sys, 'executable', binary)
            start_identity_session(endpoint, plan.cdp_overrides)
        for target in [discover_page_target_endpoint(endpoint), create_page_target_endpoint(endpoint)]:
            with CdpClient(target.web_socket_debugger_url) as client:
                page_navigate(client, url)
                result = runtime_evaluate(client, '({ua:navigator.userAgent,platform:navigator.platform,tz:Intl.DateTimeFormat().resolvedOptions().timeZone})')
                assert result == {'ua': identity['browser']['userAgent'], 'platform': 'Win32', 'tz': identity['locale']['timezoneId']}
                frame = runtime_evaluate(client, "new Promise(resolve => {if(window.frameResult) return resolve(window.frameResult);addEventListener('message', e => resolve(e.data), {once:true});setTimeout(()=>resolve(null),3000)})")
                assert frame == {'platform': 'Win32', 'tz': identity['locale']['timezoneId']}
                assert browser.poll() is None
                # Reload re-creates renderer/frame targets and must also survive.
                page_navigate(client, url + '?reload')
                frame = runtime_evaluate(client, "new Promise(resolve => {if(window.frameResult) return resolve(window.frameResult);addEventListener('message', e => resolve(e.data), {once:true});setTimeout(()=>resolve(null),3000)})")
                assert frame == {'platform': 'Win32', 'tz': identity['locale']['timezoneId']}
                assert browser.poll() is None
            # Closing an unrelated evaluation client must not clear identity.
            with CdpClient(target.web_socket_debugger_url) as client:
                assert runtime_evaluate(client, 'navigator.platform') == 'Win32'
        assert requests
        for headers in requests:
            lowered = {k.lower(): v for k, v in headers.items()}
            assert lowered['user-agent'] == identity['browser']['userAgent']
            assert lowered['sec-ch-ua-platform'] == '"Windows"'
            assert '"120"' in lowered['sec-ch-ua']
    finally:
        browser.terminate()
        browser.wait(timeout=10)
        server.shutdown()
        server.server_close()


def test_shared_renderer_locale_reply_still_resumes_target():
    socket = Socket()
    session = IdentitySession(socket, {'locale': {'locale': 'en-US'}}, lambda: None)
    session.handle({'method': 'Target.attachedToTarget', 'params': {'sessionId': 'frame', 'targetInfo': {'type': 'iframe'}}})
    session.handle({'id': 1, 'error': {'code': -32000, 'message': 'Another locale override is already in effect'}})
    session.handle({'id': 2, 'result': {}})
    assert socket.sent[-1]['method'] == 'Runtime.runIfWaitingForDebugger'


def test_target_closed_error_can_arrive_before_detach_event():
    socket = Socket()
    session = IdentitySession(socket, {'locale': {'locale': 'en-US'}}, lambda: None)
    session.handle({'method': 'Target.attachedToTarget', 'params': {'sessionId': 'closed'}})
    session.handle({'id': 1, 'error': {'code': -32001, 'message': 'Session with given id not found.'}})
    assert not session.pending
    assert 'closed' not in session.sessions
