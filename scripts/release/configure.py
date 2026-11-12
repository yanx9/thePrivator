"""Keep per-platform bundle settings out of the local Linux build defaults."""
import json
import os
from pathlib import Path
import shutil
import sys

icon = {'win32': 'icon.ico', 'darwin': 'icon.icns'}.get(sys.platform, 'icon.png')
bundle = {'icon': [f'icons/generated/{icon}']}
if sys.platform == 'darwin':
    bundle['macOS'] = {'signingIdentity': os.environ.get('APPLE_SIGNING_IDENTITY') or '-'}
if sys.platform == 'win32':
    # Raw cargo test also invokes tauri-build, before the CLI config override.
    shutil.copyfile('src-tauri/icons/generated/icon.ico', 'src-tauri/icons/icon.ico')
Path('tmp').mkdir(exist_ok=True)
Path('tmp/ci-bundle.json').write_text(json.dumps({'bundle': bundle}, indent=2) + '\n')
