"""Keep per-platform bundle settings out of the local Linux build defaults."""
import json
import os
from pathlib import Path
import shutil
import sys

def apple_environment(environment):
    identity = environment.get('APPLE_SIGNING_IDENTITY', '')
    certificate = environment.get('APPLE_CERTIFICATE', '')
    if bool(identity) != bool(certificate):
        raise ValueError('Apple signing requires both a certificate and signing identity')
    notarization = ('APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID')
    if any(environment.get(key) for key in notarization):
        if not identity or not all(environment.get(key) for key in notarization):
            raise ValueError('Apple notarization requires signing and all three account secrets')
    # An earlier action imports the certificate for PyInstaller and Tauri.
    # Do not forward empty secrets: Tauri treats a present-but-empty P12 as a
    # certificate to import, rather than falling back to ad-hoc signing.
    return {key: environment[key] for key in ('APPLE_SIGNING_IDENTITY', *notarization)
            if environment.get(key)}


def main():
    icon = {'win32': 'icon.ico', 'darwin': 'icon.icns'}.get(sys.platform, 'icon.png')
    bundle = {'icon': [f'icons/generated/{icon}']}
    if sys.platform == 'darwin':
        signing = apple_environment(os.environ)
        bundle['macOS'] = {'signingIdentity': signing.get('APPLE_SIGNING_IDENTITY', '-')}
        if os.environ.get('GITHUB_ENV'):
            with open(os.environ['GITHUB_ENV'], 'a') as output:
                for key, value in signing.items():
                    if '\n' in value or '\r' in value:
                        raise ValueError(f'{key} must be a single line')
                    output.write(f'{key}={value}\n')
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
                output.write(f'apple-signing={str(bool(signing)).lower()}\n')
    if sys.platform == 'win32':
        # Raw cargo test also invokes tauri-build, before the CLI config override.
        shutil.copyfile('src-tauri/icons/generated/icon.ico', 'src-tauri/icons/icon.ico')
    Path('tmp').mkdir(exist_ok=True)
    Path('tmp/ci-bundle.json').write_text(json.dumps({'bundle': bundle}, indent=2) + '\n')


if __name__ == '__main__':
    main()
