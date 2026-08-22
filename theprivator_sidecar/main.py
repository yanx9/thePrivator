"""NDJSON command runner for the ThePrivator Python sidecar."""

from __future__ import annotations

import os
import platform
import sys
import time
from typing import Any, Callable, Dict, Optional, Sequence, TextIO, Tuple

from . import chromium, cookies, identity_audit, legacy_import, profile_package, proxy_check
from .diagnostics import append_events
from .identity import IDENTITY_PRESETS, IDENTITY_VERSION, curated_preset, validate_identity, warnings_for_identity
from .profiles import ProfileStore, require_string_param
from .proxy import PROXY_VERSION, public_proxy_summary
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
    legacy_import_outcome_diagnostic,
    parse_request_line,
)

PRODUCT_NAME = "ThePrivator"


def run(stdin: TextIO, stdout: TextIO, stderr: TextIO) -> int:
    """Process NDJSON requests from ``stdin`` until EOF.

    Diagnostics are flushed to stderr *before* the response goes to stdout. The
    two streams are independent, so nothing observable depends on the order --
    except for a caller that keeps this process alive across requests. There, the
    response line is the only marker of where one request ends, so emitting
    diagnostics first is what lets a reader attribute them to the right request
    instead of racing them against the next one.
    """
    for raw_line in stdin:
        response, diagnostics = handle_request_line(raw_line)
        for diagnostic in diagnostics:
            print(encode_ndjson(diagnostic), file=stderr, flush=True)
        print(encode_ndjson(response), file=stdout, flush=True)

    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    """CLI entrypoint used by ``python -m theprivator_sidecar``."""
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] == ["automation-api"]:
        from .automation_api import run_from_env

        return run_from_env(os.environ)

    if args[:1] == ["proxy-bridge"]:
        from .proxy_bridge import run_bridge_from_stdin

        # Config arrives on stdin, never as an argv path: it carries the upstream
        # proxy password, and argv is world-readable through /proc.
        return run_bridge_from_stdin()

    return run(sys.stdin, sys.stdout, sys.stderr)


def handle_request_line(raw_line: str) -> Tuple[JsonObject, list[JsonObject]]:
    """Handle one raw input line and return stdout/stderr envelope objects."""
    started = time.perf_counter()
    request_id = None
    method = None
    request: Optional[SidecarRequest] = None

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
        diagnostics = [diagnostic]
        diagnostics.extend(_legacy_import_outcome_diagnostics(request.method, result, duration_ms))
        return response, _with_store_root_persistence(request, diagnostics)

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
        diagnostics = [diagnostic]
        if request is None:
            return response, diagnostics
        return response, _with_store_root_persistence(request, diagnostics)

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
        diagnostics = [diagnostic]
        if request is None:
            return response, diagnostics
        return response, _with_store_root_persistence(request, diagnostics)


def _with_store_root_persistence(
    request: SidecarRequest,
    diagnostics: list[JsonObject],
) -> list[JsonObject]:
    """Persist store-root diagnostics without changing response authority."""
    if request.method == "proxy.validate":
        return diagnostics

    result = append_events(
        request.params.get("storeRoot"),
        diagnostics,
        request_id=request.id,
        method=request.method,
    )
    if result.get("ok") is False:
        failure = result.get("diagnostic")
        if isinstance(failure, dict):
            return [*diagnostics, failure]
    return diagnostics


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

    if request.method.startswith("identity."):
        return dispatch_identity_request(request)

    if request.method.startswith("proxy."):
        return dispatch_proxy_request(request)

    if request.method.startswith("profiles."):
        return dispatch_profile_request(request)

    if request.method.startswith("legacy."):
        return dispatch_legacy_request(request)

    if request.method.startswith("chromium."):
        return dispatch_chromium_request(request)

    if request.method.startswith("portability."):
        return dispatch_portability_request(request)

    raise SidecarError(
        code=UNKNOWN_COMMAND,
        message="Unknown sidecar command.",
        request_id=request.id,
        method=request.method,
    )


def dispatch_identity_request(request: SidecarRequest) -> JsonObject:
    """Dispatch sidecar-owned identity validation and preset commands."""
    try:
        if request.method == "identity.presets.list":
            presets = [curated_preset(preset_id) for preset_id in sorted(IDENTITY_PRESETS)]
            return {
                "identityVersion": IDENTITY_VERSION,
                "presets": presets,
                "count": len(presets),
            }

        if request.method == "identity.validate":
            normalized = validate_identity(request.params.get("identity"))
            return {
                "identityVersion": IDENTITY_VERSION,
                "identity": normalized,
                "warnings": warnings_for_identity(normalized),
            }

        if request.method == "identity.audit.plan":
            store_root = require_string_param(
                request.params,
                "storeRoot",
                "Audit storeRoot is required.",
            )
            profile_id = require_string_param(
                request.params,
                "profileId",
                "Audit profileId is required.",
            )
            return identity_audit.audit_plan_for_profile(store_root, profile_id)

        if request.method == "identity.audit.open":
            store_root = require_string_param(
                request.params,
                "storeRoot",
                "Audit storeRoot is required.",
            )
            profile_id = require_string_param(
                request.params,
                "profileId",
                "Audit profileId is required.",
            )
            page_id = require_string_param(
                request.params,
                "pageId",
                "Audit pageId is required.",
            )
            return identity_audit.open_audit_page_for_profile(store_root, profile_id, page_id)

        if request.method == "identity.audit.collect":
            store_root = require_string_param(
                request.params,
                "storeRoot",
                "Audit storeRoot is required.",
            )
            profile_id = require_string_param(
                request.params,
                "profileId",
                "Audit profileId is required.",
            )
            return identity_audit.collect_audit_results_for_profile(store_root, profile_id)

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


def dispatch_proxy_request(request: SidecarRequest) -> JsonObject:
    """Dispatch pure proxy validation commands without profile-store persistence."""
    try:
        if request.method == "proxy.validate":
            return {
                "proxyVersion": PROXY_VERSION,
                "proxy": public_proxy_summary(request.params.get("proxy")),
                "warnings": [],
            }

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



def dispatch_profile_request(request: SidecarRequest) -> JsonObject:
    """Dispatch profile CRUD commands through the sidecar-owned store."""
    try:
        store_root = require_string_param(
            request.params,
            "storeRoot",
            "Profile storeRoot is required.",
        )
        store = ProfileStore(store_root)

        if request.method == "profiles.proxy.update":
            profile_id = require_string_param(
                request.params,
                "profileId",
                "Profile id is required.",
            )
            return store.update_proxy(profile_id, request.params.get("proxy"))

        if request.method == "profiles.proxy.check":
            profile_id = require_string_param(
                request.params,
                "profileId",
                "Profile id is required.",
            )
            return proxy_check.check_profile_proxy(store_root, profile_id)

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
        if request.method == "profiles.identity.applyPreset":
            profile_id = require_string_param(
                request.params,
                "profileId",
                "Profile id is required.",
            )
            preset_id = require_string_param(
                request.params,
                "presetId",
                "Identity preset id is required.",
            )
            return store.apply_identity_preset(profile_id, preset_id)
        if request.method == "profiles.identity.update":
            profile_id = require_string_param(
                request.params,
                "profileId",
                "Profile id is required.",
            )
            return store.update_identity(profile_id, request.params.get("identity"))

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


def dispatch_legacy_request(request: SidecarRequest) -> JsonObject:
    """Dispatch legacy scan/import commands through sidecar-owned boundaries."""
    try:
        store_root = require_string_param(
            request.params,
            "storeRoot",
            "Legacy storeRoot is required.",
        )
        legacy_root = require_string_param(
            request.params,
            "legacyRoot",
            "Legacy root is required.",
        )

        if request.method == "legacy.scan":
            return legacy_import.scan_legacy_profiles(legacy_root, store_root)
        if request.method == "legacy.import":
            return legacy_import.import_legacy_profiles(
                legacy_root,
                store_root,
                request.params.get("items"),
            )

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


def _legacy_import_outcome_diagnostics(method: str, result: JsonObject, duration_ms: float) -> list[JsonObject]:
    if method != "legacy.import":
        return []

    outcomes = result.get("outcomes")
    if not isinstance(outcomes, list):
        return []

    diagnostics: list[JsonObject] = []
    for outcome in outcomes:
        if not isinstance(outcome, dict):
            continue
        status = outcome.get("status")
        if status not in {"partial", "failed"}:
            continue
        error = outcome.get("error")
        if not isinstance(error, dict):
            continue
        error_code = error.get("code")
        detail_ref = error.get("detailRef")
        diagnostics.append(
            legacy_import_outcome_diagnostic(
                legacy_id=outcome.get("legacyId") if isinstance(outcome.get("legacyId"), str) else None,
                status=status if isinstance(status, str) else None,
                error_code=error_code if isinstance(error_code, str) else None,
                detail_ref=detail_ref if isinstance(detail_ref, str) else None,
                duration_ms=duration_ms,
            )
        )
    return diagnostics


def dispatch_chromium_request(request: SidecarRequest) -> JsonObject:
    """Dispatch Chromium lifecycle commands through the sidecar-owned registry."""
    try:
        store_root = require_string_param(
            request.params,
            "storeRoot",
            "Chromium storeRoot is required.",
        )

        if request.method == "chromium.status":
            return chromium.status(store_root)
        if request.method == "chromium.launch":
            profile_id = require_string_param(
                request.params,
                "profileId",
                "Chromium profileId is required.",
            )
            return chromium.launch(store_root, profile_id)
        if request.method == "chromium.stop":
            profile_id = require_string_param(
                request.params,
                "profileId",
                "Chromium profileId is required.",
            )
            return chromium.stop(store_root, profile_id)

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


def dispatch_portability_request(request: SidecarRequest) -> JsonObject:
    """Dispatch sidecar-owned cookie and profile-package portability commands."""
    try:
        store_root = require_string_param(
            request.params,
            "storeRoot",
            "Portability storeRoot is required.",
        )

        if request.method == "portability.cookies.export":
            profile_id = require_string_param(
                request.params,
                "profileId",
                "Cookie portability profileId is required.",
            )
            destination_path = require_string_param(
                request.params,
                "destinationPath",
                "Cookie export destinationPath is required.",
            )
            export_format = require_string_param(
                request.params,
                "format",
                "Cookie export format is required.",
            )
            return cookies.export_cookies(store_root, profile_id, destination_path, export_format)

        if request.method == "portability.cookies.replace":
            profile_id = require_string_param(
                request.params,
                "profileId",
                "Cookie portability profileId is required.",
            )
            source_path = require_string_param(
                request.params,
                "sourcePath",
                "Cookie replace sourcePath is required.",
            )
            return cookies.replace_cookies(store_root, profile_id, source_path)

        if request.method == "portability.profile_package.export":
            profile_id = require_string_param(
                request.params,
                "profileId",
                "Profile package export profileId is required.",
            )
            destination_path = require_string_param(
                request.params,
                "destinationPath",
                "Profile package export destinationPath is required.",
            )
            return profile_package.export_profile_package(store_root, profile_id, destination_path)

        if request.method == "portability.profile_package.import":
            source_path = require_string_param(
                request.params,
                "sourcePath",
                "Profile package import sourcePath is required.",
            )
            return profile_package.import_profile_package(store_root, source_path)

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
