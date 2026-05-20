"""Sidecar-owned cookie portability for stopped Chromium profiles.

The UI/Rust layers are only allowed to provide opaque dialog-selected paths and
profile ids. This module owns parsing, serialization, profile/runtime guards,
and SQLite mutation so public responses and diagnostics never echo paths or
cookie material.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Optional, Sequence, Union

from . import chromium
from .profiles import ProfileRecord, ProfileStore
from .protocol import (
    INVALID_REQUEST,
    JsonObject,
    PORTABILITY_COOKIE_DB_UNAVAILABLE,
    PORTABILITY_COOKIE_DB_WRITE_FAILED,
    PORTABILITY_COOKIE_FILE_INVALID,
    PORTABILITY_COOKIE_FILE_TOO_LARGE,
    PORTABILITY_COOKIE_READ_FAILED,
    PORTABILITY_COOKIE_WRITE_FAILED,
    PORTABILITY_UNSUPPORTED_FORMAT,
    SidecarError,
)

PORTABILITY_VERSION = 1
THEPRIVATOR_COOKIE_FORMAT = "theprivator.cookies"
THEPRIVATOR_COOKIE_SCHEMA_VERSION = 1
FORMAT_NETSCAPE = "netscape"
FORMAT_THEPRIVATOR_JSON = "theprivator-json"
SUPPORTED_EXPORT_FORMATS = frozenset({FORMAT_NETSCAPE, FORMAT_THEPRIVATOR_JSON})
MAX_IMPORT_BYTES = 1_048_576
MAX_WARNING_OBJECTS = 20
CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600
SQLITE_TIMEOUT_SECONDS = 0.25

_WARNING_MESSAGES = {
    "COOKIE_VALUE_UNAVAILABLE": "Some stored cookies could not be exported because their values were unavailable to the sidecar.",
    "COOKIE_ROW_UNSUPPORTED": "Some stored cookies had unsupported shapes and were skipped.",
    "COOKIE_SCHEMA_UNSUPPORTED": "The cookie database schema was not supported by the portability reader.",
    "NETSCAPE_METADATA_OMITTED": "Some cookie metadata is not represented by Netscape cookies.txt and was omitted from that export.",
    "IMPORT_DUPLICATE_REPLACED": "Duplicate imported cookies were resolved deterministically by domain, path, and name.",
}

_SAMESITE_TO_DB = {
    None: -1,
    "unspecified": -1,
    "no_restriction": 0,
    "lax": 1,
    "strict": 2,
}
_DB_TO_SAMESITE = {
    -1: "unspecified",
    0: "no_restriction",
    1: "lax",
    2: "strict",
}
_PRIORITY_TO_DB = {
    None: 1,
    "low": 0,
    "medium": 1,
    "high": 2,
}
_DB_TO_PRIORITY = {
    0: "low",
    1: "medium",
    2: "high",
}

_CANONICAL_COOKIE_SCHEMA = """
CREATE TABLE IF NOT EXISTS cookies (
  creation_utc INTEGER NOT NULL,
  host_key TEXT NOT NULL,
  top_frame_site_key TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  encrypted_value BLOB NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  expires_utc INTEGER NOT NULL,
  is_secure INTEGER NOT NULL,
  is_httponly INTEGER NOT NULL,
  last_access_utc INTEGER NOT NULL,
  has_expires INTEGER NOT NULL DEFAULT 1,
  is_persistent INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 1,
  samesite INTEGER NOT NULL DEFAULT -1,
  source_scheme INTEGER NOT NULL DEFAULT 0,
  source_port INTEGER NOT NULL DEFAULT -1,
  is_same_party INTEGER NOT NULL DEFAULT 0,
  last_update_utc INTEGER NOT NULL DEFAULT 0,
  source_type INTEGER NOT NULL DEFAULT 0,
  has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0,
  UNIQUE(host_key, top_frame_site_key, name, path)
)
"""

_REQUIRED_READ_COLUMNS = frozenset({"host_key", "name", "path"})
_INSERT_IDENTITY_COLUMNS = ("host_key", "top_frame_site_key", "name", "path")


@dataclass(frozen=True)
class CookieDTO:
    """Normalized cookie representation used only inside the sidecar."""

    domain: str
    host_only: bool
    path: str
    name: str
    value: str
    secure: bool
    http_only: bool
    expires_unix: Optional[int]
    same_site: Optional[str] = None
    priority: Optional[str] = None

    def key(self) -> tuple[str, str, str]:
        return (self.domain, self.path, self.name)


class WarningAccumulator:
    """Aggregate safe warning objects without storing cookie identifiers."""

    def __init__(self) -> None:
        self._counts: "OrderedDict[str, int]" = OrderedDict()

    def add(self, code: str, count: int = 1) -> None:
        if count <= 0:
            return
        if code not in _WARNING_MESSAGES:
            code = "COOKIE_ROW_UNSUPPORTED"
        self._counts[code] = self._counts.get(code, 0) + count

    def extend(self, warnings: "WarningAccumulator") -> None:
        for code, count in warnings._counts.items():
            self.add(code, count)

    def to_public(self) -> list[JsonObject]:
        rows: list[JsonObject] = []
        for index, (code, count) in enumerate(self._counts.items()):
            if index >= MAX_WARNING_OBJECTS:
                rows.append(
                    {
                        "code": "COOKIE_WARNING_TRUNCATED",
                        "message": "Additional cookie portability warnings were summarized but not listed.",
                        "count": sum(list(self._counts.values())[index:]),
                    }
                )
                break
            rows.append({"code": code, "message": _WARNING_MESSAGES[code], "count": count})
        return rows

    @property
    def count(self) -> int:
        return len(self.to_public())

    @property
    def item_count(self) -> int:
        return sum(self._counts.values())


@dataclass(frozen=True)
class ImportPayload:
    format: str
    cookies: list[CookieDTO]
    skipped_count: int
    warnings: WarningAccumulator


def export_cookies(
    store_root: Union[str, Path],
    profile_id: str,
    destination_path: Union[str, Path],
    export_format: str,
) -> JsonObject:
    """Export cookies for a stopped profile to a user-selected destination."""
    canonical_format = normalize_export_format(export_format)
    profile = _load_stopped_profile(store_root, profile_id)
    cookies, skipped_count, warnings = _read_profile_cookies(store_root, profile)
    serialized, serialization_warnings = _serialize_cookies(cookies, canonical_format)
    warnings.extend(serialization_warnings)
    _write_export_file(destination_path, serialized)
    public_warnings = warnings.to_public()
    return {
        "portabilityVersion": PORTABILITY_VERSION,
        "profileId": profile.id,
        "operation": "export",
        "format": canonical_format,
        "exportedCount": len(cookies),
        "skippedCount": skipped_count,
        "warningCount": len(public_warnings),
        "warnings": public_warnings,
    }


def replace_cookies(
    store_root: Union[str, Path],
    profile_id: str,
    source_path: Union[str, Path],
) -> JsonObject:
    """Replace a stopped profile's cookies after validating the entire import."""
    profile = _load_stopped_profile(store_root, profile_id)
    payload = _read_import_payload(source_path)
    imported_cookies, duplicate_count = _dedupe_imported_cookies(payload.cookies)
    warnings = WarningAccumulator()
    warnings.extend(payload.warnings)
    if duplicate_count:
        warnings.add("IMPORT_DUPLICATE_REPLACED", duplicate_count)
    skipped_count = payload.skipped_count + duplicate_count
    replaced_count = _replace_profile_cookies(store_root, profile, imported_cookies)
    public_warnings = warnings.to_public()
    return {
        "portabilityVersion": PORTABILITY_VERSION,
        "profileId": profile.id,
        "operation": "replace",
        "format": payload.format,
        "importedCount": len(imported_cookies),
        "replacedCount": replaced_count,
        "skippedCount": skipped_count,
        "warningCount": len(public_warnings),
        "warnings": public_warnings,
    }


def normalize_export_format(value: Any) -> str:
    if not isinstance(value, str):
        raise SidecarError(
            code=PORTABILITY_UNSUPPORTED_FORMAT,
            message="Cookie export format is not supported.",
        )
    normalized = value.strip().casefold().replace("_", "-")
    if normalized in {"netscape", "cookies-txt", "cookies.txt", "txt"}:
        return FORMAT_NETSCAPE
    if normalized in {"theprivator-json", "theprivator", "json", "theprivator.cookies"}:
        return FORMAT_THEPRIVATOR_JSON
    raise SidecarError(
        code=PORTABILITY_UNSUPPORTED_FORMAT,
        message="Cookie export format is not supported.",
    )


def _load_stopped_profile(store_root: Union[str, Path], profile_id: str) -> ProfileRecord:
    if not isinstance(profile_id, str) or not profile_id.strip():
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Profile id is required.",
        )
    profile = ProfileStore(store_root).get(profile_id)
    chromium.ensure_profile_stopped_for_portability(store_root, profile)
    return profile


def _read_profile_cookies(
    store_root: Union[str, Path], profile: ProfileRecord
) -> tuple[list[CookieDTO], int, WarningAccumulator]:
    warnings = WarningAccumulator()
    db_path = _resolve_cookie_db_path(store_root, profile, for_write=False)
    if db_path is None:
        return [], 0, warnings

    try:
        connection = _connect_cookie_db(db_path, read_only=True)
    except sqlite3.Error as exc:
        raise SidecarError(
            code=PORTABILITY_COOKIE_DB_UNAVAILABLE,
            message="Cookie database is unavailable.",
        ) from exc

    skipped_count = 0
    cookies: list[CookieDTO] = []
    try:
        columns = _cookie_table_columns(connection)
        if not columns:
            return [], 0, warnings
        if not _REQUIRED_READ_COLUMNS.issubset(columns):
            warnings.add("COOKIE_SCHEMA_UNSUPPORTED")
            return [], 0, warnings

        selected_columns = [
            column
            for column in (
                "host_key",
                "name",
                "value",
                "encrypted_value",
                "path",
                "expires_utc",
                "is_secure",
                "is_httponly",
                "has_expires",
                "is_persistent",
                "priority",
                "samesite",
            )
            if column in columns
        ]
        cursor = connection.execute(
            f"SELECT {', '.join(selected_columns)} FROM cookies ORDER BY host_key, path, name"
        )
        for row in cursor.fetchall():
            cookie = _cookie_from_db_row(row, selected_columns, warnings)
            if cookie is None:
                skipped_count += 1
            else:
                cookies.append(cookie)
    except sqlite3.Error as exc:
        raise SidecarError(
            code=PORTABILITY_COOKIE_READ_FAILED,
            message="Cookie database could not be read.",
        ) from exc
    finally:
        connection.close()

    return cookies, skipped_count, warnings


def _cookie_from_db_row(
    row: sqlite3.Row, columns: Sequence[str], warnings: WarningAccumulator
) -> Optional[CookieDTO]:
    data = {column: row[column] for column in columns}
    raw_value = data.get("value", "")
    encrypted_value = data.get("encrypted_value")
    if (not isinstance(raw_value, str) or raw_value == "") and _has_encrypted_value(encrypted_value):
        warnings.add("COOKIE_VALUE_UNAVAILABLE")
        return None
    try:
        return normalize_cookie(
            {
                "domain": data.get("host_key"),
                "hostOnly": not str(data.get("host_key", "")).startswith("."),
                "path": data.get("path", "/"),
                "name": data.get("name"),
                "value": raw_value if isinstance(raw_value, str) else "",
                "secure": _db_bool(data.get("is_secure")),
                "httpOnly": _db_bool(data.get("is_httponly")),
                "expiresUnix": _db_expiry_to_unix(data),
                "sameSite": _DB_TO_SAMESITE.get(_coerce_int(data.get("samesite"), -1), "unspecified"),
                "priority": _DB_TO_PRIORITY.get(_coerce_int(data.get("priority"), 1), "medium"),
            }
        )
    except SidecarError:
        warnings.add("COOKIE_ROW_UNSUPPORTED")
        return None


def _has_encrypted_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, memoryview):
        return len(value) > 0
    if isinstance(value, bytes):
        return len(value) > 0
    return bool(value)


def _db_expiry_to_unix(data: Mapping[str, Any]) -> Optional[int]:
    if _coerce_int(data.get("has_expires"), 1) == 0 or _coerce_int(data.get("is_persistent"), 1) == 0:
        return None
    return chrome_time_to_unix(_coerce_int(data.get("expires_utc"), 0))


def _read_import_payload(source_path: Union[str, Path]) -> ImportPayload:
    path = _selected_path(source_path, read=True)
    import_format = _format_from_source_path(path)
    text = _read_bounded_import_text(path)
    if import_format == FORMAT_THEPRIVATOR_JSON:
        return ImportPayload(import_format, *_parse_theprivator_json(text))
    if import_format == FORMAT_NETSCAPE:
        return ImportPayload(import_format, *_parse_netscape_cookie_text(text))
    raise SidecarError(
        code=PORTABILITY_UNSUPPORTED_FORMAT,
        message="Cookie import format is not supported.",
    )


def _read_bounded_import_text(path: Path) -> str:
    try:
        stats = path.stat()
    except OSError as exc:
        raise SidecarError(
            code=PORTABILITY_COOKIE_READ_FAILED,
            message="Cookie import file could not be read.",
        ) from exc
    if not path.is_file():
        raise SidecarError(
            code=PORTABILITY_COOKIE_READ_FAILED,
            message="Cookie import file could not be read.",
        )
    if stats.st_size > MAX_IMPORT_BYTES:
        raise SidecarError(
            code=PORTABILITY_COOKIE_FILE_TOO_LARGE,
            message="Cookie import file is too large.",
        )
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise SidecarError(
            code=PORTABILITY_COOKIE_FILE_INVALID,
            message="Cookie import file is invalid.",
        ) from exc
    except OSError as exc:
        raise SidecarError(
            code=PORTABILITY_COOKIE_READ_FAILED,
            message="Cookie import file could not be read.",
        ) from exc


def _format_from_source_path(path: Path) -> str:
    name = path.name.casefold()
    suffix = path.suffix.casefold()
    if suffix == ".json":
        return FORMAT_THEPRIVATOR_JSON
    if suffix == ".txt" or name.endswith(".cookies.txt"):
        return FORMAT_NETSCAPE
    raise SidecarError(
        code=PORTABILITY_UNSUPPORTED_FORMAT,
        message="Cookie import format is not supported.",
    )


def _parse_theprivator_json(text: str) -> tuple[list[CookieDTO], int, WarningAccumulator]:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SidecarError(
            code=PORTABILITY_COOKIE_FILE_INVALID,
            message="Cookie import file is invalid.",
        ) from exc
    if not isinstance(payload, Mapping):
        _raise_invalid_cookie_file()
    if payload.get("format") != THEPRIVATOR_COOKIE_FORMAT or payload.get("version") != THEPRIVATOR_COOKIE_SCHEMA_VERSION:
        _raise_invalid_cookie_file()
    raw_cookies = payload.get("cookies")
    if not isinstance(raw_cookies, list):
        _raise_invalid_cookie_file()
    cookies: list[CookieDTO] = []
    for raw_cookie in raw_cookies:
        if not isinstance(raw_cookie, Mapping):
            _raise_invalid_cookie_file()
        cookies.append(normalize_cookie(raw_cookie, strict_keys=True))
    return cookies, 0, WarningAccumulator()


def _parse_netscape_cookie_text(text: str) -> tuple[list[CookieDTO], int, WarningAccumulator]:
    cookies: list[CookieDTO] = []
    for raw_line in text.splitlines():
        line = raw_line.rstrip("\r\n")
        if not line.strip():
            continue
        http_only = False
        if line.startswith("#HttpOnly_"):
            http_only = True
            line = line[len("#HttpOnly_") :]
        elif line.lstrip().startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) != 7:
            _raise_invalid_cookie_file()
        domain, include_subdomains, path, secure, expires, name, value = parts
        include_subdomains_bool = _parse_netscape_bool(include_subdomains)
        secure_bool = _parse_netscape_bool(secure)
        if include_subdomains_bool is None or secure_bool is None:
            _raise_invalid_cookie_file()
        if not expires.isdecimal():
            _raise_invalid_cookie_file()
        expires_int = int(expires)
        cookies.append(
            normalize_cookie(
                {
                    "domain": domain,
                    "hostOnly": not include_subdomains_bool,
                    "path": path,
                    "name": name,
                    "value": value,
                    "secure": secure_bool,
                    "httpOnly": http_only,
                    "expiresUnix": None if expires_int == 0 else expires_int,
                    "sameSite": "unspecified",
                    "priority": "medium",
                }
            )
        )
    return cookies, 0, WarningAccumulator()


def _parse_netscape_bool(value: str) -> Optional[bool]:
    folded = value.casefold()
    if folded == "true":
        return True
    if folded == "false":
        return False
    return None


def normalize_cookie(raw: Mapping[str, Any], *, strict_keys: bool = False) -> CookieDTO:
    allowed = {
        "domain",
        "hostOnly",
        "path",
        "name",
        "value",
        "secure",
        "httpOnly",
        "expiresUnix",
        "sameSite",
        "priority",
    }
    if strict_keys and set(raw) != allowed:
        _raise_invalid_cookie_file()
    domain = _required_clean_string(raw.get("domain"), max_length=253)
    path = _required_clean_string(raw.get("path"), max_length=2048)
    name = _required_clean_string(raw.get("name"), max_length=1024)
    value = _required_clean_string(raw.get("value"), max_length=16_384, allow_empty=True)
    if not path.startswith("/"):
        _raise_invalid_cookie_file()
    host_only = _required_bool(raw.get("hostOnly"))
    secure = _required_bool(raw.get("secure"))
    http_only = _required_bool(raw.get("httpOnly"))
    expires_unix = _optional_expiry(raw.get("expiresUnix"))
    same_site = _optional_enum(raw.get("sameSite"), {"unspecified", "no_restriction", "lax", "strict"})
    priority = _optional_enum(raw.get("priority"), {"low", "medium", "high"})
    return CookieDTO(
        domain=domain,
        host_only=host_only,
        path=path,
        name=name,
        value=value,
        secure=secure,
        http_only=http_only,
        expires_unix=expires_unix,
        same_site=same_site,
        priority=priority,
    )


def _required_clean_string(value: Any, *, max_length: int, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        _raise_invalid_cookie_file()
    if not allow_empty and not value:
        _raise_invalid_cookie_file()
    if len(value) > max_length or "\x00" in value or any(ord(character) < 32 for character in value):
        _raise_invalid_cookie_file()
    return value


def _required_bool(value: Any) -> bool:
    if not isinstance(value, bool):
        _raise_invalid_cookie_file()
    return value


def _optional_expiry(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        _raise_invalid_cookie_file()
    if value < 0 or value > 253_402_300_799:
        _raise_invalid_cookie_file()
    return value


def _optional_enum(value: Any, allowed: set[str]) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        _raise_invalid_cookie_file()
    normalized = value.strip().casefold().replace("-", "_")
    if normalized not in allowed:
        _raise_invalid_cookie_file()
    return normalized


def _dedupe_imported_cookies(cookies: Iterable[CookieDTO]) -> tuple[list[CookieDTO], int]:
    unique: "OrderedDict[tuple[str, str, str], CookieDTO]" = OrderedDict()
    duplicate_count = 0
    for cookie in cookies:
        key = cookie.key()
        if key in unique:
            duplicate_count += 1
            unique.pop(key)
        unique[key] = cookie
    return list(unique.values()), duplicate_count


def _serialize_cookies(cookies: Sequence[CookieDTO], export_format: str) -> tuple[str, WarningAccumulator]:
    if export_format == FORMAT_THEPRIVATOR_JSON:
        payload = {
            "format": THEPRIVATOR_COOKIE_FORMAT,
            "version": THEPRIVATOR_COOKIE_SCHEMA_VERSION,
            "cookies": [_cookie_to_json(cookie) for cookie in cookies],
        }
        return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", WarningAccumulator()
    if export_format == FORMAT_NETSCAPE:
        return _serialize_netscape(cookies)
    raise SidecarError(
        code=PORTABILITY_UNSUPPORTED_FORMAT,
        message="Cookie export format is not supported.",
    )


def _cookie_to_json(cookie: CookieDTO) -> JsonObject:
    return {
        "domain": cookie.domain,
        "hostOnly": cookie.host_only,
        "path": cookie.path,
        "name": cookie.name,
        "value": cookie.value,
        "secure": cookie.secure,
        "httpOnly": cookie.http_only,
        "expiresUnix": cookie.expires_unix,
        "sameSite": cookie.same_site,
        "priority": cookie.priority,
    }


def _serialize_netscape(cookies: Sequence[CookieDTO]) -> tuple[str, WarningAccumulator]:
    warnings = WarningAccumulator()
    lines = [
        "# Netscape HTTP Cookie File",
        "# Generated by ThePrivator cookie portability.",
    ]
    omitted_metadata_count = 0
    for cookie in cookies:
        if cookie.same_site not in {None, "unspecified"} or cookie.priority not in {None, "medium"}:
            omitted_metadata_count += 1
        domain = cookie.domain
        if cookie.http_only:
            domain = f"#HttpOnly_{domain}"
        include_subdomains = "FALSE" if cookie.host_only else "TRUE"
        secure = "TRUE" if cookie.secure else "FALSE"
        expires = str(cookie.expires_unix if cookie.expires_unix is not None else 0)
        lines.append("\t".join([domain, include_subdomains, cookie.path, secure, expires, cookie.name, cookie.value]))
    if omitted_metadata_count:
        warnings.add("NETSCAPE_METADATA_OMITTED", omitted_metadata_count)
    return "\n".join(lines) + "\n", warnings


def _replace_profile_cookies(
    store_root: Union[str, Path], profile: ProfileRecord, cookies: Sequence[CookieDTO]
) -> int:
    db_path = _resolve_cookie_db_path(store_root, profile, for_write=True)
    if db_path is None:
        raise SidecarError(
            code=PORTABILITY_COOKIE_DB_WRITE_FAILED,
            message="Cookie database could not be prepared.",
        )
    try:
        db_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise SidecarError(
            code=PORTABILITY_COOKIE_DB_WRITE_FAILED,
            message="Cookie database could not be prepared.",
        ) from exc

    connection: Optional[sqlite3.Connection] = None
    try:
        connection = _connect_cookie_db(db_path, read_only=False)
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(_CANONICAL_COOKIE_SCHEMA)
        columns = _cookie_table_columns(connection)
        _assert_insertable_cookie_schema(columns)
        existing_keys = _existing_cookie_keys(connection, columns)
        connection.execute("DELETE FROM cookies")
        insert_columns = _insert_columns(columns)
        insert_sql = _insert_sql(insert_columns)
        for cookie in cookies:
            values = _insert_values(cookie, insert_columns)
            connection.execute(insert_sql, values)
        connection.commit()
        return sum(1 for cookie in cookies if cookie.key() in existing_keys)
    except sqlite3.Error as exc:
        if connection is not None:
            try:
                connection.rollback()
            except sqlite3.Error:
                pass
        raise SidecarError(
            code=PORTABILITY_COOKIE_DB_WRITE_FAILED,
            message="Cookie database could not be updated.",
        ) from exc
    finally:
        if connection is not None:
            connection.close()


def _resolve_cookie_db_path(
    store_root: Union[str, Path], profile: ProfileRecord, *, for_write: bool
) -> Optional[Path]:
    user_data_path = chromium.resolve_user_data_path(store_root, profile)
    modern = user_data_path / "Default" / "Network" / "Cookies"
    legacy = user_data_path / "Default" / "Cookies"
    for candidate in (modern, legacy):
        if candidate.exists():
            if candidate.is_file():
                return candidate
            raise SidecarError(
                code=PORTABILITY_COOKIE_DB_UNAVAILABLE,
                message="Cookie database is unavailable.",
            )
    if for_write:
        return modern
    return None


def _connect_cookie_db(path: Path, *, read_only: bool) -> sqlite3.Connection:
    try:
        if read_only:
            connection = sqlite3.connect(
                f"file:{path}?mode=ro",
                uri=True,
                timeout=SQLITE_TIMEOUT_SECONDS,
            )
        else:
            connection = sqlite3.connect(path, timeout=SQLITE_TIMEOUT_SECONDS)
        connection.row_factory = sqlite3.Row
        return connection
    except sqlite3.Error:
        raise


def _cookie_table_columns(connection: sqlite3.Connection) -> dict[str, JsonObject]:
    rows = connection.execute("PRAGMA table_info(cookies)").fetchall()
    columns: dict[str, JsonObject] = {}
    for row in rows:
        name = row["name"]
        if not isinstance(name, str):
            continue
        columns[name] = {
            "notnull": bool(row["notnull"]),
            "default": row["dflt_value"],
            "pk": row["pk"],
        }
    return columns


def _assert_insertable_cookie_schema(columns: Mapping[str, Mapping[str, Any]]) -> None:
    required = {"host_key", "name", "value", "path", "expires_utc", "is_secure", "is_httponly"}
    if not required.issubset(columns):
        raise sqlite3.OperationalError("unsupported cookie schema")
    known = set(_known_insert_value_map(_empty_cookie(), 0))
    for column, metadata in columns.items():
        if column in known:
            continue
        if metadata.get("pk"):
            continue
        if metadata.get("notnull") and metadata.get("default") is None:
            raise sqlite3.OperationalError("unsupported required cookie column")


def _existing_cookie_keys(
    connection: sqlite3.Connection, columns: Mapping[str, Mapping[str, Any]]
) -> set[tuple[str, str, str]]:
    if not {"host_key", "path", "name"}.issubset(columns):
        return set()
    rows = connection.execute("SELECT host_key, path, name FROM cookies").fetchall()
    keys: set[tuple[str, str, str]] = set()
    for row in rows:
        host_key = row["host_key"]
        path = row["path"]
        name = row["name"]
        if isinstance(host_key, str) and isinstance(path, str) and isinstance(name, str):
            keys.add((host_key, path, name))
    return keys


def _insert_columns(columns: Mapping[str, Mapping[str, Any]]) -> list[str]:
    return [column for column in _known_insert_value_map(_empty_cookie(), 0) if column in columns]


def _insert_sql(columns: Sequence[str]) -> str:
    quoted_columns = ", ".join(columns)
    placeholders = ", ".join("?" for _column in columns)
    return f"INSERT INTO cookies ({quoted_columns}) VALUES ({placeholders})"


def _insert_values(cookie: CookieDTO, columns: Sequence[str]) -> list[Any]:
    now = unix_time_to_chrome(int(time.time()))
    values = _known_insert_value_map(cookie, now)
    return [values[column] for column in columns]


def _known_insert_value_map(cookie: CookieDTO, now_chrome_time: int) -> dict[str, Any]:
    expires_utc = unix_time_to_chrome(cookie.expires_unix) if cookie.expires_unix is not None else 0
    has_expiry = 1 if cookie.expires_unix is not None else 0
    return {
        "creation_utc": now_chrome_time,
        "host_key": cookie.domain,
        "top_frame_site_key": "",
        "name": cookie.name,
        "value": cookie.value,
        "encrypted_value": sqlite3.Binary(b""),
        "path": cookie.path,
        "expires_utc": expires_utc,
        "is_secure": 1 if cookie.secure else 0,
        "is_httponly": 1 if cookie.http_only else 0,
        "last_access_utc": now_chrome_time,
        "has_expires": has_expiry,
        "is_persistent": has_expiry,
        "priority": _PRIORITY_TO_DB.get(cookie.priority, 1),
        "samesite": _SAMESITE_TO_DB.get(cookie.same_site, -1),
        "source_scheme": 2 if cookie.secure else 1,
        "source_port": 443 if cookie.secure else 80,
        "is_same_party": 0,
        "last_update_utc": now_chrome_time,
        "source_type": 0,
        "has_cross_site_ancestor": 0,
    }


def _empty_cookie() -> CookieDTO:
    return CookieDTO(
        domain="example.invalid",
        host_only=True,
        path="/",
        name="name",
        value="",
        secure=False,
        http_only=False,
        expires_unix=None,
    )


def _write_export_file(destination_path: Union[str, Path], content: str) -> None:
    path = _selected_path(destination_path, read=False)
    try:
        path.write_text(content, encoding="utf-8")
    except OSError as exc:
        raise SidecarError(
            code=PORTABILITY_COOKIE_WRITE_FAILED,
            message="Cookie export file could not be written.",
        ) from exc


def _selected_path(value: Union[str, Path], *, read: bool) -> Path:
    if isinstance(value, Path):
        raw = str(value)
    elif isinstance(value, str):
        raw = value
    else:
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Cookie file path is required.",
        )
    if not raw.strip() or "\x00" in raw:
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Cookie file path is required.",
        )
    try:
        path = Path(raw).expanduser()
    except (RuntimeError, ValueError) as exc:
        code = PORTABILITY_COOKIE_READ_FAILED if read else PORTABILITY_COOKIE_WRITE_FAILED
        message = "Cookie import file could not be read." if read else "Cookie export file could not be written."
        raise SidecarError(code=code, message=message) from exc
    return path


def _raise_invalid_cookie_file() -> None:
    raise SidecarError(
        code=PORTABILITY_COOKIE_FILE_INVALID,
        message="Cookie import file is invalid.",
    )


def _db_bool(value: Any) -> bool:
    return _coerce_int(value, 0) != 0


def _coerce_int(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    return default


def chrome_time_to_unix(value: int) -> Optional[int]:
    if value <= 0:
        return None
    unix = int(value // 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS)
    return unix if unix > 0 else None


def unix_time_to_chrome(value: Optional[int]) -> int:
    if value is None or value <= 0:
        return 0
    return int((value + CHROME_EPOCH_OFFSET_SECONDS) * 1_000_000)


__all__ = [
    "FORMAT_NETSCAPE",
    "FORMAT_THEPRIVATOR_JSON",
    "MAX_IMPORT_BYTES",
    "PORTABILITY_VERSION",
    "THEPRIVATOR_COOKIE_FORMAT",
    "THEPRIVATOR_COOKIE_SCHEMA_VERSION",
    "export_cookies",
    "normalize_export_format",
    "replace_cookies",
]
