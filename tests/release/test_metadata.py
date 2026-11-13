"""Exercise the real release checker against a Windows-style checkout."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class MetadataTests(unittest.TestCase):
    def test_windows_line_endings_and_mismatched_tag(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            (root / "src-tauri").mkdir()
            shutil.copyfile(Path(__file__).resolve().parents[2] / "scripts/verify-release.mjs",
                            root / "scripts/verify-release.mjs")
            metadata = {"version": "3.2.7"}
            (root / "package.json").write_text(json.dumps(metadata))
            (root / "package-lock.json").write_text(json.dumps({**metadata, "packages": {"": metadata}}))
            (root / "src-tauri/tauri.conf.json").write_text(json.dumps(metadata))
            (root / "src-tauri/Cargo.toml").write_bytes(b'[package]\r\nversion = "3.2.7"\r\n')
            (root / "src-tauri/Cargo.lock").write_bytes(b'[[package]]\r\nname = "theprivator"\r\nversion = "3.2.7"\r\n')
            (root / "CHANGELOG.md").write_bytes(b'## [3.2.7]\r\n')
            # Cold Node startup can exceed 10 seconds on shared Windows runners.
            result = subprocess.run(["node", "scripts/verify-release.mjs", "v3.2.7"], cwd=root,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run(["node", "scripts/verify-release.mjs", "v9.9.9"], cwd=root,
                                    capture_output=True, text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Release tag must match", result.stderr)
