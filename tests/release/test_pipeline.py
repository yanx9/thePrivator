import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from scripts.release.prepare import release_plan
from scripts.release.assets import assemble, collect
from scripts.release.arch import render
from scripts.release.configure import apple_environment

SHA = 'a' * 40


class SigningEnvironmentTests(unittest.TestCase):
    def test_absent_or_empty_secrets_do_not_request_certificate_import(self):
        self.assertEqual(apple_environment({}), {})
        self.assertEqual(apple_environment({key: '' for key in (
            'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY',
            'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID')}), {})

    def test_imported_identity_is_forwarded_without_p12_credentials(self):
        self.assertEqual(apple_environment({
            'APPLE_CERTIFICATE': 'base64', 'APPLE_CERTIFICATE_PASSWORD': 'secret',
            'APPLE_SIGNING_IDENTITY': 'Developer ID Application: Example',
        }), {'APPLE_SIGNING_IDENTITY': 'Developer ID Application: Example'})

    def test_incomplete_signing_or_notarization_fails_early(self):
        for environment in ({'APPLE_SIGNING_IDENTITY': 'Example'},
                            {'APPLE_CERTIFICATE': 'base64'}, {'APPLE_ID': 'example'}):
            with self.subTest(environment=environment), self.assertRaises(ValueError):
                apple_environment(environment)


class ReleasePlanTests(unittest.TestCase):
    def plan(self, **kwargs):
        return release_plan('3.2.7', SHA, 'workflow_dispatch', 'refs/heads/master', **kwargs)

    def test_manual_run_defaults_to_artifacts(self):
        self.assertFalse(self.plan()['publish'])

    def test_branch_push_creates_unique_prerelease(self):
        plan = release_plan('3.2.7', SHA, 'push', 'refs/heads/master', run_id='123', attempt='2')
        self.assertTrue(plan['publish'])
        self.assertTrue(plan['prerelease'])
        self.assertFalse(plan['aur'])
        self.assertEqual(plan['tag'], 'nightly-123-2-aaaaaaaa')
        self.assertEqual(plan['archPackage'], 'theprivator-preview-bin')

    def test_stable_tag_publishes_and_updates_aur(self):
        plan = release_plan('3.2.7', SHA, 'push', 'refs/tags/v3.2.7')
        self.assertTrue(plan['publish'])
        self.assertTrue(plan['aur'])
        self.assertFalse(plan['prerelease'])

    def test_rc_tag_does_not_update_stable_aur(self):
        plan = release_plan('3.2.7-rc.1', SHA, 'push', 'refs/tags/v3.2.7-rc.1')
        self.assertTrue(plan['prerelease'])
        self.assertFalse(plan['aur'])

    def test_pull_request_never_publishes(self):
        self.assertFalse(release_plan('3.2.7', SHA, 'pull_request', 'refs/pull/1/merge')['publish'])

    def test_mismatched_version_and_conflicting_options_fail(self):
        with self.assertRaises(ValueError):
            self.plan(channel='release', tag='v9.9.9')
        with self.assertRaises(ValueError):
            self.plan(channel='nightly', tag='v3.2.7')


class AssetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'downloaded'
        self.source.mkdir()
        self.plan = release_plan('3.2.7', SHA, 'push', 'refs/tags/v3.2.7')

    def seed(self):
        names = ['linux-x86_64-app.deb', 'linux-x86_64-app.rpm', 'linux-x86_64-app.AppImage',
                 'macos-aarch64-app.dmg', 'macos-x86_64-app.dmg', 'windows-x86_64-app.exe',
                 'windows-x86_64-app.msi', 'theprivator-bin-3.2.7-1-x86_64.pkg.tar.zst',
                 'theprivator-arch-recipe-v3.2.7.tar.gz']
        for name in names:
            (self.source / name).write_bytes(b'synthetic installer ' + name.encode())

    def test_complete_release_has_correct_checksums(self):
        self.seed()
        output = self.root / 'release'
        manifest = assemble(self.source, output, self.plan)
        self.assertEqual(len(manifest['assets']), 9)
        for line in (output / 'SHA256SUMS').read_text().splitlines():
            checksum, name = line.split('  ')
            self.assertEqual(checksum, hashlib.sha256((output / name).read_bytes()).hexdigest())
        self.assertEqual(json.loads((output / 'release-manifest.json').read_text())['sha'], SHA)

    def test_missing_platform_blocks_release(self):
        self.seed()
        (self.source / 'macos-aarch64-app.dmg').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing'):
            assemble(self.source, self.root / 'release', self.plan)

    def test_duplicate_asset_names_are_rejected(self):
        self.seed()
        extra = self.source / 'second'
        extra.mkdir()
        (extra / 'macos-aarch64-app.dmg').write_bytes(b'other installer')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            assemble(self.source, self.root / 'release', self.plan)

    def test_empty_installer_is_rejected(self):
        self.seed()
        (self.source / 'linux-x86_64-app.deb').write_bytes(b'')
        with self.assertRaisesRegex(ValueError, 'empty'):
            assemble(self.source, self.root / 'release', self.plan)

    def test_collection_requires_each_requested_format(self):
        (self.source / 'nsis').mkdir()
        (self.source / 'nsis/app-setup.exe').write_bytes(b'installer')
        with self.assertRaisesRegex(ValueError, 'msi'):
            collect(self.source, self.root / 'output', 'windows-x86_64')

    def test_arch_recipe_is_pinned_to_exact_installer(self):
        deb = self.source / 'linux-x86_64-app.deb'
        deb.write_bytes(b'synthetic deb')
        output = self.root / 'arch'
        render(deb, self.plan, 'yanx9/thePrivator', output)
        recipe = (output / 'PKGBUILD').read_text()
        self.assertIn('/releases/download/v3.2.7/linux-x86_64-app.deb', recipe)
        self.assertIn(hashlib.sha256(deb.read_bytes()).hexdigest(), recipe)
        self.assertNotIn('SKIP', recipe)
        self.assertNotIn('@', recipe)

    def test_arch_metadata_cannot_inject_shell_commands(self):
        deb = self.source / 'app.deb'
        deb.write_bytes(b'test')
        with self.assertRaises(ValueError):
            render(deb, {**self.plan, 'tag': "v3.2.7'; id; '"}, 'yanx9/thePrivator', self.root / 'arch')


if __name__ == '__main__':
    unittest.main()
