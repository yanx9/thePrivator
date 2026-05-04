"""Sidecar-owned legacy ThePrivator scan and import contract.

The legacy import flow starts with a read-only scan of a user-selected root and
then imports explicit selections through ``ProfileStore``. This module
intentionally does not reuse ``theprivator.utils.legacy_migration``: that legacy
helper recursively sizes user-data, logs absolute paths, sanitizes names, and
writes through the GUI profile manager. The sidecar contract must instead return
compact typed results, reuse S02 profile-store validation rules, and avoid
mutating either the legacy root or app-data profile store during scan. Import is
non-destructive: legacy files are read only, destination user-data is copied into
a sidecar-owned relative storage target, and per-profile copy failures become
partial outcomes rather than top-level tracebacks.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import uuid
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Mapping, Optional, Union

from .profiles import ProfileStore, is_valid_profile_name
from .protocol import (
    INVALID_REQUEST,
    LEGACY_CONFIG_MALFORMED,
    LEGACY_CONFIG_MISSING,
    LEGACY_ROOT_INVALID,
    LEGACY_SELECTION_INVALID,
    LEGACY_USER_DATA_COPY_FAILED,
    PROFILE_DUPLICATE_NAME,
    PROFILE_INVALID_NAME,
    JsonObject,
    SidecarError,
    make_detail_ref,
)

SCAN_VERSION = 1
IMPORT_VERSION = 1
LEGACY_SOURCE = "legacy-theprivator"
LEGACY_FORMAT = "legacy-profile"
LEGACY_ID_PREFIX = "legacy-"

_IMPORT_STATUS_SUCCESS = "success"
_IMPORT_STATUS_PARTIAL = "partial"
_IMPORT_STATUS_FAILED = "failed"
_COPY_STATUS_COPIED = "copied"
_COPY_STATUS_MISSING = "missing"
_COPY_STATUS_FAILED = "failed"
_COPY_STATUS_SKIPPED = "skipped"


def scan_legacy_profiles(legacy_root: Union[str, Path], store_root: Union[str, Path]) -> JsonObject:
    """Scan immediate legacy profile folders without side effects.

    ``legacy_root`` is user-supplied and only used as a scan root after it is
    validated as an existing directory. Candidate IDs are stable opaque hashes
    of the resolved root and immediate folder name; callers must never treat the
    ID as a filesystem path. ``store_root`` is read through ``ProfileStore`` only
    so duplicate target names use the same persisted profile truth as S02.
    """
    root = _validated_legacy_root(legacy_root)
    existing_names = _existing_profile_names(store_root)

    candidates = []
    try:
        children = sorted(root.iterdir(), key=lambda child: child.name.casefold())
    except OSError as exc:
        raise SidecarError(
            code=LEGACY_ROOT_INVALID,
            message="Legacy root must be readable.",
        ) from exc

    for child in children:
        if not _is_directory(child):
            continue
        candidates.append(_scan_candidate(root, child, existing_names))

    return {
        "scanVersion": SCAN_VERSION,
        "count": len(candidates),
        "candidates": candidates,
        "issues": [],
    }


def import_legacy_profiles(
    legacy_root: Union[str, Path],
    store_root: Union[str, Path],
    items: Any,
) -> JsonObject:
    """Import selected legacy profiles with per-profile outcomes.

    The item list is validated up front so malformed shapes and duplicate
    selected legacy IDs cannot produce partial side effects. A fresh scan maps
    opaque ``legacyId`` values back to immediate child folders under
    ``legacy_root``; the ID is never interpreted as a path. Profile records are
    created only through ``ProfileStore.create_imported`` so S02 validation,
    duplicate checks, relative storage construction, and atomic store writes stay
    canonical. User-data copy uses a sibling temporary directory and converts
    copy failures into ``partial`` outcomes while retaining the imported record.
    """
    import_items = _validated_import_items(items)
    if not import_items:
        return _import_response([])

    root = _validated_legacy_root(legacy_root)
    scan_result = scan_legacy_profiles(root, store_root)
    candidates_by_id = {
        candidate["legacyId"]: candidate
        for candidate in scan_result["candidates"]
        if isinstance(candidate, Mapping) and isinstance(candidate.get("legacyId"), str)
    }

    store = ProfileStore(store_root)
    outcomes = []
    for item in import_items:
        legacy_id = item["legacyId"]
        target_name = item["targetName"]
        candidate = candidates_by_id.get(legacy_id)
        if candidate is None:
            outcomes.append(
                _failed_outcome(
                    legacy_id=legacy_id,
                    target_name=target_name,
                    error=_outcome_error(
                        LEGACY_SELECTION_INVALID,
                        "Selected legacy profile was not found in a fresh scan.",
                    ),
                )
            )
            continue

        try:
            create_result = store.create_imported(target_name, metadata=_candidate_metadata(candidate))
        except SidecarError as error:
            outcomes.append(
                _failed_outcome(
                    legacy_id=legacy_id,
                    target_name=target_name,
                    candidate=candidate,
                    error=error.to_dict(),
                )
            )
            continue

        profile = create_result["profile"]
        profile_id = str(profile["id"])
        source_user_data = root / str(candidate["folderName"]) / "user-data"
        if not _candidate_has_user_data(candidate) or not _is_directory(source_user_data):
            outcomes.append(
                _success_outcome(
                    legacy_id=legacy_id,
                    target_name=target_name,
                    candidate=candidate,
                    profile_id=profile_id,
                    copy_status=_COPY_STATUS_MISSING,
                )
            )
            continue

        destination = Path(store_root) / str(profile["storage"]["userDataDir"])
        try:
            _copy_user_data(source_user_data, destination)
        except SidecarError as error:
            outcomes.append(
                _partial_outcome(
                    legacy_id=legacy_id,
                    target_name=target_name,
                    candidate=candidate,
                    profile_id=profile_id,
                    error=error.to_dict(),
                )
            )
            continue

        outcomes.append(
            _success_outcome(
                legacy_id=legacy_id,
                target_name=target_name,
                candidate=candidate,
                profile_id=profile_id,
                copy_status=_COPY_STATUS_COPIED,
            )
        )

    return _import_response(outcomes)


def _validated_import_items(items: Any) -> list[JsonObject]:
    if not isinstance(items, list):
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Legacy import items must be a list.",
        )

    seen_legacy_ids: set[str] = set()
    validated = []
    for raw_item in items:
        if not isinstance(raw_item, Mapping):
            raise SidecarError(
                code=INVALID_REQUEST,
                message="Legacy import item must be an object.",
            )

        legacy_id = raw_item.get("legacyId")
        target_name = raw_item.get("targetName")
        if not isinstance(legacy_id, str) or not legacy_id.strip():
            raise SidecarError(
                code=INVALID_REQUEST,
                message="Legacy import item legacyId is required.",
            )
        if not isinstance(target_name, str) or not target_name.strip():
            raise SidecarError(
                code=INVALID_REQUEST,
                message="Legacy import item targetName is required.",
            )
        if legacy_id in seen_legacy_ids:
            raise SidecarError(
                code=INVALID_REQUEST,
                message="Legacy import item legacyId values must be unique.",
            )

        seen_legacy_ids.add(legacy_id)
        validated.append({"legacyId": legacy_id, "targetName": target_name})

    return validated


def _validated_legacy_root(value: Union[str, Path]) -> Path:
    if isinstance(value, str):
        if not value.strip():
            raise SidecarError(
                code=INVALID_REQUEST,
                message="Legacy root is required.",
            )
        candidate = Path(value).expanduser()
    elif isinstance(value, Path):
        candidate = value.expanduser()
    else:
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Legacy root is required.",
        )

    try:
        if not candidate.exists() or not candidate.is_dir():
            raise SidecarError(
                code=LEGACY_ROOT_INVALID,
                message="Legacy root must be an existing directory.",
            )
        return candidate.resolve()
    except SidecarError:
        raise
    except OSError as exc:
        raise SidecarError(
            code=LEGACY_ROOT_INVALID,
            message="Legacy root must be an existing directory.",
        ) from exc


def _existing_profile_names(store_root: Union[str, Path]) -> set[str]:
    collection = ProfileStore(store_root).list()
    return {
        profile["name"].casefold()
        for profile in collection["profiles"]
        if isinstance(profile, Mapping) and isinstance(profile.get("name"), str)
    }


def _scan_candidate(root: Path, profile_dir: Path, existing_names: set[str]) -> JsonObject:
    config, config_issue = _read_config(profile_dir / "config.json")
    folder_name = profile_dir.name
    legacy_name = _optional_nonblank_string(config.get("name")) if config is not None else None
    target_name = legacy_name if legacy_name is not None else folder_name
    has_user_data = _has_user_data(profile_dir)
    issues = []
    if config_issue is not None:
        issues.append(config_issue)
    issues.extend(_target_name_issues(target_name, existing_names))

    return {
        "legacyId": _legacy_id(root, folder_name),
        "folderName": folder_name,
        "legacyName": legacy_name,
        "targetName": target_name,
        "userData": {"status": "available" if has_user_data else "missing"},
        "metadata": _safe_metadata(folder_name, legacy_name, config, has_user_data),
        "issues": issues,
    }


def _read_config(config_path: Path) -> tuple[Optional[Mapping[str, Any]], Optional[JsonObject]]:
    try:
        if not config_path.exists() or not config_path.is_file():
            return None, _issue(
                LEGACY_CONFIG_MISSING,
                "Legacy profile config.json is missing.",
            )
        with config_path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
        return None, _issue(
            LEGACY_CONFIG_MALFORMED,
            "Legacy profile config.json could not be parsed.",
        )

    if not isinstance(payload, Mapping):
        return None, _issue(
            LEGACY_CONFIG_MALFORMED,
            "Legacy profile config.json must contain an object.",
        )
    return payload, None


def _target_name_issues(target_name: str, existing_names: set[str]) -> list[JsonObject]:
    if not is_valid_profile_name(target_name):
        return [_issue(PROFILE_INVALID_NAME, "Target profile name is invalid.")]
    if target_name.casefold() in existing_names:
        return [_issue(PROFILE_DUPLICATE_NAME, "Target profile name already exists.")]
    return []


def _safe_metadata(
    folder_name: str,
    legacy_name: Optional[str],
    config: Optional[Mapping[str, Any]],
    has_user_data: bool,
) -> JsonObject:
    metadata: JsonObject = {
        "source": LEGACY_SOURCE,
        "format": LEGACY_FORMAT,
        "legacyFolder": folder_name,
        "hasUserData": has_user_data,
    }
    if legacy_name is not None:
        metadata["legacyName"] = legacy_name
    if config is None:
        return metadata

    format_version = _optional_scalar_string(config.get("format_version"))
    if format_version is None:
        format_version = _optional_scalar_string(config.get("version"))
    if format_version is not None:
        metadata["formatVersion"] = format_version

    chromium_version = _optional_scalar_string(config.get("chromium_version"))
    if chromium_version is not None:
        metadata["chromiumVersion"] = chromium_version

    remote_control_port = _optional_port(config.get("rc_port"))
    if remote_control_port is not None:
        metadata["remoteControlPort"] = remote_control_port

    return metadata


def _legacy_id(root: Path, folder_name: str) -> str:
    digest = hashlib.sha256(
        f"{SCAN_VERSION}\0{root.as_posix()}\0{folder_name}".encode("utf-8", errors="surrogatepass")
    ).hexdigest()[:24]
    return f"{LEGACY_ID_PREFIX}{digest}"


def _issue(code: str, message: str) -> JsonObject:
    return {
        "code": code,
        "message": message,
        "detailRef": make_detail_ref(),
    }


def _is_directory(path: Path) -> bool:
    try:
        return path.is_dir()
    except OSError:
        return False


def _has_user_data(profile_dir: Path) -> bool:
    try:
        return (profile_dir / "user-data").is_dir()
    except OSError:
        return False


def _candidate_metadata(candidate: Mapping[str, Any]) -> JsonObject:
    metadata = candidate.get("metadata")
    return dict(metadata) if isinstance(metadata, Mapping) else {}


def _candidate_has_user_data(candidate: Mapping[str, Any]) -> bool:
    user_data = candidate.get("userData")
    return isinstance(user_data, Mapping) and user_data.get("status") == "available"


def _success_outcome(
    *,
    legacy_id: str,
    target_name: str,
    candidate: Mapping[str, Any],
    profile_id: str,
    copy_status: str,
) -> JsonObject:
    outcome = _base_outcome(legacy_id=legacy_id, target_name=target_name, candidate=candidate)
    outcome.update(
        {
            "status": _IMPORT_STATUS_SUCCESS,
            "profileId": profile_id,
            "copyStatus": copy_status,
        }
    )
    return outcome


def _partial_outcome(
    *,
    legacy_id: str,
    target_name: str,
    candidate: Mapping[str, Any],
    profile_id: str,
    error: JsonObject,
) -> JsonObject:
    outcome = _base_outcome(legacy_id=legacy_id, target_name=target_name, candidate=candidate)
    outcome.update(
        {
            "status": _IMPORT_STATUS_PARTIAL,
            "profileId": profile_id,
            "copyStatus": _COPY_STATUS_FAILED,
            "error": error,
        }
    )
    return outcome


def _failed_outcome(
    *,
    legacy_id: str,
    target_name: str,
    error: JsonObject,
    candidate: Optional[Mapping[str, Any]] = None,
) -> JsonObject:
    outcome = _base_outcome(legacy_id=legacy_id, target_name=target_name, candidate=candidate)
    outcome.update(
        {
            "status": _IMPORT_STATUS_FAILED,
            "copyStatus": _COPY_STATUS_SKIPPED,
            "error": error,
        }
    )
    return outcome


def _base_outcome(
    *,
    legacy_id: str,
    target_name: str,
    candidate: Optional[Mapping[str, Any]],
) -> JsonObject:
    outcome: JsonObject = {
        "legacyId": legacy_id,
        "targetName": target_name,
    }
    if candidate is not None:
        folder_name = candidate.get("folderName")
        legacy_name = candidate.get("legacyName")
        if isinstance(folder_name, str):
            outcome["folderName"] = folder_name
        if isinstance(legacy_name, str):
            outcome["legacyName"] = legacy_name
    return outcome


def _outcome_error(code: str, message: str) -> JsonObject:
    return SidecarError(code=code, message=message).to_dict()


def _import_response(outcomes: list[JsonObject]) -> JsonObject:
    success_count = sum(1 for outcome in outcomes if outcome.get("status") == _IMPORT_STATUS_SUCCESS)
    partial_count = sum(1 for outcome in outcomes if outcome.get("status") == _IMPORT_STATUS_PARTIAL)
    failed_count = sum(1 for outcome in outcomes if outcome.get("status") == _IMPORT_STATUS_FAILED)
    return {
        "importVersion": IMPORT_VERSION,
        "requestedCount": len(outcomes),
        "successCount": success_count,
        "partialCount": partial_count,
        "failedCount": failed_count,
        "outcomes": outcomes,
    }


def _copy_user_data(source: Path, destination: Path) -> None:
    try:
        source_root = source.resolve(strict=True)
        if not source_root.is_dir():
            raise _copy_error()
        destination_parent = destination.parent
        temp_destination = destination_parent / f".{destination.name}.legacy-import-{uuid.uuid4().hex}.tmp"
        destination_parent.mkdir(parents=True, exist_ok=True)
        temp_destination.mkdir(mode=0o700)
        copy_committed = False
        try:
            _copy_directory_contents(source_root, temp_destination)
            if destination.exists():
                if not destination.is_dir() or any(destination.iterdir()):
                    raise _copy_error()
                destination.rmdir()
            os.replace(temp_destination, destination)
            copy_committed = True
        finally:
            if not copy_committed:
                if temp_destination.exists():
                    shutil.rmtree(temp_destination, ignore_errors=True)
                if not destination.exists():
                    try:
                        destination.mkdir(parents=True, exist_ok=True)
                    except OSError:
                        pass
    except SidecarError:
        raise
    except OSError as exc:
        raise _copy_error() from exc


def _copy_directory_contents(source: Path, destination: Path) -> None:
    with os.scandir(source) as entries:
        for entry in entries:
            if entry.is_symlink():
                raise _copy_error()

            entry_path = Path(entry.path)
            target_path = destination / entry.name
            if entry.is_dir(follow_symlinks=False):
                target_path.mkdir()
                _copy_directory_contents(entry_path, target_path)
            elif entry.is_file(follow_symlinks=False):
                shutil.copy2(entry_path, target_path, follow_symlinks=False)
            else:
                raise _copy_error()


def _copy_error() -> SidecarError:
    return SidecarError(
        code=LEGACY_USER_DATA_COPY_FAILED,
        message="Legacy user-data copy failed.",
    )


def _optional_nonblank_string(value: Any) -> Optional[str]:
    if isinstance(value, str) and value.strip() and _is_safe_metadata_string(value):
        return value
    return None


def _optional_scalar_string(value: Any) -> Optional[str]:
    if isinstance(value, str) and value.strip() and _is_safe_metadata_string(value):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    return None


def _is_safe_metadata_string(value: str) -> bool:
    return not (
        PurePosixPath(value).is_absolute()
        or PureWindowsPath(value).is_absolute()
        or "://" in value
    )


def _optional_port(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        port = value
    elif isinstance(value, str) and value.isdigit():
        port = int(value)
    else:
        return None
    if 0 < port <= 65535:
        return port
    return None


__all__ = [
    "IMPORT_VERSION",
    "LEGACY_FORMAT",
    "LEGACY_SOURCE",
    "SCAN_VERSION",
    "import_legacy_profiles",
    "scan_legacy_profiles",
]
