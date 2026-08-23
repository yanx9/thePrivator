"""Typed NDJSON protocol models for the ThePrivator sidecar."""

from __future__ import annotations

import dataclasses
import json
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional, Tuple, Union

PROTOCOL_VERSION = "1.0.0"
SIDECAR_VERSION = "0.1.0"
_DETAIL_REF_FORBIDDEN_FRAGMENTS = ("9222",)

INVALID_REQUEST = "INVALID_REQUEST"
UNKNOWN_COMMAND = "UNKNOWN_COMMAND"
DIAGNOSTIC_FAILURE = "DIAGNOSTIC_FAILURE"
INTERNAL_ERROR = "INTERNAL_ERROR"
PROFILE_INVALID_NAME = "PROFILE_INVALID_NAME"
PROFILE_DUPLICATE_NAME = "PROFILE_DUPLICATE_NAME"
PROFILE_NOT_FOUND = "PROFILE_NOT_FOUND"
PROFILE_STORE_UNAVAILABLE = "PROFILE_STORE_UNAVAILABLE"
PROFILE_STORE_CORRUPT = "PROFILE_STORE_CORRUPT"
PROFILE_STORE_WRITE_FAILED = "PROFILE_STORE_WRITE_FAILED"
# A store written by a newer build. Distinct from CORRUPT on purpose: reporting
# "your entire profile library is damaged" when the only problem is an out-of-date
# app reads as total data loss, and once profiles sync between machines a single
# early upgrade would show that on every other machine at once.
PROFILE_STORE_VERSION_TOO_NEW = "PROFILE_STORE_VERSION_TOO_NEW"
PROFILE_START_URL_INVALID = "PROFILE_START_URL_INVALID"
PROFILE_ORGANIZATION_INVALID = "PROFILE_ORGANIZATION_INVALID"
# A user-supplied Chromium switch outside the curated allow-list. Named
# separately from PROXY_LAUNCH_ARG_UNSAFE so the UI can tell "this flag is not on
# the list" from "this flag would break the proxy layer".
LAUNCH_ARG_UNSUPPORTED = "LAUNCH_ARG_UNSUPPORTED"
PROFILE_DELETE_FAILED = "PROFILE_DELETE_FAILED"
LEGACY_ROOT_INVALID = "LEGACY_ROOT_INVALID"
LEGACY_CONFIG_MISSING = "LEGACY_CONFIG_MISSING"
LEGACY_CONFIG_MALFORMED = "LEGACY_CONFIG_MALFORMED"
LEGACY_SELECTION_INVALID = "LEGACY_SELECTION_INVALID"
LEGACY_USER_DATA_COPY_FAILED = "LEGACY_USER_DATA_COPY_FAILED"
CHROMIUM_EXECUTABLE_NOT_FOUND = "CHROMIUM_EXECUTABLE_NOT_FOUND"
CHROMIUM_ALREADY_RUNNING = "CHROMIUM_ALREADY_RUNNING"
CHROMIUM_LAUNCH_FAILED = "CHROMIUM_LAUNCH_FAILED"
CHROMIUM_STOP_FAILED = "CHROMIUM_STOP_FAILED"
PROXY_INVALID = "PROXY_INVALID"
PROXY_UNSUPPORTED_MODE = "PROXY_UNSUPPORTED_MODE"
PROXY_PAC_UNSUPPORTED = "PROXY_PAC_UNSUPPORTED"
PROXY_RUNTIME_UNSUPPORTED = "PROXY_RUNTIME_UNSUPPORTED"
PROXY_LAUNCH_UNSUPPORTED = "PROXY_LAUNCH_UNSUPPORTED"
PROXY_SOCKS_AUTH_UNSUPPORTED = "PROXY_SOCKS_AUTH_UNSUPPORTED"
PROXY_LAUNCH_ARG_UNSAFE = "PROXY_LAUNCH_ARG_UNSAFE"
PROXY_AUTH_HELPER_FAILED = "PROXY_AUTH_HELPER_FAILED"
PROXY_CONNECTIVITY_FAILED = "PROXY_CONNECTIVITY_FAILED"
PROXY_PROOF_FAILED = "PROXY_PROOF_FAILED"
IDENTITY_INVALID = "IDENTITY_INVALID"
IDENTITY_EXTENSION_FAILED = "IDENTITY_EXTENSION_FAILED"
IDENTITY_CDP_FAILED = "IDENTITY_CDP_FAILED"
IDENTITY_PROOF_FAILED = "IDENTITY_PROOF_FAILED"
IDENTITY_AUDIT_FAILED = "IDENTITY_AUDIT_FAILED"
IDENTITY_AUDIT_PAGE_NOT_FOUND = "IDENTITY_AUDIT_PAGE_NOT_FOUND"
IDENTITY_PRESET_NOT_FOUND = "IDENTITY_PRESET_NOT_FOUND"
IDENTITY_UNSUPPORTED_MODE = "IDENTITY_UNSUPPORTED_MODE"
AUTOMATION_API_CONFIGURATION_ERROR = "AUTOMATION_API_CONFIGURATION_ERROR"
AUTOMATION_API_BIND_FAILED = "AUTOMATION_API_BIND_FAILED"
AUTOMATION_API_STARTUP_FAILED = "AUTOMATION_API_STARTUP_FAILED"
AUTOMATION_API_ROUTE_NOT_FOUND = "AUTOMATION_API_ROUTE_NOT_FOUND"
AUTOMATION_API_HTTP_ERROR = "AUTOMATION_API_HTTP_ERROR"
AUTOMATION_AUTH_REQUIRED = "AUTOMATION_AUTH_REQUIRED"
AUTOMATION_AUTH_INVALID = "AUTOMATION_AUTH_INVALID"
AUTOMATION_LEASE_NOT_FOUND = "AUTOMATION_LEASE_NOT_FOUND"
AUTOMATION_LEASE_PROFILE_BUSY = "AUTOMATION_LEASE_PROFILE_BUSY"
AUTOMATION_LEASE_EXPIRED = "AUTOMATION_LEASE_EXPIRED"
AUTOMATION_LEASE_RELEASED = "AUTOMATION_LEASE_RELEASED"
AUTOMATION_LEASE_HANDOFF_FAILED = "AUTOMATION_LEASE_HANDOFF_FAILED"
PORTABILITY_PROFILE_BUSY = "PORTABILITY_PROFILE_BUSY"
PORTABILITY_PACKAGE_INVALID = "PORTABILITY_PACKAGE_INVALID"
PORTABILITY_PACKAGE_TOO_LARGE = "PORTABILITY_PACKAGE_TOO_LARGE"
PORTABILITY_PACKAGE_READ_FAILED = "PORTABILITY_PACKAGE_READ_FAILED"
PORTABILITY_PACKAGE_WRITE_FAILED = "PORTABILITY_PACKAGE_WRITE_FAILED"
PORTABILITY_PACKAGE_UNSUPPORTED_VERSION = "PORTABILITY_PACKAGE_UNSUPPORTED_VERSION"
PORTABILITY_PACKAGE_CHECKSUM_MISMATCH = "PORTABILITY_PACKAGE_CHECKSUM_MISMATCH"
PORTABILITY_PACKAGE_PAYLOAD_FAILED = "PORTABILITY_PACKAGE_PAYLOAD_FAILED"
PORTABILITY_PACKAGE_IMPORT_FAILED = "PORTABILITY_PACKAGE_IMPORT_FAILED"
PORTABILITY_COOKIE_FILE_INVALID = "PORTABILITY_COOKIE_FILE_INVALID"
PORTABILITY_COOKIE_FILE_TOO_LARGE = "PORTABILITY_COOKIE_FILE_TOO_LARGE"
PORTABILITY_COOKIE_READ_FAILED = "PORTABILITY_COOKIE_READ_FAILED"
PORTABILITY_COOKIE_WRITE_FAILED = "PORTABILITY_COOKIE_WRITE_FAILED"
PORTABILITY_COOKIE_DB_UNAVAILABLE = "PORTABILITY_COOKIE_DB_UNAVAILABLE"
PORTABILITY_COOKIE_DB_WRITE_FAILED = "PORTABILITY_COOKIE_DB_WRITE_FAILED"
PORTABILITY_UNSUPPORTED_FORMAT = "PORTABILITY_UNSUPPORTED_FORMAT"
SYNC_NOT_CONFIGURED = "SYNC_NOT_CONFIGURED"
SYNC_ROOT_INVALID = "SYNC_ROOT_INVALID"
SYNC_ROOT_REFUSED = "SYNC_ROOT_REFUSED"
SYNC_REMOTE_UNAVAILABLE = "SYNC_REMOTE_UNAVAILABLE"
SYNC_STATE_INVALID = "SYNC_STATE_INVALID"
SYNC_LOCK_HELD = "SYNC_LOCK_HELD"
SYNC_LOCK_STALE = "SYNC_LOCK_STALE"
SYNC_METADATA_INVALID = "SYNC_METADATA_INVALID"
SYNC_PAYLOAD_INVALID = "SYNC_PAYLOAD_INVALID"
SYNC_PROFILE_BUSY = "SYNC_PROFILE_BUSY"
SYNC_CONFLICT_UNRESOLVED = "SYNC_CONFLICT_UNRESOLVED"

RequestId = Union[str, int, float, bool, None]
JsonObject = Dict[str, Any]


def make_detail_ref() -> str:
    """Create an opaque reference that can connect UI errors to sidecar logs."""
    while True:
        suffix = uuid.uuid4().hex[:12]
        lowered = suffix.casefold()
        if not any(fragment in lowered for fragment in _DETAIL_REF_FORBIDDEN_FRAGMENTS):
            return f"sidecar-{suffix}"


def encode_ndjson(value: Mapping[str, Any]) -> str:
    """Serialize one response or diagnostic object as a compact NDJSON line."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


@dataclass(frozen=True)
class SidecarRequest:
    """Validated sidecar command request."""

    id: RequestId
    method: str
    params: JsonObject = field(default_factory=dict)


@dataclass(frozen=True)
class SuccessResponse:
    """Successful sidecar response envelope."""

    id: RequestId
    result: JsonObject
    duration_ms: float

    def to_dict(self) -> JsonObject:
        return {
            "id": self.id,
            "ok": True,
            "protocolVersion": PROTOCOL_VERSION,
            "durationMs": self.duration_ms,
            "result": self.result,
        }


@dataclass(frozen=True)
class SidecarError(Exception):
    """Recoverable sidecar protocol error suitable for UI display."""

    code: str
    message: str
    recoverable: bool = True
    detail_ref: str = field(default_factory=make_detail_ref)
    request_id: Optional[RequestId] = None
    method: Optional[str] = None

    def __post_init__(self) -> None:
        Exception.__init__(self, self.message)

    def to_dict(self) -> JsonObject:
        return {
            "code": self.code,
            "message": self.message,
            "recoverable": self.recoverable,
            "detailRef": self.detail_ref,
        }


def _sidecar_error_setattr(self: "SidecarError", name: str, value: Any) -> None:
    """Keep the declared fields frozen, but let exception machinery write.

    contextlib assigns ``exc.__traceback__`` from Python when re-raising through
    a generator context manager, and a frozen dataclass rejects that with
    FrozenInstanceError -- which then *replaces* the real error, so a genuine
    failure surfaces as a confusing complaint about traceback assignment and the
    original cause is lost. Installed after the class because the dataclass
    decorator refuses to let a frozen class define __setattr__ itself.
    """
    if name.startswith("__") and name.endswith("__"):
        object.__setattr__(self, name, value)
        return
    raise dataclasses.FrozenInstanceError(f"cannot assign to field {name!r}")


SidecarError.__setattr__ = _sidecar_error_setattr  # type: ignore[method-assign]


@dataclass(frozen=True)
class ErrorResponse:
    """Failed sidecar response envelope."""

    id: Optional[RequestId]
    error: SidecarError
    duration_ms: float

    def to_dict(self) -> JsonObject:
        return {
            "id": self.id,
            "ok": False,
            "protocolVersion": PROTOCOL_VERSION,
            "durationMs": self.duration_ms,
            "error": self.error.to_dict(),
        }


def parse_request_line(raw_line: str) -> SidecarRequest:
    """Parse and validate one NDJSON request line.

    Invalid input is always represented as ``SidecarError`` instead of allowing
    JSON parser exceptions or tracebacks to leak into stdout.
    """
    if not raw_line.strip():
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Request line is empty.",
        )

    try:
        parsed = json.loads(raw_line)
    except json.JSONDecodeError as exc:
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Request line must contain valid JSON.",
        ) from exc

    if not isinstance(parsed, dict):
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Request line must be a JSON object.",
        )

    request_id, method = _extract_partial_context(parsed)

    if "id" not in parsed:
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Request id is required.",
            method=method,
        )

    if not _is_valid_request_id(request_id):
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Request id must be a JSON scalar.",
            method=method,
        )

    if not isinstance(method, str) or not method.strip():
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Request method is required.",
            request_id=request_id,
        )

    params = parsed.get("params", {})
    if not isinstance(params, dict):
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Request params must be a JSON object.",
            request_id=request_id,
            method=method,
        )

    return SidecarRequest(id=request_id, method=method, params=params)


def diagnostic_event(
    *,
    request_id: Optional[RequestId],
    method: Optional[str],
    status: str,
    duration_ms: float,
    error_code: Optional[str],
    detail_ref: Optional[str],
) -> JsonObject:
    """Build the single redacted structured stderr event for a request."""
    return {
        "event": "sidecar.request",
        "requestId": _redact_log_value(request_id),
        "method": _redact_log_value(method),
        "status": status,
        "durationMs": duration_ms,
        "errorCode": error_code,
        "detailRef": detail_ref,
    }


def legacy_import_outcome_diagnostic(
    *,
    legacy_id: Optional[str],
    status: Optional[str],
    error_code: Optional[str],
    detail_ref: Optional[str],
    duration_ms: Optional[float] = None,
) -> JsonObject:
    """Build a redacted diagnostic for one failed legacy import outcome."""
    diagnostic = {
        "event": "legacy.import.outcome",
        "legacyId": _redact_log_value(legacy_id),
        "status": _redact_log_value(status),
        "errorCode": error_code,
        "detailRef": detail_ref,
    }
    if duration_ms is not None:
        diagnostic["durationMs"] = duration_ms
    return diagnostic


def _extract_partial_context(parsed: Mapping[str, Any]) -> Tuple[Optional[RequestId], Optional[str]]:
    request_id = parsed.get("id")
    method = parsed.get("method")
    return (
        request_id if _is_valid_request_id(request_id) else None,
        method if isinstance(method, str) else None,
    )


def _is_valid_request_id(value: Any) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def _redact_log_value(value: Any) -> Any:
    if value is None or isinstance(value, (int, float, bool)):
        return value

    if isinstance(value, str):
        if len(value) <= 128:
            return value
        return f"{value[:125]}..."

    return "<invalid>"
