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
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Iterable, List, Mapping, Optional, Sequence, Union

from .identity import DEFAULT_REAL_IDENTITY, curated_preset, normalize_identity, warnings_for_identity
from .profile_sections import (
    default_launch,
    default_lifecycle,
    default_organization,
    default_sync,
    normalize_launch as normalize_profile_launch,
    normalize_lifecycle,
    normalize_organization,
    normalize_sync,
    start_urls_for_launch,
)
from .launch_args import validate_user_launch_args
from .proxy import default_proxy_config, is_proxy_secret_key, normalize_proxy_config, public_proxy_summary
from .protocol import (
    INVALID_REQUEST,
    PROFILE_DELETE_FAILED,
    PROFILE_DUPLICATE_NAME,
    PROFILE_INVALID_NAME,
    PROFILE_NOT_FOUND,
    PROFILE_STORE_CORRUPT,
    PROFILE_STORE_UNAVAILABLE,
    PROFILE_STORE_VERSION_TOO_NEW,
    PROFILE_STORE_WRITE_FAILED,
    JsonObject,
    SidecarError,
)

STORE_VERSION = 4
SUPPORTED_READ_STORE_VERSIONS = frozenset({1, 2, 3, STORE_VERSION})
DEVICE_FILE = "device.json"
STORE_DIR = "profile-store"
PROFILES_DIR = "profiles"
PROFILES_FILE = "profiles.json"
MAX_PROFILE_NAME_LENGTH = 100
# profiles.json holds proxy credentials in the clear, so it must never be
# readable by other local accounts. os.replace preserves the source file's
# mode, so creating the temp file 0600 makes the swap atomic in permissions
# as well as contents -- there is no window where the store is world-readable.
STORE_FILE_MODE = 0o600

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
    proxy: JsonObject = field(default_factory=default_proxy_config)
    metadata: Optional[JsonObject] = None
    organization: JsonObject = field(default_factory=default_organization)
    launch: JsonObject = field(default_factory=default_launch)
    lifecycle: JsonObject = field(default_factory=default_lifecycle)
    sync: JsonObject = field(default_factory=lambda: default_sync(local_device_id()))


    @classmethod
    def create(
        cls,
        name: str,
        metadata: Optional[Mapping[str, Any]] = None,
        *,
        device_id: Optional[str] = None,
    ) -> "ProfileRecord":
        profile_id = str(uuid.uuid4())
        now = utc_now_iso()
        proxy = default_proxy_config()
        identity = default_identity()
        launch = default_launch()
        return cls(
            id=profile_id,
            name=name,
            createdAt=now,
            updatedAt=now,
            defaults=derive_defaults(proxy=proxy, identity=identity, launch=launch),
            storage=storage_for_profile(profile_id),
            identity=identity,
            proxy=proxy,
            metadata=normalize_profile_metadata(metadata),
            organization=default_organization(),
            launch=launch,
            lifecycle=default_lifecycle(),
            sync=default_sync(device_id or local_device_id()),
        )

    @classmethod
    def create_from_package(
        cls,
        name: str,
        *,
        identity: Mapping[str, Any],
        proxy: Mapping[str, Any],
        metadata: Optional[Mapping[str, Any]] = None,
        device_id: Optional[str] = None,
        profile_id: Optional[str] = None,
        organization: Optional[Mapping[str, Any]] = None,
        launch_override: Optional[Mapping[str, Any]] = None,
        revision: Optional[int] = None,
    ) -> "ProfileRecord":
        """Create an imported package record with sidecar-normalized safe fields.

        ``profile_id`` is supplied only by sync, where a profile has to keep the
        same identity on every device -- two machines calling the same profile by
        different ids would make every exchange look like a new profile and grow
        a duplicate on each run. It is validated as a uuid rather than trusted,
        because it arrived from a shared folder.
        """
        if profile_id is None:
            profile_id = str(uuid.uuid4())
        else:
            try:
                profile_id = str(uuid.UUID(str(profile_id)))
            except (ValueError, AttributeError, TypeError):
                raise SidecarError(
                    code=INVALID_REQUEST,
                    message="An imported profile id must be a uuid.",
                ) from None
        now = utc_now_iso()
        normalized_proxy = normalize_proxy_config(proxy)
        normalized_identity = normalize_profile_identity(identity)
        launch = default_launch() if launch_override is None else normalize_profile_launch(launch_override)
        return cls(
            id=profile_id,
            name=name,
            createdAt=now,
            updatedAt=now,
            defaults=derive_defaults(proxy=normalized_proxy, identity=normalized_identity, launch=launch),
            storage=storage_for_profile(profile_id),
            identity=normalized_identity,
            proxy=normalized_proxy,
            metadata=normalize_profile_metadata(metadata),
            organization=default_organization() if organization is None else normalize_organization(organization),
            launch=launch,
            lifecycle=default_lifecycle(),
            sync=_sync_at_revision(device_id or local_device_id(), revision),
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
        if store_version >= 2:
            allowed_fields.add("identity")
        if store_version >= 3:
            allowed_fields.add("proxy")
        if store_version >= STORE_VERSION:
            allowed_fields.update({"organization", "launch", "lifecycle", "sync"})
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

        proxy = proxy_for_store_version(data, store_version)

        if store_version == 1:
            identity = default_identity()
        elif store_version >= 2:
            identity = normalize_profile_identity(data.get("identity"))
        else:
            raise_corrupt_store()

        # Sections a pre-v4 record never had; a migrated profile starts them at
        # their inert defaults rather than inventing content.
        launch = normalize_profile_launch(data.get("launch")) if store_version >= STORE_VERSION else default_launch()
        organization = (
            normalize_organization(data.get("organization")) if store_version >= STORE_VERSION else default_organization()
        )
        lifecycle = (
            normalize_lifecycle(data.get("lifecycle")) if store_version >= STORE_VERSION else default_lifecycle()
        )
        sync = (
            normalize_sync(data.get("sync"), device_id=local_device_id())
            if store_version >= STORE_VERSION
            else default_sync(local_device_id())
        )

        if defaults != asdict(
            defaults_for_store_version(store_version, proxy=proxy, identity=identity, launch=launch)
        ):
            raise_corrupt_store()

        expected_storage = asdict(storage_for_profile(profile_id))
        if storage != expected_storage:
            raise_corrupt_store()
        if PurePosixPath(expected_storage["profileDir"]).is_absolute():
            raise_corrupt_store()
        if PurePosixPath(expected_storage["userDataDir"]).is_absolute():
            raise_corrupt_store()

        return cls(
            id=profile_id,
            name=name,
            createdAt=created_at,
            updatedAt=updated_at,
            defaults=derive_defaults(proxy=proxy, identity=identity, launch=launch),
            storage=storage_for_profile(profile_id),
            identity=identity,
            proxy=proxy,
            metadata=metadata,
            organization=organization,
            launch=launch,
            lifecycle=lifecycle,
            sync=sync,
        )

    def _evolve(self, **changes: Any) -> "ProfileRecord":
        """Return a mutated copy, always stamping updatedAt and bumping the revision.

        This replaced three near-identical constructors that each re-listed every
        field. With four more sections that was untenable, but the real reason is
        sync: every one of them was a place to forget the revision bump, and a
        missed bump makes a local edit invisible to the other machine. Routing
        every mutation through one place makes forgetting structurally impossible.
        """
        proxy = normalize_proxy_config(changes.pop("proxy", self.proxy))
        identity = normalize_profile_identity(changes.pop("identity", self.identity))
        launch = normalize_profile_launch(changes.pop("launch", self.launch))
        organization = normalize_organization(changes.pop("organization", self.organization))
        lifecycle = normalize_lifecycle(changes.pop("lifecycle", self.lifecycle))
        device_id = changes.pop("device_id", None) or local_device_id()
        sync = {
            **normalize_sync(changes.pop("sync", self.sync), device_id=device_id),
        }
        sync["revision"] = int(sync["revision"]) + 1
        sync["updatedBy"] = device_id

        return replace(
            self,
            proxy=proxy,
            identity=identity,
            launch=launch,
            organization=organization,
            lifecycle=lifecycle,
            sync=sync,
            updatedAt=utc_now_iso(),
            defaults=derive_defaults(proxy=proxy, identity=identity, launch=launch),
            **changes,
        )

    def renamed(self, name: str, *, device_id: Optional[str] = None) -> "ProfileRecord":
        return self._evolve(name=name, device_id=device_id)

    def with_identity(self, identity: Mapping[str, Any], *, device_id: Optional[str] = None) -> "ProfileRecord":
        return self._evolve(identity=identity, device_id=device_id)

    def with_proxy(self, proxy: Mapping[str, Any], *, device_id: Optional[str] = None) -> "ProfileRecord":
        return self._evolve(proxy=proxy, device_id=device_id)

    def with_organization(self, organization: Mapping[str, Any], *, device_id: Optional[str] = None) -> "ProfileRecord":
        return self._evolve(organization=organization, device_id=device_id)

    def with_launch(self, launch: Mapping[str, Any], *, device_id: Optional[str] = None) -> "ProfileRecord":
        return self._evolve(launch=launch, device_id=device_id)

    def trashed(self, *, device_id: Optional[str] = None) -> "ProfileRecord":
        return self._evolve(lifecycle={**self.lifecycle, "deletedAt": utc_now_iso()}, device_id=device_id)

    def restored(self, *, name: Optional[str] = None, device_id: Optional[str] = None) -> "ProfileRecord":
        changes: dict[str, Any] = {"lifecycle": {**self.lifecycle, "deletedAt": None}}
        if name is not None:
            changes["name"] = name
        return self._evolve(**changes, device_id=device_id)

    @property
    def is_trashed(self) -> bool:
        return self.lifecycle.get("deletedAt") is not None

    def to_store_dict(self) -> JsonObject:
        """Return the private persisted shape, including raw proxy credentials."""
        proxy = normalize_proxy_config(self.proxy)
        payload: JsonObject = {
            "id": self.id,
            "name": self.name,
            "createdAt": self.createdAt,
            "updatedAt": self.updatedAt,
            "defaults": asdict(derive_defaults(proxy=proxy, identity=self.identity, launch=self.launch)),
            "storage": asdict(self.storage),
            "identity": normalize_profile_identity(self.identity),
            "proxy": proxy,
            "organization": normalize_organization(self.organization),
            "launch": normalize_profile_launch(self.launch),
            "lifecycle": normalize_lifecycle(self.lifecycle),
            "sync": normalize_sync(self.sync, device_id=local_device_id()),
        }
        if self.metadata is not None:
            payload["metadata"] = normalize_profile_metadata(self.metadata)
        return payload

    def to_public_dict(self) -> JsonObject:
        """Return the redaction-safe command/UI shape for a profile."""
        proxy = normalize_proxy_config(self.proxy)
        payload: JsonObject = {
            "id": self.id,
            "name": self.name,
            "createdAt": self.createdAt,
            "updatedAt": self.updatedAt,
            "defaults": asdict(derive_defaults(proxy=proxy, identity=self.identity, launch=self.launch)),
            "storage": asdict(self.storage),
            "identity": normalize_profile_identity(self.identity),
            "proxy": public_proxy_summary(proxy),
            "organization": normalize_organization(self.organization),
            "launch": normalize_profile_launch(self.launch),
            "lifecycle": normalize_lifecycle(self.lifecycle),
            "sync": normalize_sync(self.sync, device_id=local_device_id()),
        }
        if self.metadata is not None:
            payload["metadata"] = normalize_profile_metadata(self.metadata)
        return payload

    def to_dict(self) -> JsonObject:
        """Backward-compatible alias for the private persisted shape."""
        return self.to_store_dict()


class ProfileStore:
    """Durable JSON profile store rooted in caller-provided app data."""

    def __init__(self, store_root: Union[str, Path]) -> None:
        self.store_root = Path(store_root)
        self.store_dir = self.store_root / STORE_DIR
        self.profiles_dir = self.store_dir / PROFILES_DIR
        self.store_file = self.store_dir / PROFILES_FILE

    @property
    def device_id(self) -> str:
        """This installation's sync identity, persisted under this store root.

        Resolved from the store rather than a record constructor: a record does
        not know which store it belongs to, and an earlier draft that guessed
        wrote files into the user's home instead. Records take it as a parameter
        so every write from this store stamps the same, restart-stable id.
        """
        return local_device_id(self.store_root)

    def records(self) -> List["ProfileRecord"]:
        """Every stored record, live and trashed, in one read.

        Callers that need the record objects rather than their public
        dictionaries would otherwise call get() in a loop and re-read the whole
        store once per profile.
        """
        return list(self._read_profiles())

    def list(self) -> JsonObject:
        """The profile library as the user sees it: everything except the trash."""
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

    def create_profile_package_import(
        self,
        name: str,
        *,
        identity: Mapping[str, Any],
        proxy: Mapping[str, Any],
        metadata: Mapping[str, Any],
    ) -> JsonObject:
        """Commit a validated .tpkg import as a new stopped profile record."""
        valid_name = normalize_profile_name(name)
        profiles = self._read_profiles()
        self._ensure_unique_name(profiles, valid_name)

        profile = ProfileRecord.create_from_package(
            valid_name,
            identity=identity,
            proxy=proxy,
            metadata=metadata,
            device_id=self.device_id,
        )
        self._ensure_profile_directories(profile)
        updated_profiles = sort_profiles([*profiles, profile])
        self._write_profiles(updated_profiles)
        return self._collection_response(updated_profiles, profile=profile)

    def create_synced_profile(
        self,
        name: str,
        *,
        identity: Mapping[str, Any],
        proxy: Mapping[str, Any],
        profile_id: Optional[str],
        organization: Mapping[str, Any],
        launch: Mapping[str, Any],
        revision: int,
    ) -> JsonObject:
        """Commit a profile that arrived from another device.

        Unlike a package import this keeps the profile id, because a profile has
        to be the same profile on every machine -- two devices calling it by
        different ids would make every exchange look like a first meeting and
        grow a duplicate on each run.
        """
        valid_name = normalize_profile_name(name)
        profiles = self._read_profiles()
        self._ensure_unique_name(profiles, valid_name)
        if profile_id is not None and any(profile.id == profile_id for profile in profiles):
            raise SidecarError(
                code=PROFILE_DUPLICATE_NAME,
                message="A profile with that id already exists on this device.",
            )

        profile = ProfileRecord.create_from_package(
            valid_name,
            identity=identity,
            proxy=proxy,
            metadata={"source": "profile-sync", "hasUserData": True},
            device_id=self.device_id,
            profile_id=profile_id,
            organization=organization,
            launch_override=launch,
            revision=revision,
        )
        self._ensure_profile_directories(profile)
        updated_profiles = sort_profiles([*profiles, profile])
        self._write_profiles(updated_profiles)
        return self._collection_response(updated_profiles, profile=profile)

    def _create_profile(
        self,
        name: str,
        metadata: Optional[Mapping[str, Any]],
    ) -> JsonObject:
        valid_name = normalize_profile_name(name)
        profiles = self._read_profiles()
        self._ensure_unique_name(profiles, valid_name)

        profile = ProfileRecord.create(valid_name, metadata=metadata, device_id=self.device_id)
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
        updated = target.with_identity(identity, device_id=self.device_id)
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

    def update_proxy(self, profile_id: str, proxy: Mapping[str, Any]) -> JsonObject:
        """Replace one profile proxy after validating the private proxy draft."""
        if not isinstance(profile_id, str) or not profile_id.strip():
            raise SidecarError(
                code=INVALID_REQUEST,
                message="Profile id is required.",
            )

        normalized_proxy = normalize_proxy_config(proxy)
        profiles = self._read_profiles()
        target = self._find_profile(profiles, profile_id)
        updated = target.with_proxy(normalized_proxy, device_id=self.device_id)
        updated_profiles = sort_profiles(
            [updated if profile.id == target.id else profile for profile in profiles]
        )
        self._write_profiles(updated_profiles)
        return self._collection_response(updated_profiles, profile=updated)

    def update_organization(self, profile_id: str, organization: Mapping[str, Any]) -> JsonObject:
        """Replace one profile's folder, tags, notes, favourite flag and colour.

        Takes the whole section rather than a patch: the sections are small and
        strict-key, so a partial update would need its own merge rules and a way
        to say "clear this field" that is distinguishable from "leave it alone".
        """
        if not isinstance(profile_id, str) or not profile_id.strip():
            raise SidecarError(code=INVALID_REQUEST, message="Profile id is required.")

        normalized = normalize_organization(organization)
        profiles = self._read_profiles()
        target = self._find_profile(profiles, profile_id)
        updated = target.with_organization(normalized, device_id=self.device_id)
        updated_profiles = sort_profiles(
            [updated if profile.id == target.id else profile for profile in profiles]
        )
        self._write_profiles(updated_profiles)
        return self._collection_response(updated_profiles, profile=updated)

    def update_launch(self, profile_id: str, launch: Mapping[str, Any]) -> JsonObject:
        """Replace one profile's startup behaviour, start URLs and launch flags.

        The flags are checked against the curated allow-list here, not only at
        launch: saving a switch that would be refused later leaves a profile that
        looks configured and then fails to start.
        """
        if not isinstance(profile_id, str) or not profile_id.strip():
            raise SidecarError(code=INVALID_REQUEST, message="Profile id is required.")

        normalized = normalize_profile_launch(launch)
        validate_user_launch_args(normalized.get("args"))
        profiles = self._read_profiles()
        target = self._find_profile(profiles, profile_id)
        updated = target.with_launch(normalized, device_id=self.device_id)
        updated_profiles = sort_profiles(
            [updated if profile.id == target.id else profile for profile in profiles]
        )
        self._write_profiles(updated_profiles)
        return self._collection_response(updated_profiles, profile=updated)

    def apply_identity_preset(self, profile_id: str, preset_id: str) -> JsonObject:
        """Apply a curated identity preset to one profile and return warnings."""
        if not isinstance(profile_id, str) or not profile_id.strip():
            raise SidecarError(
                code=INVALID_REQUEST,
                message="Profile id is required.",
            )
        return self.update_identity(profile_id, curated_preset(preset_id))

    def delete(self, profile_id: str) -> JsonObject:
        """Move a profile to the trash, keeping its record and user-data.

        Deletion used to drop the record while deliberately leaving the browser
        data on disk -- a half-measure that lost the profile but not its bytes.
        The trash makes that caution the actual guarantee: nothing is removed
        until purge, and the profile can come back with its sessions intact.
        """
        if not isinstance(profile_id, str) or not profile_id.strip():
            raise SidecarError(
                code=INVALID_REQUEST,
                message="Profile id is required.",
            )

        profiles = self._read_profiles()
        target = self._find_profile(profiles, profile_id)
        if target.is_trashed:
            return self._collection_response(profiles, profile=target)

        trashed = target.trashed(device_id=self.device_id)
        updated_profiles = sort_profiles(
            [trashed if profile.id == target.id else profile for profile in profiles]
        )
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
        return self._collection_response(updated_profiles, profile=trashed)

    def list_trash(self) -> JsonObject:
        """Profiles waiting in the trash, newest first."""
        profiles = self._read_profiles()
        trashed = sorted(
            (profile for profile in profiles if profile.is_trashed),
            key=lambda profile: profile.lifecycle.get("deletedAt") or "",
            reverse=True,
        )
        return {
            "storeVersion": STORE_VERSION,
            "profiles": [profile.to_public_dict() for profile in trashed],
            "count": len(trashed),
        }

    def restore(self, profile_id: str) -> JsonObject:
        """Bring a profile back, renaming it if the name was taken meanwhile."""
        if not isinstance(profile_id, str) or not profile_id.strip():
            raise SidecarError(code=INVALID_REQUEST, message="Profile id is required.")

        profiles = self._read_profiles()
        target = self._find_profile(profiles, profile_id)
        if not target.is_trashed:
            return self._collection_response(profiles, profile=target)

        name = unique_profile_name(profiles, target.name, exclude_ids=frozenset({target.id}))
        restored = target.restored(name=name if name != target.name else None, device_id=self.device_id)
        updated_profiles = sort_profiles(
            [restored if profile.id == target.id else profile for profile in profiles]
        )
        self._write_profiles(updated_profiles)
        return self._collection_response(updated_profiles, profile=restored)

    def purge(self, profile_id: str) -> JsonObject:
        """Permanently drop a trashed profile's record. Caller removes its data."""
        if not isinstance(profile_id, str) or not profile_id.strip():
            raise SidecarError(code=INVALID_REQUEST, message="Profile id is required.")

        profiles = self._read_profiles()
        target = self._find_profile(profiles, profile_id)
        if not target.is_trashed:
            raise SidecarError(
                code=INVALID_REQUEST,
                message="Move the profile to the trash before deleting it permanently.",
            )
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

        self._restrict_store_file_mode()
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

        stored_version = payload.get("storeVersion") if isinstance(payload, Mapping) else None
        profiles, needs_migration = parse_store_payload_for_read(payload)
        sorted_profiles = sort_profiles(profiles)
        if needs_migration:
            if isinstance(stored_version, int) and stored_version < STORE_VERSION:
                self._back_up_before_migration(stored_version)
            try:
                self._write_profiles(sorted_profiles)
            except SidecarError as error:
                # Every record parsed; only persisting the newer form failed. On a
                # read-only or full volume that used to make the whole library
                # unreadable -- a write error raised out of what the caller issued
                # as a read, taking get() and therefore launching with it. The
                # in-memory migration is complete and correct, so degrade to
                # read-only rather than pretending the profiles are gone.
                if error.code != PROFILE_STORE_WRITE_FAILED:
                    raise
        return sorted_profiles

    def _back_up_before_migration(self, from_version: int) -> None:
        """Copy the store aside before rewriting it in a newer format.

        Migration is the one write that cannot be undone by editing a field back.
        If a future version's rules reject something this one accepted, or the
        rewrite goes wrong halfway, the original bytes are the only way back --
        and a profile library represents accounts and sessions that cannot be
        recreated. Failing to write the copy is not a reason to refuse the read;
        it only means this particular safety net is missing.
        """
        backup_path = self.store_file.with_name(
            f"{self.store_file.stem}.v{from_version}.{utc_now_iso().replace(':', '-')}.bak"
        )
        if backup_path.exists():
            return
        try:
            original = self.store_file.read_bytes()
            descriptor = os.open(backup_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, STORE_FILE_MODE)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(original)
                handle.flush()
                os.fsync(handle.fileno())
        except OSError:
            return

    def _restrict_store_file_mode(self) -> None:
        """Narrow a pre-existing store written before STORE_FILE_MODE existed.

        New writes are already 0600 (see _write_profiles), so this only matters
        for a store that is read but never mutated. Windows has no POSIX mode
        bits and chmod there is a documented no-op, so a failure to narrow is
        not treated as a read failure -- but it is never silent on POSIX, where
        an unreadable mode means the store root itself is broken and the read
        below will surface that.
        """
        if os.name != "posix":
            return
        try:
            current_mode = self.store_file.stat().st_mode & 0o777
            if current_mode != STORE_FILE_MODE:
                self.store_file.chmod(STORE_FILE_MODE)
        except OSError as exc:
            raise SidecarError(
                code=PROFILE_STORE_UNAVAILABLE,
                message="Profile store is unavailable.",
            ) from exc

    def _write_profiles(self, profiles: Sequence[ProfileRecord]) -> None:
        try:
            self._ensure_write_layout()
            payload = {
                "storeVersion": STORE_VERSION,
                "profiles": [profile.to_store_dict() for profile in sort_profiles(profiles)],
            }
            temp_file = self.store_file.with_name(
                f".{self.store_file.name}.{uuid.uuid4().hex}.tmp"
            )
            try:
                descriptor = os.open(
                    temp_file,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    STORE_FILE_MODE,
                )
                with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
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
            # A trashed profile must not keep reserving its name, or deleting
            # "Client A" would block ever creating one again.
            if profile.is_trashed:
                continue
            if profile.id != excluding_id and profile.name.casefold() == requested:
                raise SidecarError(
                    code=PROFILE_DUPLICATE_NAME,
                    message="Profile name already exists.",
                )

    @staticmethod
    def _live(profiles: Sequence[ProfileRecord]) -> List[ProfileRecord]:
        """Profiles the ordinary list surfaces show: everything not in the trash."""
        return [profile for profile in profiles if not profile.is_trashed]

    def _collection_response(
        self,
        profiles: Sequence[ProfileRecord],
        profile: Optional[ProfileRecord] = None,
        warnings: Optional[list[JsonObject]] = None,
    ) -> JsonObject:
        """Build the standard collection reply.

        Trashed records are filtered here rather than by each caller. Doing it at
        the call sites meant nine places had to remember, four of them did not,
        and a deleted profile reappeared in the list after any unrelated rename or
        create. The ``profile`` field is exempt: delete and restore both need to
        return the record they just acted on, which is precisely the trashed one.
        """
        sorted_profiles = sort_profiles(self._live(profiles))
        response: JsonObject = {
            "storeVersion": STORE_VERSION,
            "profiles": [item.to_public_dict() for item in sorted_profiles],
            "count": len(sorted_profiles),
        }
        if profile is not None:
            response["profile"] = profile.to_public_dict()
        if warnings is not None:
            response["warnings"] = warnings
        return response


def parse_store_payload(payload: Any) -> List[ProfileRecord]:
    """Parse and validate the on-disk store JSON schema."""
    profiles, _needs_migration = parse_store_payload_for_read(payload)
    return profiles


def parse_store_payload_for_read(payload: Any) -> tuple[List[ProfileRecord], bool]:
    """Parse v1/v2/v3 store payloads and report whether they should be rewritten."""
    if not isinstance(payload, Mapping):
        raise_corrupt_store()

    store_version = payload.get("storeVersion")
    if isinstance(store_version, bool) or not isinstance(store_version, int):
        raise_corrupt_store()
    if store_version > STORE_VERSION:
        # Not corruption: a newer build wrote this. Saying "corrupt" here would
        # tell a user their whole library is damaged when the fix is to update
        # the app -- and once profiles sync, one early upgrade would show that
        # on every other machine at once.
        raise SidecarError(
            code=PROFILE_STORE_VERSION_TOO_NEW,
            message="This profile store was written by a newer version of ThePrivator. Update the app to open it.",
        )
    if store_version not in SUPPORTED_READ_STORE_VERSIONS:
        raise_corrupt_store()

    raw_profiles = payload.get("profiles")
    if not isinstance(raw_profiles, list):
        raise_corrupt_store()

    profiles = [
        ProfileRecord.from_dict(raw_profile, store_version=store_version)
        for raw_profile in raw_profiles
    ]
    profiles, names_repaired = repair_duplicate_names(profiles)
    return profiles, store_version < STORE_VERSION or names_repaired


def proxy_for_store_version(data: Mapping[str, Any], store_version: int) -> JsonObject:
    """Return the private proxy config for a record read from a given store version."""
    if store_version >= 3:
        return normalize_proxy_config(data.get("proxy"))
    if store_version in {1, 2}:
        return default_proxy_config()
    raise_corrupt_store()


def derive_defaults(*, proxy: Any, identity: Any, launch: Any) -> ProfileDefaults:
    """Derive the non-authoritative defaults block from canonical truth.

    ``defaults`` is a summary, never a source. from_dict re-derives it and rejects
    any record whose stored copy disagrees, which is what stops a caller smuggling
    a startUrl or fingerprintMode into a section the launcher trusts. Widening what
    it summarises therefore has to keep that check exact rather than relax it.
    """
    normalized_proxy = normalize_proxy_config(proxy)
    start_urls = start_urls_for_launch(normalize_profile_launch(launch))
    return ProfileDefaults(
        browser="chromium",
        startUrl=start_urls[0] if start_urls else "about:blank",
        proxyMode=normalized_proxy["mode"],
        # v3 froze this at "disabled" even for a fully masked preset, so it lied.
        fingerprintMode="disabled" if _identity_is_all_real(identity) else "managed",
    )


def defaults_for_store_version(store_version: int, *, proxy: Any, identity: Any, launch: Any) -> ProfileDefaults:
    """Reproduce the defaults rule of the version a record was written under.

    Migration has to verify a stored record against the rule that was in force
    when it was written; checking it against the current rule would make every
    older record look tampered with. Tamper detection therefore survives at every
    version instead of being switched off for the ones being migrated.
    """
    if store_version >= STORE_VERSION:
        return derive_defaults(proxy=proxy, identity=identity, launch=launch)
    return ProfileDefaults(proxyMode=normalize_proxy_config(proxy)["mode"])


def _identity_is_all_real(identity: Any) -> bool:
    normalized = normalize_profile_identity(identity)
    return all(
        isinstance(surface, Mapping) and surface.get("mode") == "real"
        for key, surface in normalized.items()
        if isinstance(surface, Mapping) and key not in {"identityVersion", "label", "presetId"}
    )


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


def repair_duplicate_names(profiles: Sequence[ProfileRecord]) -> tuple[List[ProfileRecord], bool]:
    """Rename colliding profiles instead of declaring the store corrupt.

    A duplicate name used to fail the whole read. That was defensible while the
    store had exactly one writer, but two machines can independently create
    "Client A" and then sync, and a name collision must not present as a damaged
    library. The first record by id keeps the name; the rest are suffixed.
    """
    seen: set[str] = set()
    repaired: List[ProfileRecord] = []
    changed = False
    for profile in sorted(profiles, key=lambda item: item.id):
        if profile.is_trashed:
            # A trashed profile does not hold its name -- that is what lets a new
            # "Client A" be created after the old one is deleted. Repairing against
            # it would rename the live profile instead, and which one lost the name
            # would depend on how their uuids happened to sort.
            repaired.append(profile)
            continue
        folded = profile.name.casefold()
        if folded not in seen:
            seen.add(folded)
            repaired.append(profile)
            continue
        candidate = _next_available_name(profile.name, seen)
        seen.add(candidate.casefold())
        repaired.append(replace(profile, name=candidate))
        changed = True
    return repaired, changed


def _next_available_name(base: str, taken: set[str]) -> str:
    for suffix in range(2, 10_000):
        marker = f" ({suffix})"
        trimmed = base[: MAX_PROFILE_NAME_LENGTH - len(marker)].rstrip()
        candidate = f"{trimmed}{marker}"
        if candidate.casefold() not in taken and is_valid_profile_name(candidate):
            return candidate
    return f"{base[:8]}-{uuid.uuid4().hex[:8]}"


def unique_profile_name(
    profiles: Iterable[ProfileRecord],
    base_name: str,
    *,
    exclude_ids: frozenset[str] = frozenset(),
) -> str:
    """A name not already used by another profile, suffixed if needed.

    Shared by package import, trash restore, and sync, which all have to land a
    profile whose preferred name may already be taken.
    """
    taken = {
        profile.name.casefold()
        for profile in profiles
        if profile.id not in exclude_ids and profile.lifecycle.get("deletedAt") is None
    }
    if base_name.casefold() not in taken:
        return base_name
    return _next_available_name(base_name, taken)


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
    return (
        folded in _UNSAFE_METADATA_KEYS
        or "proxy" in folded
        or "debugport" in folded
        or is_proxy_secret_key(key)
    )


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


_DEVICE_ID_CACHE: dict[str, str] = {}
_EPHEMERAL_DEVICE_ID: Optional[str] = None


def local_device_id(store_root: Optional[Union[str, Path]] = None) -> str:
    """A stable per-install identifier, generated once and never synchronised.

    Sync needs to tell "this machine wrote it" from "the other machine did", and
    a hostname cannot do that job: it is not stable, not unique, and is exactly
    the kind of value the redaction rules keep out of anything user-visible. This
    is a random id with no meaning outside the pairing.

    Without a store root there is nowhere legitimate to persist it -- writing to
    the user's home from a record constructor would put files outside the store
    the caller named, and made test runs depend on each other. In that case the
    id is process-local: stable for this run, and replaced by the persisted one
    as soon as a store is involved.
    """
    global _EPHEMERAL_DEVICE_ID
    if store_root is None:
        if _EPHEMERAL_DEVICE_ID is None:
            _EPHEMERAL_DEVICE_ID = str(uuid.uuid4())
        return _EPHEMERAL_DEVICE_ID

    root = Path(store_root) / STORE_DIR
    key = str(root)
    cached = _DEVICE_ID_CACHE.get(key)
    if cached is not None:
        return cached

    path = root / DEVICE_FILE
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        device_id = payload.get("deviceId")
        if isinstance(device_id, str) and is_uuid(device_id):
            _DEVICE_ID_CACHE[key] = device_id
            return device_id
    except (OSError, json.JSONDecodeError, AttributeError):
        pass

    device_id = str(uuid.uuid4())
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump({"deviceId": device_id}, handle)
    except OSError:
        # Not persisting it only costs stability across restarts, which is a sync
        # inconvenience rather than a reason to fail a profile read.
        pass
    _DEVICE_ID_CACHE[key] = device_id
    return device_id


def _sync_at_revision(device_id: str, revision: Optional[int]) -> JsonObject:
    """A fresh sync section, optionally starting at a revision from elsewhere.

    A profile arriving from another device already has a revision history.
    Starting it back at 1 would make the next comparison read as "this device
    went backwards", which the merge rules correctly refuse to act on.
    """
    section = default_sync(device_id)
    if revision is not None and isinstance(revision, int) and revision >= 1:
        section = {**section, "revision": revision}
    return normalize_sync(section, device_id=device_id)


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
    "MAX_PROFILE_NAME_LENGTH",
    "PROFILE_DELETE_FAILED",
    "PROFILE_DUPLICATE_NAME",
    "PROFILE_INVALID_NAME",
    "PROFILE_NOT_FOUND",
    "PROFILE_STORE_CORRUPT",
    "PROFILE_STORE_UNAVAILABLE",
    "PROFILE_STORE_WRITE_FAILED",
    "require_string_param",
]
