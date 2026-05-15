"""Loopback-only, token-guarded automation API for the app-managed sidecar."""

from __future__ import annotations

import asyncio
import base64
import ipaddress
import json
import os
import secrets
import socket
import sys
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional, TextIO

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import chromium
from .diagnostics import append_events
from .profiles import ProfileRecord, ProfileStore, defaults_for_proxy, normalize_profile_identity
from .protocol import (
    AUTOMATION_API_BIND_FAILED,
    AUTOMATION_API_CONFIGURATION_ERROR,
    AUTOMATION_API_HTTP_ERROR,
    AUTOMATION_API_ROUTE_NOT_FOUND,
    AUTOMATION_API_STARTUP_FAILED,
    AUTOMATION_AUTH_INVALID,
    AUTOMATION_AUTH_REQUIRED,
    AUTOMATION_LEASE_EXPIRED,
    AUTOMATION_LEASE_HANDOFF_FAILED,
    AUTOMATION_LEASE_NOT_FOUND,
    AUTOMATION_LEASE_PROFILE_BUSY,
    AUTOMATION_LEASE_RELEASED,
    CHROMIUM_ALREADY_RUNNING,
    CHROMIUM_EXECUTABLE_NOT_FOUND,
    CHROMIUM_LAUNCH_FAILED,
    CHROMIUM_STOP_FAILED,
    IDENTITY_CDP_FAILED,
    INTERNAL_ERROR,
    INVALID_REQUEST,
    PROFILE_NOT_FOUND,
    PROFILE_STORE_CORRUPT,
    PROFILE_STORE_UNAVAILABLE,
    PROFILE_STORE_WRITE_FAILED,
    JsonObject,
    SIDECAR_VERSION,
    SidecarError,
    diagnostic_event,
    make_detail_ref,
)
from .proxy import DIRECT_PROXY_MODE, FIXED_SERVER_PROXY_MODE, PROXY_VERSION, normalize_proxy_config

AUTOMATION_API_VERSION = "1.0.0"
PRODUCT_NAME = "ThePrivator"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 0
MAX_AUTHORIZATION_HEADER_LENGTH = 8192
PROFILE_API_VERSION = 1
RUNTIME_API_VERSION = 1
LEASE_API_VERSION = 1
DEFAULT_PROFILE_LIST_LIMIT = 50
MAX_PROFILE_LIST_LIMIT = 100
DEFAULT_LEASE_TTL_SECONDS = 30
MIN_LEASE_TTL_SECONDS = 1
MAX_LEASE_TTL_SECONDS = 120
_PROFILE_CURSOR_PREFIX = "p_"
_PROFILE_CURSOR_MARKER = "profiles:"
_MAX_PROFILE_CURSOR_LENGTH = 96
_URLSAFE_BASE64_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
_AUTOMATION_PROFILES_LIST_METHOD = "automation.profiles.list"
_AUTOMATION_PROFILES_STATUS_METHOD = "automation.profiles.status"
_AUTOMATION_RUNTIME_STATUS_METHOD = "automation.runtime.status"
_AUTOMATION_LEASES_CREATE_METHOD = "automation.leases.create"
_AUTOMATION_LEASES_STATUS_METHOD = "automation.leases.status"
_AUTOMATION_LEASES_RELEASE_METHOD = "automation.leases.release"

ENV_HOST = "THEPRIVATOR_AUTOMATION_API_HOST"
ENV_PORT = "THEPRIVATOR_AUTOMATION_API_PORT"
ENV_STORE_ROOT = "THEPRIVATOR_AUTOMATION_API_STORE_ROOT"
ENV_TOKEN = "THEPRIVATOR_AUTOMATION_API_TOKEN"

_SAFE_STARTUP_PHASES = {"configuration", "bind", "serve"}
_SAFE_ERROR_DETAILS = {
    "configuration": {"phase": "configuration"},
    "bind": {"phase": "bind"},
    "serve": {"phase": "serve"},
    "auth": {"phase": "auth"},
    "routing": {"phase": "routing"},
    "http": {"phase": "http"},
    "profile": {"phase": "profile"},
    "runtime": {"phase": "runtime"},
    "lease": {"phase": "lease"},
}


@dataclass(frozen=True)
class AutomationApiConfig:
    """Trusted runtime configuration for the local automation API."""

    host: str
    port: int
    store_root: Path = field(repr=False)
    token: str = field(repr=False)
    started_at: str = field(default_factory=lambda: _utc_now_iso())

    def with_port(self, port: int) -> "AutomationApiConfig":
        """Return a copy with the bound port recorded for public status payloads."""
        return replace(self, port=port)


@dataclass(frozen=True)
class AutomationStartupError(Exception):
    """Safe startup/configuration failure that never stores sensitive values."""

    code: str
    message: str
    phase: str
    detail_ref: str = field(default_factory=make_detail_ref)

    def __post_init__(self) -> None:
        Exception.__init__(self, self.message)


@dataclass(frozen=True)
class AutomationHttpError(Exception):
    """Safe HTTP failure rendered through the automation API error envelope."""

    status_code: int
    code: str
    message: str
    phase: str
    detail_ref: str = field(default_factory=make_detail_ref)
    headers: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        Exception.__init__(self, self.message)


@dataclass(frozen=True)
class AutomationLeaseRecord:
    """In-memory automation lease state without attach endpoint material."""

    lease_id: str
    profile_id: str
    framework: str
    status: str
    created_at: str
    expires_at: str
    expires_at_epoch: float
    ttl_seconds: int
    released_at: Optional[str] = None
    expired_at: Optional[str] = None

    def as_safe_dict(self) -> JsonObject:
        payload: JsonObject = {
            "id": self.lease_id,
            "profileId": self.profile_id,
            "framework": self.framework,
            "status": self.status,
            "createdAt": self.created_at,
            "expiresAt": self.expires_at,
            "ttlSeconds": self.ttl_seconds,
        }
        if self.released_at is not None:
            payload["releasedAt"] = self.released_at
        if self.expired_at is not None:
            payload["expiredAt"] = self.expired_at
        return payload


class AutomationLeaseManager:
    """Process-local lease registry with per-profile active lease serialization."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._leases: dict[str, AutomationLeaseRecord] = {}
        self._active_by_profile: dict[str, str] = {}

    def create(self, store_root: Path, profile_id: str, *, framework: str, ttl_seconds: int) -> tuple[AutomationLeaseRecord, JsonObject, str]:
        with self._lock:
            self._cleanup_expired_locked(store_root)
            active_lease_id = self._active_by_profile.get(profile_id)
            if active_lease_id is not None:
                active_lease = self._leases.get(active_lease_id)
                if active_lease is not None and active_lease.status == "active":
                    raise SidecarError(
                        code=AUTOMATION_LEASE_PROFILE_BUSY,
                        message="An automation lease is already active for this profile.",
                    )
                self._active_by_profile.pop(profile_id, None)

            try:
                launch_payload = chromium.launch_for_automation(store_root, profile_id)
            except SidecarError as error:
                raise _normalize_lease_launch_error(error) from error

            try:
                handoff_endpoint = _extract_lease_handoff_endpoint(launch_payload, profile_id)
                runtime_payload = _lease_create_runtime_payload(profile_id, launch_payload)
            except ValueError as exc:
                _best_effort_stop_after_failed_handoff(store_root, profile_id)
                raise SidecarError(
                    code=AUTOMATION_LEASE_HANDOFF_FAILED,
                    message="Automation lease handoff could not be prepared.",
                ) from exc

            lease_id = _make_lease_id()
            now_epoch = time.time()
            created_at = _iso_from_epoch(now_epoch)
            expires_at_epoch = now_epoch + ttl_seconds
            lease = AutomationLeaseRecord(
                lease_id=lease_id,
                profile_id=profile_id,
                framework=framework,
                status="active",
                created_at=created_at,
                expires_at=_iso_from_epoch(expires_at_epoch),
                expires_at_epoch=expires_at_epoch,
                ttl_seconds=ttl_seconds,
            )
            self._leases[lease_id] = lease
            self._active_by_profile[profile_id] = lease_id
            return lease, runtime_payload, handoff_endpoint

    def get(self, store_root: Path, lease_id: str) -> AutomationLeaseRecord:
        with self._lock:
            lease = self._leases.get(lease_id)
            if lease is None:
                raise SidecarError(
                    code=AUTOMATION_LEASE_NOT_FOUND,
                    message="Automation lease was not found.",
                )
            return self._expire_if_due_locked(store_root, lease)

    def release(self, store_root: Path, lease_id: str) -> tuple[AutomationLeaseRecord, JsonObject]:
        with self._lock:
            lease = self._leases.get(lease_id)
            if lease is None:
                raise SidecarError(
                    code=AUTOMATION_LEASE_NOT_FOUND,
                    message="Automation lease was not found.",
                )
            lease = self._expire_if_due_locked(store_root, lease)
            if lease.status == "released":
                raise SidecarError(
                    code=AUTOMATION_LEASE_RELEASED,
                    message="Automation lease was already released.",
                )
            if lease.status == "expired":
                raise SidecarError(
                    code=AUTOMATION_LEASE_EXPIRED,
                    message="Automation lease has expired.",
                )

            try:
                stop_payload = chromium.stop(store_root, lease.profile_id)
                runtime_payload = _lease_release_runtime_payload(lease.profile_id, stop_payload)
            except SidecarError:
                raise
            except ValueError as exc:
                raise SidecarError(
                    code=CHROMIUM_STOP_FAILED,
                    message="Automation lease release cleanup failed.",
                ) from exc

            released = replace(lease, status="released", released_at=_utc_now_iso())
            self._leases[lease.lease_id] = released
            self._active_by_profile.pop(lease.profile_id, None)
            return released, runtime_payload

    def _cleanup_expired_locked(self, store_root: Path) -> None:
        for lease in list(self._leases.values()):
            if lease.status == "active" and time.time() >= lease.expires_at_epoch:
                self._expire_if_due_locked(store_root, lease)

    def _expire_if_due_locked(self, store_root: Path, lease: AutomationLeaseRecord) -> AutomationLeaseRecord:
        if lease.status != "active" or time.time() < lease.expires_at_epoch:
            return lease
        try:
            chromium.stop(store_root, lease.profile_id)
        except SidecarError:
            raise
        expired = replace(lease, status="expired", expired_at=_utc_now_iso())
        self._leases[lease.lease_id] = expired
        self._active_by_profile.pop(lease.profile_id, None)
        return expired


def create_app(config: AutomationApiConfig) -> FastAPI:
    """Create the versioned local automation API app."""
    app = FastAPI(
        title="ThePrivator Automation API",
        version=AUTOMATION_API_VERSION,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.automation_config = config
    app.state.automation_lease_manager = AutomationLeaseManager()

    @app.middleware("http")
    async def add_request_context(request: Request, call_next):  # type: ignore[no-untyped-def]
        request.state.request_id = _make_request_id()
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["X-Automation-API-Version"] = AUTOMATION_API_VERSION
        response.headers["X-Response-Duration-Ms"] = str(_elapsed_ms(started))
        return response

    @app.exception_handler(AutomationHttpError)
    async def automation_http_error_handler(request: Request, error: AutomationHttpError):  # type: ignore[no-untyped-def]
        return _error_response(request, error.status_code, error.code, error.message, error.phase, error.detail_ref, error.headers)

    @app.exception_handler(StarletteHTTPException)
    async def starlette_http_error_handler(request: Request, error: StarletteHTTPException):  # type: ignore[no-untyped-def]
        if error.status_code == 404:
            return _error_response(
                request,
                404,
                AUTOMATION_API_ROUTE_NOT_FOUND,
                "Automation API route was not found.",
                "routing",
                make_detail_ref(),
            )
        return _error_response(
            request,
            error.status_code,
            AUTOMATION_API_HTTP_ERROR,
            "Automation API request failed.",
            "http",
            make_detail_ref(),
        )

    @app.exception_handler(Exception)
    async def unhandled_error_handler(request: Request, error: Exception):  # type: ignore[no-untyped-def]
        return _error_response(
            request,
            500,
            AUTOMATION_API_STARTUP_FAILED,
            "Automation API request failed unexpectedly.",
            "http",
            make_detail_ref(),
        )

    @app.get("/health")
    async def health(request: Request) -> JsonObject:
        cfg = _request_config(request)
        return {
            "status": "healthy",
            "product": {
                "name": PRODUCT_NAME,
                "version": _product_version(),
            },
            "sidecar": {
                "version": SIDECAR_VERSION,
            },
            "automationApi": {
                "version": AUTOMATION_API_VERSION,
            },
            "api": {
                "host": cfg.host,
                "port": cfg.port,
                "scope": "loopback",
            },
            "request": {
                "requestId": request.state.request_id,
            },
        }

    @app.get("/v1/status")
    async def status(request: Request, _authorized: None = Depends(require_token)) -> JsonObject:
        cfg = _request_config(request)
        return {
            "status": "running",
            "automationApi": {
                "version": AUTOMATION_API_VERSION,
            },
            "api": {
                "host": cfg.host,
                "port": cfg.port,
                "scope": "loopback",
            },
            "store": {
                "configured": True,
            },
            "startedAt": cfg.started_at,
            "request": {
                "requestId": request.state.request_id,
            },
        }

    @app.get("/v1/profiles")
    async def profiles(request: Request, _authorized: None = Depends(require_token)) -> JsonObject:
        started = time.perf_counter()
        try:
            limit, cursor_offset = _parse_profile_list_query(request)
            records = ProfileStore(_request_config(request).store_root)._read_profiles()
            offset = _validate_profile_cursor_offset(cursor_offset, len(records))
            page = records[offset : offset + limit]
            next_offset = offset + len(page)
            next_cursor = _encode_profile_cursor(next_offset) if next_offset < len(records) else None
            return {
                "profileApiVersion": PROFILE_API_VERSION,
                "profiles": [_automation_profile_summary(profile) for profile in page],
                "count": len(page),
                "limit": limit,
                "nextCursor": next_cursor,
                "request": {
                    "requestId": request.state.request_id,
                },
            }
        except ValueError as exc:
            _raise_profile_http_error(
                request,
                400,
                INVALID_REQUEST,
                "Profile list pagination is invalid.",
                make_detail_ref(),
                started,
                method=_AUTOMATION_PROFILES_LIST_METHOD,
            )
            raise AssertionError("unreachable") from exc
        except AutomationHttpError:
            raise
        except SidecarError as error:
            _raise_profile_sidecar_http_error(
                request,
                error,
                started,
                method=_AUTOMATION_PROFILES_LIST_METHOD,
                invalid_message="Profile list request is invalid.",
            )
            raise AssertionError("unreachable") from error
        except Exception as exc:
            detail_ref = make_detail_ref()
            _raise_profile_http_error(
                request,
                500,
                INTERNAL_ERROR,
                "Profile list request failed unexpectedly.",
                detail_ref,
                started,
                method=_AUTOMATION_PROFILES_LIST_METHOD,
            )
            raise AssertionError("unreachable") from exc

    @app.get("/v1/runtime/status")
    async def runtime_status(request: Request, _authorized: None = Depends(require_token)) -> JsonObject:
        started = time.perf_counter()
        return _load_automation_runtime_status(
            request,
            method=_AUTOMATION_RUNTIME_STATUS_METHOD,
            started=started,
        )

    @app.get("/v1/profiles/{profile_id}/status")
    async def profile_status(
        profile_id: str,
        request: Request,
        _authorized: None = Depends(require_token),
    ) -> JsonObject:
        started = time.perf_counter()
        try:
            profile = ProfileStore(_request_config(request).store_root).get(profile_id)
        except AutomationHttpError:
            raise
        except SidecarError as error:
            _raise_profile_sidecar_http_error(
                request,
                error,
                started,
                method=_AUTOMATION_PROFILES_STATUS_METHOD,
                invalid_message="Profile status request is invalid.",
            )
            raise AssertionError("unreachable") from error
        except Exception as exc:
            detail_ref = make_detail_ref()
            _raise_profile_http_error(
                request,
                500,
                INTERNAL_ERROR,
                "Profile status request failed unexpectedly.",
                detail_ref,
                started,
                method=_AUTOMATION_PROFILES_STATUS_METHOD,
            )
            raise AssertionError("unreachable") from exc

        runtime = _load_automation_runtime_status(
            request,
            method=_AUTOMATION_PROFILES_STATUS_METHOD,
            started=started,
        )
        return {
            "profileApiVersion": PROFILE_API_VERSION,
            "runtimeApiVersion": RUNTIME_API_VERSION,
            "profile": _automation_profile_summary(profile),
            "runtime": _runtime_state_for_profile(profile.id, runtime),
            "request": {
                "requestId": request.state.request_id,
            },
        }

    @app.post("/v1/profiles/{profile_id}/leases")
    async def create_profile_lease(
        profile_id: str,
        request: Request,
        _authorized: None = Depends(require_token),
    ) -> JSONResponse:
        started = time.perf_counter()
        try:
            lease_request = await _parse_lease_create_request(request, started)
            ProfileStore(_request_config(request).store_root).get(profile_id)
            lease, runtime, handoff_endpoint = _request_lease_manager(request).create(
                _request_config(request).store_root,
                profile_id,
                framework=lease_request["framework"],
                ttl_seconds=lease_request["ttlSeconds"],
            )
            content: JsonObject = {
                "leaseApiVersion": LEASE_API_VERSION,
                "lease": lease.as_safe_dict(),
                "handoff": {
                    "browser": "chromium",
                    "method": "connect-over-cdp",
                    "endpoint": handoff_endpoint,
                },
                "runtime": runtime,
                "request": {
                    "requestId": request.state.request_id,
                },
            }
            return JSONResponse(
                status_code=201,
                content=content,
                headers={"Location": f"/v1/leases/{lease.lease_id}"},
            )
        except AutomationHttpError:
            raise
        except SidecarError as error:
            _raise_lease_sidecar_http_error(request, error, started, method=_AUTOMATION_LEASES_CREATE_METHOD)
            raise AssertionError("unreachable") from error
        except Exception as exc:
            detail_ref = make_detail_ref()
            _raise_lease_http_error(
                request,
                503,
                AUTOMATION_LEASE_HANDOFF_FAILED,
                "Automation lease could not be created.",
                detail_ref,
                started,
                method=_AUTOMATION_LEASES_CREATE_METHOD,
            )
            raise AssertionError("unreachable") from exc

    @app.get("/v1/leases/{lease_id}")
    async def lease_status(
        lease_id: str,
        request: Request,
        _authorized: None = Depends(require_token),
    ) -> JsonObject:
        started = time.perf_counter()
        try:
            _validate_lease_id_or_raise(lease_id)
            lease = _request_lease_manager(request).get(_request_config(request).store_root, lease_id)
            return {
                "leaseApiVersion": LEASE_API_VERSION,
                "lease": lease.as_safe_dict(),
                "request": {
                    "requestId": request.state.request_id,
                },
            }
        except AutomationHttpError:
            raise
        except SidecarError as error:
            _raise_lease_sidecar_http_error(request, error, started, method=_AUTOMATION_LEASES_STATUS_METHOD)
            raise AssertionError("unreachable") from error
        except Exception as exc:
            detail_ref = make_detail_ref()
            _raise_lease_http_error(
                request,
                503,
                INTERNAL_ERROR,
                "Automation lease status is unavailable.",
                detail_ref,
                started,
                method=_AUTOMATION_LEASES_STATUS_METHOD,
            )
            raise AssertionError("unreachable") from exc

    @app.delete("/v1/leases/{lease_id}")
    async def release_lease(
        lease_id: str,
        request: Request,
        _authorized: None = Depends(require_token),
    ) -> JsonObject:
        started = time.perf_counter()
        try:
            _validate_lease_id_or_raise(lease_id)
            lease, runtime = _request_lease_manager(request).release(_request_config(request).store_root, lease_id)
            return {
                "leaseApiVersion": LEASE_API_VERSION,
                "lease": lease.as_safe_dict(),
                "runtime": runtime,
                "request": {
                    "requestId": request.state.request_id,
                },
            }
        except AutomationHttpError:
            raise
        except SidecarError as error:
            _raise_lease_sidecar_http_error(request, error, started, method=_AUTOMATION_LEASES_RELEASE_METHOD)
            raise AssertionError("unreachable") from error
        except Exception as exc:
            detail_ref = make_detail_ref()
            _raise_lease_http_error(
                request,
                503,
                INTERNAL_ERROR,
                "Automation lease release failed.",
                detail_ref,
                started,
                method=_AUTOMATION_LEASES_RELEASE_METHOD,
            )
            raise AssertionError("unreachable") from exc

    return app


def require_token(request: Request) -> None:
    """FastAPI dependency requiring an exact local API token."""
    raw_header = request.headers.get("authorization")
    if raw_header is None:
        raise AutomationHttpError(
            status_code=401,
            code=AUTOMATION_AUTH_REQUIRED,
            message="Local automation API token is required.",
            phase="auth",
            headers={"WWW-Authenticate": "Bearer"},
        )

    candidate = _parse_authorization_header(raw_header)
    if candidate is None:
        raise AutomationHttpError(
            status_code=401,
            code=AUTOMATION_AUTH_INVALID,
            message="Local automation API token is invalid.",
            phase="auth",
            headers={"WWW-Authenticate": "Bearer"},
        )

    expected = _request_config(request).token
    if not secrets.compare_digest(candidate.encode("utf-8"), expected.encode("utf-8")):
        raise AutomationHttpError(
            status_code=401,
            code=AUTOMATION_AUTH_INVALID,
            message="Local automation API token is invalid.",
            phase="auth",
            headers={"WWW-Authenticate": "Bearer"},
        )


def load_config_from_env(environ: Optional[Mapping[str, str]] = None) -> AutomationApiConfig:
    """Read and validate trusted automation API process environment."""
    env = environ if environ is not None else os.environ
    host = _require_loopback_host(env.get(ENV_HOST, DEFAULT_HOST))
    port = _parse_port(env.get(ENV_PORT, str(DEFAULT_PORT)))
    token = _require_token_env(env.get(ENV_TOKEN))
    store_root = _require_store_root(env.get(ENV_STORE_ROOT))
    return AutomationApiConfig(host=host, port=port, store_root=store_root, token=token)


def readiness_payload(config: AutomationApiConfig) -> JsonObject:
    """Return the strict safe readiness object consumed by the Rust supervisor."""
    return {
        "host": config.host,
        "port": config.port,
        "version": AUTOMATION_API_VERSION,
    }


def encode_safe_json_line(payload: Mapping[str, Any]) -> str:
    """Encode a safe public process line as compact JSON."""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def safe_startup_error_payload(error: AutomationStartupError) -> JsonObject:
    """Render a startup failure without token, path, argv, env, or raw diagnostics."""
    phase = error.phase if error.phase in _SAFE_STARTUP_PHASES else "configuration"
    return {
        "event": "automation-api.lifecycle",
        "status": "error",
        "phase": phase,
        "error": {
            "code": error.code,
            "message": error.message,
            "details": _SAFE_ERROR_DETAILS[phase],
            "detailRef": error.detail_ref,
        },
    }


def emit_startup_error(error: AutomationStartupError, stderr: TextIO) -> None:
    """Emit one safe startup error line to stderr."""
    print(encode_safe_json_line(safe_startup_error_payload(error)), file=stderr, flush=True)


def bind_loopback_socket(host: str, port: int) -> socket.socket:
    """Bind a loopback TCP listener and return the ready socket."""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
        sock.listen(socket.SOMAXCONN)
        sock.set_inheritable(False)
        return sock
    except OSError as exc:
        sock.close()
        raise AutomationStartupError(
            code=AUTOMATION_API_BIND_FAILED,
            message="Automation API could not bind the requested loopback listener.",
            phase="bind",
        ) from exc


def run_from_env(
    environ: Optional[Mapping[str, str]] = None,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
) -> int:
    """Run the uvicorn server from trusted process environment."""
    try:
        config = load_config_from_env(environ)
        uvicorn = _load_uvicorn()
        sock = bind_loopback_socket(config.host, config.port)
        bound_port = int(sock.getsockname()[1])
        bound_config = config.with_port(bound_port)
        print(encode_safe_json_line(readiness_payload(bound_config)), file=stdout, flush=True)
        return _serve(bound_config, sock, stderr, uvicorn)
    except AutomationStartupError as error:
        emit_startup_error(error, stderr)
        return 2


def _load_uvicorn() -> Any:
    try:
        import uvicorn
    except Exception as exc:
        raise AutomationStartupError(
            code=AUTOMATION_API_STARTUP_FAILED,
            message="Automation API server failed.",
            phase="serve",
        ) from exc
    return uvicorn


def _serve(config: AutomationApiConfig, sock: socket.socket, stderr: TextIO, uvicorn: Any) -> int:
    try:
        uvicorn_config = uvicorn.Config(
            create_app(config),
            host=config.host,
            port=config.port,
            access_log=False,
            log_config=None,
            log_level="critical",
            server_header=False,
            date_header=False,
        )
        server = uvicorn.Server(uvicorn_config)
        asyncio.run(server.serve(sockets=[sock]))
        return 0
    except Exception:
        try:
            sock.close()
        except OSError:
            pass
        safe_error = AutomationStartupError(
            code=AUTOMATION_API_STARTUP_FAILED,
            message="Automation API server failed.",
            phase="serve",
        )
        emit_startup_error(safe_error, stderr)
        return 3


def _error_response(
    request: Request,
    status_code: int,
    code: str,
    message: str,
    phase: str,
    detail_ref: str,
    headers: Optional[Mapping[str, str]] = None,
) -> JSONResponse:
    safe_phase = phase if phase in _SAFE_ERROR_DETAILS else "http"
    request_id = getattr(request.state, "request_id", _make_request_id())
    content: JsonObject = {
        "error": {
            "code": code,
            "message": message,
            "details": _SAFE_ERROR_DETAILS[safe_phase],
            "detailRef": detail_ref,
            "requestId": request_id,
        }
    }
    return JSONResponse(status_code=status_code, content=content, headers=dict(headers or {}))


def _parse_profile_list_query(request: Request) -> tuple[int, Optional[int]]:
    limit = _parse_profile_limit(_single_query_value(request, "limit"))
    cursor_offset = _decode_profile_cursor(_single_query_value(request, "cursor"))
    return limit, cursor_offset


def _single_query_value(request: Request, key: str) -> Optional[str]:
    values = request.query_params.getlist(key)
    if not values:
        return None
    if len(values) != 1:
        raise ValueError(f"{key} must appear once")
    return values[0]


def _parse_profile_limit(raw_limit: Optional[str]) -> int:
    if raw_limit is None:
        return DEFAULT_PROFILE_LIST_LIMIT
    if not raw_limit or not raw_limit.isascii() or not raw_limit.isdigit():
        raise ValueError("limit must be an ASCII integer")
    limit = int(raw_limit, 10)
    if limit < 1 or limit > MAX_PROFILE_LIST_LIMIT:
        raise ValueError("limit is outside allowed bounds")
    return limit


def _decode_profile_cursor(raw_cursor: Optional[str]) -> Optional[int]:
    if raw_cursor is None:
        return None
    if (
        not raw_cursor
        or len(raw_cursor) > _MAX_PROFILE_CURSOR_LENGTH
        or any(character.isspace() for character in raw_cursor)
        or not raw_cursor.startswith(_PROFILE_CURSOR_PREFIX)
    ):
        raise ValueError("cursor is malformed")

    encoded = raw_cursor[len(_PROFILE_CURSOR_PREFIX) :]
    if not encoded or any(character not in _URLSAFE_BASE64_CHARS for character in encoded):
        raise ValueError("cursor is malformed")

    padding = "=" * (-len(encoded) % 4)
    try:
        decoded = base64.b64decode((encoded + padding).encode("ascii"), altchars=b"-_", validate=True).decode("ascii")
    except Exception as exc:
        raise ValueError("cursor is malformed") from exc

    if not decoded.startswith(_PROFILE_CURSOR_MARKER):
        raise ValueError("cursor is unknown")
    offset_text = decoded[len(_PROFILE_CURSOR_MARKER) :]
    if not offset_text or not offset_text.isascii() or not offset_text.isdigit():
        raise ValueError("cursor is unknown")
    offset = int(offset_text, 10)
    if offset <= 0:
        raise ValueError("cursor is outside allowed bounds")
    return offset


def _validate_profile_cursor_offset(cursor_offset: Optional[int], total_profiles: int) -> int:
    if cursor_offset is None:
        return 0
    if cursor_offset >= total_profiles:
        raise ValueError("cursor is outside the current profile page range")
    return cursor_offset


def _encode_profile_cursor(offset: int) -> str:
    payload = f"{_PROFILE_CURSOR_MARKER}{offset}".encode("ascii")
    encoded = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    return f"{_PROFILE_CURSOR_PREFIX}{encoded}"


def _automation_profile_summary(profile: ProfileRecord) -> JsonObject:
    proxy = normalize_proxy_config(profile.proxy)
    return {
        "id": profile.id,
        "name": profile.name,
        "createdAt": profile.createdAt,
        "updatedAt": profile.updatedAt,
        "defaults": asdict(defaults_for_proxy(proxy)),
        "identity": normalize_profile_identity(profile.identity),
        "proxy": _automation_proxy_summary(proxy),
    }


def _automation_proxy_summary(proxy: Mapping[str, Any]) -> JsonObject:
    normalized = normalize_proxy_config(proxy)
    if normalized["mode"] == DIRECT_PROXY_MODE:
        return {
            "proxyVersion": PROXY_VERSION,
            "mode": DIRECT_PROXY_MODE,
            "summary": "Direct connection",
        }

    if normalized["mode"] == FIXED_SERVER_PROXY_MODE:
        protocol = normalized["protocol"]
        host = normalized["host"]
        port = normalized["port"]
        return {
            "proxyVersion": PROXY_VERSION,
            "mode": FIXED_SERVER_PROXY_MODE,
            "protocol": protocol,
            "host": host,
            "port": port,
            "summary": f"{protocol}://{_proxy_host_for_summary(host)}:{port}",
        }

    raise ValueError("unsupported normalized proxy mode")


def _proxy_host_for_summary(host: str) -> str:
    try:
        parsed = ipaddress.ip_address(host)
    except ValueError:
        return host
    if parsed.version == 6:
        return f"[{host}]"
    return host


async def _parse_lease_create_request(request: Request, started: float) -> JsonObject:
    raw_body = await request.body()
    if not raw_body:
        payload: Any = {}
    else:
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            _raise_lease_http_error(
                request,
                400,
                INVALID_REQUEST,
                "Automation lease request body must be valid JSON.",
                make_detail_ref(),
                started,
                method=_AUTOMATION_LEASES_CREATE_METHOD,
            )
            raise AssertionError("unreachable") from exc

    if not isinstance(payload, Mapping):
        _raise_lease_http_error(
            request,
            400,
            INVALID_REQUEST,
            "Automation lease request body must be a JSON object.",
            make_detail_ref(),
            started,
            method=_AUTOMATION_LEASES_CREATE_METHOD,
        )

    allowed_keys = {"framework", "ttlSeconds"}
    if any(key not in allowed_keys for key in payload):
        _raise_lease_http_error(
            request,
            400,
            INVALID_REQUEST,
            "Automation lease request contains unsupported fields.",
            make_detail_ref(),
            started,
            method=_AUTOMATION_LEASES_CREATE_METHOD,
        )

    framework = payload.get("framework", "playwright")
    if framework != "playwright":
        _raise_lease_http_error(
            request,
            400,
            INVALID_REQUEST,
            "Automation lease framework is unsupported.",
            make_detail_ref(),
            started,
            method=_AUTOMATION_LEASES_CREATE_METHOD,
        )

    ttl_seconds = payload.get("ttlSeconds", DEFAULT_LEASE_TTL_SECONDS)
    if type(ttl_seconds) is not int or ttl_seconds < MIN_LEASE_TTL_SECONDS or ttl_seconds > MAX_LEASE_TTL_SECONDS:
        _raise_lease_http_error(
            request,
            400,
            INVALID_REQUEST,
            "Automation lease TTL is outside allowed bounds.",
            make_detail_ref(),
            started,
            method=_AUTOMATION_LEASES_CREATE_METHOD,
        )

    return {"framework": framework, "ttlSeconds": ttl_seconds}


def _request_lease_manager(request: Request) -> AutomationLeaseManager:
    manager = getattr(request.app.state, "automation_lease_manager", None)
    if not isinstance(manager, AutomationLeaseManager):
        raise SidecarError(
            code=AUTOMATION_LEASE_HANDOFF_FAILED,
            message="Automation lease manager is unavailable.",
        )
    return manager


def _normalize_lease_launch_error(error: SidecarError) -> SidecarError:
    if error.code == CHROMIUM_ALREADY_RUNNING:
        return SidecarError(
            code=AUTOMATION_LEASE_PROFILE_BUSY,
            message="An automation lease cannot start while this profile is already running.",
            detail_ref=error.detail_ref,
        )
    if error.code in {CHROMIUM_EXECUTABLE_NOT_FOUND, CHROMIUM_LAUNCH_FAILED, IDENTITY_CDP_FAILED}:
        return SidecarError(
            code=AUTOMATION_LEASE_HANDOFF_FAILED,
            message="Automation lease handoff could not be prepared.",
            detail_ref=error.detail_ref,
        )
    return error


def _extract_lease_handoff_endpoint(launch_payload: Mapping[str, Any], profile_id: str) -> str:
    if not isinstance(launch_payload, Mapping):
        raise ValueError("automation launch payload must be a mapping")
    if launch_payload.get("profileId") != profile_id:
        raise ValueError("automation launch profileId is malformed")
    if launch_payload.get("status") != "running":
        raise ValueError("automation launch status is malformed")
    started_at = launch_payload.get("startedAt")
    if not isinstance(started_at, str) or not started_at.endswith("Z"):
        raise ValueError("automation launch startedAt is malformed")
    running_count = launch_payload.get("runningCount")
    if not isinstance(running_count, int) or running_count < 1:
        raise ValueError("automation launch runningCount is malformed")
    handoff_endpoint = launch_payload.get("handoffOrigin")
    if not _is_safe_loopback_cdp_origin(handoff_endpoint):
        raise ValueError("automation launch handoff origin is malformed")
    return handoff_endpoint


def _is_safe_loopback_cdp_origin(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    prefix = "http://127.0.0.1:"
    if not value.startswith(prefix):
        return False
    port_text = value[len(prefix) :]
    if not port_text or not port_text.isascii() or not port_text.isdigit():
        return False
    port = int(port_text, 10)
    return 1 <= port <= 65535


def _lease_create_runtime_payload(profile_id: str, launch_payload: Mapping[str, Any]) -> JsonObject:
    handoff_endpoint = _extract_lease_handoff_endpoint(launch_payload, profile_id)
    del handoff_endpoint
    return {
        "runtimeApiVersion": RUNTIME_API_VERSION,
        "runningCount": launch_payload["runningCount"],
        "profile": {
            "profileId": profile_id,
            "status": "running",
            "startedAt": launch_payload["startedAt"],
        },
    }


def _lease_release_runtime_payload(profile_id: str, stop_payload: Mapping[str, Any]) -> JsonObject:
    if not isinstance(stop_payload, Mapping):
        raise ValueError("automation stop payload must be a mapping")
    if stop_payload.get("profileId") != profile_id:
        raise ValueError("automation stop profileId is malformed")
    if stop_payload.get("status") != "stopped":
        raise ValueError("automation stop status is malformed")
    stopped_at = stop_payload.get("stoppedAt")
    termination = stop_payload.get("termination")
    running_count = stop_payload.get("runningCount")
    if not isinstance(stopped_at, str) or not stopped_at.endswith("Z"):
        raise ValueError("automation stop stoppedAt is malformed")
    if not isinstance(termination, str) or not termination:
        raise ValueError("automation stop termination is malformed")
    if not isinstance(running_count, int) or running_count < 0:
        raise ValueError("automation stop runningCount is malformed")
    return {
        "runtimeApiVersion": RUNTIME_API_VERSION,
        "profile": {
            "profileId": profile_id,
            "status": "stopped",
            "stoppedAt": stopped_at,
            "termination": termination,
        },
        "runningCount": running_count,
    }


def _best_effort_stop_after_failed_handoff(store_root: Path, profile_id: str) -> None:
    try:
        chromium.stop(store_root, profile_id)
    except Exception:
        pass


def _raise_lease_sidecar_http_error(request: Request, error: SidecarError, started: float, *, method: str) -> None:
    if error.code == INVALID_REQUEST:
        _raise_lease_http_error(
            request,
            400,
            INVALID_REQUEST,
            "Automation lease request is invalid.",
            error.detail_ref,
            started,
            method=method,
        )

    if error.code == PROFILE_NOT_FOUND:
        _raise_lease_http_error(request, 404, PROFILE_NOT_FOUND, error.message, error.detail_ref, started, method=method)

    if error.code == AUTOMATION_LEASE_NOT_FOUND:
        _raise_lease_http_error(request, 404, AUTOMATION_LEASE_NOT_FOUND, error.message, error.detail_ref, started, method=method)

    if error.code in {AUTOMATION_LEASE_PROFILE_BUSY, AUTOMATION_LEASE_RELEASED, AUTOMATION_LEASE_EXPIRED}:
        _raise_lease_http_error(request, 409, error.code, error.message, error.detail_ref, started, method=method)

    if error.code == CHROMIUM_ALREADY_RUNNING:
        _raise_lease_http_error(
            request,
            409,
            AUTOMATION_LEASE_PROFILE_BUSY,
            "An automation lease cannot start while this profile is already running.",
            error.detail_ref,
            started,
            method=method,
        )

    if error.code in {CHROMIUM_EXECUTABLE_NOT_FOUND, CHROMIUM_LAUNCH_FAILED, IDENTITY_CDP_FAILED, AUTOMATION_LEASE_HANDOFF_FAILED}:
        _raise_lease_http_error(
            request,
            503,
            AUTOMATION_LEASE_HANDOFF_FAILED,
            "Automation lease handoff could not be prepared.",
            error.detail_ref,
            started,
            method=method,
        )

    if error.code in {PROFILE_STORE_CORRUPT, PROFILE_STORE_UNAVAILABLE, PROFILE_STORE_WRITE_FAILED, CHROMIUM_STOP_FAILED}:
        _raise_lease_http_error(request, 503, error.code, error.message, error.detail_ref, started, method=method)

    _raise_lease_http_error(
        request,
        503,
        INTERNAL_ERROR,
        "Automation lease request failed unexpectedly.",
        error.detail_ref,
        started,
        method=method,
    )


def _raise_lease_http_error(
    request: Request,
    status_code: int,
    code: str,
    message: str,
    detail_ref: str,
    started: float,
    *,
    method: str,
) -> None:
    _record_domain_error(request, method=method, code=code, detail_ref=detail_ref, started=started)
    raise AutomationHttpError(
        status_code=status_code,
        code=code,
        message=message,
        phase="lease",
        detail_ref=detail_ref,
    )


def _make_lease_id() -> str:
    while True:
        suffix = secrets.token_urlsafe(18).rstrip("=")
        if suffix and all(character in _URLSAFE_BASE64_CHARS for character in suffix):
            return f"lease_{suffix}"


def _validate_lease_id_or_raise(lease_id: str) -> None:
    if (
        not isinstance(lease_id, str)
        or not lease_id
        or lease_id.strip() != lease_id
        or len(lease_id) > 128
        or not lease_id.startswith("lease_")
    ):
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Automation lease id is invalid.",
        )
    suffix = lease_id[len("lease_") :]
    if not suffix or any(character not in _URLSAFE_BASE64_CHARS for character in suffix):
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Automation lease id is invalid.",
        )


def _iso_from_epoch(epoch_seconds: float) -> str:
    return datetime.fromtimestamp(epoch_seconds, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _raise_profile_sidecar_http_error(
    request: Request,
    error: SidecarError,
    started: float,
    *,
    method: str,
    invalid_message: str,
) -> None:
    if error.code == INVALID_REQUEST:
        _raise_profile_http_error(
            request,
            400,
            INVALID_REQUEST,
            invalid_message,
            error.detail_ref,
            started,
            method=method,
        )

    if error.code == PROFILE_NOT_FOUND:
        _raise_profile_http_error(request, 404, PROFILE_NOT_FOUND, error.message, error.detail_ref, started, method=method)

    if error.code in {PROFILE_STORE_CORRUPT, PROFILE_STORE_UNAVAILABLE, PROFILE_STORE_WRITE_FAILED}:
        _raise_profile_http_error(request, 503, error.code, error.message, error.detail_ref, started, method=method)

    _raise_profile_http_error(
        request,
        503,
        PROFILE_STORE_CORRUPT,
        "Profile store is corrupt.",
        error.detail_ref,
        started,
        method=method,
    )


def _raise_profile_http_error(
    request: Request,
    status_code: int,
    code: str,
    message: str,
    detail_ref: str,
    started: float,
    *,
    method: str,
) -> None:
    _record_domain_error(request, method=method, code=code, detail_ref=detail_ref, started=started)
    raise AutomationHttpError(
        status_code=status_code,
        code=code,
        message=message,
        phase="profile",
        detail_ref=detail_ref,
    )


def _record_domain_error(request: Request, *, method: str, code: str, detail_ref: str, started: float) -> None:
    append_events(
        _request_config(request).store_root,
        [
            diagnostic_event(
                request_id=getattr(request.state, "request_id", None),
                method=method,
                status="error",
                duration_ms=_elapsed_ms(started),
                error_code=code,
                detail_ref=detail_ref,
            )
        ],
        request_id=getattr(request.state, "request_id", None),
        method=method,
    )


def _load_automation_runtime_status(request: Request, *, method: str, started: float) -> JsonObject:
    try:
        raw_status = chromium.status(_request_config(request).store_root)
        return _automation_runtime_status(raw_status, request)
    except AutomationHttpError:
        raise
    except ValueError as exc:
        detail_ref = make_detail_ref()
        _raise_runtime_http_error(
            request,
            503,
            INTERNAL_ERROR,
            "Chromium runtime status is unavailable.",
            detail_ref,
            started,
            method=method,
        )
        raise AssertionError("unreachable") from exc
    except SidecarError as error:
        _raise_runtime_sidecar_http_error(request, error, started, method=method)
        raise AssertionError("unreachable") from error
    except Exception as exc:
        detail_ref = make_detail_ref()
        _raise_runtime_http_error(
            request,
            503,
            INTERNAL_ERROR,
            "Chromium runtime status request failed unexpectedly.",
            detail_ref,
            started,
            method=method,
        )
        raise AssertionError("unreachable") from exc


def _automation_runtime_status(raw_status: Mapping[str, Any], request: Request) -> JsonObject:
    if not isinstance(raw_status, Mapping):
        raise ValueError("runtime status must be a mapping")
    raw_profiles = raw_status.get("profiles")
    raw_reconciled = raw_status.get("reconciled")
    raw_running_count = raw_status.get("runningCount")
    if not isinstance(raw_profiles, list) or not isinstance(raw_reconciled, list):
        raise ValueError("runtime status collections are malformed")
    if not isinstance(raw_running_count, int) or raw_running_count < 0:
        raise ValueError("runtime runningCount is malformed")

    safe_profiles = [_safe_runtime_entry(item, expected_status="running") for item in raw_profiles]
    safe_reconciled = [_safe_runtime_entry(item, expected_status="stopped") for item in raw_reconciled]
    if raw_running_count != len(safe_profiles):
        raise ValueError("runtime runningCount does not match running profiles")

    return {
        "runtimeApiVersion": RUNTIME_API_VERSION,
        "runningCount": len(safe_profiles),
        "profiles": safe_profiles,
        "reconciled": safe_reconciled,
        "request": {
            "requestId": request.state.request_id,
        },
    }


def _safe_runtime_entry(raw_entry: Any, *, expected_status: str) -> JsonObject:
    if not isinstance(raw_entry, Mapping):
        raise ValueError("runtime entry must be a mapping")
    profile_id = raw_entry.get("profileId")
    status = raw_entry.get("status")
    if not isinstance(profile_id, str) or not profile_id.strip():
        raise ValueError("runtime entry profileId is malformed")
    if status != expected_status:
        raise ValueError("runtime entry status is malformed")

    entry: JsonObject = {
        "profileId": profile_id,
        "status": status,
    }
    if status == "running":
        started_at = raw_entry.get("startedAt")
        if not isinstance(started_at, str) or not started_at.endswith("Z"):
            raise ValueError("runtime running entry startedAt is malformed")
        entry["startedAt"] = started_at
        return entry

    stopped_at = raw_entry.get("stoppedAt")
    termination = raw_entry.get("termination")
    if not isinstance(stopped_at, str) or not stopped_at.endswith("Z"):
        raise ValueError("runtime stopped entry stoppedAt is malformed")
    if not isinstance(termination, str) or not termination:
        raise ValueError("runtime stopped entry termination is malformed")
    entry["stoppedAt"] = stopped_at
    entry["termination"] = termination
    return entry


def _runtime_state_for_profile(profile_id: str, runtime: Mapping[str, Any]) -> JsonObject:
    for collection_name in ("profiles", "reconciled"):
        collection = runtime.get(collection_name, [])
        if not isinstance(collection, list):
            continue
        for entry in collection:
            if isinstance(entry, Mapping) and entry.get("profileId") == profile_id:
                return dict(entry)
    return {
        "profileId": profile_id,
        "status": "stopped",
    }


def _raise_runtime_sidecar_http_error(request: Request, error: SidecarError, started: float, *, method: str) -> None:
    if error.code == INVALID_REQUEST:
        _raise_runtime_http_error(
            request,
            400,
            INVALID_REQUEST,
            "Chromium runtime status request is invalid.",
            error.detail_ref,
            started,
            method=method,
        )

    status_code = 503
    _raise_runtime_http_error(
        request,
        status_code,
        error.code,
        error.message,
        error.detail_ref,
        started,
        method=method,
    )


def _raise_runtime_http_error(
    request: Request,
    status_code: int,
    code: str,
    message: str,
    detail_ref: str,
    started: float,
    *,
    method: str,
) -> None:
    _record_domain_error(request, method=method, code=code, detail_ref=detail_ref, started=started)
    raise AutomationHttpError(
        status_code=status_code,
        code=code,
        message=message,
        phase="runtime",
        detail_ref=detail_ref,
    )


def _parse_authorization_header(raw_header: str) -> Optional[str]:
    if not raw_header or len(raw_header) > MAX_AUTHORIZATION_HEADER_LENGTH:
        return None
    parts = raw_header.split()
    if len(parts) != 2:
        return None
    scheme, candidate = parts
    if scheme.casefold() != "bearer" or not candidate:
        return None
    if any(char.isspace() for char in candidate):
        return None
    return candidate


def _request_config(request: Request) -> AutomationApiConfig:
    return request.app.state.automation_config


def _require_loopback_host(value: Optional[str]) -> str:
    host = (value or DEFAULT_HOST).strip()
    if not host or "://" in host or "/" in host or "\\" in host:
        raise _configuration_error("Automation API host must be a loopback host.")
    if host.casefold() == "localhost":
        return "127.0.0.1"
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise _configuration_error("Automation API host must be a loopback host.") from exc
    if not address.is_loopback:
        raise _configuration_error("Automation API host must be a loopback host.")
    return address.compressed


def _parse_port(value: Optional[str]) -> int:
    text = (value or str(DEFAULT_PORT)).strip()
    try:
        port = int(text, 10)
    except ValueError as exc:
        raise _configuration_error("Automation API port must be a valid TCP port.") from exc
    if port < 0 or port > 65535:
        raise _configuration_error("Automation API port must be a valid TCP port.")
    return port


def _require_token_env(value: Optional[str]) -> str:
    token = (value or "").strip()
    if not token:
        raise _configuration_error("Automation API token is required.")
    if len(token) > MAX_AUTHORIZATION_HEADER_LENGTH:
        raise _configuration_error("Automation API token is invalid.")
    return token


def _require_store_root(value: Optional[str]) -> Path:
    raw = (value or "").strip()
    if not raw:
        raise _configuration_error("Automation API store root is required.")
    try:
        candidate = Path(raw).expanduser()
    except RuntimeError as exc:
        raise _configuration_error("Automation API store root is invalid.") from exc
    if not candidate.is_absolute() or any(part == ".gsd" for part in candidate.parts):
        raise _configuration_error("Automation API store root is invalid.")
    return candidate


def _configuration_error(message: str) -> AutomationStartupError:
    return AutomationStartupError(
        code=AUTOMATION_API_CONFIGURATION_ERROR,
        message=message,
        phase="configuration",
    )


def _make_request_id() -> str:
    return f"automation-{uuid.uuid4().hex[:12]}"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _product_version() -> str:
    try:
        from theprivator import __version__

        return __version__
    except Exception:
        return "unknown"


def _elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 3)


__all__ = [
    "AUTOMATION_API_VERSION",
    "DEFAULT_HOST",
    "DEFAULT_PORT",
    "DEFAULT_PROFILE_LIST_LIMIT",
    "ENV_HOST",
    "ENV_PORT",
    "ENV_STORE_ROOT",
    "ENV_TOKEN",
    "MAX_PROFILE_LIST_LIMIT",
    "PROFILE_API_VERSION",
    "RUNTIME_API_VERSION",
    "AutomationApiConfig",
    "AutomationHttpError",
    "AutomationStartupError",
    "bind_loopback_socket",
    "create_app",
    "emit_startup_error",
    "encode_safe_json_line",
    "load_config_from_env",
    "readiness_payload",
    "require_token",
    "run_from_env",
    "safe_startup_error_payload",
]
