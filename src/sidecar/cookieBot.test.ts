import { invoke } from '@tauri-apps/api/core';
import { beforeEach, expect, it, vi } from 'vitest';
import { startCookieBot, getCookieBotDefaults, getCookieBotStatus, cancelCookieBot } from './client';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const config = { urls: ['https://www.wikipedia.org/'], maxPages: 10, maxDepth: 1, dwellSeconds: 5, maxDurationSeconds: 120, closeAfterCompletion: false };
const job = { jobId: 'job-1', profileId: 'profile-1', status: 'running', config, createdAt: '2026-09-07T10:00:00Z', finishedAt: null, currentUrl: null, visitedPages: 0, failedPages: 0, errors: [], stopReason: null };
const envelope = (result: unknown) => ({ requestId: 'bot-1', protocolVersion: '1.0.0', durationMs: 5, result });
beforeEach(() => vi.resetAllMocks());
it('loads transparent defaults and maps start/status/cancel commands', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(envelope({config}));
  expect((await getCookieBotDefaults()).config).toEqual(config);
  vi.mocked(invoke).mockResolvedValue(envelope({job}));
  expect((await startCookieBot('profile-1', {maxPages: 3})).job).toEqual(job);
  expect(invoke).toHaveBeenLastCalledWith('cookie_bot_start', {profileId: 'profile-1', config: {maxPages: 3}});
  await getCookieBotStatus('profile-1');
  expect(invoke).toHaveBeenLastCalledWith('cookie_bot_status', {profileId: 'profile-1'});
  await cancelCookieBot('profile-1', 'job-1');
  expect(invoke).toHaveBeenLastCalledWith('cookie_bot_cancel', {profileId: 'profile-1', jobId: 'job-1'});
});
it('accepts never-started status but rejects malformed or wrong-profile jobs', async () => {
  vi.mocked(invoke).mockResolvedValue(envelope({job: null}));
  expect((await getCookieBotStatus('profile-1')).job).toBeNull();
  for (const bad of [{...job, status: 'invented'}, {...job, visitedPages: -1}, {...job, profileId: 'wrong'}, {...job, config: {...config, maxPages: 900}}, {...job, currentUrl: 'file:///etc/passwd'}]) {
    vi.mocked(invoke).mockResolvedValue(envelope({job: bad}));
    await expect(getCookieBotStatus('profile-1')).rejects.toMatchObject({code: 'SIDECAR_PROTOCOL_ERROR'});
  }
});
