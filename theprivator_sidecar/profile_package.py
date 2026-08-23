"""Sidecar-owned ThePrivator profile package (.tpkg) export/import contract.

The UI and Rust bridge only pass opaque dialog-selected paths plus profile ids.
This module owns archive validation, payload sanitization, cookie payload wiring,
profile-store mutation, and public redaction so package operations never expose
paths, member lists, raw manifests, cookie material, proxy credentials, or stack
traces through command responses/diagnostics.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import tempfile
import uuid
import zipfile
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Iterable, Mapping, Optional, Sequence, Union

from . import chromium, cookies
from .profile_sections import normalize_launch, normalize_organization
from .profiles import (
    MAX_PROFILE_NAME_LENGTH,
    ProfileRecord,
    ProfileStore,
    is_utc_iso_timestamp,
    is_valid_profile_name,
    normalize_profile_identity,
    utc_now_iso,
)
from .protocol import (
    INVALID_REQUEST,
    JsonObject,
    PORTABILITY_PACKAGE_CHECKSUM_MISMATCH,
    PORTABILITY_PACKAGE_IMPORT_FAILED,
    PORTABILITY_PACKAGE_INVALID,
    PORTABILITY_PACKAGE_PAYLOAD_FAILED,
    PORTABILITY_PACKAGE_READ_FAILED,
    PORTABILITY_PACKAGE_TOO_LARGE,
    PORTABILITY_PACKAGE_UNSUPPORTED_VERSION,
    PORTABILITY_PACKAGE_WRITE_FAILED,
    SidecarError,
)
from .proxy import is_proxy_secret_key, normalize_proxy_config, public_proxy_summary

PACKAGE_FORMAT = "theprivator.profile-package"
# Bumped with identity v2: a package carrying a v2 identity while claiming
# version 1 is a format that lies about its own contents.
# Bumped again for sync: a package now says what it is for. A sync payload
# carries the profile id and revision it belongs to, which a package handed to
# another person must not.
PACKAGE_VERSION = 3
# Versions 1 and 2 still import, as portable packages. Their identity is
# upgraded on read like any other older identity, so refusing them would strand
# every package exported before this release -- and a package is exactly the
# artifact a user keeps around.
SUPPORTED_PACKAGE_VERSIONS = frozenset({1, 2, PACKAGE_VERSION})

# What a package is for.
#
# "portable" is the artifact a user exports to move a profile or hand it to
# someone else, and it deliberately carries no identifiers tying it to a store.
# "sync" is machinery: it names the profile id and revision it represents, so the
# engine can tell which local record it corresponds to without guessing by name.
PACKAGE_KIND_PORTABLE = "portable"
PACKAGE_KIND_SYNC = "sync"
SUPPORTED_PACKAGE_KINDS = frozenset({PACKAGE_KIND_PORTABLE, PACKAGE_KIND_SYNC})
PACKAGE_FILE_SUFFIX = ".tpkg"
MANIFEST_MEMBER = "manifest.json"
COOKIE_MEMBER = "cookies/theprivator-cookies.json"
PAYLOAD_PREFIX = "payload/"
PROFILE_PACKAGE_SOURCE = "profile-package"

MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_MANIFEST_BYTES = 1 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 10_000
MAX_PAYLOAD_FILES = 9_000
MAX_PAYLOAD_BYTES = 500 * 1024 * 1024
MAX_PAYLOAD_FILE_BYTES = 128 * 1024 * 1024
MAX_WARNING_OBJECTS = 20
MAX_MEMBER_COMPRESSION_RATIO = 100
MIN_SUSPICIOUS_COMPRESSED_BYTES = 1024

_MANIFEST_FIELDS = frozenset({"format", "version", "createdAt", "profile", "cookies", "payload", "warnings"})
# Version 3 adds the discriminator and, for sync payloads only, the section that
# says which profile and revision the payload is.
_MANIFEST_FIELDS_V3 = _MANIFEST_FIELDS | {"kind", "sync"}
_SYNC_FIELDS = frozenset({"profileId", "revision", "deviceId", "organization", "launch"})
_PROFILE_FIELDS = frozenset({"name", "identity", "proxy", "proxySummary"})
_RESERVED_WINDOWS_PATH_SEGMENTS = frozenset(
    {
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
)

_RUNTIME_FILE_NAMES = {"DevToolsActivePort"}
_RUNTIME_FILE_PREFIXES = ("Singleton",)

_WARNING_MESSAGES = {
    "PACKAGE_PAYLOAD_RUNTIME_SKIPPED": "Volatile Chromium runtime files were skipped from the package.",
    "PACKAGE_PAYLOAD_SPECIAL_SKIPPED": "Unsupported special payload entries were skipped from the package.",
    "PACKAGE_PAYLOAD_UNREADABLE_SKIPPED": "Unreadable payload entries were skipped from the package.",
    "PACKAGE_PAYLOAD_COOKIE_DB_SKIPPED": "Chromium cookie database files were replaced by the portable cookie payload.",
    "PACKAGE_EXPORT_DESTINATION_SKIPPED": "The selected package destination was excluded from the payload snapshot.",
    "PACKAGE_WARNING_TRUNCATED": "Additional package portability warnings were summarized but not listed.",
}


@dataclass(frozen=True)
class PayloadFile:
    """One sanitized payload file selected for package export."""

    relative_path: str
    source_path: Path
    byte_count: int
    sha256: str


@dataclass(frozen=True)
class PayloadManifestEntry:
    """One validated payload entry declared by a package manifest."""

    relative_path: str
    byte_count: int
    sha256: str


@dataclass(frozen=True)
class ValidatedPackage:
    """A fully validated package staged in a temporary payload directory."""

    profile_name: str
    identity: JsonObject
    proxy: JsonObject
    cookie_bytes: bytes
    cookie_count: int
    payload_temp_dir: Path
    payload_files: list[PayloadManifestEntry]
    payload_byte_count: int
    warnings: list[JsonObject]
    kind: str = PACKAGE_KIND_PORTABLE
    sync: Optional[JsonObject] = None

    def restore_into(self, destination: Path) -> None:
        """Copy the staged payload into a profile's user-data directory."""
        _copy_prepared_payload(self.payload_temp_dir, destination)


class PackageWarningAccumulator:
    """Aggregate safe package/cookie warning objects without identifiers."""

    def __init__(self) -> None:
        self._warnings: "OrderedDict[str, JsonObject]" = OrderedDict()

    def add(self, code: str, count: int = 1, message: Optional[str] = None) -> None:
        if count <= 0:
            return
        safe_code = code if isinstance(code, str) and code else "PACKAGE_PAYLOAD_UNREADABLE_SKIPPED"
        safe_message = message if isinstance(message, str) and message else _WARNING_MESSAGES.get(safe_code)
        if safe_message is None:
            safe_message = "Some package portability data was summarized without exposing sensitive details."
        existing = self._warnings.get(safe_code)
        if existing is None:
            self._warnings[safe_code] = {"code": safe_code, "message": safe_message, "count": count}
        else:
            existing["count"] = int(existing.get("count", 0)) + count

    def extend_public(self, warnings: Iterable[Mapping[str, Any]]) -> None:
        for warning in warnings:
            if not isinstance(warning, Mapping):
                continue
            code = warning.get("code")
            message = warning.get("message")
            count = warning.get("count", 1)
            if isinstance(code, str) and isinstance(count, int) and not isinstance(count, bool):
                self.add(code, count, message if isinstance(message, str) else None)

    def to_public(self) -> list[JsonObject]:
        rows: list[JsonObject] = []
        values = list(self._warnings.values())
        for index, warning in enumerate(values):
            if index >= MAX_WARNING_OBJECTS:
                rows.append(
                    {
                        "code": "PACKAGE_WARNING_TRUNCATED",
                        "message": _WARNING_MESSAGES["PACKAGE_WARNING_TRUNCATED"],
                        "count": sum(int(item.get("count", 0)) for item in values[index:]),
                    }
                )
                break
            rows.append(dict(warning))
        return rows

    @property
    def item_count(self) -> int:
        return sum(int(warning.get("count", 0)) for warning in self._warnings.values())


class PackageValidationError(SidecarError):
    """Internal marker for package validation errors that are already redacted."""


class PackageImportCommitError(SidecarError):
    """Internal marker for commit-time import failures that need rollback."""



def export_profile_package(
    store_root: Union[str, Path],
    profile_id: str,
    destination_path: Union[str, Path],
    *,
    kind: str = PACKAGE_KIND_PORTABLE,
) -> JsonObject:
    """Export a stopped profile into a versioned ThePrivator ``.tpkg`` archive.

    ``kind`` decides whether the manifest carries the profile id and revision. A
    sync payload does; a portable package deliberately does not, because it is
    something a user may hand to another person.
    """
    if kind not in SUPPORTED_PACKAGE_KINDS:
        raise SidecarError(code=INVALID_REQUEST, message="Unsupported package kind.")
    destination = _selected_path(destination_path, read=False)
    store = ProfileStore(store_root)
    profile = store.get(profile_id)
    chromium.ensure_profile_stopped_for_portability(store_root, profile)

    warnings = PackageWarningAccumulator()
    cookie_payload = cookies.export_theprivator_cookie_payload(store_root, profile)
    warnings.extend_public(cookie_payload.warnings)

    user_data_path = chromium.resolve_user_data_path(store_root, profile)
    payload_files = _collect_payload_files(
        user_data_path,
        warnings,
        selected_destination=destination,
    )
    payload_byte_count = sum(item.byte_count for item in payload_files)
    manifest = _build_manifest(
        profile,
        cookie_payload=cookie_payload,
        payload_files=payload_files,
        payload_byte_count=payload_byte_count,
        warnings=warnings.to_public(),
        kind=kind,
    )
    _write_package_archive(destination, manifest, cookie_payload.content, payload_files)

    public_warnings = warnings.to_public()
    return {
        "packageVersion": PACKAGE_VERSION,
        "format": PACKAGE_FORMAT,
        "operation": "export",
        "profileId": profile.id,
        "profileName": profile.name,
        "cookieCount": cookie_payload.cookie_count,
        "skippedCookieCount": cookie_payload.skipped_count,
        "payloadFileCount": len(payload_files),
        "payloadByteCount": payload_byte_count,
        "warningCount": len(public_warnings),
        "warnings": public_warnings,
    }


def import_profile_package(
    store_root: Union[str, Path],
    source_path: Union[str, Path],
) -> JsonObject:
    """Import a validated ``.tpkg`` into a new stopped copied profile."""
    source = _selected_path(source_path, read=True)
    with tempfile.TemporaryDirectory(prefix="theprivator-profile-package-") as temp_root:
        staged_payload_dir = Path(temp_root) / "payload"
        validated = _read_validated_package(source, staged_payload_dir)
        return _commit_validated_package(store_root, validated)


def read_sync_package(payload: bytes, staging: Path) -> ValidatedPackage:
    """Validate a sync payload held in memory, staged under a caller-owned directory.

    It goes through exactly the same reader as a file a user picked, because a
    payload from a shared folder is no more trustworthy than one from a
    download: same zip-bomb ceilings, same per-file checksums, same path-escape
    checks.

    The staging directory belongs to the caller because the staged copy is a
    whole profile -- routinely hundreds of megabytes. Allocating it here would
    leave one behind in the temp directory on every single pull.
    """
    staging.mkdir(parents=True, exist_ok=True)
    archive_path = staging / "payload.tpkg"
    archive_path.write_bytes(payload)
    return _read_validated_package(archive_path, staging / "payload")


def _commit_validated_package(store_root: Union[str, Path], package: ValidatedPackage) -> JsonObject:
    store = ProfileStore(store_root)
    target_name = _unique_import_name(store, package.profile_name)
    metadata = {
        "source": PROFILE_PACKAGE_SOURCE,
        "format": PACKAGE_FORMAT,
        "formatVersion": str(PACKAGE_VERSION),
        "originalName": package.profile_name,
        "hasUserData": bool(package.payload_files),
    }
    create_result: Optional[JsonObject] = None
    created_profile_id: Optional[str] = None
    existing_profile_ids = _profile_ids_from_collection(store.list())
    try:
        create_result = store.create_profile_package_import(
            target_name,
            identity=package.identity,
            proxy=package.proxy,
            metadata=metadata,
        )
        if not isinstance(create_result, Mapping):
            created_profile_id = _created_profile_id_since(store, existing_profile_ids)
            raise PackageImportCommitError(
                code=PORTABILITY_PACKAGE_IMPORT_FAILED,
                message="Profile package import failed.",
            )
        created_profile_id = _created_profile_id_from_create_result(create_result) or _created_profile_id_since(
            store,
            existing_profile_ids,
        )
        created_profile = create_result.get("profile")
        if (
            created_profile_id is None
            or not isinstance(created_profile, Mapping)
            or created_profile.get("id") != created_profile_id
        ):
            raise PackageImportCommitError(
                code=PORTABILITY_PACKAGE_IMPORT_FAILED,
                message="Profile package import failed.",
            )
        imported_record = store.get(created_profile_id)
        destination = chromium.resolve_user_data_path(store_root, imported_record)
        _copy_prepared_payload(package.payload_temp_dir, destination)
        cookie_result = cookies.restore_theprivator_cookie_payload(
            store_root,
            imported_record,
            package.cookie_bytes,
        )
    except SidecarError as exc:
        if created_profile_id is not None:
            _rollback_created_profile(store_root, created_profile_id)
        if isinstance(exc, PackageImportCommitError):
            raise
        raise PackageImportCommitError(
            code=PORTABILITY_PACKAGE_IMPORT_FAILED,
            message="Profile package import failed.",
        ) from exc

    public_warnings = _merge_import_warnings(package.warnings, cookie_result.get("warnings", []))
    profile = create_result["profile"]
    return {
        "packageVersion": PACKAGE_VERSION,
        "format": PACKAGE_FORMAT,
        "operation": "import",
        "profileId": profile["id"],
        "profileName": profile["name"],
        "nameConflictResolved": profile["name"] != package.profile_name,
        "profile": profile,
        "cookieCount": package.cookie_count,
        "importedCookieCount": cookie_result.get("importedCount", 0),
        "replacedCookieCount": cookie_result.get("replacedCount", 0),
        "payloadFileCount": len(package.payload_files),
        "payloadByteCount": package.payload_byte_count,
        "warningCount": len(public_warnings),
        "warnings": public_warnings,
    }


def _build_manifest(
    profile: ProfileRecord,
    *,
    cookie_payload: Any,
    payload_files: Sequence[PayloadFile],
    payload_byte_count: int,
    warnings: Sequence[Mapping[str, Any]],
    kind: str = PACKAGE_KIND_PORTABLE,
) -> JsonObject:
    cookie_sha256 = hashlib.sha256(cookie_payload.content).hexdigest()
    manifest: JsonObject = {
        "format": PACKAGE_FORMAT,
        "version": PACKAGE_VERSION,
        "kind": kind,
        "createdAt": utc_now_iso(),
        "profile": {
            "name": profile.name,
            "identity": normalize_profile_identity(profile.identity),
            "proxy": _strip_proxy_credentials(profile.proxy),
            "proxySummary": public_proxy_summary(_strip_proxy_credentials(profile.proxy)),
        },
        "cookies": {
            "member": COOKIE_MEMBER,
            "format": cookies.THEPRIVATOR_COOKIE_FORMAT,
            "version": cookies.THEPRIVATOR_COOKIE_SCHEMA_VERSION,
            "byteCount": len(cookie_payload.content),
            "sha256": cookie_sha256,
            "cookieCount": cookie_payload.cookie_count,
            "skippedCount": cookie_payload.skipped_count,
        },
        "payload": {
            "prefix": PAYLOAD_PREFIX,
            "fileCount": len(payload_files),
            "byteCount": payload_byte_count,
            "files": [
                {
                    "path": item.relative_path,
                    "member": f"{PAYLOAD_PREFIX}{item.relative_path}",
                    "byteCount": item.byte_count,
                    "sha256": item.sha256,
                }
                for item in payload_files
            ],
        },
        "warnings": [dict(warning) for warning in warnings],
    }

    if kind == PACKAGE_KIND_SYNC:
        # Only a sync payload carries these. A portable package is something a
        # user may hand to another person, and a store-local id plus a device id
        # is exactly the kind of correlatable identifier this product exists to
        # avoid handing out.
        manifest["sync"] = {
            "profileId": profile.id,
            "revision": int(profile.sync.get("revision", 1)),
            "deviceId": str(profile.sync.get("updatedBy", "")),
            "organization": dict(profile.organization),
            "launch": dict(profile.launch),
        }

    return manifest


def _write_package_archive(
    destination: Path,
    manifest: Mapping[str, Any],
    cookie_bytes: bytes,
    payload_files: Sequence[PayloadFile],
) -> None:
    manifest_bytes = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8") + b"\n"
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(_zip_info(MANIFEST_MEMBER), manifest_bytes)
            archive.writestr(_zip_info(COOKIE_MEMBER), cookie_bytes)
            for item in payload_files:
                archive.write(item.source_path, f"{PAYLOAD_PREFIX}{item.relative_path}")
    except OSError as exc:
        raise SidecarError(
            code=PORTABILITY_PACKAGE_WRITE_FAILED,
            message="Profile package could not be written.",
        ) from exc
    except zipfile.BadZipFile as exc:
        raise SidecarError(
            code=PORTABILITY_PACKAGE_WRITE_FAILED,
            message="Profile package could not be written.",
        ) from exc


def _zip_info(member_name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(member_name)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o600 << 16
    return info


def _collect_payload_files(
    user_data_path: Path,
    warnings: PackageWarningAccumulator,
    *,
    selected_destination: Path,
) -> list[PayloadFile]:
    if not user_data_path.exists():
        return []
    if not user_data_path.is_dir():
        raise SidecarError(
            code=PORTABILITY_PACKAGE_PAYLOAD_FAILED,
            message="Profile payload could not be prepared.",
        )

    selected_resolved = _safe_resolve_existing_or_parent(selected_destination)
    files: list[PayloadFile] = []
    total_bytes = 0

    def walk(directory: Path, parts: tuple[str, ...]) -> None:
        nonlocal total_bytes
        try:
            with os.scandir(directory) as iterator:
                entries = sorted(iterator, key=lambda entry: entry.name.casefold())
        except OSError:
            warnings.add("PACKAGE_PAYLOAD_UNREADABLE_SKIPPED")
            return

        for entry in entries:
            name = entry.name
            if _is_runtime_payload_name(name):
                warnings.add("PACKAGE_PAYLOAD_RUNTIME_SKIPPED")
                continue
            entry_path = Path(entry.path)
            if _same_resolved_path(entry_path, selected_resolved):
                warnings.add("PACKAGE_EXPORT_DESTINATION_SKIPPED")
                continue
            if _entry_is_symlink(entry):
                warnings.add("PACKAGE_PAYLOAD_SPECIAL_SKIPPED")
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    walk(entry_path, (*parts, name))
                    continue
                if not entry.is_file(follow_symlinks=False):
                    warnings.add("PACKAGE_PAYLOAD_SPECIAL_SKIPPED")
                    continue
                stat_result = entry.stat(follow_symlinks=False)
            except OSError:
                warnings.add("PACKAGE_PAYLOAD_UNREADABLE_SKIPPED")
                continue

            if not stat.S_ISREG(stat_result.st_mode):
                warnings.add("PACKAGE_PAYLOAD_SPECIAL_SKIPPED")
                continue
            if getattr(stat_result, "st_nlink", 1) > 1:
                warnings.add("PACKAGE_PAYLOAD_SPECIAL_SKIPPED")
                continue
            relative_path = _safe_payload_relative_path(PurePosixPath(*parts, name).as_posix())
            if _is_cookie_database_payload_path(relative_path):
                warnings.add("PACKAGE_PAYLOAD_COOKIE_DB_SKIPPED")
                continue
            if stat_result.st_size > MAX_PAYLOAD_FILE_BYTES:
                raise SidecarError(
                    code=PORTABILITY_PACKAGE_TOO_LARGE,
                    message="Profile package payload is too large.",
                )
            if len(files) + 1 > MAX_PAYLOAD_FILES:
                raise SidecarError(
                    code=PORTABILITY_PACKAGE_TOO_LARGE,
                    message="Profile package payload has too many files.",
                )
            total_bytes += stat_result.st_size
            if total_bytes > MAX_PAYLOAD_BYTES:
                raise SidecarError(
                    code=PORTABILITY_PACKAGE_TOO_LARGE,
                    message="Profile package payload is too large.",
                )
            files.append(
                PayloadFile(
                    relative_path=relative_path,
                    source_path=entry_path,
                    byte_count=stat_result.st_size,
                    sha256=_sha256_file(entry_path),
                )
            )


    walk(user_data_path, ())
    return files


def _read_validated_package(source: Path, staged_payload_dir: Path) -> ValidatedPackage:
    _assert_readable_package_file(source)
    try:
        with zipfile.ZipFile(source, "r") as archive:
            infos = archive.infolist()
            _validate_archive_infos(infos)
            by_name = {info.filename: info for info in infos}
            manifest = _read_manifest(archive, by_name)
            (
                profile_name,
                identity,
                proxy,
                cookie_meta,
                payload_entries,
                warnings,
                kind,
                sync_section,
            ) = _validate_manifest(manifest)
            cookie_bytes = _read_and_verify_cookie_member(archive, by_name, cookie_meta)
            payload_byte_count = _stage_and_verify_payload_members(
                archive,
                by_name,
                payload_entries,
                staged_payload_dir,
            )
            return ValidatedPackage(
                profile_name=profile_name,
                identity=identity,
                proxy=proxy,
                cookie_bytes=cookie_bytes,
                cookie_count=int(cookie_meta.get("cookieCount", 0)),
                payload_temp_dir=staged_payload_dir,
                payload_files=payload_entries,
                payload_byte_count=payload_byte_count,
                warnings=warnings,
                kind=kind,
                sync=sync_section,
            )
    except PackageValidationError:
        raise
    except zipfile.BadZipFile as exc:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_INVALID,
            message="Profile package is invalid.",
        ) from exc
    except OSError as exc:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_READ_FAILED,
            message="Profile package could not be read.",
        ) from exc


def _assert_readable_package_file(source: Path) -> None:
    try:
        stats = source.stat()
    except OSError as exc:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_READ_FAILED,
            message="Profile package could not be read.",
        ) from exc
    if not source.is_file():
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_READ_FAILED,
            message="Profile package could not be read.",
        )
    if stats.st_size > MAX_ARCHIVE_BYTES:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_TOO_LARGE,
            message="Profile package is too large.",
        )


def _validate_archive_infos(infos: Sequence[zipfile.ZipInfo]) -> None:
    if len(infos) > MAX_ARCHIVE_MEMBERS:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_TOO_LARGE,
            message="Profile package has too many entries.",
        )
    names = [info.filename for info in infos]
    if len(set(names)) != len(names):
        _raise_invalid_package()
    if MANIFEST_MEMBER not in names or COOKIE_MEMBER not in names:
        _raise_invalid_package()

    total_payload_bytes = 0
    payload_count = 0
    for info in infos:
        _validate_member_name(info.filename)
        _validate_member_compression(info)
        if info.is_dir():
            _raise_invalid_package()
        if _zip_info_is_symlink_or_special(info):
            raise PackageValidationError(
                code=PORTABILITY_PACKAGE_PAYLOAD_FAILED,
                message="Profile package payload is invalid.",
            )
        if info.filename == COOKIE_MEMBER and info.file_size > cookies.MAX_IMPORT_BYTES:
            raise PackageValidationError(
                code=PORTABILITY_PACKAGE_TOO_LARGE,
                message="Profile package is too large.",
            )
        if info.filename.startswith(PAYLOAD_PREFIX):
            payload_count += 1
            total_payload_bytes += info.file_size
            if info.file_size > MAX_PAYLOAD_FILE_BYTES:
                raise PackageValidationError(
                    code=PORTABILITY_PACKAGE_TOO_LARGE,
                    message="Profile package payload is too large.",
                )
        elif info.filename not in {MANIFEST_MEMBER, COOKIE_MEMBER}:
            _raise_invalid_package()
    if payload_count > MAX_PAYLOAD_FILES or total_payload_bytes > MAX_PAYLOAD_BYTES:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_TOO_LARGE,
            message="Profile package payload is too large.",
        )


def _read_manifest(archive: zipfile.ZipFile, by_name: Mapping[str, zipfile.ZipInfo]) -> JsonObject:
    info = by_name.get(MANIFEST_MEMBER)
    if info is None or info.file_size > MAX_MANIFEST_BYTES:
        _raise_invalid_package()
    raw = _read_member_bytes(archive, info, MAX_MANIFEST_BYTES)
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_INVALID,
            message="Profile package manifest is invalid.",
        ) from exc
    if not isinstance(parsed, dict):
        _raise_invalid_package()
    return parsed


def _validate_manifest(
    manifest: Mapping[str, Any]
) -> tuple[
    str,
    JsonObject,
    JsonObject,
    JsonObject,
    list[PayloadManifestEntry],
    list[JsonObject],
    str,
    Optional[JsonObject],
]:
    if manifest.get("format") != PACKAGE_FORMAT:
        _raise_invalid_package()
    version = manifest.get("version")
    if isinstance(version, bool) or not isinstance(version, int):
        _raise_invalid_package()
    if version not in SUPPORTED_PACKAGE_VERSIONS:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_UNSUPPORTED_VERSION,
            message="Profile package version is not supported.",
        )

    keys = frozenset(manifest.keys())
    if version < 3:
        # Older packages predate the discriminator and are portable by
        # definition -- there was nothing else to be.
        if keys != _MANIFEST_FIELDS:
            _raise_invalid_package()
        kind = PACKAGE_KIND_PORTABLE
    else:
        kind = manifest.get("kind")
        if kind not in SUPPORTED_PACKAGE_KINDS:
            _raise_invalid_package()
        expected = _MANIFEST_FIELDS_V3 if kind == PACKAGE_KIND_SYNC else (_MANIFEST_FIELDS | {"kind"})
        if keys != expected:
            _raise_invalid_package()
    sync_section: Optional[JsonObject] = None
    if version >= 3 and kind == PACKAGE_KIND_SYNC:
        sync_section = _validate_sync_manifest(manifest.get("sync"))
    created_at = manifest.get("createdAt")
    if not isinstance(created_at, str) or not is_utc_iso_timestamp(created_at):
        _raise_invalid_package()

    profile = manifest.get("profile")
    if not isinstance(profile, Mapping):
        _raise_invalid_package()
    if frozenset(profile.keys()) != _PROFILE_FIELDS:
        _raise_invalid_package()
    profile_name = profile.get("name")
    if not isinstance(profile_name, str) or not is_valid_profile_name(profile_name):
        _raise_invalid_package()
    try:
        identity = normalize_profile_identity(profile.get("identity"))
        _reject_imported_proxy_secret_fields(profile.get("proxy"))
        proxy = _strip_proxy_credentials(profile.get("proxy"))
        if profile.get("proxySummary") != public_proxy_summary(proxy):
            _raise_invalid_package()
    except SidecarError as exc:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_INVALID,
            message="Profile package manifest is invalid.",
        ) from exc

    cookie_meta = _validate_cookie_manifest(manifest.get("cookies"))
    payload_entries = _validate_payload_manifest(manifest.get("payload"))
    warnings = _validate_manifest_warnings(manifest.get("warnings", []))
    return profile_name, identity, proxy, cookie_meta, payload_entries, warnings, kind, sync_section


def _validate_sync_manifest(raw: Any) -> JsonObject:
    """The sync section, checked as strictly as everything else in a manifest.

    This arrives from a shared folder, which is to say from another machine that
    may be running a different build -- or from whatever else can write to that
    directory.
    """
    if not isinstance(raw, Mapping) or frozenset(raw.keys()) != _SYNC_FIELDS:
        _raise_invalid_package()

    profile_id = raw.get("profileId")
    if not isinstance(profile_id, str) or not profile_id or len(profile_id) > 64:
        _raise_invalid_package()

    revision = raw.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        _raise_invalid_package()

    device_id = raw.get("deviceId")
    if not isinstance(device_id, str) or len(device_id) > 64:
        _raise_invalid_package()

    try:
        organization = normalize_organization(raw.get("organization"))
        launch = normalize_launch(raw.get("launch"))
    except SidecarError as exc:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_INVALID,
            message="Profile package manifest is invalid.",
        ) from exc

    return {
        "profileId": profile_id,
        "revision": revision,
        "deviceId": device_id,
        "organization": organization,
        "launch": launch,
    }


def _validate_cookie_manifest(raw: Any) -> JsonObject:
    if not isinstance(raw, Mapping):
        _raise_invalid_package()
    allowed = {"member", "format", "version", "byteCount", "sha256", "cookieCount", "skippedCount"}
    if set(raw) - allowed:
        _raise_invalid_package()
    if raw.get("member") != COOKIE_MEMBER:
        _raise_invalid_package()
    if raw.get("format") != cookies.THEPRIVATOR_COOKIE_FORMAT:
        _raise_invalid_package()
    if raw.get("version") != cookies.THEPRIVATOR_COOKIE_SCHEMA_VERSION:
        _raise_invalid_package()
    byte_count = _manifest_nonnegative_int(raw.get("byteCount"))
    if byte_count > cookies.MAX_IMPORT_BYTES:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_TOO_LARGE,
            message="Profile package is too large.",
        )
    cookie_count = _manifest_nonnegative_int(raw.get("cookieCount"))
    skipped_count = _manifest_nonnegative_int(raw.get("skippedCount"))
    sha256 = raw.get("sha256")
    if not _is_sha256_hex(sha256):
        _raise_invalid_package()
    return {
        "member": COOKIE_MEMBER,
        "byteCount": byte_count,
        "sha256": sha256,
        "cookieCount": cookie_count,
        "skippedCount": skipped_count,
    }


def _validate_payload_manifest(raw: Any) -> list[PayloadManifestEntry]:
    if not isinstance(raw, Mapping):
        _raise_invalid_package()
    allowed = {"prefix", "fileCount", "byteCount", "files"}
    if set(raw) - allowed:
        _raise_invalid_package()
    if raw.get("prefix") != PAYLOAD_PREFIX:
        _raise_invalid_package()
    file_count = _manifest_nonnegative_int(raw.get("fileCount"))
    byte_count = _manifest_nonnegative_int(raw.get("byteCount"))
    files = raw.get("files")
    if not isinstance(files, list) or len(files) != file_count:
        _raise_invalid_package()
    if file_count > MAX_PAYLOAD_FILES or byte_count > MAX_PAYLOAD_BYTES:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_TOO_LARGE,
            message="Profile package payload is too large.",
        )

    entries: list[PayloadManifestEntry] = []
    seen: set[str] = set()
    computed_bytes = 0
    for raw_file in files:
        if not isinstance(raw_file, Mapping):
            _raise_invalid_package()
        if set(raw_file) - {"path", "member", "byteCount", "sha256"}:
            _raise_invalid_package()
        relative_path = _safe_payload_relative_path(raw_file.get("path"))
        if relative_path in seen:
            _raise_invalid_package()
        seen.add(relative_path)
        if raw_file.get("member") != f"{PAYLOAD_PREFIX}{relative_path}":
            _raise_invalid_package()
        file_bytes = _manifest_nonnegative_int(raw_file.get("byteCount"))
        if file_bytes > MAX_PAYLOAD_FILE_BYTES:
            raise PackageValidationError(
                code=PORTABILITY_PACKAGE_TOO_LARGE,
                message="Profile package payload is too large.",
            )
        checksum = raw_file.get("sha256")
        if not _is_sha256_hex(checksum):
            _raise_invalid_package()
        computed_bytes += file_bytes
        entries.append(PayloadManifestEntry(relative_path, file_bytes, checksum))
    if computed_bytes != byte_count:
        _raise_invalid_package()
    return entries


def _validate_manifest_warnings(raw: Any) -> list[JsonObject]:
    if not isinstance(raw, list):
        _raise_invalid_package()
    warnings = PackageWarningAccumulator()
    warnings.extend_public([item for item in raw if isinstance(item, Mapping)])
    return warnings.to_public()


def _read_and_verify_cookie_member(
    archive: zipfile.ZipFile,
    by_name: Mapping[str, zipfile.ZipInfo],
    cookie_meta: Mapping[str, Any],
) -> bytes:
    info = by_name.get(COOKIE_MEMBER)
    if info is None:
        _raise_invalid_package()
    expected_bytes = int(cookie_meta["byteCount"])
    if expected_bytes > cookies.MAX_IMPORT_BYTES or info.file_size > cookies.MAX_IMPORT_BYTES:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_TOO_LARGE,
            message="Profile package is too large.",
        )
    if info.file_size != expected_bytes:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_CHECKSUM_MISMATCH,
            message="Profile package checksum validation failed.",
        )
    raw = _read_member_bytes(archive, info, expected_bytes)
    _assert_checksum(raw, str(cookie_meta["sha256"]))
    try:
        parsed = cookies.parse_theprivator_cookie_payload_bytes(raw)
    except SidecarError as exc:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_INVALID,
            message="Profile package cookie payload is invalid.",
        ) from exc
    if len(parsed.cookies) != int(cookie_meta["cookieCount"]):
        _raise_invalid_package()
    return raw


def _stage_and_verify_payload_members(
    archive: zipfile.ZipFile,
    by_name: Mapping[str, zipfile.ZipInfo],
    entries: Sequence[PayloadManifestEntry],
    staged_payload_dir: Path,
) -> int:
    expected_member_names = {f"{PAYLOAD_PREFIX}{entry.relative_path}" for entry in entries}
    actual_payload_names = {name for name in by_name if name.startswith(PAYLOAD_PREFIX)}
    if actual_payload_names != expected_member_names:
        _raise_invalid_package()

    total_bytes = 0
    staged_payload_dir.mkdir(parents=True, exist_ok=True)
    for entry in entries:
        member_name = f"{PAYLOAD_PREFIX}{entry.relative_path}"
        info = by_name.get(member_name)
        if info is None:
            _raise_invalid_package()
        if info.file_size != entry.byte_count:
            raise PackageValidationError(
                code=PORTABILITY_PACKAGE_CHECKSUM_MISMATCH,
                message="Profile package checksum validation failed.",
            )
        total_bytes += entry.byte_count
        if total_bytes > MAX_PAYLOAD_BYTES:
            raise PackageValidationError(
                code=PORTABILITY_PACKAGE_TOO_LARGE,
                message="Profile package payload is too large.",
            )
        target = _safe_staged_payload_target(staged_payload_dir, entry.relative_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        try:
            with archive.open(info, "r") as source, target.open("wb") as destination:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    destination.write(chunk)
        except (OSError, zipfile.BadZipFile) as exc:
            raise PackageValidationError(
                code=PORTABILITY_PACKAGE_READ_FAILED,
                message="Profile package could not be read.",
            ) from exc
        if digest.hexdigest() != entry.sha256:
            raise PackageValidationError(
                code=PORTABILITY_PACKAGE_CHECKSUM_MISMATCH,
                message="Profile package checksum validation failed.",
            )
    return total_bytes


def _read_member_bytes(archive: zipfile.ZipFile, info: zipfile.ZipInfo, limit: int) -> bytes:
    if info.file_size > limit:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_TOO_LARGE,
            message="Profile package is too large.",
        )
    try:
        with archive.open(info, "r") as handle:
            raw = handle.read(limit + 1)
    except (OSError, zipfile.BadZipFile) as exc:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_READ_FAILED,
            message="Profile package could not be read.",
        ) from exc
    if len(raw) > limit:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_TOO_LARGE,
            message="Profile package is too large.",
        )
    return raw


def _copy_prepared_payload(source: Path, destination: Path) -> None:
    try:
        destination.mkdir(parents=True, exist_ok=True)
        if not source.exists():
            return
        _copy_directory_contents(source, destination)
    except SidecarError:
        raise
    except OSError as exc:
        raise PackageImportCommitError(
            code=PORTABILITY_PACKAGE_PAYLOAD_FAILED,
            message="Profile package payload could not be restored.",
        ) from exc


def _copy_directory_contents(source: Path, destination: Path) -> None:
    try:
        with os.scandir(source) as iterator:
            entries = sorted(iterator, key=lambda entry: entry.name.casefold())
    except OSError as exc:
        raise PackageImportCommitError(
            code=PORTABILITY_PACKAGE_PAYLOAD_FAILED,
            message="Profile package payload could not be restored.",
        ) from exc
    for entry in entries:
        if _entry_is_symlink(entry):
            raise PackageImportCommitError(
                code=PORTABILITY_PACKAGE_PAYLOAD_FAILED,
                message="Profile package payload could not be restored.",
            )
        entry_path = Path(entry.path)
        target_path = destination / entry.name
        try:
            if entry.is_dir(follow_symlinks=False):
                target_path.mkdir(exist_ok=True)
                _copy_directory_contents(entry_path, target_path)
            elif entry.is_file(follow_symlinks=False):
                shutil.copy2(entry_path, target_path, follow_symlinks=False)
            else:
                raise PackageImportCommitError(
                    code=PORTABILITY_PACKAGE_PAYLOAD_FAILED,
                    message="Profile package payload could not be restored.",
                )
        except OSError as exc:
            raise PackageImportCommitError(
                code=PORTABILITY_PACKAGE_PAYLOAD_FAILED,
                message="Profile package payload could not be restored.",
            ) from exc


def _created_profile_id_from_create_result(result: Mapping[str, Any]) -> Optional[str]:
    profile = result.get("profile")
    if isinstance(profile, Mapping) and isinstance(profile.get("id"), str):
        return profile["id"]
    return None


def _created_profile_id_since(store: ProfileStore, existing_profile_ids: set[str]) -> Optional[str]:
    try:
        created_ids = _profile_ids_from_collection(store.list()) - existing_profile_ids
    except SidecarError:
        return None
    if len(created_ids) == 1:
        return next(iter(created_ids))
    return None


def _profile_ids_from_collection(collection: Mapping[str, Any]) -> set[str]:
    profiles = collection.get("profiles")
    if not isinstance(profiles, list):
        return set()
    return {
        profile["id"]
        for profile in profiles
        if isinstance(profile, Mapping) and isinstance(profile.get("id"), str)
    }


def _rollback_created_profile(store_root: Union[str, Path], profile_id: str) -> None:
    store = ProfileStore(store_root)
    profile_dir: Optional[Path] = None
    try:
        profile = store.get(profile_id)
        profile_dir = Path(store_root) / profile.storage.profileDir
    except SidecarError:
        profile_dir = None
    try:
        # Trash, then purge. delete() is a soft delete now, and a rollback must
        # leave nothing behind: an import that failed halfway never existed as far
        # as the user is concerned, so surfacing it in the trash would be a profile
        # they did not create and cannot meaningfully restore.
        store.delete(profile_id)
        store.purge(profile_id)
    except SidecarError:
        pass
    if profile_dir is not None:
        shutil.rmtree(profile_dir, ignore_errors=True)


def _unique_import_name(store: ProfileStore, base_name: str) -> str:
    existing = {
        profile["name"].casefold()
        for profile in store.list().get("profiles", [])
        if isinstance(profile, Mapping) and isinstance(profile.get("name"), str)
    }
    if base_name.casefold() not in existing:
        return base_name
    for index in range(1, 10_000):
        suffix = " Copy" if index == 1 else f" Copy {index}"
        prefix = base_name[: max(1, MAX_PROFILE_NAME_LENGTH - len(suffix))].rstrip(" .")
        if not prefix:
            prefix = "Imported Profile"
        candidate = f"{prefix}{suffix}"
        if is_valid_profile_name(candidate) and candidate.casefold() not in existing:
            return candidate
    raise PackageImportCommitError(
        code=PORTABILITY_PACKAGE_IMPORT_FAILED,
        message="Profile package import failed.",
    )


def _merge_import_warnings(
    package_warnings: Sequence[Mapping[str, Any]],
    cookie_warnings: Any,
) -> list[JsonObject]:
    warnings = PackageWarningAccumulator()
    warnings.extend_public(package_warnings)
    if isinstance(cookie_warnings, list):
        warnings.extend_public([item for item in cookie_warnings if isinstance(item, Mapping)])
    return warnings.to_public()


def _strip_proxy_credentials(proxy: Any) -> JsonObject:
    normalized = normalize_proxy_config(proxy)
    if "credentials" not in normalized:
        return normalized
    stripped = dict(normalized)
    stripped.pop("credentials", None)
    return stripped


def _selected_path(value: Union[str, Path], *, read: bool) -> Path:
    if isinstance(value, Path):
        raw = str(value)
    elif isinstance(value, str):
        raw = value
    else:
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Profile package path is required.",
        )
    if not raw.strip() or "\x00" in raw:
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Profile package path is required.",
        )
    try:
        return Path(raw).expanduser()
    except (RuntimeError, ValueError) as exc:
        code = PORTABILITY_PACKAGE_READ_FAILED if read else PORTABILITY_PACKAGE_WRITE_FAILED
        message = "Profile package could not be read." if read else "Profile package could not be written."
        raise SidecarError(code=code, message=message) from exc


def _validate_member_name(name: Any) -> str:
    if not isinstance(name, str):
        _raise_invalid_package()
    if name == "" or name.endswith("/") or name.startswith("/") or "//" in name:
        _raise_invalid_package()
    if "\\" in name or "\x00" in name or any(ord(character) < 32 or ord(character) == 127 for character in name):
        _raise_invalid_package()
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or any(part in {"", "."} for part in path.parts):
        _raise_invalid_package()
    if PureWindowsPath(name).is_absolute() or (len(name) >= 2 and name[1] == ":"):
        _raise_invalid_package()
    for segment in path.parts:
        if _unsafe_member_segment(segment):
            _raise_invalid_package()
    return path.as_posix()


def _safe_payload_relative_path(value: Any) -> str:
    name = _validate_member_name(value)
    if name.startswith(PAYLOAD_PREFIX):
        _raise_invalid_package()
    if name in {MANIFEST_MEMBER, COOKIE_MEMBER}:
        _raise_invalid_package()
    return name


def _safe_staged_payload_target(root: Path, relative_path: str) -> Path:
    candidate = root.joinpath(*PurePosixPath(relative_path).parts).resolve()
    resolved_root = root.resolve()
    try:
        candidate.relative_to(resolved_root)
    except ValueError as exc:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_PAYLOAD_FAILED,
            message="Profile package payload is invalid.",
        ) from exc
    return candidate


def _manifest_nonnegative_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        _raise_invalid_package()
    return value


def _is_sha256_hex(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def _unsafe_member_segment(segment: str) -> bool:
    if segment.endswith((" ", ".")):
        return True
    if ":" in segment:
        return True
    reserved_candidate = segment.split(".", 1)[0].upper()
    return reserved_candidate in _RESERVED_WINDOWS_PATH_SEGMENTS


def _reject_imported_proxy_secret_fields(value: Any) -> None:
    if isinstance(value, Mapping):
        for key, nested in value.items():
            if is_proxy_secret_key(key):
                _raise_invalid_package()
            _reject_imported_proxy_secret_fields(nested)
    elif isinstance(value, list):
        for nested in value:
            _reject_imported_proxy_secret_fields(nested)


def _validate_member_compression(info: zipfile.ZipInfo) -> None:
    file_size = int(info.file_size)
    compress_size = int(info.compress_size)
    if file_size <= 0:
        return
    if compress_size <= 0:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_TOO_LARGE,
            message="Profile package is too large.",
        )
    if compress_size < MIN_SUSPICIOUS_COMPRESSED_BYTES:
        return
    if file_size > compress_size * MAX_MEMBER_COMPRESSION_RATIO:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_TOO_LARGE,
            message="Profile package is too large.",
        )


def _assert_checksum(raw: bytes, expected: str) -> None:
    if hashlib.sha256(raw).hexdigest() != expected:
        raise PackageValidationError(
            code=PORTABILITY_PACKAGE_CHECKSUM_MISMATCH,
            message="Profile package checksum validation failed.",
        )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
    except OSError as exc:
        raise SidecarError(
            code=PORTABILITY_PACKAGE_PAYLOAD_FAILED,
            message="Profile package payload could not be prepared.",
        ) from exc
    return digest.hexdigest()


def _is_runtime_payload_name(name: str) -> bool:
    return name in _RUNTIME_FILE_NAMES or any(name.startswith(prefix) for prefix in _RUNTIME_FILE_PREFIXES)


def _is_cookie_database_payload_path(relative_path: str) -> bool:
    parts = PurePosixPath(relative_path).parts
    return parts in {
        ("Default", "Network", "Cookies"),
        ("Default", "Network", "Cookies-journal"),
        ("Default", "Cookies"),
        ("Default", "Cookies-journal"),
    }


def _entry_is_symlink(entry: os.DirEntry[str]) -> bool:
    try:
        return entry.is_symlink()
    except OSError:
        return True


def _zip_info_is_symlink_or_special(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0o170000
    if mode == 0:
        return False
    return not stat.S_ISREG(mode)


def _safe_resolve_existing_or_parent(path: Path) -> Optional[Path]:
    try:
        if path.exists():
            return path.resolve()
        return path.parent.resolve() / path.name
    except OSError:
        return None


def _same_resolved_path(path: Path, other: Optional[Path]) -> bool:
    if other is None:
        return False
    try:
        return path.resolve() == other
    except OSError:
        return False


def _raise_invalid_package() -> None:
    raise PackageValidationError(
        code=PORTABILITY_PACKAGE_INVALID,
        message="Profile package is invalid.",
    )


__all__ = [
    "COOKIE_MEMBER",
    "MANIFEST_MEMBER",
    "PACKAGE_FORMAT",
    "PACKAGE_VERSION",
    "PAYLOAD_PREFIX",
    "export_profile_package",
    "import_profile_package",
]
