"""Store v4 profile sections: organization, launch, lifecycle, and sync.

These are kept out of ``profiles.py`` for the same reason ``identity`` and
``proxy`` are: each is a self-contained schema with its own bounds, and the
record module's job is to compose them rather than to know their rules.

Every normalizer here is strict-key by design, matching the rest of the store.
An unknown field is a sign that something wrote a shape this build does not
understand, and silently dropping it would lose data on the next write.
"""

from __future__ import annotations

import re
from typing import Any, Mapping, Optional, Sequence

from .protocol import (
    JsonObject,
    PROFILE_ORGANIZATION_INVALID,
    PROFILE_START_URL_INVALID,
    SidecarError,
)

# --- Organization -----------------------------------------------------------

MAX_TAGS_PER_PROFILE = 10
MAX_TAG_LENGTH = 32
MAX_NOTES_LENGTH = 1500
_TAG_RE = re.compile(r"^[\w \-]+$", re.UNICODE)
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

_ORGANIZATION_FIELDS = frozenset({"folderId", "tags", "notes", "favorite", "color"})

# --- Launch -----------------------------------------------------------------

STARTUP_BEHAVIOR_CUSTOM_URLS = "customUrls"
STARTUP_BEHAVIOR_RESTORE_SESSION = "restoreSession"
_STARTUP_BEHAVIORS = frozenset({STARTUP_BEHAVIOR_CUSTOM_URLS, STARTUP_BEHAVIOR_RESTORE_SESSION})

MAX_START_URLS = 10
MAX_START_URL_LENGTH = 2048
MAX_LAUNCH_ARGS = 20
MAX_LAUNCH_ARG_LENGTH = 256

# A start URL becomes a positional Chromium argument. Requiring one of these
# exact prefixes is what makes switch injection structurally impossible: a string
# beginning "https://" can never be parsed as a flag. Everything else -- file:,
# chrome:, javascript:, data:, view-source: -- is rejected rather than sanitized,
# because sanitizing an argv value is a losing game.
_ALLOWED_START_URL_PREFIXES = ("https://", "http://")
_ALLOWED_START_URL_LITERALS = frozenset({"about:blank"})

_LAUNCH_FIELDS = frozenset({"startupBehavior", "startUrls", "args"})

# --- Lifecycle --------------------------------------------------------------

_LIFECYCLE_FIELDS = frozenset({"deletedAt", "lastLaunchedAt", "launchCount"})

# --- Sync -------------------------------------------------------------------

_SYNC_FIELDS = frozenset(
    {"revision", "updatedBy", "originDeviceId", "lastSyncedAt", "lastSyncedRevision"}
)


def default_organization() -> JsonObject:
    return {"folderId": None, "tags": [], "notes": "", "favorite": False, "color": None}


def default_launch() -> JsonObject:
    return {"startupBehavior": STARTUP_BEHAVIOR_CUSTOM_URLS, "startUrls": [], "args": []}


def default_lifecycle() -> JsonObject:
    return {"deletedAt": None, "lastLaunchedAt": None, "launchCount": 0}


def default_sync(device_id: str) -> JsonObject:
    return {
        "revision": 1,
        "updatedBy": device_id,
        "originDeviceId": device_id,
        "lastSyncedAt": None,
        "lastSyncedRevision": None,
    }


def normalize_organization(value: Any) -> JsonObject:
    """Validate the folder, tags, notes, favourite flag, and colour."""
    record = _require_object(value, default_organization(), _ORGANIZATION_FIELDS)

    folder_id = record.get("folderId")
    if folder_id is not None and not _is_uuid(folder_id):
        raise _organization_error("Profile folder id must be a uuid or null.")

    tags = record.get("tags", [])
    if not isinstance(tags, list) or len(tags) > MAX_TAGS_PER_PROFILE:
        raise _organization_error(
            f"A profile can carry at most {MAX_TAGS_PER_PROFILE} tags."
        )
    normalized_tags: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        if not isinstance(tag, str):
            raise _organization_error("Profile tags must be text.")
        trimmed = tag.strip()
        if not trimmed or len(trimmed) > MAX_TAG_LENGTH or not _TAG_RE.match(trimmed):
            raise _organization_error(
                f"Profile tags must be 1-{MAX_TAG_LENGTH} characters of letters, digits, spaces, or hyphens."
            )
        folded = trimmed.casefold()
        if folded in seen:
            continue
        seen.add(folded)
        normalized_tags.append(trimmed)

    notes = record.get("notes", "")
    if not isinstance(notes, str) or len(notes) > MAX_NOTES_LENGTH:
        raise _organization_error(f"Profile notes must be {MAX_NOTES_LENGTH} characters or fewer.")
    # Notes are free text a user typed: slashes and colons are ordinary content,
    # so the guard is control characters and length, never a path-shaped rejection.
    if _contains_control_characters(notes):
        raise _organization_error("Profile notes cannot contain control characters.")

    favorite = record.get("favorite", False)
    if not isinstance(favorite, bool):
        raise _organization_error("Profile favorite must be true or false.")

    color = record.get("color")
    if color is not None and (not isinstance(color, str) or not _COLOR_RE.match(color)):
        raise _organization_error("Profile color must be a #rrggbb value or null.")

    return {
        "folderId": folder_id,
        "tags": normalized_tags,
        "notes": notes,
        "favorite": favorite,
        "color": color,
    }


def normalize_launch(value: Any) -> JsonObject:
    """Validate startup behaviour, start URLs, and extra launch arguments."""
    record = _require_object(value, default_launch(), _LAUNCH_FIELDS)

    behavior = record.get("startupBehavior", STARTUP_BEHAVIOR_CUSTOM_URLS)
    if behavior not in _STARTUP_BEHAVIORS:
        raise _start_url_error("Startup behavior must be customUrls or restoreSession.")

    start_urls = record.get("startUrls", [])
    if not isinstance(start_urls, list) or len(start_urls) > MAX_START_URLS:
        raise _start_url_error(f"A profile can carry at most {MAX_START_URLS} start URLs.")
    normalized_urls = [_normalized_start_url(entry) for entry in start_urls]

    args = record.get("args", [])
    if not isinstance(args, list) or len(args) > MAX_LAUNCH_ARGS:
        raise _start_url_error(f"A profile can carry at most {MAX_LAUNCH_ARGS} launch arguments.")
    normalized_args: list[str] = []
    for arg in args:
        if not isinstance(arg, str) or not arg.startswith("--"):
            raise _start_url_error("Launch arguments must be switches beginning with '--'.")
        if len(arg) > MAX_LAUNCH_ARG_LENGTH or _contains_control_characters(arg) or "\x00" in arg:
            raise _start_url_error("Launch arguments must be short, printable switches.")
        normalized_args.append(arg)

    return {
        "startupBehavior": behavior,
        "startUrls": normalized_urls,
        "args": normalized_args,
    }


def normalize_lifecycle(value: Any) -> JsonObject:
    record = _require_object(value, default_lifecycle(), _LIFECYCLE_FIELDS)

    deleted_at = _optional_timestamp(record.get("deletedAt"), "deletedAt")
    last_launched_at = _optional_timestamp(record.get("lastLaunchedAt"), "lastLaunchedAt")

    launch_count = record.get("launchCount", 0)
    if isinstance(launch_count, bool) or not isinstance(launch_count, int) or launch_count < 0:
        raise _organization_error("Profile launch count must be a non-negative whole number.")

    return {
        "deletedAt": deleted_at,
        "lastLaunchedAt": last_launched_at,
        "launchCount": launch_count,
    }


def normalize_sync(value: Any, *, device_id: str) -> JsonObject:
    record = _require_object(value, default_sync(device_id), _SYNC_FIELDS)

    revision = record.get("revision", 1)
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        raise _organization_error("Profile sync revision must be a positive whole number.")

    updated_by = record.get("updatedBy", device_id)
    origin_device_id = record.get("originDeviceId", device_id)
    for label, candidate in (("updatedBy", updated_by), ("originDeviceId", origin_device_id)):
        if not isinstance(candidate, str) or not candidate or len(candidate) > 64:
            raise _organization_error(f"Profile sync {label} must be a short device identifier.")

    last_synced_at = _optional_timestamp(record.get("lastSyncedAt"), "lastSyncedAt")

    last_synced_revision = record.get("lastSyncedRevision")
    if last_synced_revision is not None and (
        isinstance(last_synced_revision, bool)
        or not isinstance(last_synced_revision, int)
        or last_synced_revision < 1
    ):
        raise _organization_error("Profile sync lastSyncedRevision must be a positive number or null.")

    return {
        "revision": revision,
        "updatedBy": updated_by,
        "originDeviceId": origin_device_id,
        "lastSyncedAt": last_synced_at,
        "lastSyncedRevision": last_synced_revision,
    }


def start_urls_for_launch(launch: Mapping[str, Any]) -> Sequence[str]:
    """The positional URLs Chromium should open, in order."""
    if launch.get("startupBehavior") != STARTUP_BEHAVIOR_CUSTOM_URLS:
        return ()
    urls = launch.get("startUrls")
    return tuple(urls) if isinstance(urls, list) else ()


def _normalized_start_url(value: Any) -> str:
    if not isinstance(value, str):
        raise _start_url_error("Start URLs must be text.")
    candidate = value.strip()
    if not candidate or len(candidate) > MAX_START_URL_LENGTH:
        raise _start_url_error(f"Start URLs must be 1-{MAX_START_URL_LENGTH} characters.")
    if _contains_control_characters(candidate) or any(ch.isspace() for ch in candidate):
        raise _start_url_error("Start URLs cannot contain whitespace or control characters.")
    if candidate in _ALLOWED_START_URL_LITERALS:
        return candidate
    if not candidate.startswith(_ALLOWED_START_URL_PREFIXES):
        raise _start_url_error("Start URLs must begin with https:// or http://.")
    return candidate


def _require_object(value: Any, fallback: JsonObject, allowed: frozenset[str]) -> JsonObject:
    if value is None:
        return dict(fallback)
    if not isinstance(value, Mapping):
        raise _organization_error("Profile section must be an object.")
    unknown = set(value) - allowed
    if unknown:
        raise _organization_error("Profile section contains unknown fields.")
    merged = dict(fallback)
    merged.update(value)
    return merged


def _optional_timestamp(value: Any, label: str) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str) or not value.endswith("Z") or len(value) > 40:
        raise _organization_error(f"Profile {label} must be a UTC timestamp or null.")
    return value


def _contains_control_characters(value: str) -> bool:
    return any(ord(character) < 32 or ord(character) == 127 for character in value)


def _is_uuid(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    import uuid as _uuid

    try:
        return str(_uuid.UUID(value)) == value
    except (ValueError, AttributeError, TypeError):
        return False


def _organization_error(message: str) -> SidecarError:
    return SidecarError(code=PROFILE_ORGANIZATION_INVALID, message=message)


def _start_url_error(message: str) -> SidecarError:
    return SidecarError(code=PROFILE_START_URL_INVALID, message=message)
