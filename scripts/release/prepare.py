"""Resolve an immutable source commit and release channel for every build job."""
import json
import os
from pathlib import Path
import re
import subprocess


def release_plan(version, sha, event, ref, channel='artifacts', tag='', run_id='0', attempt='1'):
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', version):
        raise ValueError('Unsupported application version')
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('A full source commit is required')
    if event == 'push':
        channel = 'release' if ref.startswith('refs/tags/') else 'nightly'
        tag = ref.removeprefix('refs/tags/') if channel == 'release' else ''
    if channel not in ('artifacts', 'nightly', 'release'):
        raise ValueError('Unknown release channel')
    if tag and channel != 'release':
        raise ValueError('A tag is only accepted for the release channel')
    if channel == 'release':
        tag = tag or f'v{version}'
        if tag != f'v{version}':
            raise ValueError('Release tag must match the application version')
    else:
        if not run_id.isdecimal() or not attempt.isdecimal():
            raise ValueError('Invalid workflow run identity')
        tag = f'{"nightly" if channel == "nightly" else "build"}-{run_id}-{attempt}-{sha[:8]}'
    prerelease = channel != 'release' or '-' in version
    return {
        'version': version, 'sha': sha, 'tag': tag, 'channel': channel,
        'publish': channel != 'artifacts', 'prerelease': prerelease,
        'aur': channel == 'release' and not prerelease,
        'archVersion': version.replace('-', '_') + (f'.r{run_id}.{attempt}' if channel != 'release' else ''),
        'archPackage': 'theprivator-preview-bin' if prerelease else 'theprivator-bin',
    }


def main():
    version = json.loads(Path('package.json').read_text())['version']
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    plan = release_plan(version, sha, os.environ['GITHUB_EVENT_NAME'], os.environ['GITHUB_REF'],
                        os.environ.get('RELEASE_CHANNEL', 'artifacts'), os.environ.get('RELEASE_TAG', ''),
                        os.environ['GITHUB_RUN_ID'], os.environ.get('GITHUB_RUN_ATTEMPT', '1'))
    Path('release-plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        for key in ('sha', 'tag', 'publish', 'prerelease', 'aur'):
            value = str(plan[key]).lower() if isinstance(plan[key], bool) else plan[key]
            output.write(f'{key}={value}\n')
    print(f"{plan['channel']}: {plan['tag']} from {plan['sha']}")


if __name__ == '__main__':
    main()
