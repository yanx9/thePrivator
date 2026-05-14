"""Bounded, redacted diagnostic JSONL storage for sidecar store-root commands."""

from __future__ import annotations

import json
import math
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Iterable, Mapping, Optional, Union

from .profiles import STORE_DIR
from .proxy import PROXY_SECRET_FIELD_MARKERS
from .protocol import JsonObject, RequestId

DIAGNOSTIC_SCHEMA_VERSION = 1
DIAGNOSTIC_SOURCE = "python-sidecar"
DIAGNOSTICS_DIR = "diagnostics"
DIAGNOSTICS_FILE = "events.jsonl"
DIAGNOSTIC_RELATIVE_LOG_PATH = f"{STORE_DIR}/{DIAGNOSTICS_DIR}/{DIAGNOSTICS_FILE}"
DIAGNOSTIC_STORE_WRITE_FAILED = "DIAGNOSTIC_STORE_WRITE_FAILED"
MAX_LOG_BYTES = 512 * 1024
MAX_LOG_LINES = 1000
MAX_LOOKUP_RESULTS = 25

_ALLOWED_EVENTS = {"sidecar.request", "legacy.import.outcome"}
_ALLOWED_SOURCES = {DIAGNOSTIC_SOURCE}
_REQUEST_STATUSES = {"ok", "error"}
_LEGACY_OUTCOME_STATUSES = {"partial", "failed"}
_SAFE_CONTEXT_KEYS = {"legacyId"}
_DETAIL_REF_PATTERN = re.compile(r"^(?:sidecar|bridge|ui)-[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_METHOD_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$")
_ERROR_CODE_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{1,95}$")
_LEGACY_ID_PATTERN = re.compile(r"^legacy-[A-Za-z0-9_.:-]{1,96}$")

_PROXY_FORBIDDEN_STRING_MARKERS = tuple(
    sorted(
        {
            *(marker.casefold() for marker in PROXY_SECRET_FIELD_MARKERS if marker != "auth"),
            "proxy-authorization",
            "proxy_authorization",
            "proxy-pass",
            "proxy-password",
            "proxy-user",
            "proxy-username",
        }
    )
)

_FORBIDDEN_STRING_MARKERS = (
    "traceback",
    "stdout",
    "stderr",
    "params",
    "argv",
    "authorization",
    "bearer",
    "www-authenticate",
    "launchargs",
    "proxy_user",
    "proxy_pass",
    "token=",
    "password=",
    "secret=",
    "--user-data-dir",
    "proxy-server",
    "proxy-auth-extensions",
    "load-extension",
    "disable-extensions-except",
    "remote-debugging",
    "devtoolsactiveport",
    "debugport",
    *_PROXY_FORBIDDEN_STRING_MARKERS,
)


def diagnostic_log_path(store_root: Union[str, Path]) -> Path:
    """Return the only Python-side diagnostics path for an app-data root."""
    root = _safe_store_root(store_root)
    if root is None:
        raise ValueError("store_root must be an absolute app-data path")
    return root / STORE_DIR / DIAGNOSTICS_DIR / DIAGNOSTICS_FILE


def append_events(
    store_root: Union[str, Path, None],
    events: Iterable[Mapping[str, Any]],
    *,
    request_id: Optional[RequestId] = None,
    method: Optional[str] = None,
) -> JsonObject:
    """Append normalized events and trim the log without leaking write paths.

    Invalid store roots and events that cannot be represented by the allowlisted
    schema are skipped. Filesystem failures are returned as a safe diagnostic so
    callers can keep the original sidecar response authoritative.
    """
    root = _safe_store_root(store_root)
    if root is None:
        return {"ok": True, "written": 0, "skipped": True}

    normalized = [
        record
        for event in events
        if (record := normalize_event(event, request_id=request_id, method=method)) is not None
    ]
    if not normalized:
        return {"ok": True, "written": 0, "skipped": True}

    path = root / STORE_DIR / DIAGNOSTICS_DIR / DIAGNOSTICS_FILE
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            for record in normalized:
                handle.write(_encode_record(record) + "\n")
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                # Some test filesystems or platforms may not support fsync; the
                # append succeeded enough for the caller contract, so continue.
                pass
        _trim_log(path)
        return {"ok": True, "written": len(normalized), "skipped": False}
    except OSError:
        return {
            "ok": False,
            "written": 0,
            "diagnostic": diagnostic_store_write_failed_event(
                request_id=request_id,
                method=method,
            ),
        }


def lookup_by_detail_ref(store_root: Union[str, Path], detail_ref: str) -> JsonObject:
    """Return normalized diagnostic records matching one opaque detailRef."""
    base: JsonObject = {
        "found": False,
        "logPath": DIAGNOSTIC_RELATIVE_LOG_PATH,
        "entries": [],
    }
    if not _is_detail_ref(detail_ref):
        return base

    root = _safe_store_root(store_root)
    if root is None:
        return base

    path = root / STORE_DIR / DIAGNOSTICS_DIR / DIAGNOSTICS_FILE
    if not path.is_file():
        return base

    matches = [
        record
        for record in _read_valid_records(path)
        if record.get("detailRef") == detail_ref
    ][:MAX_LOOKUP_RESULTS]
    return {
        "found": bool(matches),
        "logPath": DIAGNOSTIC_RELATIVE_LOG_PATH,
        "entries": matches,
    }


def normalize_event(
    raw_event: Mapping[str, Any],
    *,
    request_id: Optional[RequestId] = None,
    method: Optional[str] = None,
    ts: Optional[str] = None,
) -> Optional[JsonObject]:
    """Convert a stderr-style diagnostic to the durable allowlisted schema."""
    if not isinstance(raw_event, Mapping):
        return None

    event_name = raw_event.get("event")
    if event_name not in _ALLOWED_EVENTS:
        return None

    source = raw_event.get("source", DIAGNOSTIC_SOURCE)
    if source not in _ALLOWED_SOURCES:
        return None

    status = raw_event.get("status")
    if event_name == "sidecar.request" and status not in _REQUEST_STATUSES:
        return None
    if event_name == "legacy.import.outcome" and status not in _LEGACY_OUTCOME_STATUSES:
        return None

    record: JsonObject = {
        "schemaVersion": DIAGNOSTIC_SCHEMA_VERSION,
        "ts": _safe_timestamp(ts or raw_event.get("ts")),
        "source": DIAGNOSTIC_SOURCE,
        "event": event_name,
        "status": status,
        "logPath": DIAGNOSTIC_RELATIVE_LOG_PATH,
    }

    normalized_request_id = _safe_request_id(raw_event.get("requestId", request_id))
    if normalized_request_id is not None:
        record["requestId"] = normalized_request_id

    normalized_method = _safe_method(raw_event.get("method", method))
    if normalized_method is None and event_name == "legacy.import.outcome":
        normalized_method = _safe_method(method) or "legacy.import"
    if normalized_method is not None:
        record["method"] = normalized_method

    duration = _safe_duration(raw_event.get("durationMs"))
    if duration is not None:
        record["durationMs"] = duration

    error_code = _safe_error_code(raw_event.get("errorCode"))
    detail_ref = _safe_detail_ref(raw_event.get("detailRef"))
    if event_name == "sidecar.request":
        if status == "error" and (error_code is None or detail_ref is None):
            return None
        record["errorCode"] = error_code
        record["detailRef"] = detail_ref
        return record

    if error_code is None or detail_ref is None:
        return None
    record["errorCode"] = error_code
    record["detailRef"] = detail_ref

    context = _safe_context(raw_event)
    if context:
        record["context"] = context
    return record


def diagnostic_store_write_failed_event(
    *, request_id: Optional[RequestId] = None, method: Optional[str] = None
) -> JsonObject:
    """Build a safe stderr diagnostic for local diagnostic log write failures."""
    diagnostic: JsonObject = {
        "event": "sidecar.diagnostic_store_write_failed",
        "requestId": _safe_request_id(request_id),
        "method": _safe_method(method),
        "status": "error",
        "errorCode": DIAGNOSTIC_STORE_WRITE_FAILED,
        "detailRef": f"sidecar-{uuid.uuid4().hex[:12]}",
    }
    return {key: value for key, value in diagnostic.items() if value is not None}


def _safe_store_root(value: Union[str, Path, None]) -> Optional[Path]:
    if isinstance(value, Path):
        candidate = value
    elif isinstance(value, str) and value.strip():
        candidate = Path(value)
    else:
        return None

    try:
        expanded = candidate.expanduser()
    except RuntimeError:
        return None
    if not expanded.is_absolute():
        return None
    if any(part == ".gsd" for part in expanded.parts):
        return None
    return expanded


def _read_valid_records(path: Path) -> list[JsonObject]:
    records: list[JsonObject] = []
    for line in _read_bounded_lines(path):
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed, Mapping):
            continue
        normalized = _normalize_existing_record(parsed)
        if normalized is not None:
            records.append(normalized)
    return records[-MAX_LOG_LINES:]


def _normalize_existing_record(record: Mapping[str, Any]) -> Optional[JsonObject]:
    if record.get("schemaVersion") != DIAGNOSTIC_SCHEMA_VERSION:
        return None
    if record.get("logPath") != DIAGNOSTIC_RELATIVE_LOG_PATH:
        return None
    if record.get("source") != DIAGNOSTIC_SOURCE:
        return None
    return normalize_event(record, ts=record.get("ts"))


def _trim_log(path: Path) -> None:
    records = _read_valid_records(path)[-MAX_LOG_LINES:]
    while records and _encoded_size(records) > MAX_LOG_BYTES:
        records.pop(0)

    temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temp_path.open("w", encoding="utf-8") as handle:
            for record in records:
                handle.write(_encode_record(record) + "\n")
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                pass
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def _read_bounded_lines(path: Path) -> list[str]:
    try:
        size = path.stat().st_size
        with path.open("rb") as handle:
            start = max(0, size - MAX_LOG_BYTES)
            handle.seek(start)
            data = handle.read(MAX_LOG_BYTES)
    except OSError:
        return []

    text = data.decode("utf-8", errors="ignore")
    lines = text.splitlines()
    if size > MAX_LOG_BYTES and lines:
        lines = lines[1:]
    return lines


def _encoded_size(records: Iterable[Mapping[str, Any]]) -> int:
    return sum(len(_encode_record(record).encode("utf-8")) + 1 for record in records)


def _encode_record(record: Mapping[str, Any]) -> str:
    return json.dumps(record, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _safe_timestamp(value: Any) -> str:
    if isinstance(value, str) and value.endswith("Z"):
        try:
            datetime.fromisoformat(value[:-1] + "+00:00")
            return value
        except ValueError:
            pass
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _safe_request_id(value: Any) -> Optional[RequestId]:
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str) and _safe_short_string(value):
        return value
    return None


def _safe_method(value: Any) -> Optional[str]:
    if isinstance(value, str) and _METHOD_PATTERN.fullmatch(value) and _safe_short_string(value):
        return value
    return None


def _safe_error_code(value: Any) -> Optional[str]:
    if isinstance(value, str) and _ERROR_CODE_PATTERN.fullmatch(value) and _safe_short_string(value):
        return value
    return None


def _safe_detail_ref(value: Any) -> Optional[str]:
    if isinstance(value, str) and _is_detail_ref(value) and _safe_short_string(value):
        return value
    return None


def _is_detail_ref(value: Any) -> bool:
    return isinstance(value, str) and bool(_DETAIL_REF_PATTERN.fullmatch(value))


def _safe_duration(value: Any) -> Optional[Union[int, float]]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, float) and math.isfinite(value) and value >= 0:
        return value
    return None


def _safe_context(raw_event: Mapping[str, Any]) -> JsonObject:
    context: JsonObject = {}
    raw_context = raw_event.get("context")
    nested_context = raw_context if isinstance(raw_context, Mapping) else {}
    for key in _SAFE_CONTEXT_KEYS:
        value = raw_event.get(key, nested_context.get(key))
        if key == "legacyId" and isinstance(value, str) and _LEGACY_ID_PATTERN.fullmatch(value):
            context[key] = value
    return context


def _safe_short_string(value: str) -> bool:
    if not value or len(value) > 256:
        return False
    lowered = value.casefold()
    if any(marker in lowered for marker in _FORBIDDEN_STRING_MARKERS):
        return False
    return not _looks_path_like(value)


def _looks_path_like(value: str) -> bool:
    if value == DIAGNOSTIC_RELATIVE_LOG_PATH:
        return False
    if "://" in value or value.startswith("~"):
        return True
    if "/" in value or "\\" in value:
        return True
    try:
        if PurePosixPath(value).is_absolute() or PureWindowsPath(value).is_absolute():
            return True
    except TypeError:
        return True
    if re.match(r"^[A-Za-z]:", value):
        return True
    return False


__all__ = [
    "DIAGNOSTIC_RELATIVE_LOG_PATH",
    "DIAGNOSTIC_SCHEMA_VERSION",
    "DIAGNOSTIC_SOURCE",
    "DIAGNOSTIC_STORE_WRITE_FAILED",
    "MAX_LOG_BYTES",
    "MAX_LOG_LINES",
    "MAX_LOOKUP_RESULTS",
    "append_events",
    "diagnostic_log_path",
    "diagnostic_store_write_failed_event",
    "lookup_by_detail_ref",
    "normalize_event",
]
