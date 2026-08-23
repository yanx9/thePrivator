"""What each device remembers about what it has already exchanged.

This file never leaves the machine. It is the *base* half of a three-way merge:
without a record of what this device last agreed with the remote, a divergence
is indistinguishable from a first-ever pull, and the engine would have to guess
which side is newer -- which is exactly the guess that loses data.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Mapping, Optional

from ..profiles import utc_now_iso
from ..protocol import SidecarError

SYNC_STATE_INVALID = "SYNC_STATE_INVALID"

STATE_FILE = "sync-state.json"
STATE_VERSION = 1
STATE_FILE_MODE = 0o600

MAX_DEVICE_LABEL_LENGTH = 64
MAX_TRACKED_PROFILES = 5000


@dataclass(frozen=True)
class ProfileSyncState:
    """What this device knows about one profile's last exchange.

    ``base_revision`` is the revision both sides agreed on. ``remote_etag`` is
    what the metadata read as at that moment, so a change can be detected
    without trusting any clock.
    """

    profile_id: str
    base_revision: int
    remote_etag: Optional[str]
    last_synced_at: Optional[str]
    payload_key: Optional[str] = None


@dataclass(frozen=True)
class SyncState:
    version: int = STATE_VERSION
    device_id: str = ""
    device_label: str = ""
    sync_root: Optional[str] = None
    enabled: bool = False
    last_run_at: Optional[str] = None
    profiles: dict[str, ProfileSyncState] = field(default_factory=dict)

    def for_profile(self, profile_id: str) -> Optional[ProfileSyncState]:
        return self.profiles.get(profile_id)

    def with_profile(self, entry: ProfileSyncState) -> "SyncState":
        if len(self.profiles) >= MAX_TRACKED_PROFILES and entry.profile_id not in self.profiles:
            raise SidecarError(
                code=SYNC_STATE_INVALID,
                message=f"Sync state tracks at most {MAX_TRACKED_PROFILES} profiles.",
            )
        updated = dict(self.profiles)
        updated[entry.profile_id] = entry
        return replace(self, profiles=updated)

    def without_profile(self, profile_id: str) -> "SyncState":
        if profile_id not in self.profiles:
            return self
        updated = dict(self.profiles)
        del updated[profile_id]
        return replace(self, profiles=updated)


def state_path(store_root: Path | str) -> Path:
    return Path(store_root) / STATE_FILE


def read_state(store_root: Path | str) -> SyncState:
    """Read this device's sync state, falling back to an empty one.

    A damaged state file is treated as "this device has never synced" rather
    than as an error. That is the safe direction: the engine then sees every
    profile as new on both sides and reports conflicts for the user to resolve,
    instead of refusing to sync at all or silently picking a winner.
    """
    path = state_path(store_root)
    try:
        raw = path.read_text(encoding="utf-8")
    except (FileNotFoundError, NotADirectoryError):
        return SyncState()
    except OSError as error:
        raise SidecarError(
            code=SYNC_STATE_INVALID,
            message=f"The sync state could not be read: {error.strerror or 'unknown error'}.",
        ) from error

    try:
        record = json.loads(raw)
    except json.JSONDecodeError:
        return SyncState()

    return _state_from_mapping(record)


def write_state(store_root: Path | str, state: SyncState) -> None:
    path = state_path(store_root)
    payload = json.dumps(
        {
            "version": STATE_VERSION,
            "deviceId": state.device_id,
            "deviceLabel": state.device_label,
            "syncRoot": state.sync_root,
            "enabled": state.enabled,
            "lastRunAt": state.last_run_at,
            "profiles": {
                profile_id: {
                    "profileId": entry.profile_id,
                    "baseRevision": entry.base_revision,
                    "remoteEtag": entry.remote_etag,
                    "lastSyncedAt": entry.last_synced_at,
                    "payloadKey": entry.payload_key,
                }
                for profile_id, entry in sorted(state.profiles.items())
            },
        },
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    ) + "\n"

    handle, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=".sync-state-", suffix=".part")
    temporary_path = Path(temporary)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        # Owner-only: it records the sync folder path and the device label the
        # user chose, neither of which other accounts on the machine need.
        os.chmod(temporary_path, STATE_FILE_MODE)
        os.replace(temporary_path, path)
    except OSError as error:
        temporary_path.unlink(missing_ok=True)
        raise SidecarError(
            code=SYNC_STATE_INVALID,
            message=f"The sync state could not be written: {error.strerror or 'unknown error'}.",
        ) from error


def normalize_device_label(value: Any, *, fallback: str = "This device") -> str:
    """A label a person picked, not a hostname.

    The hostname is real-world identifying information, and the whole point of
    this product is not leaking that. It also has to survive being shown back to
    the user as the confirmation for taking over someone else's lock, so it is
    kept printable and short.
    """
    if not isinstance(value, str):
        return fallback
    cleaned = "".join(character for character in value if character.isprintable()).strip()
    if not cleaned:
        return fallback
    return cleaned[:MAX_DEVICE_LABEL_LENGTH]


def _state_from_mapping(record: Any) -> SyncState:
    if not isinstance(record, Mapping):
        return SyncState()
    if record.get("version") != STATE_VERSION:
        # A state written by a newer build describes exchanges this one cannot
        # reason about. Starting fresh reports conflicts; trusting it would
        # skip a pull that is genuinely needed.
        return SyncState()

    profiles: dict[str, ProfileSyncState] = {}
    raw_profiles = record.get("profiles")
    if isinstance(raw_profiles, Mapping):
        for profile_id, entry in list(raw_profiles.items())[:MAX_TRACKED_PROFILES]:
            parsed = _profile_from_mapping(profile_id, entry)
            if parsed is not None:
                profiles[parsed.profile_id] = parsed

    sync_root = record.get("syncRoot")
    return SyncState(
        version=STATE_VERSION,
        device_id=record.get("deviceId") if isinstance(record.get("deviceId"), str) else "",
        device_label=normalize_device_label(record.get("deviceLabel")),
        sync_root=sync_root if isinstance(sync_root, str) and sync_root else None,
        enabled=record.get("enabled") is True,
        last_run_at=record.get("lastRunAt") if isinstance(record.get("lastRunAt"), str) else None,
        profiles=profiles,
    )


def _profile_from_mapping(profile_id: Any, entry: Any) -> Optional[ProfileSyncState]:
    if not isinstance(profile_id, str) or not profile_id or not isinstance(entry, Mapping):
        return None
    revision = entry.get("baseRevision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        return None
    etag = entry.get("remoteEtag")
    payload_key = entry.get("payloadKey")
    return ProfileSyncState(
        profile_id=profile_id,
        base_revision=revision,
        remote_etag=etag if isinstance(etag, str) and etag else None,
        last_synced_at=entry.get("lastSyncedAt") if isinstance(entry.get("lastSyncedAt"), str) else None,
        payload_key=payload_key if isinstance(payload_key, str) and payload_key else None,
    )


def touch_run(state: SyncState) -> SyncState:
    return replace(state, last_run_at=utc_now_iso())


def state_as_public_dict(state: SyncState) -> dict[str, Any]:
    """The parts of the state the UI may see.

    The sync root is a filesystem path outside the store, so it is reported as a
    boolean and a basename rather than in full: the redaction perimeter treats
    absolute paths as leaks, and the user already knows which folder they chose.
    """
    root = Path(state.sync_root) if state.sync_root else None
    return {
        "enabled": state.enabled,
        "configured": root is not None,
        "folderName": root.name if root is not None else None,
        "deviceLabel": state.device_label,
        "lastRunAt": state.last_run_at,
        "trackedProfiles": len(state.profiles),
    }
