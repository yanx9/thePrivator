"""Opt-in real browser smoke: THEPRIVATOR_COOKIE_BOT_SMOKE=1 python -m unittest tests.test_cookie_bot_smoke -v.

Only synthetic profiles and a loopback HTTP fixture are used. Optional
THEPRIVATOR_TEST_SIDECAR points to the built executable to prove frozen dispatch.
"""
import json
from contextlib import closing
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from theprivator_sidecar import chromium, cdp
from theprivator_sidecar.profiles import ProfileStore


@unittest.skipUnless(os.getenv('THEPRIVATOR_COOKIE_BOT_SMOKE') == '1', 'Opt-in Chromium smoke')
class BrowserSmoke(unittest.TestCase):
    def test_real_worker_visits_bounded_links_and_persists_cookies(self):
        visits = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                visits.append(self.path)
                body = b'<a href="/article">Article</a><a href="/second">Second</a><a href="/logout">Logout</a><a href="http://localhost:1/outside">Outside</a><a href="javascript:alert(1)">Unsafe</a><form><button>Buy</button></form>'
                self.send_response(200)
                self.send_header('Content-Type', 'text/html')
                self.send_header('Content-Length', str(len(body)))
                if self.path in ('/', '/article'):
                    name = 'fixture_root' if self.path == '/' else 'fixture_article'
                    self.send_header('Set-Cookie', name + '=retained; Max-Age=3600; Path=/; SameSite=Lax')
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, format, *args): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory(prefix='theprivator-cookie-bot-smoke-') as root:
                store = ProfileStore(root)
                profile_id = store.create('Synthetic Cookie Bot Smoke')['profile']['id']
                store.update_launch(profile_id, {'startupBehavior': 'customUrls', 'startUrls': ['about:blank'], 'args': ['--password-store=basic', '--disable-gpu']})
                executable = os.getenv('THEPRIVATOR_TEST_SIDECAR')
                args = [executable] if executable else [sys.executable, '-m', 'theprivator_sidecar']
                def call(method, params):
                    result = subprocess.run(args, input=json.dumps({'id': 'fixture', 'method': method, 'params': params})+'\n', text=True, capture_output=True, timeout=20, check=True)
                    envelope = json.loads(result.stdout.strip())
                    self.assertTrue(envelope['ok'], envelope)
                    return envelope['result']
                params = {'storeRoot': root, 'profileId': profile_id}
                try:
                    started = time.monotonic()
                    result = call('cookieBot.start', {**params, 'config': {'urls': [f'http://127.0.0.1:{server.server_port}/'], 'maxPages': 2, 'maxDepth': 1, 'dwellSeconds': 1, 'maxDurationSeconds': 30, 'closeAfterCompletion': True}})
                    self.assertLess(time.monotonic() - started, 10)
                    job = result['job']
                    deadline = time.monotonic() + 60
                    while time.monotonic() < deadline:
                        job = call('cookieBot.status', params)['job']
                        if job['status'] not in ('queued', 'running', 'cancelling'):
                            break
                        time.sleep(.2)
                    self.assertEqual(job['status'], 'completed', job)
                    self.assertEqual(job['visitedPages'], 2, job)
                    self.assertEqual(job['failedPages'], 0, job)
                    self.assertEqual(job['stopReason'], 'page-limit')
                    self.assertEqual(chromium.status(root)['runningCount'], 0)
                    document_visits = [p for p in visits if p != '/favicon.ico']
                    self.assertEqual(document_visits, ['/', '/article'])
                    user_data = chromium.resolve_user_data_path(root, store.get(profile_id))
                    db = next(p for p in [user_data/'Default'/'Cookies', user_data/'Default'/'Network'/'Cookies'] if p.exists())
                    with closing(sqlite3.connect(db)) as connection:
                        names = {row[0] for row in connection.execute('SELECT name FROM cookies')}
                    self.assertTrue({'fixture_root', 'fixture_article'} <= names, names)
                    # A fresh browser process must recover values from this profile.
                    reopened = call('cookieBot.start', {**params, 'config': {'urls': [f'http://127.0.0.1:{server.server_port}/check'], 'maxPages': 1, 'dwellSeconds': 1, 'closeAfterCompletion': False}})['job']
                    deadline = time.monotonic() + 30
                    while reopened['status'] in ('queued', 'running', 'cancelling') and time.monotonic() < deadline:
                        time.sleep(.1)
                        reopened = call('cookieBot.status', params)['job']
                    self.assertEqual(reopened['status'], 'completed', reopened)
                    endpoint = cdp.discover_devtools_endpoint(user_data)
                    with cdp.CdpClient(endpoint.web_socket_debugger_url) as client:
                        persisted = {c['name']: c['value'] for c in client.command('Storage.getCookies')['cookies']}
                    self.assertEqual(persisted['fixture_root'], 'retained')
                    self.assertEqual(persisted['fixture_article'], 'retained')
                    # Reuse this running instance, cancel during dwell, and keep
                    # it open. Polls are independent short-lived sidecars.
                    second = call('cookieBot.start', {**params, 'config': {'urls': [f'http://127.0.0.1:{server.server_port}/'], 'maxPages': 10, 'dwellSeconds': 30, 'maxDurationSeconds': 60, 'closeAfterCompletion': False}})['job']
                    active = second
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline:
                        active = call('cookieBot.status', params)['job']
                        if active['currentUrl']:
                            break
                        time.sleep(.1)
                    self.assertEqual(active['status'], 'running', active)
                    cancelled_at = time.monotonic()
                    cancelled = call('cookieBot.cancel', {**params, 'jobId': second['jobId']})['job']
                    call('health.status', {})
                    while time.monotonic() - cancelled_at < 15:
                        cancelled = call('cookieBot.status', params)['job']
                        if cancelled['status'] not in ('running', 'queued', 'cancelling'):
                            break
                        time.sleep(.1)
                    self.assertEqual(cancelled['status'], 'cancelled', cancelled)
                    self.assertEqual(chromium.status(root)['runningCount'], 1)
                    print(json.dumps({'smoke': 'cookie-bot', 'packaged': bool(executable), 'visited': document_visits, 'persistedAfterRelaunch': sorted(persisted), 'status': job['status'], 'cancelStatus': cancelled['status'], 'keptBrowserOpen': True}))
                finally:
                    chromium.stop(root, profile_id)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
