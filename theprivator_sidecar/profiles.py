"""Sidecar-owned persistent profile store and CRUD contract.

This module is the canonical owner for S02 profile truth. It deliberately does
not import the legacy GUI profile manager because that code persists runtime
state and absolute paths that the Tauri sidecar contract must not expose.
"""

from __future__ import annotations

import json
import math
import os
import re
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Iterable, List, Mapping, Optional, Sequence, Union

from .identity import DEFAULT_REAL_IDENTITY, curated_preset, normalize_identity, warnings_for_identity
from .protocol import (
    INVALID_REQUEST,
    PROFILE_DELETE_FAILED,
    PROFILE_DUPLICATE_NAME,
    PROFILE_INVALID_NAME,
    PROFILE_NOT_FOUND,
    PROFILE_STORE_CORRUPT,
    PROFILE_STORE_UNAVAILABLE,
    PROFILE_STORE_WRITE_FAILED,
    JsonObject,
    SidecarError,
)

STORE_VERSION = 2
STORE_DIR = "profile-store"
PROFILES_DIR = "profiles"
PROFILES_FILE = "profiles.json"
MAX_PROFILE_NAME_LENGTH = 100

_INVALID_PROFILE_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED_WINDOWS_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
}


@dataclass(frozen=True)
class ProfileDefaults:
    """Sidecar-owned browser/runtime defaults for a stored profile."""

    browser: str = "chromium"
    startUrl: str = "about:blank"
    proxyMode: str = "direct"
    fingerprintMode: str = "disabled"


@dataclass(frozen=True)
class ProfileStorage:
    """Relative storage targets owned by the sidecar profile store."""

    profileDir: str
    userDataDir: str


@dataclass(frozen=True)
class ProfileRecord:
    """One durable profile record persisted in ``profiles.json``."""

    id: str
    name: str
    createdAt: str
    updatedAt: str
    defaults: ProfileDefaults
    storage: ProfileStorage
    identity: JsonObject
    metadata: Optional[JsonObject] = None

    @classmethod
    def create(cls, name: str, metadata: Optional[Mapping[str, Any]] = None) -> "ProfileRecord":
        profile_id = str(uuid.uuid4())
        now = utc_now_iso()
        return cls(
            id=profile_id,
            name=name,
            createdAt=now,
            updatedAt=now,
            defaults=ProfileDefaults(),
            storage=storage_for_profile(profile_id),
            identity=default_identity(),
            metadata=normalize_profile_metadata(metadata),
        )

    @classmethod
    def from_dict(cls, data: Mapping[str, Any], *, store_version: int = STORE_VERSION) -> "ProfileRecord":
        if not isinstance(data, Mapping):
            raise_corrupt_store()

        allowed_fields = {
            "id",
            "name",
            "createdAt",
            "updatedAt",
            "defaults",
            "storage",
            "metadata",
        }
        if store_version == STORE_VERSION:
            allowed_fields.add("identity")
        if set(data) - allowed_fields:
            raise_corrupt_store()

        profile_id = data.get("id")
        name = data.get("name")
        created_at = data.get("createdAt")
        updated_at = data.get("updatedAt")
        defaults = data.get("defaults")
        storage = data.get("storage")
        metadata = (
            normalize_profile_metadata(
                data.get("metadata"),
                scrub_unsafe_legacy_fields=(store_version == 1),
            )
            if "metadata" in data
            else None
        )

        if not isinstance(profile_id, str) or not is_uuid(profile_id):
            raise_corrupt_store()
        if not isinstance(name, str) or not is_valid_profile_name(name):
            raise_corrupt_store()
        if not isinstance(created_at, str) or not is_utc_iso_timestamp(created_at):
            raise_corrupt_store()
        if not isinstance(updated_at, str) or not is_utc_iso_timestamp(updated_at):
            raise_corrupt_store()
        if defaults != asdict(ProfileDefaults()):
            raise_corrupt_store()

        expected_storage = asdict(storage_for_profile(profile_id))
        if storage != expected_storage:
            raise_corrupt_store()
        if PurePosixPath(expected_storage["profileDir"]).is_absolute():
            raise_corrupt_store()
        if PurePosixPath(expected_storage["userDataDir"]).is_absolute():
            raise_corrupt_store()

        if store_version == 1:
            identity = default_identity()
        elif store_version == STORE_VERSION:
            identity = normalize_profile_identity(data.get("identity"))
        else:
            raise_corrupt_store()

        return cls(
            id=profile_id,
            name=name,
            createdAt=created_at,
            updatedAt=updated_at,
            defaults=ProfileDefaults(),
            storage=storage_for_profile(profile_id),
            identity=identity,
            metadata=metadata,
        )

    def renamed(self, name: str) -> "ProfileRecord":
        return ProfileRecord(
            id=self.id,
            name=name,
            createdAt=self.createdAt,
            updatedAt=utc_now_iso(),
            defaults=self.defaults,
            storage=self.storage,
            identity=self.identity,
            metadata=self.metadata,
        )

    def with_identity(self, identity: Mapping[str, Any]) -> "ProfileRecord":
        return ProfileRecord(
            id=self.id,
            name=self.name,
            createdAt=self.createdAt,
            updatedAt=utc_now_iso(),
            defaults=self.defaults,
            storage=self.storage,
            identity=normalize_profile_identity(identity),
            metadata=self.metadata,
        )

    def to_dict(self) -> JsonObject:
        payload: JsonObject = {
            "id": self.id,
            "name": self.name,
            "createdAt": self.createdAt,
            "updatedAt": self.updatedAt,
            "defaults": asdict(self.defaults),
            "storage": asdict(self.storage),
            "identity": normalize_profile_identity(self.identity),
        }
        if self.metadata is not None:
            payload["metadata"] = normalize_profile_metadata(self.metadata)
        return payload


class ProfileStore:
    """Durable JSON profile store rooted in caller-provided app data."""

    def __init__(self, store_root: Union[str, Path]) -> None:
        self.store_root = Path(store_root)
        self.store_dir = self.store_root / STORE_DIR
        self.profiles_dir = self.store_dir / PROFILES_DIR
        self.store_file = self.store_dir / PROFILES_FILE

    def list(self) -> JsonObject:
        """Return the current profile list and store metadata."""
        profiles = self._read_profiles()
        return self._collection_response(profiles)

    def get(self, profile_id: str) -> ProfileRecord:
        """Load one profile record by id through the canonical store parser."""
        if not isinstance(profile_id, str) or not profile_id.strip():
            raise SidecarError(
                code=INVALID_REQUEST,
                message="Profile id is required.",
            )
        profiles = self._read_profiles()
        return self._find_profile(profiles, profile_id)

    def create(self, name: str) -> JsonObject:
        """Create a profile, persist it, and return the refreshed list."""
        return self._create_profile(name, metadata=None)

    def create_imported(self, name: str, metadata: Mapping[str, Any]) -> JsonObject:
        """Create an imported profile through the canonical profile-store path."""
        return self._create_profile(name, metadata=metadata)

    def _create_profile(
        self,
        name: str,
        metadata: Optional[Mapping[str, Any]],
    ) -> JsonObject:
        valid_name = normalize_profile_name(name)
        profiles = self._read_profiles()
        self._ensure_unique_name(profiles, valid_name)

        profile = ProfileRecord.create(valid_name, metadata=metadata)
        self._ensure_profile_directories(profile)
        updated_profiles = sort_profiles([*profiles, profile])
        self._write_profiles(updated_profiles)
        return self._collection_response(updated_profiles, profile=profile)

    def update(self, profile_id: str, name: str) -> JsonObject:
        """Rename one profile and return the changed profile plus refreshed list."""
        if not isinstance(profile_id, str) or not profile_id.strip():
            raise SidecarError(
                code=INVALID_REQUEST,
                message="Profile id is required.",
            )

        valid_name = normalize_profile_name(name)
        profiles = self._read_profiles()
        target = self._find_profile(profiles, profile_id)
        self._ensure_unique_name(profiles, valid_name, excluding_id=target.id)

        renamed = target.renamed(valid_name)
        updated_profiles = sort_profiles(
            [renamed if profile.id == target.id else profile for profile in profiles]
        )
        self._write_profiles(updated_profiles)
        return self._collection_response(updated_profiles, profile=renamed)

    def update_identity(self, profile_id: str, identity: Mapping[str, Any]) -> JsonObject:
        """Replace one profile identity and return validation warnings plus refreshed list."""
        if not isinstance(profile_id, str) or not profile_id.strip():
            raise SidecarError(
                code=INVALID_REQUEST,
                message="Profile id is required.",
            )

        profiles = self._read_profiles()
        target = self._find_profile(profiles, profile_id)
        updated = target.with_identity(identity)
        warnings = warnings_for_identity(updated.identity)
        updated_profiles = sort_profiles(
            [updated if profile.id == target.id else profile for profile in profiles]
        )
        self._write_profiles(updated_profiles)
        return self._collection_response(
            updated_profiles,
            profile=updated,
            warnings=warnings,
        )

    def apply_identity_preset(self, profile_id: str, preset_id: str) -> JsonObject:
        """Apply a curated identity preset to one profile and return warnings."""
        if not isinstance(profile_id, str) or not profile_id.strip():
            raise SidecarError(
                code=INVALID_REQUEST,
                message="Profile id is required.",
            )
        return self.update_identity(profile_id, curated_preset(preset_id))

    def delete(self, profile_id: str) -> JsonObject:
        """Delete only the profile record; browser user-data stays on disk."""
        if not isinstance(profile_id, str) or not profile_id.strip():
            raise SidecarError(
                code=INVALID_REQUEST,
                message="Profile id is required.",
            )

        profiles = self._read_profiles()
        target = self._find_profile(profiles, profile_id)
        updated_profiles = [profile for profile in profiles if profile.id != target.id]
        try:
            self._write_profiles(updated_profiles)
        except SidecarError as error:
            if error.code == PROFILE_STORE_WRITE_FAILED:
                raise SidecarError(
                    code=PROFILE_DELETE_FAILED,
                    message="Profile delete bookkeeping failed.",
                    detail_ref=error.detail_ref,
                ) from error
            raise
        return self._collection_response(updated_profiles)

    def _read_profiles(self) -> List[ProfileRecord]:
        self._ensure_store_root_readable()
        if not self.store_file.exists():
            return []
        if not self.store_file.is_file():
            raise_corrupt_store()

        try:
            with self.store_file.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except json.JSONDecodeError as exc:
            raise_corrupt_store(exc)
        except UnicodeDecodeError as exc:
            raise_corrupt_store(exc)
        except OSError as exc:
            raise SidecarError(
                code=PROFILE_STORE_UNAVAILABLE,
                message="Profile store is unavailable.",
            ) from exc

        profiles, needs_migration = parse_store_payload_for_read(payload)
        ensure_no_duplicate_names(profiles)
        sorted_profiles = sort_profiles(profiles)
        if needs_migration:
            self._write_profiles(sorted_profiles)
        return sorted_profiles

    def _write_profiles(self, profiles: Sequence[ProfileRecord]) -> None:
        try:
            self._ensure_write_layout()
            payload = {
                "storeVersion": STORE_VERSION,
                "profiles": [profile.to_dict() for profile in sort_profiles(profiles)],
            }
            temp_file = self.store_file.with_name(
                f".{self.store_file.name}.{uuid.uuid4().hex}.tmp"
            )
            try:
                with temp_file.open("w", encoding="utf-8") as handle:
                    json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_file, self.store_file)
            finally:
                if temp_file.exists():
                    temp_file.unlink()
        except SidecarError:
            raise
        except OSError as exc:
            raise SidecarError(
                code=PROFILE_STORE_WRITE_FAILED,
                message="Profile store write failed.",
            ) from exc

    def _ensure_store_root_readable(self) -> None:
        if self.store_root.exists() and not self.store_root.is_dir():
            raise SidecarError(
                code=PROFILE_STORE_UNAVAILABLE,
                message="Profile store is unavailable.",
            )
        if self.store_dir.exists() and not self.store_dir.is_dir():
            raise SidecarError(
                code=PROFILE_STORE_UNAVAILABLE,
                message="Profile store is unavailable.",
            )

    def _ensure_write_layout(self) -> None:
        try:
            if self.store_root.exists() and not self.store_root.is_dir():
                raise SidecarError(
                    code=PROFILE_STORE_UNAVAILABLE,
                    message="Profile store is unavailable.",
                )
            self.profiles_dir.mkdir(parents=True, exist_ok=True)
        except SidecarError:
            raise
        except OSError as exc:
            raise SidecarError(
                code=PROFILE_STORE_WRITE_FAILED,
                message="Profile store write failed.",
            ) from exc

    def _ensure_profile_directories(self, profile: ProfileRecord) -> None:
        try:
            user_data_dir = self.store_root / profile.storage.userDataDir
            user_data_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise SidecarError(
                code=PROFILE_STORE_WRITE_FAILED,
                message="Profile store write failed.",
            ) from exc

    def _find_profile(
        self, profiles: Iterable[ProfileRecord], profile_id: str
    ) -> ProfileRecord:
        for profile in profiles:
            if profile.id == profile_id:
                return profile
        raise SidecarError(
            code=PROFILE_NOT_FOUND,
            message="Profile was not found.",
        )

    def _ensure_unique_name(
        self,
        profiles: Iterable[ProfileRecord],
        name: str,
        excluding_id: Optional[str] = None,
    ) -> None:
        requested = name.casefold()
        for profile in profiles:
            if profile.id != excluding_id and profile.name.casefold() == requested:
                raise SidecarError(
                    code=PROFILE_DUPLICATE_NAME,
                    message="Profile name already exists.",
                )

    def _collection_response(
        self,
        profiles: Sequence[ProfileRecord],
        profile: Optional[ProfileRecord] = None,
        warnings: Optional[list[JsonObject]] = None,
    ) -> JsonObject:
        sorted_profiles = sort_profiles(profiles)
        response: JsonObject = {
            "storeVersion": STORE_VERSION,
            "profiles": [item.to_dict() for item in sorted_profiles],
            "count": len(sorted_profiles),
        }
        if profile is not None:
            response["profile"] = profile.to_dict()
        if warnings is not None:
            response["warnings"] = warnings
        return response


def parse_store_payload(payload: Any) -> List[ProfileRecord]:
    """Parse and validate the on-disk store JSON schema."""
    profiles, _needs_migration = parse_store_payload_for_read(payload)
    return profiles


def parse_store_payload_for_read(payload: Any) -> tuple[List[ProfileRecord], bool]:
    """Parse v1/v2 store payloads and report whether v1 should be rewritten."""
    if not isinstance(payload, Mapping):
        raise_corrupt_store()

    store_version = payload.get("storeVersion")
    if store_version not in {1, STORE_VERSION}:
        raise_corrupt_store()

    raw_profiles = payload.get("profiles")
    if not isinstance(raw_profiles, list):
        raise_corrupt_store()

    profiles = [
        ProfileRecord.from_dict(raw_profile, store_version=store_version)
        for raw_profile in raw_profiles
    ]
    return profiles, store_version == 1


def default_identity() -> JsonObject:
    """Return the normalized default real identity for a new or migrated profile."""
    return normalize_profile_identity(DEFAULT_REAL_IDENTITY)


def normalize_profile_identity(identity: Any) -> JsonObject:
    """Normalize profile identity before persistence or response serialization."""
    return normalize_identity(identity)


def storage_for_profile(profile_id: str) -> ProfileStorage:
    profile_dir = f"{STORE_DIR}/{PROFILES_DIR}/{profile_id}"
    return ProfileStorage(
        profileDir=profile_dir,
        userDataDir=f"{profile_dir}/user-data",
    )


def sort_profiles(profiles: Iterable[ProfileRecord]) -> List[ProfileRecord]:
    return sorted(profiles, key=lambda profile: (profile.name.casefold(), profile.name, profile.id))


def ensure_no_duplicate_names(profiles: Sequence[ProfileRecord]) -> None:
    seen = set()
    for profile in profiles:
        folded = profile.name.casefold()
        if folded in seen:
            raise_corrupt_store()
        seen.add(folded)


_SKIP_METADATA_VALUE = object()
_UNSAFE_METADATA_KEYS = {
    "absolutepath",
    "command",
    "debugport",
    "pid",
    "process",
    "proxyurl",
    "proxyuser",
    "proxyusername",
    "proxypass",
    "proxypassword",
    "rcport",
    "remotecontrolport",
    "remotedebuggingport",
    "status",
}


def normalize_profile_metadata(
    metadata: Optional[Mapping[str, Any]],
    *,
    scrub_unsafe_legacy_fields: bool = False,
) -> Optional[JsonObject]:
    """Return a JSON-safe copy of optional profile metadata.

    Legacy import metadata is deliberately constrained to a JSON object so old
    profile records can omit it and imported records cannot smuggle Python
    objects, paths, proxy-like values, debug ports, or non-finite numbers into
    ``profiles.json``. During v1 migration only, formerly persisted sensitive
    optional fields are scrubbed so otherwise valid M001 profiles can be safely
    rewritten as v2 records.
    """
    if metadata is None:
        return None
    if not isinstance(metadata, Mapping):
        raise_corrupt_store()
    normalized: JsonObject = {}
    for key, value in metadata.items():
        if not _is_string_key(key, scrub_unsafe_legacy_fields=scrub_unsafe_legacy_fields):
            continue
        safe_value = _json_safe_metadata_value(value, scrub_unsafe_legacy_fields=scrub_unsafe_legacy_fields)
        if safe_value is _SKIP_METADATA_VALUE:
            continue
        normalized[key] = safe_value
    return normalized


def _is_string_key(key: Any, *, scrub_unsafe_legacy_fields: bool = False) -> bool:
    if not isinstance(key, str) or not key:
        raise_corrupt_store()
    if _is_unsafe_metadata_key(key):
        if scrub_unsafe_legacy_fields:
            return False
        raise_corrupt_store()
    return True


def _is_unsafe_metadata_key(key: str) -> bool:
    folded = key.casefold()
    return folded in _UNSAFE_METADATA_KEYS or "proxy" in folded or "debugport" in folded


def _json_safe_metadata_value(value: Any, *, scrub_unsafe_legacy_fields: bool = False) -> Any:
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, str):
        if _is_safe_metadata_string(value):
            return value
        if scrub_unsafe_legacy_fields:
            return _SKIP_METADATA_VALUE
        raise_corrupt_store()
    if isinstance(value, float):
        if math.isfinite(value):
            return value
        raise_corrupt_store()
    if isinstance(value, list):
        normalized_items = []
        for item in value:
            safe_item = _json_safe_metadata_value(item, scrub_unsafe_legacy_fields=scrub_unsafe_legacy_fields)
            if safe_item is not _SKIP_METADATA_VALUE:
                normalized_items.append(safe_item)
        return normalized_items
    if isinstance(value, Mapping):
        normalized: JsonObject = {}
        for key, nested_value in value.items():
            if not _is_string_key(key, scrub_unsafe_legacy_fields=scrub_unsafe_legacy_fields):
                continue
            safe_value = _json_safe_metadata_value(nested_value, scrub_unsafe_legacy_fields=scrub_unsafe_legacy_fields)
            if safe_value is not _SKIP_METADATA_VALUE:
                normalized[key] = safe_value
        return normalized
    raise_corrupt_store()


def _is_safe_metadata_string(value: str) -> bool:
    if _contains_control_characters(value):
        return False
    return not (
        PurePosixPath(value).is_absolute()
        or PureWindowsPath(value).is_absolute()
        or "://" in value
    )


def _contains_control_characters(value: str) -> bool:
    return any(ord(character) < 32 for character in value)


def normalize_profile_name(name: str) -> str:
    if not isinstance(name, str):
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Profile name is required.",
        )
    if not is_valid_profile_name(name):
        raise SidecarError(
            code=PROFILE_INVALID_NAME,
            message="Profile name is invalid.",
        )
    return name


def is_valid_profile_name(name: str) -> bool:
    if not name or not name.strip():
        return False
    if name != name.strip():
        return False
    if len(name) > MAX_PROFILE_NAME_LENGTH:
        return False
    if _INVALID_PROFILE_NAME.search(name):
        return False
    if name.endswith(".") or name.endswith(" "):
        return False

    reserved_candidate = name.split(".", 1)[0].upper()
    if reserved_candidate in _RESERVED_WINDOWS_NAMES:
        return False

    return True


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def is_utc_iso_timestamp(value: str) -> bool:
    if not value.endswith("Z"):
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return True


def is_uuid(value: str) -> bool:
    try:
        return str(uuid.UUID(value)) == value
    except ValueError:
        return False


def raise_corrupt_store(cause: Optional[BaseException] = None) -> None:
    error = SidecarError(
        code=PROFILE_STORE_CORRUPT,
        message="Profile store is corrupt.",
    )
    if cause is not None:
        raise error from cause
    raise error


def require_string_param(params: Mapping[str, Any], key: str, message: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value.strip():
        raise SidecarError(
            code=INVALID_REQUEST,
            message=message,
        )
    return value


__all__ = [
    "STORE_VERSION",
    "ProfileDefaults",
    "ProfileRecord",
    "ProfileStorage",
    "ProfileStore",
    "PROFILE_DELETE_FAILED",
    "PROFILE_DUPLICATE_NAME",
    "PROFILE_INVALID_NAME",
    "PROFILE_NOT_FOUND",
    "PROFILE_STORE_CORRUPT",
    "PROFILE_STORE_UNAVAILABLE",
    "PROFILE_STORE_WRITE_FAILED",
    "require_string_param",
]
