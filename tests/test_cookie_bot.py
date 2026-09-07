"""Cookie bot policy and worker tests; no external sites required."""
import unittest
from theprivator_sidecar import cookie_bot
from theprivator_sidecar.protocol import SidecarError


class PolicyTests(unittest.TestCase):
    def test_job_timestamps_use_the_shared_utc_wire_format(self):
        job = cookie_bot.new_job('profile', {})
        self.assertRegex(job['createdAt'], r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')

    def test_defaults_are_explicit_and_bounded(self):
        config = cookie_bot.validate_config({})
        self.assertEqual(config['urls'], list(cookie_bot.DEFAULT_URLS))
        self.assertFalse(config['closeAfterCompletion'])
        self.assertLessEqual(config['maxPages'], 50)
        self.assertLessEqual(config['maxDurationSeconds'], 600)

    def test_rejects_unsafe_urls_and_invalid_bounds(self):
        for url in ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'https://user:pass@example.com', 'https://', 'http://x:bad', 'https://x/\nfoo']:
            with self.subTest(url=url), self.assertRaises(SidecarError):
                cookie_bot.validate_config({'urls': [url]})
        for config in [{'urls': []}, {'maxPages': 0}, {'maxPages': True}, {'maxDurationSeconds': 601}, {'closeAfterCompletion': 'false'}]:
            with self.subTest(config=config), self.assertRaises(SidecarError):
                cookie_bot.validate_config(config)

    def test_crawl_stays_on_exact_host_and_skips_actions(self):
        links = ['/article#section', 'https://other.test/article', '/logout', '/checkout', 'javascript:void(0)', '/article', '/search?q=x', '/account/delete', '/download.zip']
        self.assertEqual(cookie_bot.safe_links('https://example.test/', links), ['https://example.test/article'])


class InspectionTests(unittest.TestCase):
    def inspect(self, snapshots, *, deadline=20.0, cancel_at=None):
        from unittest.mock import patch
        clock = [0.0]
        index = [0]
        def evaluate(*args, **kwargs):
            snapshot = snapshots[min(index[0], len(snapshots) - 1)]
            index[0] += 1
            if isinstance(snapshot, Exception):
                raise snapshot
            return snapshot
        def wait(seconds, cancelled):
            clock[0] += seconds
            return cancelled()
        with patch.object(cookie_bot.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(cookie_bot, '_wait', side_effect=wait), \
             patch.object(cookie_bot.cdp, 'runtime_evaluate', side_effect=evaluate):
            result = cookie_bot._inspect_page(object(), 1, deadline,
                lambda: cancel_at is not None and clock[0] >= cancel_at, True)
        return result, clock[0]

    def test_does_not_follow_stale_dom_during_later_navigation(self):
        snapshots = [
            {'url': 'http://example.test/', 'readyState': 'complete', 'links': ['/old']},
            {'url': 'http://example.test/new', 'readyState': 'loading', 'links': []},
        ]
        with self.assertRaises(SidecarError):
            self.inspect(snapshots)

    def test_retries_transient_context_loss_and_waits_for_hydrated_links(self):
        snapshots = [SidecarError(code='CDP_ERROR', message='context gone')]
        snapshots += [{'url': 'http://example.test/', 'readyState': 'complete', 'links': []}] * 15
        snapshots += [{'url': 'http://example.test/', 'readyState': 'complete', 'links': ['/article']}]
        result, elapsed = self.inspect(snapshots)
        self.assertEqual(result['links'], ['/article'])
        self.assertLess(elapsed, 3)

    def test_linkless_page_grace_and_cancellation_are_bounded(self):
        page = {'url': 'http://example.test/', 'readyState': 'complete', 'links': []}
        result, elapsed = self.inspect([page])
        self.assertEqual(result, page)
        self.assertLess(elapsed, 3.2)
        _, elapsed = self.inspect([page], cancel_at=.2)
        self.assertLessEqual(elapsed, .3)
        _, elapsed = self.inspect([page], deadline=.3)
        self.assertLessEqual(elapsed, .3)


class WorkerTests(unittest.TestCase):
    def test_failed_endpoint_discovery_closes_only_new_launch_when_requested(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        for close_after in (False, True):
            with patch.object(cookie_bot.chromium, '_load_profile', return_value=SimpleNamespace()), \
                 patch.object(cookie_bot.chromium, 'status', return_value={'profiles': []}), \
                 patch.object(cookie_bot.chromium, 'launch_for_automation', return_value={'startedAt': 'original'}), \
                 patch.object(cookie_bot.chromium, 'resolve_user_data_path', return_value='/synthetic'), \
                 patch.object(cookie_bot.cdp, 'discover_devtools_endpoint', side_effect=SidecarError(code='CDP_FAILED', message='static')), \
                 patch.object(cookie_bot, '_close_profile_if_same') as close:
                with self.assertRaises(SidecarError):
                    cookie_bot._connect_profile('root', 'profile', close_after)
                self.assertEqual(close.call_count, int(close_after))

    def test_runner_bounds_crawl_and_closes_owned_tab(self):
        from unittest.mock import patch
        import tempfile
        from pathlib import Path
        from types import SimpleNamespace
        visits = []
        class Browser:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def command(self, method, params=None, **kwargs):
                if method == 'Page.navigate': visits.append(params['url'])
                return {}
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'job.json'
            job = cookie_bot.new_job('profile', {'urls': ['http://example.test/'], 'maxPages': 2, 'dwellSeconds': 1, 'closeAfterCompletion': True})
            with patch.object(cookie_bot, '_connect_profile', return_value=(SimpleNamespace(), 'original')) as connect, \
                 patch.object(cookie_bot.cdp, 'create_page_target_endpoint', return_value=SimpleNamespace(web_socket_debugger_url='ws://127.0.0.1:1/devtools/page/a', target_id='a')), \
                 patch.object(cookie_bot.cdp, 'CdpClient', return_value=Browser()), \
                 patch.object(cookie_bot, '_inspect_page', return_value={'url': 'http://example.test/', 'links': ['/article', '/logout', 'http://other.test/']}), \
                 patch.object(cookie_bot.cdp, 'close_page_target') as close_tab, \
                 patch.object(cookie_bot, '_close_profile_if_same') as close_profile, \
                 patch.object(cookie_bot, '_wait', return_value=False):
                cookie_bot.run_job(root, job, path)
            self.assertEqual(visits, ['http://example.test/', 'http://example.test/article'])
            self.assertEqual(job['status'], 'completed')
            self.assertEqual(job['visitedPages'], 2)
            close_tab.assert_called_once()
            close_profile.assert_called_once_with(root, 'profile', 'original')
            self.assertTrue(connect.called)

    def test_cancel_before_launch_does_not_touch_browser(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'job.json'
            job = cookie_bot.new_job('profile', {})
            cookie_bot.cancel_path(path, job['jobId']).touch()
            with patch.object(cookie_bot, '_connect_profile') as connect:
                cookie_bot.run_job(root, job, path)
            connect.assert_not_called()
            self.assertEqual(job['status'], 'cancelled')


class CommandTests(unittest.TestCase):
    def test_detached_worker_has_independent_frozen_environment(self):
        from unittest.mock import patch, MagicMock
        process = MagicMock(pid=123)
        with patch('subprocess.Popen', return_value=process) as spawn, patch('threading.Thread'):
            self.assertEqual(cookie_bot._spawn_worker('/root', 'profile', 'job'), 123)
        self.assertEqual(spawn.call_args.kwargs['env']['PYINSTALLER_RESET_ENVIRONMENT'], '1')
        self.assertEqual(spawn.call_args.kwargs['stdout'], -3)

    def test_defaults_dispatch_and_error_envelope(self):
        import json
        from theprivator_sidecar.main import handle_request_line
        response, _ = handle_request_line(json.dumps({'id': 'bot', 'method': 'cookieBot.defaults', 'params': {}}))
        self.assertTrue(response['ok'])
        self.assertEqual(response['result']['config']['urls'], list(cookie_bot.DEFAULT_URLS))

    def test_job_state_cross_command_cancel_and_duplicate_guard(self):
        import tempfile
        from unittest.mock import patch
        from theprivator_sidecar.profiles import ProfileStore
        with tempfile.TemporaryDirectory() as root:
            profile_id = ProfileStore(root).create('Bot fixture')['profile']['id']
            with patch.object(cookie_bot, '_spawn_worker', return_value=123), patch.object(cookie_bot, '_worker_alive', return_value=True):
                result = cookie_bot.command('start', {'storeRoot': root, 'profileId': profile_id, 'config': {'urls': ['http://example.test/?token=private']}})
                self.assertEqual(result['job']['config']['urls'], ['http://example.test/'])
                with self.assertRaises(SidecarError):
                    cookie_bot.command('start', {'storeRoot': root, 'profileId': profile_id})
                current = cookie_bot.command('status', {'storeRoot': root, 'profileId': profile_id})
                self.assertEqual(current['job']['jobId'], result['job']['jobId'])
                with self.assertRaises(SidecarError):
                    cookie_bot.command('cancel', {'storeRoot': root, 'profileId': profile_id, 'jobId': 'wrong'})
                cancelled = cookie_bot.command('cancel', {'storeRoot': root, 'profileId': profile_id, 'jobId': result['job']['jobId']})
                self.assertEqual(cancelled['job']['status'], 'cancelling')
            interrupted = cookie_bot.command('status', {'storeRoot': root, 'profileId': profile_id})
            self.assertEqual(interrupted['job']['status'], 'failed')
            self.assertEqual(interrupted['job']['stopReason'], 'worker-exited')


if __name__ == '__main__':
    unittest.main()
