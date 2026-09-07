"""Bounded, navigation-only cookie browsing in a real stored Chromium profile.

No cookies are fabricated and no controls are clicked. Public sites decide
whether they set cookies; consent walls are deliberately left untouched.
"""
from __future__ import annotations

import re
import json
import os
import time
import uuid
from pathlib import Path
from collections import deque

from . import chromium, cdp
from .profiles import utc_now_iso
from urllib.parse import urljoin, urlsplit, urlunsplit, unquote

from .protocol import SidecarError

DEFAULT_URLS = ('https://www.wikipedia.org/', 'https://www.bbc.com/', 'https://www.mozilla.org/')
DEFAULT_CONFIG = {'maxPages': 10, 'maxDepth': 1, 'dwellSeconds': 5,
                  'maxDurationSeconds': 120, 'closeAfterCompletion': False}
_ACTION = re.compile(r'login|log[-_]?out|sign[-_]?(?:in|out|up)|register|account|auth|checkout|cart|buy|purchase|order|delete|remove|unsubscribe|consent|accept|confirm|download|payment', re.I)


def _error(message, code='COOKIE_BOT_INVALID_CONFIG'):
    return SidecarError(code=code, message=message)


def validate_url(value):
    if not isinstance(value, str) or not value or len(value) > 2048 or any(ord(c) < 33 for c in value) or '\\' in value:
        raise _error('URLs must be absolute HTTP or HTTPS addresses without credentials or whitespace.')
    try:
        parts = urlsplit(value)
        if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username is not None or parts.password is not None:
            raise ValueError()
        _ = parts.port
    except ValueError:
        raise _error('URLs must be absolute HTTP or HTTPS addresses without credentials.') from None
    return urlunsplit((parts.scheme, parts.netloc, parts.path or '/', parts.query, ''))


def validate_config(value):
    if not isinstance(value, dict) or set(value) - {'urls', *DEFAULT_CONFIG}:
        raise _error('Unknown cookie bot configuration field.')
    urls = value.get('urls', list(DEFAULT_URLS))
    if not isinstance(urls, list) or not 1 <= len(urls) <= 25:
        raise _error('Provide between 1 and 25 URLs, or omit URLs to use the displayed defaults.')
    config = {**DEFAULT_CONFIG, **value, 'urls': list(dict.fromkeys(validate_url(url) for url in urls))}
    for key, low, high in [('maxPages', 1, 50), ('maxDepth', 0, 2), ('dwellSeconds', 1, 30), ('maxDurationSeconds', 10, 600)]:
        if type(config[key]) is not int or not low <= config[key] <= high:
            raise _error(f'{key} must be an integer between {low} and {high}.')
    if type(config['closeAfterCompletion']) is not bool:
        raise _error('closeAfterCompletion must be a boolean.')
    return config


def safe_links(base, links):
    """Conservative crawl: exact origin, no queries/actions/files or controls."""
    origin = urlsplit(validate_url(base))
    result = []
    for raw in links[:500]:
        try:
            url = validate_url(urljoin(base, raw))
            parts = urlsplit(url)
            path = unquote(parts.path)
            if (parts.scheme, parts.netloc) != (origin.scheme, origin.netloc) or parts.query or _ACTION.search(path):
                continue
            if re.search(r'\.[a-z0-9]{1,8}$', path, re.I) and not path.lower().endswith(('.html', '.htm')):
                continue
            if url not in result:
                result.append(url)
        except (SidecarError, TypeError, ValueError):
            continue
    return result


def _now():
    return utc_now_iso()


def new_job(profile_id, config):
    return {'jobId': uuid.uuid4().hex, 'profileId': profile_id, 'status': 'queued',
            'config': validate_config(config), 'createdAt': _now(), 'finishedAt': None,
            'currentUrl': None, 'visitedPages': 0, 'failedPages': 0, 'errors': [], 'stopReason': None}


def _write(path, value):
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as handle:
            json.dump(value, handle)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def cancel_path(path, job_id):
    return path.with_name(path.stem + '.' + job_id + '.cancel')


def _wait(seconds, cancelled):
    deadline = time.monotonic() + max(0, seconds)
    while time.monotonic() < deadline:
        if cancelled():
            return True
        time.sleep(min(0.1, max(0, deadline - time.monotonic())))
    return cancelled()


def _connect_profile(root, profile_id, close_after=False):
    profile = chromium._load_profile(root, profile_id)
    running = next((p for p in chromium.status(root)['profiles'] if p['profileId'] == profile_id), None)
    launched = running is None
    if launched:
        running = chromium.launch_for_automation(root, profile_id)
    try:
        endpoint = cdp.discover_devtools_endpoint(chromium.resolve_user_data_path(root, profile), timeout_seconds=5, http_timeout_seconds=2)
    except SidecarError:
        if launched and close_after:
            _close_profile_if_same(root, profile_id, running['startedAt'])
        raise _error('Cannot connect to this profile. Stop it and retry the cookie bot.', 'COOKIE_BOT_CDP_UNAVAILABLE') from None
    return endpoint, running['startedAt']


def _close_profile_if_same(root, profile_id, started_at):
    running = next((p for p in chromium.status(root)['profiles'] if p['profileId'] == profile_id), None)
    if running and running['startedAt'] == started_at:
        # SIGTERM alone can lose Chromium's recently buffered cookie writes.
        # Ask Chromium to shut down normally first, then let the existing stop
        # lifecycle reconcile its registry and authenticated proxy bridge.
        try:
            profile = chromium._load_profile(root, profile_id)
            endpoint = cdp.discover_devtools_endpoint(chromium.resolve_user_data_path(root, profile), timeout_seconds=2, http_timeout_seconds=1)
            with cdp.CdpClient(endpoint.web_socket_debugger_url, timeout_seconds=2) as client:
                client.command('Browser.close')
        except Exception:
            pass  # Chrome may close the WebSocket before acknowledging close.
        deadline = time.monotonic() + 5
        while chromium.is_process_alive(running['pid']) and time.monotonic() < deadline:
            time.sleep(.1)
        # Recheck identity after waiting: never stop a user-relaunched instance.
        current = next((p for p in chromium.status(root)['profiles'] if p['profileId'] == profile_id), None)
        if current and current['startedAt'] == started_at:
            chromium.stop(root, profile_id)


_CAPTURE_LINKS = """(() => ({url: location.href, readyState: document.readyState, links: Array.from(document.querySelectorAll('a[href]')).filter(a => !a.hasAttribute('download') && !a.closest('form') && (!a.getAttribute('role') || a.getAttribute('role') === 'link')).slice(0, 500).map(a => a.href)}))()"""


def _inspect_page(client, dwell, deadline, cancelled, follow_links):
    """Wait for a usable DOM, then dwell; bounded grace for hydrated links.

    Navigation commits before asynchronous rendering necessarily completes.
    Never click controls, wait for network-idle, or retry navigation itself.
    """
    load_deadline = min(deadline, time.monotonic() + 10)
    ready_at = None
    capture = None
    while not cancelled() and time.monotonic() < deadline:
        now = time.monotonic()
        try:
            candidate = cdp.runtime_evaluate(client, _CAPTURE_LINKS,
                timeout_seconds=min(1, max(.001, deadline - now)))
            if (isinstance(candidate, dict) and isinstance(candidate.get('links'), list)
                    and candidate.get('readyState') in ('interactive', 'complete')):
                validate_url(candidate.get('url'))  # Excludes about:blank/error pages.
                if capture is None or capture['url'] != candidate['url']:
                    ready_at = time.monotonic()
                capture = candidate
            else:
                capture = None
                ready_at = None
        except SidecarError:
            # Execution contexts can disappear during a redirect. Never reuse
            # a snapshot from the previous document after that transition.
            capture = None
            ready_at = None
        now = time.monotonic()
        if capture is not None and ready_at is not None:
            elapsed = now - ready_at
            if elapsed >= dwell and (not follow_links or safe_links(capture['url'], capture['links']) or elapsed >= dwell + 2):
                return capture
        if now >= load_deadline and capture is None:
            raise _error('Page did not become ready within the load limit.', 'COOKIE_BOT_NAVIGATION_FAILED')
        if _wait(min(.1, max(0, deadline - now)), cancelled):
            break
    return capture



def run_job(root, job, path):
    """Worker owns only its new tab; the selected profile owns every cookie."""
    config = job['config']
    marker = cancel_path(path, job['jobId'])
    cancelled = marker.exists
    endpoint = page = started_at = None
    deadline = time.monotonic() + config['maxDurationSeconds']
    try:
        if cancelled():
            job['status'] = 'cancelled'
            return
        job['status'] = 'running'
        _write(path, job)
        endpoint, started_at = _connect_profile(root, job['profileId'], config['closeAfterCompletion'])
        if cancelled():
            job['status'] = 'cancelled'
            return
        page = cdp.create_page_target_endpoint(endpoint, timeout_seconds=5, http_timeout_seconds=2)
        queue = deque((url, 0) for url in config['urls'])
        seen = set()
        attempts = 0
        while queue and attempts < config['maxPages'] and time.monotonic() < deadline and not cancelled():
            url, depth = queue.popleft()
            if url in seen:
                continue
            seen.add(url)
            attempts += 1
            job['currentUrl'] = url
            _write(path, job)
            try:
                # Our own strict http(s) validator permits custom HTTP sites as
                # well as HTTPS; the generic CDP audit helper is HTTPS-only.
                with cdp.CdpClient(page.web_socket_debugger_url, timeout_seconds=min(5, max(.001, deadline - time.monotonic()))) as client:
                    result = client.command('Page.navigate', {'url': validate_url(url)})
                    if result.get('errorText') or result.get('isDownload'):
                        raise _error('Page navigation failed.', 'COOKIE_BOT_NAVIGATION_FAILED')
                    capture = _inspect_page(client, config['dwellSeconds'], deadline, cancelled, depth < config['maxDepth'])
                    if capture is None:
                        continue
                    job['visitedPages'] += 1
                    # A redirect destination is already visited; don't queue it
                    # again when a child links back to the landing page.
                    seen.add(validate_url(capture['url']))
                    if not cancelled() and depth < config['maxDepth'] and time.monotonic() < deadline:
                        # Redirects must never widen the crawl boundary.
                        if isinstance(capture, dict) and isinstance(capture.get('links'), list):
                            final = urlsplit(validate_url(capture.get('url')))
                            original = urlsplit(url)
                            if (final.scheme, final.netloc) == (original.scheme, original.netloc):
                                queue.extend((link, depth + 1) for link in safe_links(capture['url'], capture['links'])[:config['maxPages']] if link not in seen)
            except Exception:
                job['failedPages'] += 1
                if len(job['errors']) < 10:
                    job['errors'].append('A page could not be loaded or inspected; continuing within limits.')
            _write(path, job)
        job['status'] = 'cancelled' if cancelled() else ('failed' if not job['visitedPages'] and job['failedPages'] else 'completed')
        job['stopReason'] = ('cancelled' if cancelled() else 'time-limit' if time.monotonic() >= deadline else 'page-limit' if attempts >= config['maxPages'] else 'queue-exhausted')
    except Exception as exc:
        job['status'] = 'cancelled' if cancelled() else 'failed'
        job['errors'].append(exc.message if isinstance(exc, SidecarError) else 'Cookie bot failed; check the profile browser and retry.')
    finally:
        if page is not None and endpoint is not None and page.target_id is not None:
            try:
                cdp.close_page_target(endpoint, page.target_id, timeout_seconds=3)
            except Exception:
                job['errors'].append('Could not close the bot tab; it may already be closed.')
        if started_at is not None and config['closeAfterCompletion']:
            try:
                _close_profile_if_same(root, job['profileId'], started_at)
            except Exception:
                job['errors'].append('Could not close the profile. Stop it manually.')
                job['status'] = 'failed'
        job['currentUrl'] = None
        job['finishedAt'] = _now()
        _write(path, job)
        marker.unlink(missing_ok=True)


# Files, not process globals: Rust's warm pool may send each poll to a different
# sidecar. A short OS lock serializes starts; browsing never holds a pool slot.
_ACTIVE = {'queued', 'running', 'cancelling'}


def _job_path(root, profile_id):
    import hashlib
    directory = Path(root) / 'profile-store' / 'runtime' / 'cookie-bot'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    return directory / (hashlib.sha256(profile_id.encode()).hexdigest() + '.json')


from contextlib import contextmanager


@contextmanager
def _command_lock(path):
    with path.with_suffix('.lock').open('a+b') as handle:
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        deadline = time.monotonic() + 2
        while True:
            try:
                if os.name == 'nt':
                    import msvcrt
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise _error('Cookie bot is busy; retry shortly.', 'COOKIE_BOT_BUSY') from None
                time.sleep(.02)
        try:
            yield
        finally:
            if os.name == 'nt':
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _read(path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        raise _error('Cookie bot state could not be read.', 'COOKIE_BOT_STATE_ERROR') from None


def _worker_alive(job):
    import psutil
    try:
        process = psutil.Process(job.get('_pid', 0))
        args = process.cmdline()
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE and 'cookie-bot-worker' in args and job['jobId'] in args
    except (psutil.Error, ValueError, TypeError):
        return False


def _public(job, path):
    if job is None:
        return {'job': None}
    result = json.loads(json.dumps({k: v for k, v in job.items() if not k.startswith('_')}))
    def redact(url):
        parts = urlsplit(url)
        return urlunsplit((parts.scheme, parts.netloc, parts.path, '', ''))
    result['config']['urls'] = [redact(url) for url in result['config']['urls']]
    if result['currentUrl']:
        result['currentUrl'] = redact(result['currentUrl'])
    if result['status'] in _ACTIVE and cancel_path(path, job['jobId']).exists():
        result['status'] = 'cancelling'
    return {'job': result}


def _spawn_worker(root, profile_id, job_id):
    import subprocess
    import threading
    # Frozen builds relaunch their own executable; source builds use -m.
    process = subprocess.Popen(chromium._sidecar_subprocess_args('cookie-bot-worker', job_id),
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        # A detached frozen worker must own its extraction directory, not depend
        # on a warm-pool parent's _MEIPASS that vanishes when that parent exits.
        env={**os.environ, 'PYINSTALLER_RESET_ENVIRONMENT': '1'},
        start_new_session=os.name != 'nt', close_fds=True,
        creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) if os.name == 'nt' else 0)
    try:
        assert process.stdin is not None
        process.stdin.write(json.dumps({'storeRoot': str(root), 'profileId': profile_id}).encode())
        process.stdin.close()
    except Exception:
        process.terminate()
        process.wait(timeout=5)
        raise
    threading.Thread(target=process.wait, daemon=True).start()
    return process.pid


def command(action, params):
    from .profiles import require_string_param
    if action == 'defaults':
        return {'config': validate_config({})}
    if action not in ('start', 'status', 'cancel'):
        raise _error('Unknown sidecar command.', 'UNKNOWN_COMMAND')
    root = require_string_param(params, 'storeRoot', 'Profile storeRoot is required.')
    profile_id = require_string_param(params, 'profileId', 'Profile id is required.')
    chromium._load_profile(root, profile_id)
    path = _job_path(root, profile_id)
    with _command_lock(path):
        job = _read(path)
        if job and job['status'] in _ACTIVE and not _worker_alive(job):
            job.update(status='failed', finishedAt=_now(), currentUrl=None, stopReason='worker-exited')
            job['errors'].append('Cookie bot worker exited unexpectedly. Check the profile and close it manually if needed.')
            _write(path, job)
        if action == 'start':
            config = validate_config(params.get('config', {}))
            if job and job['status'] in _ACTIVE:
                raise _error('A cookie bot is already running for this profile.', 'COOKIE_BOT_ALREADY_RUNNING')
            if job:
                cancel_path(path, job['jobId']).unlink(missing_ok=True)
            job = new_job(profile_id, config)
            _write(path, job)
            try:
                job['_pid'] = _spawn_worker(root, profile_id, job['jobId'])
                _write(path, job)
            except Exception:
                job.update(status='failed', finishedAt=_now(), stopReason='worker-start-failed')
                job['errors'].append('Could not start cookie bot worker.')
                _write(path, job)
                raise _error('Could not start cookie bot worker.', 'COOKIE_BOT_START_FAILED') from None
        elif action == 'cancel':
            if not job or params.get('jobId') != job['jobId']:
                raise _error('Cookie bot job no longer matches. Refresh status.', 'COOKIE_BOT_JOB_MISMATCH')
            if job['status'] in _ACTIVE:
                cancel_path(path, job['jobId']).touch(mode=0o600)
        return _public(job, path)


def worker_main(job_id):
    import sys
    payload = json.loads(sys.stdin.read(16384))
    root, profile_id = payload['storeRoot'], payload['profileId']
    path = _job_path(root, profile_id)
    with _command_lock(path):
        job = _read(path)
        if not job or job['jobId'] != job_id:
            return 1
    run_job(root, job, path)
    return 0
