"""Optional sealed storage. Plain browser files exist only while unlocked.

A fresh AES-256-GCM snapshot is committed before plaintext removal. The phase
marker makes interrupted sealing/restoration recoverable without overwriting
newer unlocked data. Keys leave this module only over private sidecar IPC to the
native supervisor; they must never reach the webview, logs or disk.
"""
from __future__ import annotations
import base64
import json
import os
import shutil
import tarfile
import time
from pathlib import Path, PurePosixPath
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from .desktop_data import atomic_json, sync_directory
from .protocol import SidecarError

MAGIC = b'TPVLT001'
AAD = b'ThePrivator vault v1'
ITEMS = ('profile-store', 'sync-state.json')
CHUNK = 1024 * 1024


def fail(message: str, code: str = 'VAULT_ERROR'):
    raise SidecarError(code=code, message=message)


def read_config(root: Path) -> dict | None:
    path = root / 'vault.json'
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text())
        if value['version'] != 1 or value['phase'] not in ('active', 'sealing', 'sealed'):
            raise ValueError()
        for key, size in [('salt', 16), ('nonce', 12), ('wrappedKey', 48)]:
            if len(base64.b64decode(value[key], validate=True)) != size:
                raise ValueError()
        return value
    except (ValueError, KeyError, TypeError, OSError):
        fail('The vault configuration is damaged. Restore a backup; existing data has been preserved.')


def status(root: Path) -> dict:
    config = read_config(root)
    return {'enabled': config is not None, 'locked': config is not None,
            'recoveryRequired': bool(config and config['phase'] != 'sealed')}


def derive(password: str, salt: bytes) -> bytes:
    if not isinstance(password, str) or not 6 <= len(password) <= 1024:
        fail('Use a PIN or password of 6 to 1024 characters.', 'VAULT_PASSWORD_INVALID')
    return Scrypt(salt=salt, length=32, n=2**17, r=8, p=1).derive(password.encode('utf-8'))


def unwrap(config: dict, password: str) -> bytes:
    try:
        key = derive(password, base64.b64decode(config['salt']))
        return AESGCM(key).decrypt(base64.b64decode(config['nonce']), base64.b64decode(config['wrappedKey']), AAD)
    except InvalidTag:
        fail('Incorrect PIN or password.', 'VAULT_PASSWORD_INVALID')


def stop_writers(root: Path) -> None:
    from . import chromium, cookie_bot
    # Workers can launch browsers again; cancel and wait before stopping Chromium.
    jobs = root / 'profile-store' / 'runtime' / 'cookie-bot'
    for path in jobs.glob('*.json'):
        try:
            job = json.loads(path.read_text())
            if cookie_bot._worker_alive(job):
                cookie_bot.cancel_path(path, job['jobId']).touch(mode=0o600)
                deadline = time.monotonic() + 15
                while cookie_bot._worker_alive(job) and time.monotonic() < deadline:
                    time.sleep(.1)
                if cookie_bot._worker_alive(job):
                    fail('A background job is still stopping. Try locking again.')
        except (ValueError, KeyError):
            fail('A background job could not be verified. Stop it before locking.')
    result = chromium.bulk_stop(root)
    if result['failed'] or result['runningCount']:
        fail('A browser could not be stopped. The vault remains unlocked; try again.')


class EncryptWriter:
    def __init__(self, output, encryptor):
        self.output, self.encryptor = output, encryptor
    def write(self, data):
        self.output.write(self.encryptor.update(data))
        return len(data)


class DecryptReader:
    def __init__(self, source, key):
        self.source = source
        source.seek(0, 2)
        size = source.tell()
        if size < len(MAGIC) + 12 + 16:
            fail('The encrypted vault is incomplete.')
        source.seek(0)
        if source.read(8) != MAGIC:
            fail('The encrypted vault format is unsupported.')
        nonce = source.read(12)
        source.seek(-16, 2)
        tag = source.read(16)
        source.seek(20)
        self.remaining = size - 36
        self.decryptor = Cipher(algorithms.AES(key), modes.GCM(nonce, tag)).decryptor()
        self.decryptor.authenticate_additional_data(AAD)
        self.finished = False
    def read(self, size=CHUNK):
        size = min(size if size >= 0 else CHUNK, self.remaining, CHUNK)
        if size:
            data = self.source.read(size)
            if len(data) != size:
                fail('The encrypted vault is incomplete.')
            self.remaining -= size
            return self.decryptor.update(data)
        if not self.finished:
            self.decryptor.finalize()
            self.finished = True
        return b''


def verify(source, key):
    reader = DecryptReader(source, key)
    while reader.read():
        pass


def archive_filter(member):
    # Browser singleton sockets/links are ephemeral. Never follow external links.
    if member.issym() or member.islnk():
        if PurePosixPath(member.name).name.startswith('Singleton'):
            return None
        fail('A profile contains a symbolic link. Remove the link before enabling or locking the vault.')
    if not member.isfile() and not member.isdir():
        fail('A profile contains an unsupported special file.')
    member.uid = member.gid = 0
    member.uname = member.gname = ''
    return member


def remove_plaintext(root):
    for name in ITEMS:
        path = root / name
        if path.is_symlink():
            fail('The data folder must not be a symbolic link.')
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)
    sync_directory(root)


def seal(root: Path, config: dict, key: bytes):
    stop_writers(root)
    if config['phase'] in ('sealed', 'sealing'):
        # A prior seal committed successfully but plaintext cleanup was interrupted.
        # Never replace that complete snapshot with the remaining partial files.
        with (root / 'vault.bin').open('rb') as source:
            verify(source, key)
        remove_plaintext(root)
        atomic_json(root / 'vault.json', {**config, 'phase': 'sealed'})
        return
    target = root / 'vault.bin'
    temporary = root / 'vault.bin.next'
    temporary.unlink(missing_ok=True)
    try:
        with temporary.open('xb') as output:
            os.chmod(temporary, 0o600)
            nonce = os.urandom(12)
            encryptor = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
            encryptor.authenticate_additional_data(AAD)
            output.write(MAGIC + nonce)
            with tarfile.open(fileobj=EncryptWriter(output, encryptor), mode='w|') as archive:
                for name in ITEMS:
                    if (root / name).exists():
                        archive.add(root / name, arcname=name, filter=archive_filter)
            output.write(encryptor.finalize())
            output.write(encryptor.tag)
            output.flush()
            os.fsync(output.fileno())
        with temporary.open('rb') as source:
            verify(source, key)
        os.replace(temporary, target)
        sync_directory(root)
        atomic_json(root / 'vault.json', {**config, 'phase': 'sealing'})
        remove_plaintext(root)
        atomic_json(root / 'vault.json', {**config, 'phase': 'sealed'})
    finally:
        temporary.unlink(missing_ok=True)


def restore(root: Path, config: dict, key: bytes):
    if config['phase'] == 'active':
        # This is the latest data after an interrupted unlocked session.
        return
    stage = root / '.vault-restore'
    try:
        with (root / 'vault.bin').open('rb') as source:
            # Authenticate the entire snapshot BEFORE writing any plaintext.
            verify(source, key)
            if stage.exists():
                shutil.rmtree(stage)
            stage.mkdir(mode=0o700)
            reader = DecryptReader(source, key)
            with tarfile.open(fileobj=reader, mode='r|') as archive:
                for member in archive:
                    parts = PurePosixPath(member.name).parts
                    if not parts or parts[0] not in ITEMS or '..' in parts or '\\' in member.name or member.name.startswith('/'):
                        fail('The encrypted vault contains an invalid entry.')
                    if not member.isdir() and not member.isfile():
                        fail('The encrypted vault contains an unsupported entry.')
                    destination = stage.joinpath(*parts)
                    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    if member.isdir():
                        destination.mkdir(exist_ok=True, mode=0o700)
                    else:
                        with destination.open('xb') as output:
                            os.chmod(destination, 0o600)
                            shutil.copyfileobj(archive.extractfile(member), output, CHUNK)
                            output.flush()
                            os.fsync(output.fileno())
            while reader.read():
                pass
        # Persist nested directory entries before committing the active phase.
        # File fsync alone does not preserve their names after a power loss.
        for directory, _, _ in os.walk(stage, topdown=False):
            sync_directory(Path(directory))
        remove_plaintext(root)
        for name in ITEMS:
            if (stage / name).exists():
                os.replace(stage / name, root / name)
        sync_directory(root)
        atomic_json(root / 'vault.json', {**config, 'phase': 'active'})
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def _command(root: Path, action: str, params: dict) -> dict:
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        config = read_config(root)
        if action == 'status':
            return status(root)
        if action == 'enable':
            if config:
                fail('Vault protection is already enabled.')
            salt, nonce, key = os.urandom(16), os.urandom(12), os.urandom(32)
            wrapping = derive(params.get('password'), salt)
            config = {'version': 1, 'phase': 'active', 'salt': base64.b64encode(salt).decode(),
                      'nonce': base64.b64encode(nonce).decode(),
                      'wrappedKey': base64.b64encode(AESGCM(wrapping).encrypt(nonce, key, AAD)).decode()}
            stop_writers(root)
            atomic_json(root / 'vault.json', config)
            seal(root, config, key)
        elif action == 'unlock':
            if not config:
                fail('Vault protection is not enabled.')
            key = unwrap(config, params.get('password'))
            restore(root, config, key)
            return {'enabled': True, 'locked': False, 'recoveryRequired': False,
                    'sessionKey': base64.b64encode(key).decode()}
        elif action == 'lock':
            if not config:
                return status(root)
            key = base64.b64decode(params.get('sessionKey', ''), validate=True)
            if len(key) != 32:
                fail('Unlock the vault before locking it.', 'VAULT_LOCKED')
            seal(root, config, key)
        elif action == 'disable':
            if not config:
                return status(root)
            key = unwrap(config, params.get('password'))
            stop_writers(root)
            restore(root, config, key)
            (root / 'vault.json').unlink()
            sync_directory(root)
            (root / 'vault.bin').unlink(missing_ok=True)
        else:
            fail('Unknown vault operation.')
        return status(root)
    except InvalidTag:
        fail('The encrypted vault failed its integrity check. Existing data has been preserved.')
    except (OSError, ValueError, tarfile.TarError):
        fail('The vault operation could not finish. Check free disk space and permissions, then retry. Existing data has been preserved.')


def command(root: Path, action: str, params: dict) -> dict:
    from .storage_access import activity_lock
    if action == 'status':
        return status(root)
    # Native supervisor stops its API first. An independent API holds a shared
    # lease and prevents sealing, instead of racing encryption in another process.
    with activity_lock(root, exclusive=True, check=False):
        return _command(root, action, params)
