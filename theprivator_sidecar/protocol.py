"""Typed NDJSON protocol models for the ThePrivator sidecar."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional, Tuple, Union

PROTOCOL_VERSION = "1.0.0"
SIDECAR_VERSION = "0.1.0"

INVALID_REQUEST = "INVALID_REQUEST"
UNKNOWN_COMMAND = "UNKNOWN_COMMAND"
DIAGNOSTIC_FAILURE = "DIAGNOSTIC_FAILURE"
INTERNAL_ERROR = "INTERNAL_ERROR"

RequestId = Union[str, int, float, bool, None]
JsonObject = Dict[str, Any]


def make_detail_ref() -> str:
    """Create an opaque reference that can connect UI errors to sidecar logs."""
    return f"sidecar-{uuid.uuid4().hex[:12]}"


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
