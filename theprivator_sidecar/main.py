"""NDJSON command runner for the ThePrivator Python sidecar."""

from __future__ import annotations

import platform
import sys
import time
from typing import Any, Callable, Dict, Optional, TextIO, Tuple

from .profiles import ProfileStore, require_string_param
from .protocol import (
    DIAGNOSTIC_FAILURE,
    INTERNAL_ERROR,
    UNKNOWN_COMMAND,
    ErrorResponse,
    JsonObject,
    SIDECAR_VERSION,
    PROTOCOL_VERSION,
    SidecarError,
    SidecarRequest,
    SuccessResponse,
    diagnostic_event,
    encode_ndjson,
    parse_request_line,
)

PRODUCT_NAME = "ThePrivator"


def run(stdin: TextIO, stdout: TextIO, stderr: TextIO) -> int:
    """Process NDJSON requests from ``stdin`` until EOF."""
    for raw_line in stdin:
        response, diagnostic = handle_request_line(raw_line)
        print(encode_ndjson(response), file=stdout, flush=True)
        print(encode_ndjson(diagnostic), file=stderr, flush=True)

    return 0


def main() -> int:
    """CLI entrypoint used by ``python -m theprivator_sidecar``."""
    return run(sys.stdin, sys.stdout, sys.stderr)


def handle_request_line(raw_line: str) -> Tuple[JsonObject, JsonObject]:
    """Handle one raw input line and return stdout/stderr envelope objects."""
    started = time.perf_counter()
    request_id = None
    method = None

    try:
        request = parse_request_line(raw_line)
        request_id = request.id
        method = request.method
        result = dispatch(request)
        duration_ms = _elapsed_ms(started)
        if request.method == "health.status":
            result["request"] = {"durationMs": duration_ms}

        response = SuccessResponse(
            id=request.id,
            result=result,
            duration_ms=duration_ms,
        ).to_dict()
        diagnostic = diagnostic_event(
            request_id=request.id,
            method=request.method,
            status="ok",
            duration_ms=duration_ms,
            error_code=None,
            detail_ref=None,
        )
        return response, diagnostic

    except SidecarError as error:
        duration_ms = _elapsed_ms(started)
        response = ErrorResponse(
            id=error.request_id,
            error=error,
            duration_ms=duration_ms,
        ).to_dict()
        diagnostic = diagnostic_event(
            request_id=error.request_id,
            method=error.method,
            status="error",
            duration_ms=duration_ms,
            error_code=error.code,
            detail_ref=error.detail_ref,
        )
        return response, diagnostic

    except Exception:
        duration_ms = _elapsed_ms(started)
        error = SidecarError(
            code=INTERNAL_ERROR,
            message="Sidecar command failed unexpectedly.",
            request_id=request_id,
            method=method,
        )
        response = ErrorResponse(
            id=error.request_id,
            error=error,
            duration_ms=duration_ms,
        ).to_dict()
        diagnostic = diagnostic_event(
            request_id=error.request_id,
            method=error.method,
            status="error",
            duration_ms=duration_ms,
            error_code=error.code,
            detail_ref=error.detail_ref,
        )
        return response, diagnostic


def dispatch(request: SidecarRequest) -> JsonObject:
    """Dispatch a validated sidecar request to a command handler."""
    if request.method == "health.status":
        return health_status()

    if request.method == "diagnostics.fail":
        raise SidecarError(
            code=DIAGNOSTIC_FAILURE,
            message="Diagnostic failure requested.",
            request_id=request.id,
            method=request.method,
        )

    if request.method.startswith("profiles."):
        return dispatch_profile_request(request)

    raise SidecarError(
        code=UNKNOWN_COMMAND,
        message="Unknown sidecar command.",
        request_id=request.id,
        method=request.method,
    )


def dispatch_profile_request(request: SidecarRequest) -> JsonObject:
    """Dispatch profile CRUD commands through the sidecar-owned store."""
    try:
        store_root = require_string_param(
            request.params,
            "storeRoot",
            "Profile storeRoot is required.",
        )
        store = ProfileStore(store_root)

        if request.method == "profiles.list":
            return store.list()
        if request.method == "profiles.create":
            name = require_string_param(
                request.params,
                "name",
                "Profile name is required.",
            )
            return store.create(name)
        if request.method == "profiles.update":
            profile_id = require_string_param(
                request.params,
                "id",
                "Profile id is required.",
            )
            name = require_string_param(
                request.params,
                "name",
                "Profile name is required.",
            )
            return store.update(profile_id, name)
        if request.method == "profiles.delete":
            profile_id = require_string_param(
                request.params,
                "id",
                "Profile id is required.",
            )
            return store.delete(profile_id)

        raise SidecarError(
            code=UNKNOWN_COMMAND,
            message="Unknown sidecar command.",
        )
    except SidecarError as error:
        raise SidecarError(
            code=error.code,
            message=error.message,
            recoverable=error.recoverable,
            detail_ref=error.detail_ref,
            request_id=request.id,
            method=request.method,
        ) from error


def health_status() -> JsonObject:
    """Return redacted product/protocol/runtime/build metadata."""
    degraded_fields = []

    def safe(label: str, supplier: Callable[[], Any], fallback: Any) -> Any:
        try:
            return supplier()
        except Exception:
            degraded_fields.append(label)
            return fallback

    app_version = safe("product.version", _product_version, "unknown")
    python_version = safe("runtime.pythonVersion", platform.python_version, "unknown")
    implementation = safe("runtime.implementation", lambda: sys.implementation.name, "unknown")
    platform_system = safe("platform.system", platform.system, "unknown")
    platform_release = safe("platform.release", platform.release, "unknown")
    platform_machine = safe("platform.machine", platform.machine, "unknown")
    frozen = bool(getattr(sys, "frozen", False))

    result: JsonObject = {
        "status": "degraded" if degraded_fields else "healthy",
        "product": {
            "name": PRODUCT_NAME,
            "version": app_version,
        },
        "sidecar": {
            "version": SIDECAR_VERSION,
        },
        "protocol": {
            "version": PROTOCOL_VERSION,
        },
        "runtime": {
            "pythonVersion": python_version,
            "implementation": implementation,
        },
        "platform": {
            "system": platform_system,
            "release": platform_release,
            "machine": platform_machine,
        },
        "build": {
            "mode": "pyinstaller" if frozen else "source",
            "frozen": frozen,
        },
    }

    if degraded_fields:
        result["degradedFields"] = degraded_fields

    return result


def _product_version() -> str:
    from theprivator import __version__

    return __version__


def _elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 3)
