"""A RemoteStore backed by a directory that some other program keeps in step.

Google Drive's desktop client, rclone, Syncthing -- the user points at a folder
and their existing tool moves the bytes. That buys real cross-device sync with
no OAuth, no HTTP client, and no token to store, and it costs the guarantees a
real object store would give: no atomic writes across devices, no locks, no
ordering, and occasional debris left behind by whichever client is in use.

Everything here is written for those conditions rather than around them.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from ..profiles import utc_now_iso
from ..protocol import SidecarError
from .remote import RemoteEntry, RemoteHealth, RemoteLock, RemoteStore, WriteOutcome

SYNC_ROOT_INVALID = "SYNC_ROOT_INVALID"

MAX_OBJECT_BYTES = 512 * 1024 * 1024
MAX_LOCK_BYTES = 8 * 1024
MAX_KEY_LENGTH = 200
SYNC_FILE_MODE = 0o600
SYNC_DIR_MODE = 0o700

_KEY_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

# Debris the syncing clients leave next to a real file when two devices wrote at
# once. These are never data: reading one would present another device's older
# state as though it were current, and listing one would make the engine chase a
# profile id that does not exist.
_CONFLICT_MARKERS = (
    ".sync-conflict-",       # Syncthing
    " (conflicted copy",     # Dropbox, and Drive in some locales
    ".~tmp",                 # partial write in progress
)
_CONFLICT_SUFFIX = re.compile(r" \(\d+\)$")


@dataclass(frozen=True)
class _Resolved:
    path: Path


def is_conflict_artifact(name: str) -> bool:
    """Whether a filename is a syncing client's leftover rather than our data."""
    if any(marker in name for marker in _CONFLICT_MARKERS):
        return True
    stem = name.rsplit(".", 1)[0] if "." in name else name
    # "meta (1).json" -- Drive's answer to two devices writing the same name.
    return bool(_CONFLICT_SUFFIX.search(stem))


class FolderRemoteStore(RemoteStore):
    """A RemoteStore over a local directory."""

    def __init__(self, root: Path | str) -> None:
        self._root = Path(root)

    @property
    def root(self) -> Path:
        return self._root

    # -- lifecycle ---------------------------------------------------------

    def health(self) -> RemoteHealth:
        if not self._root.exists():
            return RemoteHealth(False, False, "The sync folder does not exist.")
        if not self._root.is_dir():
            return RemoteHealth(False, False, "The sync folder is not a directory.")
        probe = self._root / f".theprivator-write-probe-{uuid.uuid4().hex[:8]}"
        try:
            probe.write_bytes(b"")
            probe.unlink()
        except OSError as error:
            return RemoteHealth(True, False, f"The sync folder is not writable: {error.strerror or error}.")
        return RemoteHealth(True, True, "The sync folder is readable and writable.")

    # -- objects -----------------------------------------------------------

    def list(self, prefix: str) -> Sequence[RemoteEntry]:
        base = self._resolve_prefix(prefix)
        if not base.exists() or not base.is_dir():
            return []

        entries: list[RemoteEntry] = []
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(self._root).as_posix()
            if any(is_conflict_artifact(part) for part in path.relative_to(self._root).parts):
                continue
            try:
                size = path.stat().st_size
            except OSError:
                # Listed a moment ago, gone now: another device deleted it, or
                # the syncing client has not finished materialising it.
                continue
            entries.append(RemoteEntry(key=relative, size=size, etag=self._etag(path)))
        return entries

    def get(self, key: str) -> Optional[bytes]:
        path = self._resolve(key).path
        try:
            with path.open("rb") as handle:
                data = handle.read(MAX_OBJECT_BYTES + 1)
        except FileNotFoundError:
            return None
        except IsADirectoryError:
            return None
        except OSError as error:
            raise SidecarError(
                code=SYNC_ROOT_INVALID,
                message=f"The sync folder object could not be read: {error.strerror or 'unknown error'}.",
            ) from error

        if len(data) > MAX_OBJECT_BYTES:
            raise SidecarError(
                code=SYNC_ROOT_INVALID,
                message="A sync folder object is larger than this build will read.",
            )
        return data

    def put(self, key: str, data: bytes, *, expected_etag: Optional[str]) -> WriteOutcome:
        if len(data) > MAX_OBJECT_BYTES:
            raise SidecarError(
                code=SYNC_ROOT_INVALID,
                message="Refusing to write a sync folder object larger than this build will read back.",
            )

        path = self._resolve(key).path
        current = self._etag_if_present(path)
        if current != expected_etag:
            # Not an error: on a shared folder losing a write is a normal
            # outcome, and the caller decides whether to merge or retry.
            return WriteOutcome(ok=False, etag=None, current_etag=current)

        self._write_atomically(path, data)
        return WriteOutcome(ok=True, etag=hashlib.sha256(data).hexdigest(), current_etag=None)

    def delete(self, key: str) -> bool:
        path = self._resolve(key).path
        try:
            path.unlink()
        except FileNotFoundError:
            return False
        except OSError as error:
            raise SidecarError(
                code=SYNC_ROOT_INVALID,
                message=f"The sync folder object could not be removed: {error.strerror or 'unknown error'}.",
            ) from error
        return True

    # -- locks -------------------------------------------------------------

    def read_lock(self, key: str) -> Optional[RemoteLock]:
        path = self._resolve(key).path
        try:
            raw = path.read_bytes()[: MAX_LOCK_BYTES + 1]
        except FileNotFoundError:
            return None
        except OSError:
            return None

        if len(raw) > MAX_LOCK_BYTES:
            return None
        try:
            record = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            # A half-written lock is indistinguishable from no lock, and the
            # engine already refuses to break a lock on its own, so treating it
            # as absent cannot silently steal one.
            return None
        return _lock_from_mapping(record)

    def write_lock(self, key: str, lock: RemoteLock) -> bool:
        existing = self.read_lock(key)
        if existing is not None and existing.device_id != lock.device_id:
            return False

        payload = json.dumps(
            {
                "deviceId": lock.device_id,
                "deviceLabel": lock.device_label,
                "acquiredAt": lock.acquired_at,
                "nonce": lock.nonce,
            },
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
        self._write_atomically(self._resolve(key).path, payload)
        return True

    def clear_lock(self, key: str, *, device_id: Optional[str] = None) -> bool:
        if device_id is not None:
            existing = self.read_lock(key)
            if existing is not None and existing.device_id != device_id:
                # The claim moved on while this device was working; clearing it
                # would release a lock someone else is relying on.
                return False
        return self.delete(key)

    # -- internals ---------------------------------------------------------

    def _write_atomically(self, path: Path, data: bytes) -> None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            os.chmod(path.parent, SYNC_DIR_MODE)
        except OSError:
            # A sync folder often lives on a filesystem with its own permission
            # model; failing the write over a mode we cannot set would make the
            # feature unusable there for no security gain.
            pass

        handle, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=".tp-", suffix=".part")
        temporary_path = Path(temporary)
        try:
            with os.fdopen(handle, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary_path, SYNC_FILE_MODE)
            # Rename rather than write in place: a syncing client watching this
            # directory must never see a half-written file and upload it.
            os.replace(temporary_path, path)
        except OSError as error:
            temporary_path.unlink(missing_ok=True)
            raise SidecarError(
                code=SYNC_ROOT_INVALID,
                message=f"The sync folder could not be written: {error.strerror or 'unknown error'}.",
            ) from error

    def _etag(self, path: Path) -> str:
        """A content hash, deliberately not a timestamp.

        Two machines sharing a folder do not share a clock, and a syncing client
        rewrites mtimes as it pleases. Ordering by time would silently prefer
        whichever device is running fast.
        """
        digest = hashlib.sha256()
        try:
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        except OSError:
            return ""
        return digest.hexdigest()

    def _etag_if_present(self, path: Path) -> Optional[str]:
        if not path.exists():
            return None
        etag = self._etag(path)
        return etag or None

    def _resolve(self, key: str) -> _Resolved:
        return _Resolved(path=self._root / _validated_key(key))

    def _resolve_prefix(self, prefix: str) -> Path:
        if prefix in {"", "/"}:
            return self._root
        return self._root / _validated_key(prefix, allow_directory=True)


def _validated_key(key: Any, *, allow_directory: bool = False) -> str:
    """Reject anything that could escape the sync root.

    The root is the only absolute path the frontend supplies, and keys are built
    from profile ids and revisions that ultimately came from a shared folder --
    which is to say, from another machine. Neither is trusted here.
    """
    if not isinstance(key, str) or not key or len(key) > MAX_KEY_LENGTH:
        raise SidecarError(code=SYNC_ROOT_INVALID, message="A sync object key must be short text.")
    if key.startswith("/") or "\\" in key:
        raise SidecarError(code=SYNC_ROOT_INVALID, message="A sync object key must be relative.")

    segments = key.split("/")
    if not allow_directory and len(segments) > 4:
        raise SidecarError(code=SYNC_ROOT_INVALID, message="A sync object key is nested too deeply.")

    for segment in segments:
        if not _KEY_SEGMENT.match(segment):
            raise SidecarError(
                code=SYNC_ROOT_INVALID,
                message="A sync object key may only contain letters, digits, dots, dashes and underscores.",
            )
        if segment in {".", ".."}:
            raise SidecarError(code=SYNC_ROOT_INVALID, message="A sync object key may not traverse directories.")
    return key


def _lock_from_mapping(record: Any) -> Optional[RemoteLock]:
    if not isinstance(record, Mapping):
        return None
    device_id = record.get("deviceId")
    device_label = record.get("deviceLabel")
    acquired_at = record.get("acquiredAt")
    nonce = record.get("nonce")
    if not all(isinstance(value, str) and value for value in (device_id, device_label, acquired_at, nonce)):
        return None
    if len(device_label) > 64 or len(device_id) > 64 or len(nonce) > 64:
        return None
    return RemoteLock(
        device_id=device_id,
        device_label=device_label,
        acquired_at=acquired_at,
        nonce=nonce,
    )


def make_lock(device_id: str, device_label: str) -> RemoteLock:
    return RemoteLock(
        device_id=device_id,
        device_label=device_label,
        acquired_at=utc_now_iso(),
        nonce=uuid.uuid4().hex,
    )
