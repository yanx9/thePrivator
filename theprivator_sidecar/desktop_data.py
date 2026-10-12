"""Device preferences and bounded desktop storage operations."""
from __future__ import annotations
import json
import os
import platform
import re
import subprocess
import uuid
from pathlib import Path
from .protocol import SidecarError


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8') as handle:
            os.chmod(temporary, 0o600)
            json.dump(value, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def sync_directory(path: Path) -> None:
    if os.name != 'nt':
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def settings(root: Path) -> dict:
    path = root / 'settings.json'
    if not path.exists():
        return {'version': 1, 'theme': 'system'}
    try:
        data = json.loads(path.read_text())
        if data.get('version') != 1 or data.get('theme') not in ('system', 'light', 'dark'):
            raise ValueError()
        return data
    except (OSError, ValueError, AttributeError):
        raise SidecarError(code='SETTINGS_UNAVAILABLE', message='Settings could not be read. The existing file has been preserved.')


def disk_usage(root: Path) -> dict:
    groups = {'profiles': 0, 'vault': 0, 'other': 0}
    incomplete = False
    seen = set()
    def failed(_error):
        nonlocal incomplete
        incomplete = True
    for directory, dirs, files in os.walk(root, followlinks=False, onerror=failed):
        dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()]
        for name in files:
            path = Path(directory) / name
            try:
                if path.is_symlink():
                    continue
                stat = path.stat()
                identity = (stat.st_dev, stat.st_ino)
                if identity in seen:
                    continue
                seen.add(identity)
                relative = path.relative_to(root)
                group = 'profiles' if relative.parts[0] == 'profile-store' else 'vault' if relative.parts[0].startswith('vault') else 'other'
                groups[group] += stat.st_blocks * 512 if hasattr(stat, 'st_blocks') else stat.st_size
            except OSError:
                incomplete = True
    return {'bytes': sum(groups.values()), 'groups': groups, 'incomplete': incomplete}


def machine_info() -> dict:
    from .chromium import discover_executable
    version = None
    try:
        result = subprocess.run([str(discover_executable()), '--version'], capture_output=True, timeout=5, text=True)
        match = re.search(r'(\d+\.\d+\.\d+\.\d+)', result.stdout)
        if match:
            version = match.group(1)
    except (OSError, subprocess.SubprocessError, SidecarError):
        pass
    return {'platform': platform.system(), 'architecture': platform.machine(), 'browserVersion': version}


def command(root: Path, action: str, params: dict) -> dict:
    if action == 'settings.get':
        return settings(root)
    if action == 'settings.save':
        data = settings(root)
        if 'theme' in params:
            if params['theme'] not in ('system', 'light', 'dark'):
                raise SidecarError(code='INVALID_REQUEST', message='Invalid theme.')
            data['theme'] = params['theme']
        if 'sidebarCollapsed' in params:
            if not isinstance(params['sidebarCollapsed'], bool):
                raise SidecarError(code='INVALID_REQUEST', message='Invalid sidebar preference.')
            data['sidebarCollapsed'] = params['sidebarCollapsed']
        if 'tableLayout' in params:
            layout = params['tableLayout']
            keys = {'select', 'status', 'name', 'folder', 'tags', 'proxy', 'fingerprint', 'notes', 'lastLaunchedAt', 'launchCount', 'createdAt', 'updatedAt', 'actions'}
            if not isinstance(layout, list) or len(layout) > 30 or any(not isinstance(entry, dict) or set(entry) != {'key', 'visible', 'width'} or entry['key'] not in keys or not isinstance(entry['visible'], bool) or not isinstance(entry['width'], (int, float)) or not 1 <= entry['width'] <= 2000 for entry in layout):
                raise SidecarError(code='INVALID_REQUEST', message='Invalid table preference.')
            data['tableLayout'] = layout
        atomic_json(root / 'settings.json', data)
        return data
    if action == 'storage.usage':
        return disk_usage(root)
    if action == 'machine.info':
        return machine_info()
    if action == 'packages.export':
        from .profile_package import export_profile_package
        from .profiles import ProfileStore
        profile_id = params.get('profileId')
        profile = ProfileStore(root).get(profile_id)
        directory = Path(params.get('directory', ''))
        if not directory.is_absolute() or not directory.is_dir():
            raise SidecarError(code='INVALID_REQUEST', message='Choose an existing export folder.')
        # Unique names prevent overwriting a prior backup, even with duplicate names.
        destination = directory / (profile.id + '-' + uuid.uuid4().hex[:8] + '.tpkg')
        return export_profile_package(root, profile.id, destination)
    if action.startswith('vault.'):
        from .vault import command as vault_command
        return vault_command(root, action[6:], params)
    raise SidecarError(code='UNKNOWN_COMMAND', message='Unknown desktop operation.')
