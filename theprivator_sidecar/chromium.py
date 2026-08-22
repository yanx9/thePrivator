"""Sidecar-owned Chromium lifecycle contract and transient runtime registry.

This module is intentionally separate from the legacy GUI launcher. It accepts
only S02 profile ids plus a trusted app-data store root, derives all browser
paths from the profile store, and persists only transient process bookkeeping in
``profile-store/runtime``. Public payloads never expose absolute paths, command
lines, browser stdout/stderr, or environment values.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Dict, Iterable, Mapping, Optional, Sequence, Tuple, Union

from .identity_extension import (
    IdentityExtensionArtifact,
    generate_identity_extension,
    runtime_identity_extension_root,
)
from .identity_runtime import (
    WEBRTC_DISABLE_NON_PROXIED_UDP_FLAG,
    IdentityRuntimePlan,
    build_identity_runtime_plan,
)
from .proxy_auth_extension import (
    ProxyAuthExtensionArtifact,
    generate_proxy_auth_extension,
    runtime_proxy_auth_extension_root,
)
from .profiles import STORE_DIR, ProfileRecord, ProfileStore, utc_now_iso
from .proxy import FIXED_SERVER_PROXY_MODE, normalize_proxy_config
from .protocol import (
    CHROMIUM_ALREADY_RUNNING,
    CHROMIUM_EXECUTABLE_NOT_FOUND,
    CHROMIUM_LAUNCH_FAILED,
    CHROMIUM_STOP_FAILED,
    IDENTITY_AUDIT_FAILED,
    PORTABILITY_PROFILE_BUSY,
    IDENTITY_CDP_FAILED,
    INVALID_REQUEST,
    JsonObject,
    PROXY_LAUNCH_ARG_UNSAFE,
    PROXY_PROOF_FAILED,
    SidecarError,
)
from .proxy_runtime import (
    PROXY_SERVER_ARG_PREFIX,
    ProxyRuntimePlan,
    build_proxy_runtime_plan,
    is_rejected_launch_switch,
    validate_proxy_server_launch_arg,
)

try:  # pragma: no cover - exercised through the available dependency in CI/dev.
    import psutil  # type: ignore

    HAS_PSUTIL = True
except ImportError:  # pragma: no cover - fallback remains for minimal installs.
    psutil = None  # type: ignore
    HAS_PSUTIL = False

REGISTRY_VERSION = 1
RUNTIME_DIR = "runtime"
RUNTIME_FILE = "chromium-processes.json"
PROXY_BRIDGE_DIR = "proxy-bridges"
PROXY_BRIDGE_READY_TIMEOUT_SECONDS = 5.0
GRACEFUL_STOP_TIMEOUT_SECONDS = 3.0
FORCE_STOP_TIMEOUT_SECONDS = 2.0
LAUNCH_LIVENESS_SETTLE_SECONDS = 0.05
CHROMIUM_EXECUTABLE_ENV = "THEPRIVATOR_CHROMIUM_PATH"
PROXY_PROOF_TRUST_ENABLED_ENV = "THEPRIVATOR_ENABLE_PROXY_PROOF_TRUST"
PROXY_PROOF_SPKI_SHA256_ENV = "THEPRIVATOR_PROXY_PROOF_SPKI_SHA256"
CHROMIUM_EXECUTABLE_NAMES = (
    "chromium-browser",
    "chromium",
    "google-chrome",
    "google-chrome-stable",
    "chrome",
)

_SAFE_CHROMIUM_ARGS = (
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-translate",
    "--disable-features=TranslateUI",
)
_REMOTE_DEBUGGING_ARG = "--remote-debugging-port=0"
_REMOTE_ALLOW_ORIGINS_ARG = "--remote-allow-origins=*"
_PROXY_PROOF_SPKI_ARG_PREFIX = "--ignore-certificate-errors-spki-list="
_LOAD_EXTENSION_PREFIX = "--load-extension="
_DISABLE_EXTENSIONS_EXCEPT_PREFIX = "--disable-extensions-except="
_ALLOWED_IDENTITY_LAUNCH_FLAGS = {WEBRTC_DISABLE_NON_PROXIED_UDP_FLAG}
_ALLOWED_IDENTITY_VALUE_ARG_PREFIXES = (
    "--user-agent=",
    "--lang=",
    "--window-size=",
    "--force-device-scale-factor=",
)
IDENTITY_CDP_DISCOVERY_TIMEOUT_SECONDS = 10.0
IDENTITY_CDP_APPLY_TIMEOUT_SECONDS = 10.0
AUDIT_CDP_DISCOVERY_TIMEOUT_SECONDS = 10.0
AUDIT_TARGET_OPEN_TIMEOUT_SECONDS = 5.0
AUDIT_RESULT_CAPTURE_TIMEOUT_SECONDS = 6.0
AUDIT_RESULT_READY_WAIT_MS = 2500
_DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort"


@dataclass(frozen=True)
class RuntimeRecord:
    """Compact sidecar-owned proof that one profile was launched."""

    profile_id: str
    pid: int
    started_at: str
    user_data_dir: str
    owner_token: str
    proxy_bridge_pid: Optional[int] = None
    # Relative POSIX path to the bridge's ready file. The bridge holds an
    # exclusive lock on it for its lifetime, so it doubles as proof that the
    # recorded pid is still that bridge and not a process that reused it.
    proxy_bridge_ready_file: Optional[str] = None

    @classmethod
    def from_dict(cls, payload: Any) -> Optional["RuntimeRecord"]:
        if not isinstance(payload, Mapping):
            return None
        profile_id = payload.get("profileId")
        pid = payload.get("pid")
        started_at = payload.get("startedAt")
        user_data_dir = payload.get("userDataDir")
        owner_token = payload.get("ownerToken", "")
        if not isinstance(profile_id, str) or not profile_id.strip():
            return None
        if not isinstance(pid, int) or pid <= 0:
            return None
        if not isinstance(started_at, str) or not started_at.endswith("Z"):
            return None
        if not isinstance(user_data_dir, str) or not _is_safe_relative_posix_path(user_data_dir):
            return None
        if not isinstance(owner_token, str):
            return None
        proxy_bridge_pid = payload.get("proxyBridgePid")
        if proxy_bridge_pid is not None and (not isinstance(proxy_bridge_pid, int) or proxy_bridge_pid <= 0):
            return None
        proxy_bridge_ready_file = payload.get("proxyBridgeReadyFile")
        if proxy_bridge_ready_file is not None and (
            not isinstance(proxy_bridge_ready_file, str)
            or not _is_safe_relative_posix_path(proxy_bridge_ready_file)
        ):
            return None
        return cls(
            profile_id=profile_id,
            pid=pid,
            started_at=started_at,
            user_data_dir=user_data_dir,
            owner_token=owner_token,
            proxy_bridge_pid=proxy_bridge_pid,
            proxy_bridge_ready_file=proxy_bridge_ready_file,
        )

    def to_dict(self) -> JsonObject:
        payload: JsonObject = {
            "profileId": self.profile_id,
            "pid": self.pid,
            "startedAt": self.started_at,
            "userDataDir": self.user_data_dir,
            "ownerToken": self.owner_token,
        }
        if self.proxy_bridge_pid is not None:
            payload["proxyBridgePid"] = self.proxy_bridge_pid
        if self.proxy_bridge_ready_file is not None:
            payload["proxyBridgeReadyFile"] = self.proxy_bridge_ready_file
        return payload

@dataclass(frozen=True)
class ProxyLaunchRuntime:
    launch_args: list[str]
    proxy_bridge_pid: Optional[int] = None
    proxy_bridge_ready_file: Optional[str] = None


class RuntimeRegistry:
    """Read/write the transient Chromium process registry under app data."""

    def __init__(self, store_root: Union[str, Path]) -> None:
        self.store_root = Path(store_root)
        self.runtime_dir = self.store_root / STORE_DIR / RUNTIME_DIR
        self.path = self.runtime_dir / RUNTIME_FILE

    def read(self) -> Dict[str, RuntimeRecord]:
        """Return valid records; invalid registry JSON is treated as stale."""
        if not self.path.exists():
            return {}
        if not self.path.is_file():
            return {}
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (json.JSONDecodeError, UnicodeDecodeError, OSError):
            return {}
        if not isinstance(payload, Mapping) or payload.get("registryVersion") != REGISTRY_VERSION:
            return {}
        raw_processes = payload.get("processes")
        if not isinstance(raw_processes, Mapping):
            return {}

        records: Dict[str, RuntimeRecord] = {}
        for profile_id, raw_record in raw_processes.items():
            record = RuntimeRecord.from_dict(raw_record)
            if record is not None and record.profile_id == profile_id:
                records[record.profile_id] = record
        return records

    def write(self, records: Mapping[str, RuntimeRecord], *, error_code: str = CHROMIUM_LAUNCH_FAILED) -> None:
        """Persist the runtime registry, raising if the write does not land.

        error_code used to be optional, and callers that omitted it -- status(),
        stop(), and the portability guard -- had their OSError swallowed. A failed
        write there is not cosmetic: the registry still claims a stopped profile
        is running, so the UI shows it running forever and refuses to launch it
        again. A status that errors is recoverable; a status that lies is not.
        """
        payload = {
            "registryVersion": REGISTRY_VERSION,
            "processes": {
                profile_id: record.to_dict()
                for profile_id, record in sorted(records.items(), key=lambda item: item[0])
            },
        }
        try:
            self.runtime_dir.mkdir(parents=True, exist_ok=True)
            temp_file = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
            try:
                with temp_file.open("w", encoding="utf-8") as handle:
                    json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_file, self.path)
            finally:
                if temp_file.exists():
                    temp_file.unlink()
        except OSError as exc:
            raise SidecarError(
                code=error_code,
                message="Chromium runtime bookkeeping failed.",
            ) from exc



def status(store_root: Union[str, Path]) -> JsonObject:
    """Return running Chromium profiles and reconcile stale registry records."""
    store = ProfileStore(store_root)
    store.list()
    registry = RuntimeRegistry(store_root)
    records = registry.read()
    active, reconciled, changed = _reconcile_records(store_root, records)
    if changed:
        registry.write(active)
    return _status_payload(active, reconciled)


def ensure_profile_stopped_for_portability(store_root: Union[str, Path], profile: ProfileRecord) -> None:
    """Reject cookie portability while a profile has a live Chromium runtime record.

    Automation leases and UI launches share ``RuntimeRegistry`` records, so any
    live record means the cookie DB may be locked or mutated by Chromium. Stale
    records are reconciled using the same process-liveness semantics as
    ``chromium.status`` before the busy decision is made.
    """
    registry = RuntimeRegistry(store_root)
    records = registry.read()
    active, _reconciled, changed = _reconcile_records(store_root, records)
    if changed:
        registry.write(active)

    record = active.get(profile.id)
    if record is not None and is_process_alive(record.pid):
        raise SidecarError(
            code=PORTABILITY_PROFILE_BUSY,
            message="Stop this profile before importing or exporting cookies.",
        )



def launch(store_root: Union[str, Path], profile_id: str) -> JsonObject:
    """Launch Chromium for a stored profile and record only transient runtime state."""
    profile = _load_profile(store_root, profile_id)
    proxy_plan = build_proxy_runtime_plan(profile.proxy)
    identity_plan = build_identity_runtime_plan(profile.identity)
    registry = RuntimeRegistry(store_root)
    active = _reconciled_active_records(registry, error_code=CHROMIUM_LAUNCH_FAILED)
    _reject_if_already_running(active, profile)

    outcome = _launch_registered(
        store_root,
        profile,
        identity_plan,
        proxy_plan,
        active=active,
        registry=registry,
        error_code=CHROMIUM_LAUNCH_FAILED,
    )
    return {**_running_payload(outcome.record), "runningCount": outcome.running_count}


def launch_for_automation(store_root: Union[str, Path], profile_id: str) -> JsonObject:
    """Launch Chromium for an ephemeral automation lease and return a CDP origin.

    The returned origin is intentionally in-memory only. Runtime bookkeeping stays
    limited to the existing ``RuntimeRecord`` shape so normal status surfaces do
    not expose DevTools URLs, launch arguments, executable paths, or profile
    storage paths.
    """
    profile = _load_profile(store_root, profile_id)
    proxy_plan = build_proxy_runtime_plan(profile.proxy)
    identity_plan = build_identity_runtime_plan(profile.identity)
    registry = RuntimeRegistry(store_root)
    active = _reconciled_active_records(registry, error_code=CHROMIUM_LAUNCH_FAILED)
    _reject_if_already_running(active, profile)

    outcome = _launch_registered(
        store_root,
        profile,
        identity_plan,
        proxy_plan,
        active=active,
        registry=registry,
        error_code=CHROMIUM_LAUNCH_FAILED,
        force_remote_debugging=True,
        after_endpoint=_handoff_origin_from_endpoint,
    )
    return {
        "profileId": outcome.record.profile_id,
        "status": "running",
        "startedAt": outcome.record.started_at,
        "runningCount": outcome.running_count,
        "handoffOrigin": outcome.endpoint_result,
    }


def open_identity_audit_page(
    store_root: Union[str, Path],
    profile_id: str,
    page: Mapping[str, Any],
    *,
    audit_version: int,
) -> JsonObject:
    """Open one curated public checker page through the internal CDP boundary."""
    profile = _load_profile(store_root, profile_id)
    proxy_plan = build_proxy_runtime_plan(profile.proxy)
    audit_page = _safe_audit_page_metadata(page)
    identity_plan = build_identity_runtime_plan(profile.identity)
    registry = RuntimeRegistry(store_root)
    records = registry.read()
    active, _reconciled, changed = _reconcile_records(store_root, records)
    if changed:
        registry.write(active, error_code=IDENTITY_AUDIT_FAILED)

    existing = active.get(profile.id)
    if existing is not None and is_process_alive(existing.pid):
        return _open_identity_audit_page_for_running(
            store_root,
            profile,
            identity_plan,
            audit_page,
            audit_version=audit_version,
            running_count=len(active),
        )

    return _launch_and_open_identity_audit_page(
        store_root,
        profile,
        identity_plan,
        proxy_plan,
        audit_page,
        audit_version=audit_version,
        active=active,
        registry=registry,
    )


def collect_identity_audit_results(
    store_root: Union[str, Path],
    profile_id: str,
    pages: Sequence[Mapping[str, Any]],
    *,
    audit_version: int,
) -> JsonObject:
    """Collect bounded observations from curated public checker pages."""
    profile = _load_profile(store_root, profile_id)
    proxy_plan = build_proxy_runtime_plan(profile.proxy)
    audit_pages = [_safe_audit_page_metadata(page) for page in pages]
    identity_plan = build_identity_runtime_plan(profile.identity)
    registry = RuntimeRegistry(store_root)
    records = registry.read()
    active, _reconciled, changed = _reconcile_records(store_root, records)
    if changed:
        registry.write(active, error_code=IDENTITY_AUDIT_FAILED)

    existing = active.get(profile.id)
    if existing is not None and is_process_alive(existing.pid):
        return _collect_identity_audit_results_for_running(
            store_root,
            profile,
            identity_plan,
            audit_pages,
            audit_version=audit_version,
            launched=False,
            running_count=len(active),
        )

    return _launch_and_collect_identity_audit_results(
        store_root,
        profile,
        identity_plan,
        proxy_plan,
        audit_pages,
        audit_version=audit_version,
        active=active,
        registry=registry,
    )



def stop(store_root: Union[str, Path], profile_id: str) -> JsonObject:
    """Stop only the owned process tree for one stored profile."""
    profile = _load_profile(store_root, profile_id)
    registry = RuntimeRegistry(store_root)
    records = registry.read()
    record = records.get(profile.id)
    if record is None:
        return _stopped_payload(profile, termination="already-stopped", running_count=_active_count(records))

    updated = dict(records)
    updated.pop(profile.id, None)

    if not is_process_alive(record.pid):
        _stop_proxy_bridge_for_record(store_root, record)
        registry.write(updated, error_code=CHROMIUM_STOP_FAILED)
        return _stopped_payload(profile, termination="reconciled", running_count=_active_count(updated))

    # Mark first, then kill. The registry write is what the UI reads, and it is
    # the step that can fail on a full or read-only disk; doing it after the kill
    # meant a failed write left the registry insisting a dead browser was still
    # running, with no way back. Recording the stop first means the worst case is
    # an orphaned process the next reconcile pass collects, rather than a profile
    # the user can never launch again.
    registry.write(updated, error_code=CHROMIUM_STOP_FAILED)
    try:
        termination = _stop_process_tree(record.pid)
    except SidecarError:
        # The process outlived both signals. Put the record back so status keeps
        # reporting it and a retry has something to act on.
        registry.write(records, error_code=CHROMIUM_STOP_FAILED)
        raise
    _stop_proxy_bridge_for_record(store_root, record)
    return _stopped_payload(profile, termination=termination, running_count=_active_count(updated))



def discover_executable() -> Path:
    """Find Chromium without accepting frontend-provided command strings."""
    configured_path = os.environ.get(CHROMIUM_EXECUTABLE_ENV, "").strip()
    if configured_path:
        candidate = Path(configured_path).expanduser()
        if _is_executable_file(candidate):
            return candidate
        raise SidecarError(
            code=CHROMIUM_EXECUTABLE_NOT_FOUND,
            message=(
                "Configured Chromium executable from THEPRIVATOR_CHROMIUM_PATH was not "
                "found or is not executable."
            ),
        )

    for executable_name in CHROMIUM_EXECUTABLE_NAMES:
        found = shutil.which(executable_name)
        if found:
            return Path(found)

    raise SidecarError(
        code=CHROMIUM_EXECUTABLE_NOT_FOUND,
        message="Chromium executable was not found. Install Chromium/Chrome or set THEPRIVATOR_CHROMIUM_PATH.",
    )



def build_launch_args(
    executable: Path,
    user_data_dir: Path,
    start_url: str,
    *,
    extra_args: Sequence[str] = (),
) -> list[str]:
    """Build safe Chromium arguments from sidecar-owned values only."""
    return [
        str(executable),
        f"--user-data-dir={user_data_dir}",
        *_SAFE_CHROMIUM_ARGS,
        *_validate_extra_launch_args(extra_args),
        start_url or "about:blank",
    ]


def _prepare_identity_extension(
    store_root: Union[str, Path],
    profile: ProfileRecord,
    identity_plan: IdentityRuntimePlan,
) -> Optional[IdentityExtensionArtifact]:
    if not identity_plan.requires_extension:
        return None
    extension_root = runtime_identity_extension_root(store_root).resolve()
    return generate_identity_extension(extension_root, profile.id, identity_plan)


def _prepare_proxy_auth_extension(
    store_root: Union[str, Path],
    profile: ProfileRecord,
    proxy_plan: ProxyRuntimePlan,
) -> Optional[ProxyAuthExtensionArtifact]:
    if not proxy_plan.requires_auth_helper:
        return None
    extension_root = runtime_proxy_auth_extension_root(store_root).resolve()
    return generate_proxy_auth_extension(extension_root, profile.id, profile.proxy, proxy_plan)


def _prepare_proxy_launch_runtime(
    store_root: Union[str, Path],
    profile: ProfileRecord,
    proxy_plan: ProxyRuntimePlan,
) -> ProxyLaunchRuntime:
    normalized = normalize_proxy_config(profile.proxy)
    credentials = normalized.get("credentials")
    if (
        normalized.get("mode") == FIXED_SERVER_PROXY_MODE
        and normalized.get("protocol") == "socks5"
        and isinstance(credentials, Mapping)
    ):
        host = normalized.get("host")
        port = normalized.get("port")
        username = credentials.get("username")
        password = credentials.get("password")
        if not isinstance(host, str) or not isinstance(port, int) or not isinstance(username, str) or not isinstance(password, str):
            raise SidecarError(
                code=CHROMIUM_LAUNCH_FAILED,
                message="Chromium proxy launch arguments could not be prepared.",
            )
        bridge = _spawn_socks5_proxy_bridge(store_root, profile.id, host, port, username, password)
        return ProxyLaunchRuntime(
            launch_args=[validate_proxy_server_launch_arg(f"{PROXY_SERVER_ARG_PREFIX}socks5://127.0.0.1:{bridge['port']}")],
            proxy_bridge_pid=bridge["pid"],
            proxy_bridge_ready_file=bridge["readyFile"],
        )
    return ProxyLaunchRuntime(launch_args=proxy_plan.launch_args)


def _spawn_socks5_proxy_bridge(
    store_root: Union[str, Path],
    profile_id: str,
    upstream_host: str,
    upstream_port: int,
    username: str,
    password: str,
) -> dict[str, int]:
    bridge_root = Path(store_root) / STORE_DIR / RUNTIME_DIR / PROXY_BRIDGE_DIR / _profile_runtime_key(profile_id)
    bridge_root.mkdir(parents=True, exist_ok=True)
    nonce = uuid.uuid4().hex
    ready_path = bridge_root / f"bridge-{nonce}.ready.json"
    # Handed to the child over its stdin pipe, never written to a file and never
    # placed on argv. A config file would need creating, chmod'ing, and deleting
    # on every exit path, and the paths that raise before the delete are exactly
    # the ones that would strand the upstream password on disk. The ready file
    # below stays a file because it carries no secrets.
    config_payload = {
        "bridgeVersion": 1,
        "upstream": {"host": upstream_host, "port": upstream_port},
        "credentials": {"username": username, "password": password},
        "readyFile": str(ready_path),
    }

    args = _sidecar_subprocess_args("proxy-bridge")
    try:
        process = subprocess.Popen(  # noqa: S603 - command is this trusted sidecar executable/module.
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            close_fds=True,
            start_new_session=platform.system() != "Windows",
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if platform.system() == "Windows" else 0,
        )
    except OSError as exc:
        raise SidecarError(
            code=CHROMIUM_LAUNCH_FAILED,
            message="Chromium proxy bridge could not be started.",
        ) from exc

    try:
        assert process.stdin is not None
        with process.stdin as handle:
            handle.write(json.dumps(config_payload, ensure_ascii=False, sort_keys=True) + "\n")
        ready = _wait_for_proxy_bridge_ready(ready_path, process)
        return {
            "pid": process.pid,
            "port": ready,
            "readyFile": ready_path.relative_to(Path(store_root)).as_posix(),
        }
    except (SidecarError, OSError, ValueError) as exc:
        _stop_child_after_failed_launch(process.pid)
        if isinstance(exc, SidecarError):
            raise
        raise SidecarError(
            code=CHROMIUM_LAUNCH_FAILED,
            message="Chromium proxy bridge could not be started.",
        ) from exc


def _sidecar_subprocess_args(*args: str) -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, *args]
    return [sys.executable, "-m", "theprivator_sidecar", *args]


def _wait_for_proxy_bridge_ready(ready_path: Path, process: subprocess.Popen[Any]) -> int:
    deadline = time.monotonic() + PROXY_BRIDGE_READY_TIMEOUT_SECONDS
    while time.monotonic() <= deadline:
        if process.poll() is not None:
            break
        if ready_path.is_file():
            try:
                payload = json.loads(ready_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError, UnicodeDecodeError):
                payload = None
            if isinstance(payload, Mapping) and payload.get("bridgeVersion") == 1:
                host = payload.get("host")
                port = payload.get("port")
                if host == "127.0.0.1" and isinstance(port, int) and 1 <= port <= 65535:
                    return port
        time.sleep(0.025)
    raise SidecarError(
        code=CHROMIUM_LAUNCH_FAILED,
        message="Chromium proxy bridge did not become ready.",
    )


def _profile_runtime_key(profile_id: str) -> str:
    digest = hashlib.sha256(profile_id.encode("utf-8", errors="surrogatepass")).hexdigest()[:16]
    return f"profile-{digest}"


def _stop_proxy_bridge_pid(pid: Optional[int]) -> None:
    if pid is None:
        return
    try:
        _stop_process_tree(pid)
    except SidecarError:
        _reap_if_child(pid)


def _stop_proxy_bridge_for_record(store_root: Union[str, Path], record: RuntimeRecord) -> None:
    """Stop this record's bridge, but only once it is proved to still be ours.

    A pid on its own is not an identity. Reconciliation runs after reboots, when
    the OS has reused pids freely, so acting on a recorded pid alone can SIGKILL
    an unrelated process tree. The bridge holds an exclusive lock on its ready
    file for its whole life and the kernel releases it on death, so being unable
    to take that lock is what proves the recorded pid is still the bridge.
    """
    if record.proxy_bridge_pid is None:
        return
    if not _proxy_bridge_is_still_ours(store_root, record):
        return
    _stop_proxy_bridge_pid(record.proxy_bridge_pid)


def _proxy_bridge_is_still_ours(store_root: Union[str, Path], record: RuntimeRecord) -> bool:
    if record.proxy_bridge_ready_file is None:
        # Written before ownership was recorded. Refusing to kill risks leaving an
        # orphan; killing risks taking down someone else's process tree. The
        # orphan is the recoverable one, and these records age out on their own.
        return False

    ready_path = Path(store_root) / record.proxy_bridge_ready_file
    try:
        payload = json.loads(ready_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        # No ready file means the bridge is gone and took its lock with it.
        return False
    if not isinstance(payload, Mapping) or payload.get("pid") != record.proxy_bridge_pid:
        return False

    return _ready_file_is_locked(ready_path)


def _ready_file_is_locked(path: Path) -> bool:
    """Return whether some process still holds the bridge's ready-file lock."""
    try:
        handle = open(path, "r+", encoding="utf-8")
    except OSError:
        return False
    try:
        if os.name == "posix":
            import fcntl

            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return True  # someone still holds it: the bridge is alive
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            return False
        if os.name == "nt":
            import msvcrt

            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                return True
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            return False
    except ImportError:
        # No locking primitive available. The recorded pid matched the one the
        # bridge wrote into its own ready file, which is the best evidence left.
        return True
    finally:
        handle.close()
    return True


def _runtime_launch_args(
    identity_plan: IdentityRuntimePlan,
    extension_artifact: Optional[IdentityExtensionArtifact],
    proxy_auth_artifact: Optional[ProxyAuthExtensionArtifact],
    *,
    force_remote_debugging: bool = False,
) -> list[str]:
    args: list[str] = []
    args.extend(
        _extension_launch_args(
            [
                artifact.extension_dir
                for artifact in (extension_artifact, proxy_auth_artifact)
                if artifact is not None
            ]
        )
    )
    if force_remote_debugging or identity_plan.requires_cdp:
        args.extend([_REMOTE_DEBUGGING_ARG, _REMOTE_ALLOW_ORIGINS_ARG])
    args.extend(identity_plan.launch_flags)
    return _validate_extra_launch_args(args)


def _extension_launch_args(extension_dirs: Sequence[Union[str, Path]]) -> list[str]:
    safe_paths: list[str] = []
    for extension_dir in extension_dirs:
        safe_path = _validate_extension_arg_path(extension_dir)
        if safe_path not in safe_paths:
            safe_paths.append(safe_path)
    if not safe_paths:
        return []
    value = ",".join(safe_paths)
    return [
        f"{_LOAD_EXTENSION_PREFIX}{value}",
        f"{_DISABLE_EXTENSIONS_EXCEPT_PREFIX}{value}",
    ]


def _validate_extra_launch_args(args: Sequence[str]) -> list[str]:
    safe_args: list[str] = []
    for arg in args:
        if not isinstance(arg, str) or not arg:
            raise SidecarError(
                code=CHROMIUM_LAUNCH_FAILED,
                message="Chromium launch arguments could not be prepared.",
            )
        if arg in {_REMOTE_DEBUGGING_ARG, _REMOTE_ALLOW_ORIGINS_ARG} or arg in _ALLOWED_IDENTITY_LAUNCH_FLAGS:
            safe_args.append(arg)
            continue
        if arg.startswith(PROXY_SERVER_ARG_PREFIX):
            safe_args.append(validate_proxy_server_launch_arg(arg))
            continue
        if _is_allowed_proxy_proof_trust_arg(arg):
            safe_args.append(arg)
            continue
        if is_rejected_launch_switch(arg):
            raise SidecarError(
                code=PROXY_LAUNCH_ARG_UNSAFE,
                message="Chromium proxy launch arguments could not be prepared.",
            )
        if _is_allowed_identity_value_arg(arg):
            safe_args.append(arg)
            continue
        if arg.startswith(_LOAD_EXTENSION_PREFIX) or arg.startswith(_DISABLE_EXTENSIONS_EXCEPT_PREFIX):
            _validate_extension_arg_paths(arg.split("=", 1)[1])
            safe_args.append(arg)
            continue
        raise SidecarError(
            code=CHROMIUM_LAUNCH_FAILED,
            message="Chromium launch arguments could not be prepared.",
        )
    return safe_args


def _proxy_proof_trust_args() -> list[str]:
    if os.environ.get(PROXY_PROOF_TRUST_ENABLED_ENV) != "1":
        return []
    pin = os.environ.get(PROXY_PROOF_SPKI_SHA256_ENV, "").strip()
    if not _is_valid_spki_pin(pin):
        raise SidecarError(
            code=PROXY_PROOF_FAILED,
            message="Proxy proof trust metadata could not be prepared.",
        )
    return [f"{_PROXY_PROOF_SPKI_ARG_PREFIX}{pin}"]


def _is_allowed_proxy_proof_trust_arg(arg: str) -> bool:
    if not isinstance(arg, str) or not arg.startswith(_PROXY_PROOF_SPKI_ARG_PREFIX):
        return False
    if os.environ.get(PROXY_PROOF_TRUST_ENABLED_ENV) != "1":
        return False
    pin = arg[len(_PROXY_PROOF_SPKI_ARG_PREFIX) :]
    expected_pin = os.environ.get(PROXY_PROOF_SPKI_SHA256_ENV, "").strip()
    return pin == expected_pin and _is_valid_spki_pin(pin)


def _is_valid_spki_pin(value: str) -> bool:
    if not isinstance(value, str) or not value or len(value) > 128:
        return False
    if "\x00" in value or any(character.isspace() for character in value):
        return False
    try:
        decoded = base64.b64decode(value, validate=True)
    except Exception:
        return False
    return len(decoded) == 32


def _is_allowed_identity_value_arg(arg: str) -> bool:
    if "\x00" in arg or any(ord(character) < 32 for character in arg):
        return False
    for prefix in _ALLOWED_IDENTITY_VALUE_ARG_PREFIXES:
        if not arg.startswith(prefix):
            continue
        value = arg[len(prefix):]
        if not value or len(value) > 512:
            return False
        if prefix == "--window-size=":
            parts = value.split(",")
            if len(parts) != 2 or not all(part.isdecimal() for part in parts):
                return False
            return all(1 <= int(part) <= 10_000 for part in parts)
        if prefix == "--force-device-scale-factor=":
            try:
                number = float(value)
            except ValueError:
                return False
            return 0.25 <= number <= 8.0
        return True
    return False


def _validate_extension_arg_paths(value: str) -> None:
    if not isinstance(value, str) or not value:
        _raise_launch_arg_error()
    paths = value.split(",")
    if not paths or any(not path for path in paths):
        _raise_launch_arg_error()
    for path in paths:
        _validate_extension_arg_path(path)


def _validate_extension_arg_path(value: Union[str, Path]) -> str:
    try:
        raw_value = str(value)
        path = Path(raw_value)
    except TypeError as exc:
        raise SidecarError(
            code=CHROMIUM_LAUNCH_FAILED,
            message="Chromium launch arguments could not be prepared.",
        ) from exc
    if (
        not raw_value
        or not path.is_absolute()
        or not path.is_dir()
        or "\x00" in raw_value
        or "," in raw_value
        or any(ord(character) < 32 for character in raw_value)
    ):
        _raise_launch_arg_error()
    return raw_value


def _raise_launch_arg_error() -> None:
    raise SidecarError(
        code=CHROMIUM_LAUNCH_FAILED,
        message="Chromium launch arguments could not be prepared.",
    )


def discover_devtools_endpoint(user_data_dir: Union[str, Path], **kwargs: Any) -> Any:
    """Lazy CDP discovery wrapper so non-CDP sidecar commands do not require CDP deps."""
    try:
        from .cdp import discover_devtools_endpoint as _discover_devtools_endpoint
    except Exception as exc:
        raise SidecarError(
            code=IDENTITY_CDP_FAILED,
            message="Identity CDP operation failed.",
        ) from exc
    return _discover_devtools_endpoint(user_data_dir, **kwargs)


def apply_identity_cdp_overrides(endpoint_or_url: Any, overrides: Mapping[str, Any], **kwargs: Any) -> JsonObject:
    """Lazy CDP apply wrapper that collapses dependency/import failures safely."""
    try:
        from .cdp import apply_identity_cdp_overrides as _apply_identity_cdp_overrides
    except Exception as exc:
        raise SidecarError(
            code=IDENTITY_CDP_FAILED,
            message="Identity CDP operation failed.",
        ) from exc
    return _apply_identity_cdp_overrides(endpoint_or_url, overrides, **kwargs)


def create_audit_page_target_endpoint(endpoint: Any, **kwargs: Any) -> Any:
    """Lazy CDP target wrapper for audit-specific exact public URL opens."""
    try:
        from .cdp import create_page_target_endpoint as _create_page_target_endpoint
    except Exception as exc:
        raise SidecarError(
            code=IDENTITY_CDP_FAILED,
            message="Identity CDP operation failed.",
        ) from exc
    return _create_page_target_endpoint(endpoint, **kwargs)


def close_audit_page_target(endpoint: Any, target_id: str, **kwargs: Any) -> JsonObject:
    """Lazy CDP close wrapper for audit-created page targets."""
    try:
        from .cdp import close_page_target as _close_page_target
    except Exception as exc:
        raise SidecarError(
            code=IDENTITY_CDP_FAILED,
            message="Identity CDP operation failed.",
        ) from exc
    return _close_page_target(endpoint, target_id, **kwargs)


def capture_audit_page_text(page_endpoint: Any, **kwargs: Any) -> Any:
    """Lazy CDP runtime wrapper for bounded public audit page capture."""
    try:
        from .cdp import CdpClient, runtime_evaluate
    except Exception as exc:
        raise SidecarError(
            code=IDENTITY_CDP_FAILED,
            message="Identity CDP operation failed.",
        ) from exc
    url = getattr(page_endpoint, "web_socket_debugger_url", None)
    if not isinstance(url, str):
        raise SidecarError(
            code=IDENTITY_CDP_FAILED,
            message="Identity CDP operation failed.",
        )
    with CdpClient(url, timeout_seconds=kwargs.get("timeout_seconds", AUDIT_RESULT_CAPTURE_TIMEOUT_SECONDS)) as client:
        return runtime_evaluate(
            client,
            kwargs["expression"],
            timeout_seconds=kwargs.get("timeout_seconds", AUDIT_RESULT_CAPTURE_TIMEOUT_SECONDS),
        )


@dataclass(frozen=True)
class LaunchOutcome:
    """Result of one registered Chromium launch."""

    record: RuntimeRecord
    running_count: int
    endpoint_result: Any = None


def _launch_registered(
    store_root: Union[str, Path],
    profile: ProfileRecord,
    identity_plan: IdentityRuntimePlan,
    proxy_plan: ProxyRuntimePlan,
    *,
    active: Mapping[str, RuntimeRecord],
    registry: RuntimeRegistry,
    error_code: str,
    force_remote_debugging: bool = False,
    discovery_timeout_seconds: float = IDENTITY_CDP_DISCOVERY_TIMEOUT_SECONDS,
    after_endpoint: Optional[Callable[[Any], Any]] = None,
) -> LaunchOutcome:
    """Spawn Chromium, apply identity, and record it as running -- or roll back.

    This is the one place the launch sequence lives. It previously existed as four
    near-identical copies (plain launch, automation lease, audit open, audit
    collect) which had already drifted in which error code they reported, and
    which is how a single credential-leak fix had to be applied four times.

    The callers differ in only four ways, all parameters here: which error code
    labels a failure, whether DevTools is forced on, how long endpoint discovery
    may take, and what to do with the endpoint once it exists.
    """
    executable = discover_executable()
    user_data_path = resolve_user_data_path(store_root, profile)
    try:
        user_data_path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise SidecarError(
            code=CHROMIUM_LAUNCH_FAILED,
            message="Chromium user data directory could not be prepared.",
        ) from exc

    extension_artifact = _prepare_identity_extension(store_root, profile, identity_plan)
    proxy_auth_artifact = _prepare_proxy_auth_extension(store_root, profile, proxy_plan)
    proxy_runtime = _prepare_proxy_launch_runtime(store_root, profile, proxy_plan)
    owner_token = uuid.uuid4().hex
    args = build_launch_args(
        executable,
        user_data_path,
        "about:blank",
        extra_args=[
            *_runtime_launch_args(
                identity_plan,
                extension_artifact,
                proxy_auth_artifact,
                force_remote_debugging=force_remote_debugging,
            ),
            *proxy_runtime.launch_args,
            *_proxy_proof_trust_args(),
        ],
    )

    # A stale port file would make discovery read the previous session's port, so
    # it only matters when something is going to look. Plain launches of a profile
    # with no CDP overrides never do.
    needs_endpoint = force_remote_debugging or identity_plan.requires_cdp
    if needs_endpoint:
        _remove_stale_devtools_active_port(user_data_path, error_code=error_code)

    process: subprocess.Popen[Any] | None = None
    try:
        process = _spawn_chromium(args, owner_token=owner_token)
        time.sleep(LAUNCH_LIVENESS_SETTLE_SECONDS)
        if process.poll() is not None or not is_process_alive(process.pid):
            _reap_if_child(process.pid)
            raise SidecarError(
                code=CHROMIUM_LAUNCH_FAILED,
                message="Chromium exited before it could be registered as running.",
            )

        endpoint_result: Any = None
        if needs_endpoint:
            endpoint = discover_devtools_endpoint(
                user_data_path,
                timeout_seconds=discovery_timeout_seconds,
            )
            _apply_identity_cdp_to_endpoint_if_needed(identity_plan, endpoint)
            if after_endpoint is not None:
                endpoint_result = after_endpoint(endpoint)

        record = RuntimeRecord(
            profile_id=profile.id,
            pid=process.pid,
            started_at=utc_now_iso(),
            user_data_dir=profile.storage.userDataDir,
            owner_token=owner_token,
            proxy_bridge_pid=proxy_runtime.proxy_bridge_pid,
            proxy_bridge_ready_file=proxy_runtime.proxy_bridge_ready_file,
        )
        updated = dict(active)
        updated[profile.id] = record
        registry.write(updated, error_code=error_code)
    except SidecarError:
        if process is not None:
            _stop_child_after_failed_launch(process.pid)
        _stop_proxy_bridge_pid(proxy_runtime.proxy_bridge_pid)
        raise
    return LaunchOutcome(record=record, running_count=len(updated), endpoint_result=endpoint_result)


def _reconciled_active_records(
    registry: RuntimeRegistry,
    *,
    error_code: str,
) -> dict[str, RuntimeRecord]:
    """Read the registry, drop records whose process is gone, and persist that."""
    records = registry.read()
    active, _reconciled, changed = _reconcile_records(registry.store_root, records)
    if changed:
        registry.write(active, error_code=error_code)
    return active


def _reject_if_already_running(active: Mapping[str, RuntimeRecord], profile: ProfileRecord) -> None:
    existing = active.get(profile.id)
    if existing is not None and is_process_alive(existing.pid):
        raise SidecarError(
            code=CHROMIUM_ALREADY_RUNNING,
            message="Chromium is already running for this profile.",
        )



def _collect_identity_audit_results_for_running(
    store_root: Union[str, Path],
    profile: ProfileRecord,
    identity_plan: IdentityRuntimePlan,
    audit_pages: Sequence[JsonObject],
    *,
    audit_version: int,
    launched: bool,
    running_count: int,
) -> JsonObject:
    user_data_path = resolve_user_data_path(store_root, profile)
    try:
        endpoint = discover_devtools_endpoint(
            user_data_path,
            timeout_seconds=AUDIT_CDP_DISCOVERY_TIMEOUT_SECONDS,
        )
    except SidecarError as exc:
        if exc.code == IDENTITY_CDP_FAILED:
            raise SidecarError(
                code=IDENTITY_AUDIT_FAILED,
                message="Stop this profile and start the audit again so ThePrivator can attach its internal browser control endpoint.",
            ) from exc
        raise
    _apply_identity_cdp_to_endpoint_if_needed(identity_plan, endpoint)
    return _audit_collect_payload(
        profile,
        audit_pages,
        _collect_public_audit_targets(endpoint, audit_pages),
        audit_version=audit_version,
        launched=launched,
        running_count=running_count,
    )


def _launch_and_collect_identity_audit_results(
    store_root: Union[str, Path],
    profile: ProfileRecord,
    identity_plan: IdentityRuntimePlan,
    proxy_plan: ProxyRuntimePlan,
    audit_pages: Sequence[JsonObject],
    *,
    audit_version: int,
    active: Mapping[str, RuntimeRecord],
    registry: RuntimeRegistry,
) -> JsonObject:
    outcome = _launch_registered(
        store_root,
        profile,
        identity_plan,
        proxy_plan,
        active=active,
        registry=registry,
        error_code=IDENTITY_AUDIT_FAILED,
        force_remote_debugging=True,
        discovery_timeout_seconds=AUDIT_CDP_DISCOVERY_TIMEOUT_SECONDS,
        after_endpoint=lambda endpoint: _collect_public_audit_targets(endpoint, audit_pages),
    )
    return _audit_collect_payload(
        profile,
        audit_pages,
        outcome.endpoint_result,
        audit_version=audit_version,
        launched=True,
        running_count=outcome.running_count,
    )


def _open_identity_audit_page_for_running(
    store_root: Union[str, Path],
    profile: ProfileRecord,
    identity_plan: IdentityRuntimePlan,
    audit_page: JsonObject,
    *,
    audit_version: int,
    running_count: int,
) -> JsonObject:
    user_data_path = resolve_user_data_path(store_root, profile)
    try:
        endpoint = discover_devtools_endpoint(
            user_data_path,
            timeout_seconds=AUDIT_CDP_DISCOVERY_TIMEOUT_SECONDS,
        )
    except SidecarError as exc:
        if exc.code == IDENTITY_CDP_FAILED:
            raise SidecarError(
                code=IDENTITY_AUDIT_FAILED,
                message="Stop this profile and start the audit again so ThePrivator can attach its internal browser control endpoint.",
            ) from exc
        raise
    _apply_identity_cdp_to_endpoint_if_needed(identity_plan, endpoint)
    _open_public_audit_target(endpoint, audit_page)
    return _audit_open_payload(
        profile,
        audit_page,
        audit_version=audit_version,
        launched=False,
        running_count=running_count,
    )


def _launch_and_open_identity_audit_page(
    store_root: Union[str, Path],
    profile: ProfileRecord,
    identity_plan: IdentityRuntimePlan,
    proxy_plan: ProxyRuntimePlan,
    audit_page: JsonObject,
    *,
    audit_version: int,
    active: Mapping[str, RuntimeRecord],
    registry: RuntimeRegistry,
) -> JsonObject:
    outcome = _launch_registered(
        store_root,
        profile,
        identity_plan,
        proxy_plan,
        active=active,
        registry=registry,
        error_code=IDENTITY_AUDIT_FAILED,
        force_remote_debugging=True,
        discovery_timeout_seconds=AUDIT_CDP_DISCOVERY_TIMEOUT_SECONDS,
        after_endpoint=lambda endpoint: _open_public_audit_target(endpoint, audit_page),
    )
    return _audit_open_payload(
        profile,
        audit_page,
        audit_version=audit_version,
        launched=True,
        running_count=outcome.running_count,
    )


def _apply_identity_cdp_to_endpoint_if_needed(identity_plan: IdentityRuntimePlan, endpoint: Any) -> None:
    if not identity_plan.requires_cdp:
        return
    apply_identity_cdp_overrides(
        endpoint,
        identity_plan.cdp_overrides,
        timeout_seconds=IDENTITY_CDP_APPLY_TIMEOUT_SECONDS,
    )


def _handoff_origin_from_endpoint(endpoint: Any) -> str:
    port = getattr(endpoint, "port", None)
    if not isinstance(port, int) or port <= 0 or port > 65535:
        raise SidecarError(
            code=IDENTITY_CDP_FAILED,
            message="Identity CDP operation failed.",
        )
    return f"http://127.0.0.1:{port}"


def _open_public_audit_target(endpoint: Any, audit_page: Mapping[str, Any]) -> None:
    url = audit_page.get("url")
    if not isinstance(url, str) or not url:
        raise _audit_error()
    create_audit_page_target_endpoint(
        endpoint,
        target_url=url,
        allowed_public_urls={url},
        timeout_seconds=AUDIT_TARGET_OPEN_TIMEOUT_SECONDS,
    )


def _collect_public_audit_targets(endpoint: Any, audit_pages: Sequence[JsonObject]) -> list[JsonObject]:
    allowed_urls = {page["url"] for page in audit_pages if isinstance(page.get("url"), str)}
    return [_collect_public_audit_target(endpoint, page, allowed_urls=allowed_urls) for page in audit_pages]


def _collect_public_audit_target(endpoint: Any, audit_page: JsonObject, *, allowed_urls: set[str]) -> JsonObject:
    page_id = audit_page.get("id")
    label = audit_page.get("label")
    category = audit_page.get("category")
    url = audit_page.get("url")
    if not all(isinstance(value, str) and value for value in (page_id, label, category, url)):
        raise _audit_error()

    if audit_page.get("requiresUserAction") is True:
        return _audit_page_result(
            audit_page,
            status="needs-user-action",
            title="Manual test required",
            summary="Open this checker in the profile and start the site test before reading results.",
            rows=[],
            notes=["This site requires a user-started public test."],
        )

    target = None
    try:
        target = create_audit_page_target_endpoint(
            endpoint,
            target_url=url,
            allowed_public_urls=allowed_urls,
            timeout_seconds=AUDIT_TARGET_OPEN_TIMEOUT_SECONDS,
        )
        capture = capture_audit_page_text(
            target,
            expression=_audit_capture_expression(audit_page),
            timeout_seconds=AUDIT_RESULT_CAPTURE_TIMEOUT_SECONDS,
        )
        return _audit_capture_to_page_result(audit_page, capture)
    except SidecarError:
        return _audit_page_result(
            audit_page,
            status="unavailable",
            title="No result captured",
            summary="The checker could not be read safely in this profile session.",
            rows=[],
            notes=["Refresh after the profile finishes loading, or open the checker manually."],
        )
    finally:
        target_id = getattr(target, "target_id", None)
        if isinstance(target_id, str):
            try:
                close_audit_page_target(endpoint, target_id, timeout_seconds=1.0)
            except SidecarError:
                pass


def _audit_capture_expression(audit_page: Mapping[str, Any]) -> str:
    surfaces = audit_page.get("surfaces") if isinstance(audit_page.get("surfaces"), list) else []
    keyword_map = {
        "browser": ["user agent", "browser", "chrome", "chromium"],
        "clientHints": ["client hints", "platform", "architecture", "bitness", "mobile"],
        "navigator": ["navigator", "hardware", "device memory", "platform"],
        "screen": ["screen", "viewport", "resolution", "color depth"],
        "locale": ["language", "timezone", "locale", "intl"],
        "canvas": ["canvas", "hash", "signature"],
        "webgl": ["webgl", "vendor", "renderer", "gpu"],
        "audio": ["audio", "sample", "hash"],
        "webrtc": ["webrtc", "rtc", "candidate", "local ip", "public ip"],
    }
    keywords: list[str] = []
    for surface in surfaces:
        if isinstance(surface, str):
            keywords.extend(keyword_map.get(surface, []))
    if not keywords:
        keywords = ["fingerprint", "browser", "privacy"]
    keywords_json = json.dumps(sorted(set(keywords)), ensure_ascii=False)
    ready_wait = int(AUDIT_RESULT_READY_WAIT_MS)
    return f"""
(() => new Promise((resolve) => {{
  const KEYWORDS = {keywords_json};
  const MAX_ROWS = 14;
  const MAX_LINES = 8;
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const rows = [];
  const seen = new Set();
  const pushRow = (label, value) => {{
    const safeLabel = clean(label).slice(0, 96);
    const safeValue = clean(value).slice(0, 360);
    if (!safeLabel || !safeValue || safeLabel === safeValue) return;
    const key = `${{safeLabel}}\u0000${{safeValue}}`;
    if (seen.has(key) || rows.length >= MAX_ROWS) return;
    seen.add(key);
    rows.push({{ label: safeLabel, value: safeValue }});
  }};
  const collect = () => {{
    document.querySelectorAll("tr").forEach((row) => {{
      const cells = Array.from(row.querySelectorAll("th,td")).map((cell) => clean(cell.innerText));
      if (cells.length >= 2) pushRow(cells[0], cells.slice(1).join(" · "));
    }});
    document.querySelectorAll("dl").forEach((list) => {{
      const terms = Array.from(list.querySelectorAll("dt"));
      terms.forEach((term) => {{
        const value = term.nextElementSibling;
        if (value) pushRow(term.innerText, value.innerText);
      }});
    }});
    const lines = clean(document.body ? document.body.innerText : "")
      .split(/(?<=[.!?])\\s+|\\n+/)
      .map(clean)
      .filter((line) => line.length >= 8 && line.length <= 220);
    const summaryLines = [];
    for (const line of lines) {{
      const lowered = line.toLowerCase();
      if (KEYWORDS.some((keyword) => lowered.includes(keyword)) && !summaryLines.includes(line)) {{
        summaryLines.push(line);
      }}
      if (summaryLines.length >= MAX_LINES) break;
    }}
    resolve({{
      title: clean(document.title).slice(0, 140),
      readyState: document.readyState,
      rows,
      summaryLines,
    }});
  }};
  let settled = false;
  const settle = () => {{
    if (settled) return;
    settled = true;
    setTimeout(collect, 350);
  }};
  if (document.readyState === "complete" || document.readyState === "interactive") settle();
  else window.addEventListener("load", settle, {{ once: true }});
  setTimeout(settle, {ready_wait});
}}))
"""


def _audit_capture_to_page_result(audit_page: JsonObject, capture: Any) -> JsonObject:
    if not isinstance(capture, Mapping):
        return _audit_page_result(
            audit_page,
            status="unavailable",
            title="No result captured",
            summary="The checker returned no readable public result.",
            rows=[],
            notes=["Refresh after the public page finishes loading."],
        )
    rows = _audit_capture_rows(capture.get("rows"))
    summary_lines = _audit_capture_lines(capture.get("summaryLines"))
    title = _safe_audit_result_text(capture.get("title"), fallback="Checker result")
    summary = _safe_audit_result_text(" ".join(summary_lines[:2]), fallback="Loaded, but no matching result text was found.", max_length=420)
    notes = [] if rows or summary_lines else ["No matching fingerprint fields were found on the public page."]
    return _audit_page_result(
        audit_page,
        status="captured" if rows or summary_lines else "unavailable",
        title=title,
        summary=summary,
        rows=rows,
        notes=notes,
    )


def _audit_capture_rows(value: Any) -> list[JsonObject]:
    if not isinstance(value, list):
        return []
    rows: list[JsonObject] = []
    for item in value:
        if not isinstance(item, Mapping):
            continue
        label = _safe_audit_result_text(item.get("label"), fallback="")
        row_value = _safe_audit_result_text(item.get("value"), fallback="", max_length=420)
        if not label or not row_value:
            continue
        rows.append({"label": label, "value": row_value})
        if len(rows) >= 12:
            break
    return rows


def _audit_capture_lines(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    lines: list[str] = []
    for item in value:
        text = _safe_audit_result_text(item, fallback="", max_length=240)
        if text and text not in lines:
            lines.append(text)
        if len(lines) >= 6:
            break
    return lines


def _audit_page_result(
    audit_page: Mapping[str, Any],
    *,
    status: str,
    title: str,
    summary: str,
    rows: Sequence[Mapping[str, Any]],
    notes: Sequence[str],
) -> JsonObject:
    page_id = audit_page.get("id")
    label = audit_page.get("label")
    category = audit_page.get("category")
    url = audit_page.get("url")
    if not all(isinstance(value, str) and value for value in (page_id, label, category, url)):
        raise _audit_error()
    return {
        "id": page_id,
        "label": label,
        "category": category,
        "url": url,
        "status": status,
        "capturedAt": utc_now_iso(),
        "title": _safe_audit_result_text(title, fallback="Checker result"),
        "summary": _safe_audit_result_text(summary, fallback="No readable public result was captured.", max_length=420),
        "extractedRows": [dict(row) for row in rows][:12],
        "notes": [_safe_audit_result_text(note, fallback="Audit note", max_length=180) for note in notes[:4]],
    }


# Must stay a superset of the TypeScript client's containsUnsafeAuditText reject
# list (src/sidecar/client.ts). The client independently hard-rejects unsafe audit
# copy, and it rejects the *whole* nine-page snapshot -- so a marker this side
# fails to redact does not leak, it destroys the entire audit result. The two
# lists having drifted is exactly how that happened.
# test_identity_audit.py::test_python_audit_redaction_covers_the_client_reject_list
# parses the client's list and proves the superset relation mechanically.
_AUDIT_FORBIDDEN_MARKERS = (
    "DevToolsActivePort",
    "remote-debugging-port",
    "debug port",
    "websocket",
    "target id",
    "targetId",
    "raw argv",
    "user-data-dir",
    "profile-store",
    "Traceback",
    "proxy username",
    "proxy password",
    "proxy-username",
    "proxy-password",
    "proxyusername",
    "proxypassword",
    "proxy_user",
    "proxy_pass",
    "proxyuser",
    "proxypass",
    "authcredentials",
    "credentials",
    "username=",
    "password=",
    "token=",
    "secret=",
    # Marketing absolutes a checker page might carry. Neither side may repeat a
    # claim this product deliberately never makes.
    "guaranteed undetectability",
    "guaranteed green",
    "guaranteed pass",
)


def _safe_audit_result_text(value: Any, *, fallback: str, max_length: int = 160) -> str:
    if not isinstance(value, str):
        value = fallback
    text = value.strip() or fallback
    text = re.sub(r"\s+", " ", text)
    # Schemes are redacted with the separator, and without requiring a path after
    # it: a bare "ws://" is itself one of the client's reject markers.
    text = re.sub(r"\b(?:file|ws|wss)://\S*", "[redacted]", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(?:127\.0\.0\.1|0\.0\.0\.0|localhost)\b", "[redacted]", text, flags=re.IGNORECASE)
    text = re.sub(r":(?:[0-9]{2,5})\b", ":[redacted]", text)
    text = re.sub(r"(?:/[A-Za-z0-9._-]+){2,}", "[redacted]", text)
    # Windows drive paths, which the POSIX-path rule above cannot match.
    text = re.sub(r"\b[A-Za-z]:[\\/]\S*", "[redacted]", text)
    for marker in _AUDIT_FORBIDDEN_MARKERS:
        text = re.sub(re.escape(marker), "[redacted]", text, flags=re.IGNORECASE)
    text = "".join(character for character in text if ord(character) >= 32 and ord(character) != 127)
    return text[:max_length].strip() or fallback


def _audit_collect_payload(
    profile: ProfileRecord,
    audit_pages: Sequence[JsonObject],
    page_results: Sequence[JsonObject],
    *,
    audit_version: int,
    launched: bool,
    running_count: int,
) -> JsonObject:
    if len(page_results) != len(audit_pages):
        raise _audit_error()
    return {
        "auditVersion": audit_version,
        "profileId": profile.id,
        "status": "collected",
        "collectedAt": utc_now_iso(),
        "launched": launched,
        "runningCount": running_count,
        "pages": [dict(page) for page in page_results],
    }


def _audit_open_payload(
    profile: ProfileRecord,
    audit_page: JsonObject,
    *,
    audit_version: int,
    launched: bool,
    running_count: int,
) -> JsonObject:
    page_id = audit_page.get("id")
    if not isinstance(page_id, str) or not page_id:
        raise _audit_error()
    return {
        "auditVersion": audit_version,
        "profileId": profile.id,
        "pageId": page_id,
        "status": "opened",
        "openedAt": utc_now_iso(),
        "launched": launched,
        "runningCount": running_count,
        "page": dict(audit_page),
    }


def _safe_audit_page_metadata(page: Mapping[str, Any]) -> JsonObject:
    if not isinstance(page, Mapping):
        raise _audit_error()
    allowed_keys = {
        "id",
        "label",
        "category",
        "url",
        "surfaces",
        "comparisonNote",
        "requiresUserAction",
        "expectedRows",
    }
    if set(page) - allowed_keys:
        raise _audit_error()
    page_id = page.get("id")
    url = page.get("url")
    if not isinstance(page_id, str) or not page_id.strip() or not isinstance(url, str) or not url.strip():
        raise _audit_error()
    return _json_safe_page_metadata({key: page[key] for key in allowed_keys if key in page})


def _json_safe_page_metadata(page: Mapping[str, Any]) -> JsonObject:
    try:
        copied = json.loads(json.dumps(page, ensure_ascii=False, allow_nan=False, sort_keys=True))
    except (TypeError, ValueError) as exc:
        raise _audit_error() from exc
    if not isinstance(copied, dict):
        raise _audit_error()
    return copied


def _remove_stale_devtools_active_port(user_data_path: Path, *, error_code: str) -> None:
    active_port_path = user_data_path / _DEVTOOLS_ACTIVE_PORT_FILE
    try:
        active_port_path.unlink()
    except FileNotFoundError:
        return
    except OSError as exc:
        raise SidecarError(
            code=error_code,
            message="Chromium internal browser-control startup state could not be prepared.",
        ) from exc



def _audit_error() -> SidecarError:
    return SidecarError(
        code=IDENTITY_AUDIT_FAILED,
        message="Identity audit could not be opened.",
    )


def _stop_child_after_failed_launch(pid: int) -> None:
    try:
        _stop_process_tree(pid)
    except SidecarError:
        _reap_if_child(pid)



def resolve_user_data_path(store_root: Union[str, Path], profile: ProfileRecord) -> Path:
    """Resolve a profile's relative user-data dir underneath the app-data root."""
    relative_path = profile.storage.userDataDir
    if not _is_safe_relative_posix_path(relative_path):
        raise SidecarError(
            code=CHROMIUM_LAUNCH_FAILED,
            message="Profile storage path is invalid.",
        )

    root = Path(store_root).resolve()
    candidate = root.joinpath(*PurePosixPath(relative_path).parts).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise SidecarError(
            code=CHROMIUM_LAUNCH_FAILED,
            message="Profile storage path is invalid.",
        ) from exc
    return candidate



def is_process_alive(pid: int) -> bool:
    """Check a tracked PID without scanning global Chromium processes."""
    if not isinstance(pid, int) or pid <= 0:
        return False
    if HAS_PSUTIL:
        try:
            if not psutil.pid_exists(pid):  # type: ignore[union-attr]
                return False
            process = psutil.Process(pid)  # type: ignore[union-attr]
            return process.is_running() and process.status() != psutil.STATUS_ZOMBIE  # type: ignore[union-attr]
        except psutil.NoSuchProcess:  # type: ignore[union-attr]
            return False
        except psutil.AccessDenied:  # type: ignore[union-attr]
            return True
        except psutil.ZombieProcess:  # type: ignore[union-attr]
            return False

    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False



def _load_profile(store_root: Union[str, Path], profile_id: str) -> ProfileRecord:
    if not isinstance(profile_id, str) or not profile_id.strip():
        raise SidecarError(
            code=INVALID_REQUEST,
            message="Chromium profileId is required.",
        )
    return ProfileStore(store_root).get(profile_id)



def _spawn_chromium(args: Iterable[str], *, owner_token: str) -> subprocess.Popen[Any]:
    env = os.environ.copy()
    env["THEPRIVATOR_CHROMIUM_OWNER"] = owner_token
    try:
        if platform.system() == "Windows":
            creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            return subprocess.Popen(  # noqa: S603 - executable path is sidecar-discovered, args are fixed.
                list(args),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=env,
                creationflags=creation_flags,
            )
        return subprocess.Popen(  # noqa: S603 - executable path is sidecar-discovered, args are fixed.
            list(args),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
            start_new_session=True,
        )
    except OSError as exc:
        raise SidecarError(
            code=CHROMIUM_LAUNCH_FAILED,
            message="Chromium process could not be started.",
        ) from exc



def _stop_process_tree(pid: int) -> str:
    if HAS_PSUTIL:
        return _stop_process_tree_with_psutil(pid)
    return _stop_process_tree_without_psutil(pid)



def _stop_process_tree_with_psutil(pid: int) -> str:
    try:
        parent = psutil.Process(pid)  # type: ignore[union-attr]
    except psutil.NoSuchProcess:  # type: ignore[union-attr]
        return "reconciled"

    if not is_process_alive(pid):
        return "reconciled"

    try:
        children = parent.children(recursive=True)
    except (psutil.NoSuchProcess, psutil.AccessDenied):  # type: ignore[union-attr]
        children = []
    targets = [*children, parent]

    for process in targets:
        _quiet_psutil_call(process.terminate)
    gone, alive = psutil.wait_procs(targets, timeout=GRACEFUL_STOP_TIMEOUT_SECONDS)  # type: ignore[union-attr]
    alive = [process for process in alive if _psutil_process_alive(process)]
    if not alive:
        _reap_if_child(pid)
        return "graceful"

    for process in alive:
        _quiet_psutil_call(process.kill)
    _gone, still_alive = psutil.wait_procs(alive, timeout=FORCE_STOP_TIMEOUT_SECONDS)  # type: ignore[union-attr]
    still_alive = [process for process in still_alive if _psutil_process_alive(process)]
    if still_alive:
        raise SidecarError(
            code=CHROMIUM_STOP_FAILED,
            message="Chromium process could not be stopped.",
        )

    _reap_if_child(pid)
    return "forced"



def _stop_process_tree_without_psutil(pid: int) -> str:
    if not is_process_alive(pid):
        return "reconciled"
    try:
        if platform.system() == "Windows":
            subprocess.run(
                ["taskkill", "/T", "/PID", str(pid)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=GRACEFUL_STOP_TIMEOUT_SECONDS,
                check=False,
            )
        else:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
    except OSError:
        if not is_process_alive(pid):
            return "reconciled"
    except subprocess.TimeoutExpired:
        pass

    if _wait_until_dead(pid, GRACEFUL_STOP_TIMEOUT_SECONDS):
        _reap_if_child(pid)
        return "graceful"

    try:
        if platform.system() == "Windows":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=FORCE_STOP_TIMEOUT_SECONDS,
                check=False,
            )
        else:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
    except OSError:
        if not is_process_alive(pid):
            _reap_if_child(pid)
            return "forced"
    except subprocess.TimeoutExpired:
        pass

    if _wait_until_dead(pid, FORCE_STOP_TIMEOUT_SECONDS):
        _reap_if_child(pid)
        return "forced"

    raise SidecarError(
        code=CHROMIUM_STOP_FAILED,
        message="Chromium process could not be stopped.",
    )



def _reconcile_records(
    store_root: Union[str, Path],
    records: Mapping[str, RuntimeRecord],
) -> Tuple[Dict[str, RuntimeRecord], list[JsonObject], bool]:
    """Drop records whose browser is gone, stopping each one's proxy bridge.

    Previously took a known_profiles filter that no caller ever passed, so the
    branch that pruned records for deleted profiles was dead code.
    """
    active: Dict[str, RuntimeRecord] = {}
    reconciled: list[JsonObject] = []
    changed = False
    for profile_id, record in sorted(records.items(), key=lambda item: item[0]):
        if is_process_alive(record.pid):
            active[profile_id] = record
        else:
            _stop_proxy_bridge_for_record(store_root, record)
            reconciled.append(_reconciled_payload(record))
            changed = True
    return active, reconciled, changed



def _status_payload(records: Mapping[str, RuntimeRecord], reconciled: list[JsonObject]) -> JsonObject:
    profiles = [_running_payload(record) for _profile_id, record in sorted(records.items())]
    return {
        "runningCount": len(profiles),
        "profiles": profiles,
        "reconciled": reconciled,
    }



def _running_payload(record: RuntimeRecord) -> JsonObject:
    return {
        "profileId": record.profile_id,
        "status": "running",
        "pid": record.pid,
        "startedAt": record.started_at,
        "userDataDir": record.user_data_dir,
    }



def _stopped_payload(profile: ProfileRecord, *, termination: str, running_count: int) -> JsonObject:
    return {
        "profileId": profile.id,
        "status": "stopped",
        "stoppedAt": utc_now_iso(),
        "termination": termination,
        "runningCount": running_count,
        "userDataDir": profile.storage.userDataDir,
    }



def _reconciled_payload(record: RuntimeRecord) -> JsonObject:
    return {
        "profileId": record.profile_id,
        "status": "stopped",
        "stoppedAt": utc_now_iso(),
        "termination": "reconciled",
        "userDataDir": record.user_data_dir,
    }



def _active_count(records: Mapping[str, RuntimeRecord]) -> int:
    return sum(1 for record in records.values() if is_process_alive(record.pid))



def _is_executable_file(path: Path) -> bool:
    try:
        return path.is_file() and (platform.system() == "Windows" or os.access(path, os.X_OK))
    except OSError:
        return False



def _is_safe_relative_posix_path(value: str) -> bool:
    try:
        path = PurePosixPath(value)
    except TypeError:
        return False
    return bool(value) and not path.is_absolute() and ".." not in path.parts



def _quiet_psutil_call(callback: Any) -> None:
    try:
        callback()
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):  # type: ignore[union-attr]
        return



def _psutil_process_alive(process: Any) -> bool:
    try:
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE  # type: ignore[union-attr]
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):  # type: ignore[union-attr]
        return False



def _wait_until_dead(pid: int, timeout_seconds: float) -> bool:
    deadline = time.monotonic() + max(timeout_seconds, 0)
    while time.monotonic() <= deadline:
        if not is_process_alive(pid):
            return True
        if _reap_if_child(pid):
            return True
        time.sleep(0.025)
    return not is_process_alive(pid) or _reap_if_child(pid)



def _reap_if_child(pid: int) -> bool:
    if platform.system() == "Windows":
        return False
    try:
        reaped_pid, _status = os.waitpid(pid, os.WNOHANG)
        return reaped_pid == pid
    except ChildProcessError:
        return False
    except OSError:
        return False


__all__ = [
    "CHROMIUM_EXECUTABLE_NAMES",
    "PROXY_PROOF_SPKI_SHA256_ENV",
    "PROXY_PROOF_TRUST_ENABLED_ENV",
    "GRACEFUL_STOP_TIMEOUT_SECONDS",
    "FORCE_STOP_TIMEOUT_SECONDS",
    "LAUNCH_LIVENESS_SETTLE_SECONDS",
    "RuntimeRegistry",
    "RuntimeRecord",
    "build_launch_args",
    "discover_executable",
    "ensure_profile_stopped_for_portability",
    "is_process_alive",
    "launch",
    "launch_for_automation",
    "open_identity_audit_page",
    "resolve_user_data_path",
    "status",
    "stop",
]
