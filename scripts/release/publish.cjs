const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

function verifyAssets(directory) {
  const lines = readFileSync(join(directory, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const names = [];
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.+-]+)$/.exec(line);
    assert(match, 'Invalid checksum entry');
    const [, expected, name] = match;
    assert(!names.includes(name), 'Duplicate checksum entry');
    const actual = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex');
    assert.equal(actual, expected, `Checksum mismatch: ${name}`);
    names.push(name);
  }
  assert(names.includes('release-manifest.json'), 'Missing release manifest');
  names.push('SHA256SUMS');
  assert.deepEqual([...names].sort(), readdirSync(directory).sort(), 'Unverified release files');
  return names;
}

async function publish({ github, context, core, directory, plan }) {
  const names = verifyAssets(directory);
  const manifest = JSON.parse(readFileSync(join(directory, 'release-manifest.json'), 'utf8'));
  for (const key of ['sha', 'tag', 'version', 'prerelease', 'publish']) {
    assert.equal(manifest[key], plan[key], `Release manifest differs from build plan: ${key}`);
  }
  assert(plan.publish, 'This run only builds artifacts');
  const repo = context.repo;
  // A manual release must never attach a new build to an unrelated existing tag.
  try {
    const { data } = await github.rest.repos.getCommit({ ...repo, ref: plan.tag });
    assert.equal(data.sha, plan.sha, 'Existing release tag points to a different commit');
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  let release;
  try {
    release = (await github.rest.repos.getReleaseByTag({ ...repo, tag: plan.tag })).data;
    assert(release.draft, 'This release is already published; its installers will not be replaced');
    assert.equal(release.target_commitish, plan.sha, 'Draft belongs to a different source commit');
  } catch (error) {
    if (error.status !== 404) throw error;
    release = (await github.rest.repos.createRelease({
      ...repo, tag_name: plan.tag, target_commitish: plan.sha,
      name: plan.prerelease ? `ThePrivator preview ${plan.tag}` : `ThePrivator ${plan.tag}`,
      body: `Source commit: ${plan.sha}\n\n${plan.prerelease ? 'Development build. ' : ''}` +
        'Installers, Arch recipe and SHA256SUMS are attached. See release-manifest.json for build identity.',
      draft: true, prerelease: plan.prerelease, generate_release_notes: !plan.prerelease,
    })).data;
  }
  // Interrupted uploads remain a draft. A retry replaces only those draft assets.
  const oldAssets = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id: release.id });
  for (const asset of oldAssets) {
    await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: asset.id });
  }
  for (const name of names) {
    const data = readFileSync(join(directory, name));
    const uploaded = await github.rest.repos.uploadReleaseAsset({
      ...repo, release_id: release.id, name, data,
      headers: { 'content-type': 'application/octet-stream', 'content-length': data.length },
    });
    assert.equal(uploaded.data.size, data.length, `Incomplete upload: ${name}`);
    assert.equal(uploaded.data.state, 'uploaded', `Upload not ready: ${name}`);
  }
  // This is the only operation that makes the complete release public.
  const published = await github.rest.repos.updateRelease({
    ...repo, release_id: release.id, draft: false, prerelease: plan.prerelease,
    make_latest: plan.prerelease ? 'false' : 'legacy',
  });
  core.setOutput('url', published.data.html_url);
  core.info(`Published ${plan.tag}: ${names.length} verified assets`);
}

module.exports = { publish, verifyAssets };
