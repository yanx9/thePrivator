"""Keep identity emulation attached for the lifetime of its browser.

CDP overrides belong to a session and disappear on detach. This private worker
owns one browser connection and configures page/iframe sessions before resuming
new targets. Configuration arrives over stdin, never argv or persistent files.
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from typing import Any, Mapping

from .protocol import IDENTITY_CDP_FAILED, SidecarError


def _error():
    return SidecarError(code=IDENTITY_CDP_FAILED, message="The managed browser identity session could not be maintained.")


def start_identity_session(endpoint, overrides: Mapping[str, Any], *, timeout_seconds=10.0):
    from .cdp import _validate_loopback_browser_ws_url
    url = endpoint.web_socket_debugger_url
    _validate_loopback_browser_ws_url(url)
    command = [sys.executable]
    if not getattr(sys, 'frozen', False):
        command += ['-m', 'theprivator_sidecar']
    command += ['identity-session']
    environment = os.environ.copy()
    if getattr(sys, 'frozen', False):
        # This worker outlives the requesting pooled sidecar. Give it its own
        # extracted runtime instead of reusing a parent's temporary directory.
        environment['PYINSTALLER_RESET_ENVIRONMENT'] = '1'
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True,
                               env=environment,
                               start_new_session=os.name != 'nt',
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    result = queue.Queue(maxsize=1)
    def read_ready():
        try:
            result.put(process.stdout.readline())
        finally:
            process.stdout.close()
    threading.Thread(target=read_ready, daemon=True).start()
    try:
        with process.stdin as stream:
            stream.write(json.dumps({'endpoint': url, 'overrides': dict(overrides)}) + '\n')
        if result.get(timeout=timeout_seconds).strip() != 'ready' or process.poll() is not None:
            raise _error()
    except Exception as exc:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
        raise _error() from exc
    # Reap the child without keeping the requesting sidecar alive.
    threading.Thread(target=process.wait, daemon=True).start()
    return {'applied': list(overrides)}


def emulation_commands(overrides, target_type='page'):
    commands = []
    for key, method in [('userAgent', 'Emulation.setUserAgentOverride'),
                        ('deviceMetrics', 'Emulation.setDeviceMetricsOverride'),
                        ('timezone', 'Emulation.setTimezoneOverride'),
                        ('locale', 'Emulation.setLocaleOverride'),
                        ('geolocation', 'Emulation.setGeolocationOverride')]:
        # Chromium owns viewport geometry on the top-level target. OOPIFs
        # inherit it; sending this command to an iframe is a protocol error.
        if key == 'deviceMetrics' and target_type != 'page':
            continue
        if key in overrides:
            commands.append((method, overrides[key]))
    return commands


class IdentitySession:
    def __init__(self, socket, overrides, ready):
        self.socket = socket
        self.overrides = overrides
        self.ready = ready
        self.sequence = 0
        self.pending = {}
        self.last_progress = time.monotonic()
        self.sessions = set()
        self.completed = set()
        self.root_ready = False
        self.announced = False

    def send(self, method, params, session=None, kind='setup'):
        self.sequence += 1
        payload = {'id': self.sequence, 'method': method, 'params': params}
        if session:
            payload['sessionId'] = session
        self.pending[self.sequence] = (session, kind, method)
        self.socket.send(json.dumps(payload))

    def auto_attach(self, session=None):
        self.send('Target.setAutoAttach', {
            'autoAttach': True, 'waitForDebuggerOnStart': True, 'flatten': True,
            'filter': [{'type': 'page'}, {'type': 'iframe'}, {'exclude': True}],
        }, session, 'setup' if session else 'root')

    def handle(self, event):
        self.last_progress = time.monotonic()
        method = event.get('method')
        if method == 'Target.attachedToTarget':
            session = event['params']['sessionId']
            self.sessions.add(session)
            target_type = event['params'].get('targetInfo', {}).get('type', 'page')
            for name, params in emulation_commands(self.overrides, target_type):
                self.send(name, params, session)
            self.auto_attach(session)
        elif method == 'Target.detachedFromTarget':
            session = event['params']['sessionId']
            self.sessions.discard(session)
            self.completed.discard(session)
            self.pending = {key: value for key, value in self.pending.items() if value[0] != session}
        elif 'id' in event:
            pending = self.pending.pop(event['id'], None)
            if pending is None:
                return
            session, kind, command = pending
            if 'error' in event:
                # A tab closed while its setup commands were in flight.
                if session and session not in self.sessions:
                    return
                error = event['error']
                # Locale is renderer-wide. A sibling session from this same
                # immutable profile may already own the identical override.
                shared_locale = (command == 'Emulation.setLocaleOverride'
                                 and error.get('code') == -32000
                                 and error.get('message') == 'Another locale override is already in effect')
                target_gone = (session and (
                    error.get('code') == -32001
                    or (error.get('code') == -32000 and error.get('message') in (
                        'Not attached to an active page', 'No target with given id found'))))
                if target_gone:
                    self.sessions.discard(session)
                    self.completed.discard(session)
                    self.pending = {key: value for key, value in self.pending.items() if value[0] != session}
                    return
                if not shared_locale:
                    raise _error()
            if kind == 'root':
                self.root_ready = True
            elif kind == 'resume':
                self.completed.add(session)
            elif session and not any(s == session for s, _, _ in self.pending.values()):
                self.send('Runtime.runIfWaitingForDebugger', {}, session, 'resume')
        if self.root_ready and self.completed and not self.pending and not self.announced:
            self.announced = True
            self.ready()


def worker_main():
    import websocket
    from .cdp import _validate_loopback_browser_ws_url
    socket = None
    try:
        payload = json.loads(sys.stdin.readline())
        url = payload['endpoint']
        _validate_loopback_browser_ws_url(url)
        socket = websocket.create_connection(url, timeout=10, suppress_origin=True)
        session = IdentitySession(socket, payload['overrides'], lambda: print('ready', flush=True))
        session.auto_attach()
        socket.settimeout(1)
        while True:
            try:
                raw = socket.recv()
            except websocket.WebSocketTimeoutException:
                if session.pending and time.monotonic() - session.last_progress > 10:
                    raise _error()
                continue
            if not raw:
                return 0
            session.handle(json.loads(raw))
    except websocket.WebSocketConnectionClosedException:
        return 0
    except Exception:
        # Never silently continue browsing after identity setup has failed.
        if socket:
            try:
                socket.send(json.dumps({'id': 2147483647, 'method': 'Browser.close'}))
            except Exception:
                pass
        return 1
    finally:
        if socket:
            socket.close()
