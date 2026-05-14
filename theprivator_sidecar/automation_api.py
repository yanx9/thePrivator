"""Loopback-only, token-guarded automation API for the app-managed sidecar."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import secrets
import socket
import sys
import time
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional, TextIO

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .protocol import (
    AUTOMATION_API_BIND_FAILED,
    AUTOMATION_API_CONFIGURATION_ERROR,
    AUTOMATION_API_HTTP_ERROR,
    AUTOMATION_API_ROUTE_NOT_FOUND,
    AUTOMATION_API_STARTUP_FAILED,
    AUTOMATION_AUTH_INVALID,
    AUTOMATION_AUTH_REQUIRED,
    JsonObject,
    SIDECAR_VERSION,
    make_detail_ref,
)

AUTOMATION_API_VERSION = "1.0.0"
PRODUCT_NAME = "ThePrivator"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 0
MAX_AUTHORIZATION_HEADER_LENGTH = 8192

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
    "ENV_HOST",
    "ENV_PORT",
    "ENV_STORE_ROOT",
    "ENV_TOKEN",
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
