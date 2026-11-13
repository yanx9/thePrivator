"""Collect expected installers and verify completeness before publishing."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

PATTERNS = {
    'linux-x86_64': ('deb/*.deb', 'rpm/*.rpm', 'appimage/*.AppImage'),
    'macos-aarch64': ('dmg/*.dmg',),
    'macos-x86_64': ('dmg/*.dmg',),
    'windows-x86_64': ('nsis/*setup.exe', 'msi/*.msi'),
}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def collect(bundle, destination, platform):
    destination.mkdir(parents=True, exist_ok=True)
    for pattern in PATTERNS[platform]:
        matches = list(bundle.glob(pattern))
        if len(matches) != 1 or matches[0].stat().st_size == 0:
            raise ValueError(f'Expected one nonempty {platform} installer matching {pattern}')
        source = matches[0]
        shutil.copy2(source, destination / f'{platform}-{source.name}')


def assemble(source, destination, plan):
    files = sorted(path for path in source.rglob('*') if path.is_file())
    names = [path.name for path in files]
    if len(names) != len(set(names)):
        raise ValueError('Duplicate release asset names')
    expected = (
        ('linux-x86_64-', '.deb'), ('linux-x86_64-', '.rpm'), ('linux-x86_64-', '.AppImage'),
        ('macos-aarch64-', '.dmg'), ('macos-x86_64-', '.dmg'),
        ('windows-x86_64-', '.exe'), ('windows-x86_64-', '.msi'),
        (plan['archPackage'] + '-', '.pkg.tar.zst'), ('theprivator-arch-recipe-', '.tar.gz'),
    )
    for prefix, suffix in expected:
        matches = [name for name in names if name.startswith(prefix) and name.endswith(suffix)]
        if len(matches) != 1:
            raise ValueError(f'Missing or duplicate release asset: {prefix}*{suffix}')
    if len(files) != len(expected) or any(path.stat().st_size == 0 for path in files):
        raise ValueError('Unexpected or empty release assets')
    destination.mkdir(parents=True, exist_ok=True)
    manifest = {**plan, 'assets': []}
    for source_file in files:
        target = destination / source_file.name
        shutil.copy2(source_file, target)
        manifest['assets'].append({'name': target.name, 'size': target.stat().st_size, 'sha256': digest(target)})
    (destination / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    all_files = sorted(path for path in destination.iterdir() if path.is_file() and path.name != 'SHA256SUMS')
    (destination / 'SHA256SUMS').write_text(''.join(f'{digest(path)}  {path.name}\n' for path in all_files))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['collect', 'assemble'])
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--platform', choices=PATTERNS)
    parser.add_argument('--plan', type=Path, default=Path('release-plan.json'))
    args = parser.parse_args()
    if args.action == 'collect':
        if args.platform is None:
            parser.error('--platform is required for collect')
        collect(args.source, args.destination, args.platform)
    else:
        manifest = assemble(args.source, args.destination, json.loads(args.plan.read_text()))
        print(f"Verified {len(manifest['assets'])} release assets for {manifest['tag']}")


if __name__ == '__main__':
    main()
