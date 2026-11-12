"""Render an AUR recipe using the exact Debian installer built in this run."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def render(deb, plan, repository, destination):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Invalid GitHub repository')
    for value in (deb.name, plan['tag'], plan['archVersion'], plan['archPackage']):
        if not re.fullmatch(r'[A-Za-z0-9_.+-]+', value):
            raise ValueError('Unsafe package metadata')
    license_path = ROOT / 'LICENSE'
    replacements = {
        'PACKAGE': plan['archPackage'], 'VERSION': plan['archVersion'], 'REPOSITORY': repository,
        'TAG': plan['tag'], 'DEB': deb.name,
        'SHA256': digest(deb), 'LICENSE_SHA256': digest(license_path),
        'CONFLICTS': ' '.join(f"'{name}'" for name in ('theprivator', 'theprivator-bin', 'theprivator-preview-bin')
                              if name != plan['archPackage']),
    }
    template = (ROOT / 'packaging/arch/PKGBUILD.in').read_text()
    for key, value in replacements.items():
        template = template.replace(f'@{key}@', value)
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'PKGBUILD').write_text(template)
    shutil.copy2(license_path, destination / 'LICENSE')
    # makepkg uses the already built installer locally; AUR fetches the same URL later.
    shutil.copy2(deb, destination / deb.name)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deb', type=Path, required=True)
    parser.add_argument('--plan', type=Path, default=Path('release-plan.json'))
    parser.add_argument('--repository', required=True)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    render(args.deb, json.loads(args.plan.read_text()), args.repository, args.destination)
