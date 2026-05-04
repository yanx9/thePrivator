"""Sidecar-owned legacy ThePrivator scan contract.

The legacy import flow starts with a read-only scan of a user-selected root. This
module intentionally does not reuse ``theprivator.utils.legacy_migration``: that
legacy helper recursively sizes user-data, logs absolute paths, sanitizes names,
and writes through the GUI profile manager. The sidecar contract must instead
return compact typed results, reuse S02 profile-store validation rules, and avoid
mutating either the legacy root or app-data profile store during scan.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Mapping, Optional, Union

from .profiles import ProfileStore, is_valid_profile_name
from .protocol import (
    INVALID_REQUEST,
    LEGACY_CONFIG_MALFORMED,
    LEGACY_CONFIG_MISSING,
    LEGACY_ROOT_INVALID,
    PROFILE_DUPLICATE_NAME,
    PROFILE_INVALID_NAME,
    JsonObject,
    SidecarError,
    make_detail_ref,
)

SCAN_VERSION = 1
LEGACY_SOURCE = "legacy-theprivator"
LEGACY_FORMAT = "legacy-profile"
LEGACY_ID_PREFIX = "legacy-"


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
    "LEGACY_FORMAT",
    "LEGACY_SOURCE",
    "SCAN_VERSION",
    "scan_legacy_profiles",
]
