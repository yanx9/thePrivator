const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { publish } = require('../../scripts/release/publish.cjs');

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'theprivator-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const plan = { sha: 'a'.repeat(40), tag: 'v3.2.7', version: '3.2.7', publish: true, prerelease: false };
  const files = { 'app.deb': 'test installer', 'release-manifest.json': JSON.stringify(plan) };
  let checksums = '';
  for (const [name, data] of Object.entries(files)) {
    writeFileSync(join(directory, name), data);
    checksums += `${createHash('sha256').update(data).digest('hex')}  ${name}\n`;
  }
  writeFileSync(join(directory, 'SHA256SUMS'), checksums);
  const calls = [];
  const repos = {
    getCommit: async () => ({ data: { sha: plan.sha } }),
    getReleaseByTag: async () => { throw Object.assign(new Error('Not found'), { status: 404 }); },
    createRelease: async (args) => { calls.push(['create', args]); return { data: { id: 1 } }; },
    listReleases: () => {},
    listReleaseAssets: () => {},
    deleteReleaseAsset: async (args) => { calls.push(['delete', args]); },
    uploadReleaseAsset: async (args) => {
      calls.push(['upload', args.name]);
      return { data: { size: args.data.length, state: 'uploaded' } };
    },
    updateRelease: async (args) => { calls.push(['publish', args]); return { data: { html_url: 'https://example.com/release' } }; },
    ...overrides,
  };
  const releasePages = [[]];
  const oldAssets = [];
  const paginate = async (method) => {
    assert.equal(method, repos.listReleaseAssets);
    return oldAssets;
  };
  paginate.iterator = async function* (method) {
    assert.equal(method, repos.listReleases);
    for (const data of releasePages) yield { data };
  };
  const git = { getRef: async () => { throw Object.assign(new Error('Not found'), { status: 404 }); } };
  return { directory, plan, calls, releasePages, oldAssets, github: { rest: { repos, git }, paginate },
    context: { repo: { owner: 'test', repo: 'app' } }, core: { setOutput() {}, info() {} } };
}

test('publishes only after all assets have uploaded', async (t) => {
  const f = fixture(t);
  await publish(f);
  assert.deepEqual(f.calls.map(([name]) => name), ['create', 'upload', 'upload', 'upload', 'publish']);
  assert.equal(f.calls[0][1].draft, true);
  assert.equal(f.calls.at(-1)[1].draft, false);
});

test('failed upload leaves a draft and never publishes', async (t) => {
  const f = fixture(t, { uploadReleaseAsset: async () => { throw new Error('Upload interrupted'); } });
  await assert.rejects(publish(f), /Upload interrupted/);
  assert.deepEqual(f.calls.map(([name]) => name), ['create']);
});

test('corrupt artifact fails before any release mutation', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'app.deb'), 'tampered');
  await assert.rejects(publish(f), /Checksum mismatch/);
  assert.deepEqual(f.calls, []);
});

test('existing tag must identify the tested commit', async (t) => {
  const f = fixture(t, { getCommit: async () => ({ data: { sha: 'b'.repeat(40) } }) });
  f.github.rest.git.getRef = async () => ({ data: { object: { type: 'commit' } } });
  await assert.rejects(publish(f), /different commit/);
  assert.deepEqual(f.calls, []);
});

test('new tags are allowed when the commit endpoint would return GitHub 422', async (t) => {
  const f = fixture(t, { getCommit: async () => {
    throw Object.assign(new Error('No commit found for SHA: v3.2.7'), { status: 422 });
  } });
  await publish(f);
  assert.equal(f.calls[0][0], 'create');
  assert.equal(f.calls.at(-1)[0], 'publish');
});

test('annotated tags are checked against their resolved commit', async (t) => {
  const f = fixture(t);
  f.github.rest.git.getRef = async () => ({ data: { object: { type: 'tag', sha: 'b'.repeat(40) } } });
  await publish(f);
  assert.equal(f.calls.at(-1)[0], 'publish');
});

test('tag lookup errors other than absence prevent publication', async (t) => {
  for (const status of [403, 422]) {
    const f = fixture(t);
    f.github.rest.git.getRef = async () => { throw Object.assign(new Error('Lookup failed'), { status }); };
    await assert.rejects(publish(f), /Lookup failed/);
    assert.deepEqual(f.calls, []);
  }
});

test('published installers cannot be overwritten on a rerun', async (t) => {
  const f = fixture(t, { getReleaseByTag: async () => ({ data: { id: 1, draft: false } }) });
  await assert.rejects(publish(f), /already published/);
  assert.deepEqual(f.calls, []);
});

test('resumes an interrupted draft found on a later release-list page', async (t) => {
  const f = fixture(t); // GitHub's tag endpoint returns 404 for drafts.
  f.releasePages.push([{ id: 2, tag_name: 'unrelated', draft: true }], [
    { id: 7, tag_name: f.plan.tag, draft: true, target_commitish: f.plan.sha },
  ]);
  f.oldAssets.push({ id: 11 });
  await publish(f);
  assert.deepEqual(f.calls.map(([name]) => name), ['delete', 'upload', 'upload', 'upload', 'publish']);
  assert.equal(f.calls[0][1].asset_id, 11);
  assert.equal(f.calls.at(-1)[1].release_id, 7);
});

test('never resumes a draft belonging to a different source commit', async (t) => {
  const f = fixture(t);
  f.releasePages.push([{ id: 7, tag_name: f.plan.tag, draft: true, target_commitish: 'b'.repeat(40) }]);
  await assert.rejects(publish(f), /different source commit/);
  assert.deepEqual(f.calls, []);
});

test('a prerelease never becomes the latest stable release', async (t) => {
  const f = fixture(t);
  f.plan.prerelease = true;
  writeFileSync(join(f.directory, 'release-manifest.json'), JSON.stringify(f.plan));
  const manifestHash = createHash('sha256').update(JSON.stringify(f.plan)).digest('hex');
  const installerHash = createHash('sha256').update('test installer').digest('hex');
  writeFileSync(join(f.directory, 'SHA256SUMS'), `${installerHash}  app.deb\n${manifestHash}  release-manifest.json\n`);
  await publish(f);
  assert.equal(f.calls.at(-1)[1].make_latest, 'false');
});
