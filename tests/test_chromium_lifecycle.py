"""Tests for the sidecar Chromium lifecycle registry and process contract."""

import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping

import pytest

from theprivator_sidecar import chromium
from theprivator_sidecar.cdp import CdpEndpoint
from theprivator_sidecar.identity import curated_preset
from theprivator_sidecar.profiles import ProfileStore
from theprivator_sidecar.proxy_proof import HttpsProxyCertificateStrategy
from theprivator_sidecar.protocol import (
    CHROMIUM_ALREADY_RUNNING,
    CHROMIUM_EXECUTABLE_NOT_FOUND,
    CHROMIUM_LAUNCH_FAILED,
    CHROMIUM_STOP_FAILED,
    IDENTITY_AUDIT_FAILED,
    IDENTITY_CDP_FAILED,
    IDENTITY_EXTENSION_FAILED,
    INVALID_REQUEST,
    PROFILE_NOT_FOUND,
    PROXY_AUTH_HELPER_FAILED,
    PROXY_LAUNCH_ARG_UNSAFE,
    PROXY_PROOF_FAILED,
    SidecarError,
)


def make_fake_chromium(tmp_path: Path) -> Path:
    """Create a tiny executable that behaves like a long-lived browser process."""
    script = tmp_path / "fake-chromium"
    script.write_text(
        "\n".join(
            [
                f"#!{sys.executable}",
                "import json",
                "import os",
                "import signal",
                "import sys",
                "import time",
                "capture = os.environ.get('THEPRIVATOR_FAKE_CHROMIUM_ARGV')",
                "if capture:",
                "    with open(capture, 'w', encoding='utf-8') as handle:",
                "        json.dump(sys.argv, handle)",
                "if os.environ.get('THEPRIVATOR_FAKE_CHROMIUM_EXIT_IMMEDIATELY') == '1':",
                "    sys.exit(23)",
                "def handle_term(signum, frame):",
                "    if os.environ.get('THEPRIVATOR_FAKE_CHROMIUM_IGNORE_TERM') == '1' and signum == signal.SIGTERM:",
                "        return",
                "    raise SystemExit(0)",
                "signal.signal(signal.SIGTERM, handle_term)",
                "while True:",
                "    time.sleep(0.1)",
                "",
            ]
        ),
        encoding="utf-8",
    )
    script.chmod(0o755)
    return script


def create_profile(tmp_path: Path, name: str = "Research") -> Mapping[str, Any]:
    return ProfileStore(tmp_path).create(name)["profile"]


def authenticated_http_proxy(protocol: str = "http") -> Mapping[str, Any]:
    return {
        "proxyVersion": 1,
        "mode": "fixedServer",
        "protocol": protocol,
        "host": "proxy.example.invalid",
        "port": 18080 if protocol == "http" else 18443,
        "credentials": {
            "username": "proxy-auth-user-sentinel",
            "password": "proxy-auth-password-sentinel",
        },
    }


def audit_page_payload(page_id: str = "browserleaks-webgl") -> Mapping[str, Any]:
    return {
        "id": page_id,
        "label": "BrowserLeaks WebGL",
        "category": "browserleaks",
        "url": "https://browserleaks.com/webgl",
        "surfaces": ["webgl"],
        "comparisonNote": "Compare WebGL values manually.",
        "requiresUserAction": False,
        "expectedRows": [
            {
                "surface": "webgl",
                "label": "WebGL",
                "expected": "Real host WebGL vendor and renderer values.",
                "guidance": "Compare visible vendor and renderer strings when exposed.",
            }
        ],
    }


def assert_sidecar_error(exc_info: pytest.ExceptionInfo[SidecarError], code: str) -> SidecarError:
    error = exc_info.value
    assert error.code == code
    assert error.recoverable is True
    assert error.detail_ref.startswith("sidecar-")
    assert "Traceback" not in error.message
    return error


def read_profiles_payload(store_root: Path) -> Mapping[str, Any]:
    return json.loads((store_root / "profile-store" / "profiles.json").read_text(encoding="utf-8"))


def assert_no_runtime_truth(profile: Mapping[str, Any]) -> None:
    forbidden = {
        "pid",
        "process",
        "command",
        "status",
        "running",
        "stoppedAt",
        "startedAt",
        "termination",
    }
    assert forbidden.isdisjoint(profile.keys())


CHROMIUM_PUBLIC_FORBIDDEN_MARKERS = (
    "proxy-auth-user-sentinel",
    "proxy-auth-password-sentinel",
    "Proxy-Authorization",
    "proxy-authorization",
    "authCredentials",
    "--proxy-server",
    "--load-extension",
    "--disable-extensions-except",
    "--remote-debugging-port",
    "DevToolsActivePort",
    "ws://",
    "wss://",
    "proxy-auth-extensions",
    "identity-extensions",
    "Traceback",
)

AUTOMATION_HANDOFF_FORBIDDEN_MARKERS = (
    *CHROMIUM_PUBLIC_FORBIDDEN_MARKERS,
    "debugPort",
    "debug-port",
    "webSocketDebuggerUrl",
    "devtools/browser",
    "ownerToken",
    "owner_token",
    "THEPRIVATOR_CHROMIUM_OWNER",
    "--user-data-dir",
    "profile-store/",
    "chromium-processes.json",
)


def assert_automation_handoff_payload_is_safe(
    payload: Mapping[str, Any],
    *,
    profile_id: str,
    expected_origin: str,
    running_count: int,
    store_root: Path,
) -> str:
    assert set(payload) == {"profileId", "status", "startedAt", "runningCount", "handoffOrigin"}
    assert payload["profileId"] == profile_id
    assert payload["status"] == "running"
    assert payload["startedAt"].endswith("Z")
    assert payload["runningCount"] == running_count
    assert payload["handoffOrigin"] == expected_origin
    assert expected_origin.startswith("http://127.0.0.1:")
    assert "/" not in expected_origin.removeprefix("http://127.0.0.1:")

    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    assert str(store_root) not in encoded
    for marker in AUTOMATION_HANDOFF_FORBIDDEN_MARKERS:
        assert marker not in encoded
    return encoded


def assert_chromium_payload_omits_forbidden_markers(
    payload: Any,
    *,
    extra_forbidden: tuple[str, ...] = (),
) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    for marker in (*CHROMIUM_PUBLIC_FORBIDDEN_MARKERS, *extra_forbidden):
        assert marker not in encoded
    return encoded


def assert_composed_extension_allowlist(argv: list[str]) -> list[Path]:
    load_extension_args = [arg for arg in argv if arg.startswith("--load-extension=")]
    disable_except_args = [arg for arg in argv if arg.startswith("--disable-extensions-except=")]
    assert len(load_extension_args) == 1
    assert len(disable_except_args) == 1
    load_value = load_extension_args[0].split("=", 1)[1]
    assert load_value == disable_except_args[0].split("=", 1)[1]

    extension_dirs = [Path(value) for value in load_value.split(",")]
    assert len(extension_dirs) == 2
    assert len({str(path) for path in extension_dirs}) == 2

    identity_dirs = [path for path in extension_dirs if "identity-extensions" in path.parts]
    proxy_auth_dirs = [path for path in extension_dirs if "proxy-auth-extensions" in path.parts]
    assert len(identity_dirs) == 1
    assert len(proxy_auth_dirs) == 1
    assert (identity_dirs[0] / "manifest.json").is_file()
    assert (identity_dirs[0] / "identity_config.js").is_file()
    assert (identity_dirs[0] / "identity_protector.js").is_file()
    assert (proxy_auth_dirs[0] / "manifest.json").is_file()
    assert (proxy_auth_dirs[0] / "proxy_auth_config.js").is_file()
    assert (proxy_auth_dirs[0] / "proxy_auth_worker.js").is_file()
    return extension_dirs


def test_socks5_proxy_credentials_launch_uses_auth_helper_without_argv_secret_leak(tmp_path, monkeypatch):
    profile = create_profile(tmp_path)
    ProfileStore(tmp_path).update_proxy(
        profile["id"],
        {
            "proxyVersion": 1,
            "mode": "fixedServer",
            "protocol": "socks5",
            "host": "proxy.example.invalid",
            "port": 9050,
            "credentials": {
                "username": "proxy-user-sentinel-e2e33f73",
                "password": "proxy-password-sentinel-74d86415",
            },
        },
    )
    fake_chromium = make_fake_chromium(tmp_path)
    argv_capture = tmp_path / "argv.json"
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_ARGV", str(argv_capture))

    launch = chromium.launch(tmp_path, profile["id"])

    try:
        assert launch["status"] == "running"
        argv = json.loads(argv_capture.read_text(encoding="utf-8"))
        joined = "\n".join(argv)
        proxy_args = [arg for arg in argv if arg.startswith("--proxy-server=")]
        assert len(proxy_args) == 1
        assert proxy_args[0].startswith("--proxy-server=socks5://127.0.0.1:")
        assert "proxy.example.invalid" not in proxy_args[0]
        assert "@" not in proxy_args[0]
        assert "proxy-user-sentinel" not in joined
        assert "proxy-password-sentinel" not in joined
        assert not [arg for arg in argv if arg.startswith("--load-extension=")]
        assert not [arg for arg in argv if arg.startswith("--disable-extensions-except=")]
        records = chromium.RuntimeRegistry(tmp_path).read()
        record = records[profile["id"]]
        assert record.proxy_bridge_pid is not None
        assert chromium.is_process_alive(record.proxy_bridge_pid)
    finally:
        chromium.stop(tmp_path, profile["id"])


def test_launch_status_stop_round_trip_uses_relative_profile_storage_and_keeps_store_clean(
    tmp_path, monkeypatch
):
    profile = create_profile(tmp_path)
    fake_chromium = make_fake_chromium(tmp_path)
    argv_capture = tmp_path / "argv.json"
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_ARGV", str(argv_capture))

    launch = chromium.launch(tmp_path, profile["id"])

    try:
        assert launch["profileId"] == profile["id"]
        assert launch["status"] == "running"
        assert launch["pid"] > 0
        assert launch["startedAt"].endswith("Z")
        assert launch["runningCount"] == 1
        assert launch["userDataDir"] == profile["storage"]["userDataDir"]
        assert not Path(launch["userDataDir"]).is_absolute()
        assert str(tmp_path) not in json.dumps(launch)

        argv = json.loads(argv_capture.read_text(encoding="utf-8"))
        user_data_arg = next(arg for arg in argv if arg.startswith("--user-data-dir="))
        launched_user_data = Path(user_data_arg.split("=", 1)[1])
        assert launched_user_data == tmp_path / profile["storage"]["userDataDir"]
        assert launched_user_data.is_dir()
        assert "--profile-directory=Default" in argv
        assert "--no-first-run" in argv
        assert "--load-extension" not in "\n".join(argv)
        assert "--disable-extensions-except" not in "\n".join(argv)
        assert "--remote-debugging-port" not in "\n".join(argv)
        assert "--force-webrtc-ip-handling-policy=disable_non_proxied_udp" not in argv
        assert not any(arg.startswith("--proxy-server=") for arg in argv)
        assert "direct://" not in "\n".join(argv)

        status = chromium.status(tmp_path)
        assert status["runningCount"] == 1
        assert status["reconciled"] == []
        assert status["profiles"] == [
            {
                "profileId": profile["id"],
                "status": "running",
                "pid": launch["pid"],
                "startedAt": launch["startedAt"],
                "userDataDir": profile["storage"]["userDataDir"],
            }
        ]

        with pytest.raises(SidecarError) as duplicate_exc:
            chromium.launch(tmp_path, profile["id"])
        duplicate = assert_sidecar_error(duplicate_exc, CHROMIUM_ALREADY_RUNNING)
        assert str(tmp_path) not in duplicate.message
        assert str(fake_chromium) not in duplicate.message

        stopped = chromium.stop(tmp_path, profile["id"])
        assert stopped["profileId"] == profile["id"]
        assert stopped["status"] == "stopped"
        assert stopped["termination"] == "graceful"
        assert stopped["stoppedAt"].endswith("Z")
        assert stopped["runningCount"] == 0
        assert stopped["userDataDir"] == profile["storage"]["userDataDir"]

        assert chromium.status(tmp_path) == {"runningCount": 0, "profiles": [], "reconciled": []}
    finally:
        chromium.stop(tmp_path, profile["id"])

    stored_profile = read_profiles_payload(tmp_path)["profiles"][0]
    assert_no_runtime_truth(stored_profile)


def test_launch_for_automation_direct_profile_forces_remote_debugging_and_returns_safe_origin(
    tmp_path, monkeypatch
):
    profile = create_profile(tmp_path)
    fake_chromium = make_fake_chromium(tmp_path)
    argv_capture = tmp_path / "automation-direct-argv.json"
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_ARGV", str(argv_capture))
    user_data_path = tmp_path / profile["storage"]["userDataDir"]
    user_data_path.mkdir(parents=True, exist_ok=True)
    stale_active_port = user_data_path / "DevToolsActivePort"
    stale_active_port.write_text("65535\n/devtools/browser/stale\n", encoding="utf-8")
    calls = []

    def fake_discover_devtools_endpoint(user_data_dir, **kwargs):
        assert Path(user_data_dir) == user_data_path
        assert not stale_active_port.exists()
        assert chromium.RuntimeRegistry(tmp_path).read() == {}
        calls.append(("discover", kwargs))
        return CdpEndpoint(
            port=31337,
            browser_target_path="/devtools/browser/test",
            web_socket_debugger_url="ws://127.0.0.1:31337/devtools/browser/test",
        )

    def fail_apply_identity_cdp_overrides(*args, **kwargs):
        raise AssertionError("direct automation launch should not apply identity CDP overrides")

    monkeypatch.setattr(chromium, "discover_devtools_endpoint", fake_discover_devtools_endpoint)
    monkeypatch.setattr(chromium, "apply_identity_cdp_overrides", fail_apply_identity_cdp_overrides)

    result = chromium.launch_for_automation(tmp_path, profile["id"])

    try:
        assert [call[0] for call in calls] == ["discover"]
        assert_automation_handoff_payload_is_safe(
            result,
            profile_id=profile["id"],
            expected_origin="http://127.0.0.1:31337",
            running_count=1,
            store_root=tmp_path,
        )
        argv = json.loads(argv_capture.read_text(encoding="utf-8"))
        assert argv.count("--remote-debugging-port=0") == 1
        assert argv.count("--remote-allow-origins=*") == 1
        assert not any(arg.startswith("--load-extension=") for arg in argv)
        assert not any(arg.startswith("--proxy-server=") for arg in argv)

        status = chromium.status(tmp_path)
        assert status["runningCount"] == 1
        assert status["profiles"][0] == {
            "profileId": profile["id"],
            "status": "running",
            "pid": status["profiles"][0]["pid"],
            "startedAt": result["startedAt"],
            "userDataDir": profile["storage"]["userDataDir"],
        }
        registry_payload = json.loads(
            (tmp_path / "profile-store" / "runtime" / "chromium-processes.json").read_text(
                encoding="utf-8"
            )
        )
        assert "handoffOrigin" not in json.dumps(registry_payload)
        assert "ws://" not in json.dumps(registry_payload)
        assert "31337" not in json.dumps(registry_payload)
        assert_no_runtime_truth(read_profiles_payload(tmp_path)["profiles"][0])
    finally:
        chromium.stop(tmp_path, profile["id"])


def test_launch_for_automation_masked_identity_with_authenticated_proxy_composes_runtime_artifacts(
    tmp_path, monkeypatch
):
    profile = create_profile(tmp_path)
    ProfileStore(tmp_path).update_identity(profile["id"], curated_preset("windows-10-chrome-120"))
    ProfileStore(tmp_path).update_proxy(profile["id"], authenticated_http_proxy("https"))
    fake_chromium = make_fake_chromium(tmp_path)
    argv_capture = tmp_path / "automation-identity-proxy-argv.json"
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_ARGV", str(argv_capture))
    user_data_path = tmp_path / profile["storage"]["userDataDir"]
    user_data_path.mkdir(parents=True, exist_ok=True)
    stale_active_port = user_data_path / "DevToolsActivePort"
    stale_active_port.write_text("65535\n/devtools/browser/stale\n", encoding="utf-8")
    calls = []

    def fake_discover_devtools_endpoint(user_data_dir, **kwargs):
        assert Path(user_data_dir) == user_data_path
        assert not stale_active_port.exists()
        assert chromium.RuntimeRegistry(tmp_path).read() == {}
        calls.append(("discover", kwargs))
        return CdpEndpoint(
            port=32001,
            browser_target_path="/devtools/browser/test",
            web_socket_debugger_url="ws://127.0.0.1:32001/devtools/browser/test",
        )

    def fake_apply_identity_cdp_overrides(endpoint, overrides, **kwargs):
        assert isinstance(endpoint, CdpEndpoint)
        assert endpoint.port == 32001
        assert "userAgent" in overrides
        assert "deviceMetrics" in overrides
        assert chromium.RuntimeRegistry(tmp_path).read() == {}
        calls.append(("apply", sorted(overrides), kwargs))
        return {"applied": ["userAgent", "deviceMetrics", "timezone", "locale"]}

    monkeypatch.setattr(chromium, "discover_devtools_endpoint", fake_discover_devtools_endpoint)
    monkeypatch.setattr(chromium, "apply_identity_cdp_overrides", fake_apply_identity_cdp_overrides)

    result = chromium.launch_for_automation(tmp_path, profile["id"])

    try:
        assert [call[0] for call in calls] == ["discover", "apply"]
        assert_automation_handoff_payload_is_safe(
            result,
            profile_id=profile["id"],
            expected_origin="http://127.0.0.1:32001",
            running_count=1,
            store_root=tmp_path,
        )

        argv = json.loads(argv_capture.read_text(encoding="utf-8"))
        joined_argv = "\n".join(argv)
        assert [arg for arg in argv if arg.startswith("--proxy-server=")] == [
            "--proxy-server=https://proxy.example.invalid:18443"
        ]
        assert argv.count("--remote-debugging-port=0") == 1
        assert argv.count("--remote-allow-origins=*") == 1
        assert argv.count("--force-webrtc-ip-handling-policy=disable_non_proxied_udp") == 1
        extension_dirs = assert_composed_extension_allowlist(argv)
        extension_allowlist = next(arg for arg in argv if arg.startswith("--load-extension=")).split("=", 1)[1]
        assert "direct://" not in joined_argv
        assert "--proxy-bypass-list" not in joined_argv
        assert "proxy-auth-user-sentinel" not in joined_argv
        assert "proxy-auth-password-sentinel" not in joined_argv
        assert "Proxy-Authorization" not in joined_argv
        assert "@proxy.example.invalid" not in joined_argv
        assert all(profile["id"] not in str(path) for path in extension_dirs)
        assert "windows-10-chrome-120" not in joined_argv

        status = chromium.status(tmp_path)
        assert status["runningCount"] == 1
        assert status["profiles"][0]["profileId"] == profile["id"]
        assert_chromium_payload_omits_forbidden_markers(
            status,
            extra_forbidden=(
                str(tmp_path),
                extension_allowlist,
                *(str(path) for path in extension_dirs),
                result["handoffOrigin"],
                "32001",
            ),
        )
        registry_payload = json.loads(
            (tmp_path / "profile-store" / "runtime" / "chromium-processes.json").read_text(
                encoding="utf-8"
            )
        )
        assert_chromium_payload_omits_forbidden_markers(
            registry_payload,
            extra_forbidden=(
                str(tmp_path),
                extension_allowlist,
                *(str(path) for path in extension_dirs),
                result["handoffOrigin"],
                "32001",
            ),
        )
        assert_no_runtime_truth(read_profiles_payload(tmp_path)["profiles"][0])
    finally:
        chromium.stop(tmp_path, profile["id"])


def test_launch_for_automation_rejects_already_running_profile_before_second_spawn(
    tmp_path, monkeypatch
):
    profile = create_profile(tmp_path)
    fake_chromium = make_fake_chromium(tmp_path)
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))

    def fake_discover_devtools_endpoint(*args, **kwargs):
        return CdpEndpoint(
            port=31338,
            browser_target_path="/devtools/browser/test",
            web_socket_debugger_url="ws://127.0.0.1:31338/devtools/browser/test",
        )

    monkeypatch.setattr(chromium, "discover_devtools_endpoint", fake_discover_devtools_endpoint)
    first = chromium.launch_for_automation(tmp_path, profile["id"])
    assert first["status"] == "running"

    def fail_discover_executable():
        raise AssertionError("busy automation launch must fail before executable discovery")

    def fail_spawn(*args, **kwargs):
        raise AssertionError("busy automation launch must fail before spawning Chromium")

    monkeypatch.setattr(chromium, "discover_executable", fail_discover_executable)
    monkeypatch.setattr(chromium, "_spawn_chromium", fail_spawn)

    try:
        with pytest.raises(SidecarError) as exc_info:
            chromium.launch_for_automation(tmp_path, profile["id"])

        error = assert_sidecar_error(exc_info, CHROMIUM_ALREADY_RUNNING)
        assert str(tmp_path) not in error.message
        assert chromium.status(tmp_path)["runningCount"] == 1
    finally:
        chromium.stop(tmp_path, profile["id"])


@pytest.mark.parametrize("bad_profile_id", [None, 42, "", "   "])
def test_launch_for_automation_rejects_malformed_profile_ids(tmp_path, bad_profile_id):
    with pytest.raises(SidecarError) as exc_info:
        chromium.launch_for_automation(tmp_path, bad_profile_id)  # type: ignore[arg-type]

    assert_sidecar_error(exc_info, INVALID_REQUEST)
    assert chromium.RuntimeRegistry(tmp_path).read() == {}


def test_launch_for_automation_unknown_profile_id_uses_profile_store_not_found_error(
    tmp_path, monkeypatch
):
    def fail_discover_executable():
        raise AssertionError("profile lookup must fail before executable discovery")

    monkeypatch.setattr(chromium, "discover_executable", fail_discover_executable)

    with pytest.raises(SidecarError) as exc_info:
        chromium.launch_for_automation(tmp_path, "missing-profile")

    assert_sidecar_error(exc_info, PROFILE_NOT_FOUND)
    assert chromium.RuntimeRegistry(tmp_path).read() == {}


def test_launch_for_automation_proxy_auth_extension_failure_happens_before_spawn(
    tmp_path, monkeypatch
):
    profile = create_profile(tmp_path)
    ProfileStore(tmp_path).update_proxy(profile["id"], authenticated_http_proxy("http"))
    fake_chromium = make_fake_chromium(tmp_path)
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))

    def fail_generate_proxy_auth_extension(*args, **kwargs):
        raise SidecarError(
            code=PROXY_AUTH_HELPER_FAILED,
            message="Proxy auth helper could not be prepared.",
        )

    def fail_if_spawned(*args, **kwargs):
        raise AssertionError("Chromium must not spawn after proxy auth helper generation fails")

    monkeypatch.setattr(chromium, "generate_proxy_auth_extension", fail_generate_proxy_auth_extension)
    monkeypatch.setattr(chromium, "_spawn_chromium", fail_if_spawned)

    with pytest.raises(SidecarError) as exc_info:
        chromium.launch_for_automation(tmp_path, profile["id"])

    error = assert_sidecar_error(exc_info, PROXY_AUTH_HELPER_FAILED)
    encoded_error = json.dumps(error.to_dict(), sort_keys=True)
    assert "proxy-auth-user-sentinel" not in encoded_error
    assert "proxy-auth-password-sentinel" not in encoded_error
    assert str(tmp_path) not in encoded_error
    assert chromium.status(tmp_path) == {"runningCount": 0, "profiles": [], "reconciled": []}
    assert chromium.stop(tmp_path, profile["id"])["termination"] == "already-stopped"
    assert_no_runtime_truth(read_profiles_payload(tmp_path)["profiles"][0])


def test_launch_for_automation_early_chromium_exit_leaves_no_runtime_record(
    tmp_path, monkeypatch
):
    profile = create_profile(tmp_path)
    fake_chromium = make_fake_chromium(tmp_path)
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_EXIT_IMMEDIATELY", "1")

    def fail_discover_devtools_endpoint(*args, **kwargs):
        raise AssertionError("CDP discovery must not run after an early Chromium exit")

    monkeypatch.setattr(chromium, "discover_devtools_endpoint", fail_discover_devtools_endpoint)

    with pytest.raises(SidecarError) as exc_info:
        chromium.launch_for_automation(tmp_path, profile["id"])

    error = assert_sidecar_error(exc_info, CHROMIUM_LAUNCH_FAILED)
    assert str(fake_chromium) not in error.message
    assert str(tmp_path) not in error.message
    assert chromium.status(tmp_path) == {"runningCount": 0, "profiles": [], "reconciled": []}
    assert chromium.stop(tmp_path, profile["id"])["termination"] == "already-stopped"
    assert_no_runtime_truth(read_profiles_payload(tmp_path)["profiles"][0])


def test_launch_for_automation_cdp_discovery_failure_stops_child_and_leaves_no_runtime_record(
    tmp_path, monkeypatch
):
    profile = create_profile(tmp_path)
    fake_chromium = make_fake_chromium(tmp_path)
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setattr(chromium, "GRACEFUL_STOP_TIMEOUT_SECONDS", 0.1)
    monkeypatch.setattr(chromium, "FORCE_STOP_TIMEOUT_SECONDS", 0.1)
    real_spawn = chromium._spawn_chromium
    spawned_pids = []

    def capture_spawn(args, *, owner_token):
        process = real_spawn(args, owner_token=owner_token)
        spawned_pids.append(process.pid)
        return process

    def fail_discover_devtools_endpoint(*args, **kwargs):
        raise SidecarError(code=IDENTITY_CDP_FAILED, message="Identity CDP operation failed.")

    monkeypatch.setattr(chromium, "_spawn_chromium", capture_spawn)
    monkeypatch.setattr(chromium, "discover_devtools_endpoint", fail_discover_devtools_endpoint)

    with pytest.raises(SidecarError) as exc_info:
        chromium.launch_for_automation(tmp_path, profile["id"])

    error = assert_sidecar_error(exc_info, IDENTITY_CDP_FAILED)
    assert str(tmp_path) not in error.message
    assert spawned_pids
    assert not chromium.is_process_alive(spawned_pids[0])
    assert chromium.status(tmp_path) == {"runningCount": 0, "profiles": [], "reconciled": []}
    assert chromium.stop(tmp_path, profile["id"])["termination"] == "already-stopped"
    assert_no_runtime_truth(read_profiles_payload(tmp_path)["profiles"][0])


def test_launch_for_automation_identity_cdp_apply_failure_stops_child_and_leaves_no_runtime_record(
    tmp_path, monkeypatch
):
    profile = create_profile(tmp_path)
    ProfileStore(tmp_path).update_identity(profile["id"], curated_preset("windows-10-chrome-120"))
    fake_chromium = make_fake_chromium(tmp_path)
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setattr(chromium, "GRACEFUL_STOP_TIMEOUT_SECONDS", 0.1)
    monkeypatch.setattr(chromium, "FORCE_STOP_TIMEOUT_SECONDS", 0.1)
    real_spawn = chromium._spawn_chromium
    spawned_pids = []

    def capture_spawn(args, *, owner_token):
        process = real_spawn(args, owner_token=owner_token)
        spawned_pids.append(process.pid)
        return process

    def fake_discover_devtools_endpoint(*args, **kwargs):
        return CdpEndpoint(
            port=31339,
            browser_target_path="/devtools/browser/test",
            web_socket_debugger_url="ws://127.0.0.1:31339/devtools/browser/test",
        )

    def fail_apply_identity_cdp_overrides(*args, **kwargs):
        raise SidecarError(code=IDENTITY_CDP_FAILED, message="Identity CDP operation failed.")

    monkeypatch.setattr(chromium, "_spawn_chromium", capture_spawn)
    monkeypatch.setattr(chromium, "discover_devtools_endpoint", fake_discover_devtools_endpoint)
    monkeypatch.setattr(chromium, "apply_identity_cdp_overrides", fail_apply_identity_cdp_overrides)

    with pytest.raises(SidecarError) as exc_info:
        chromium.launch_for_automation(tmp_path, profile["id"])

    error = assert_sidecar_error(exc_info, IDENTITY_CDP_FAILED)
    assert str(tmp_path) not in error.message
    assert spawned_pids
    assert not chromium.is_process_alive(spawned_pids[0])
    assert chromium.status(tmp_path) == {"runningCount": 0, "profiles": [], "reconciled": []}
    assert chromium.stop(tmp_path, profile["id"])["termination"] == "already-stopped"
    assert_no_runtime_truth(read_profiles_payload(tmp_path)["profiles"][0])


@pytest.mark.parametrize(
    ("protocol", "port", "expected_arg"),
    [
        ("http", 8080, "--proxy-server=http://proxy.example.invalid:8080"),
        ("https", 8443, "--proxy-server=https://proxy.example.invalid:8443"),
        ("socks4", 9040, "--proxy-server=socks4://proxy.example.invalid:9040"),
        ("socks5", 9050, "--proxy-server=socks5://proxy.example.invalid:9050"),
    ],
)
def test_fixed_server_no_auth_launch_adds_one_safe_proxy_arg_without_direct_fallback(
    tmp_path,
    monkeypatch,
    protocol,
    port,
    expected_arg,
):
    profile = create_profile(tmp_path)
    ProfileStore(tmp_path).update_proxy(
        profile["id"],
        {
            "proxyVersion": 1,
            "mode": "fixedServer",
            "protocol": protocol,
            "host": "proxy.example.invalid",
            "port": port,
        },
    )
    fake_chromium = make_fake_chromium(tmp_path)
    argv_capture = tmp_path / f"argv-{protocol}.json"
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_ARGV", str(argv_capture))

    launch = chromium.launch(tmp_path, profile["id"])

    try:
        assert launch["status"] == "running"
        argv = json.loads(argv_capture.read_text(encoding="utf-8"))
        proxy_args = [arg for arg in argv if arg.startswith("--proxy-server=")]
        assert proxy_args == [expected_arg]
        joined = "\n".join(argv)
        assert "direct://" not in joined
        assert "--proxy-bypass-list" not in joined
        assert "username" not in joined
        assert "password" not in joined
        assert "@" not in expected_arg
    finally:
        chromium.stop(tmp_path, profile["id"])


def test_chromium_launch_arg_validator_rejects_unsafe_proxy_debug_and_path_args(tmp_path):
    executable = tmp_path / "chromium"
    executable.write_text("", encoding="utf-8")
    user_data_dir = tmp_path / "user-data"
    unsafe_args = [
        "--proxy-server=http://user:pass@proxy.example.invalid:8080",
        "--proxy-server=direct://",
        "--proxy-bypass-list=<-loopback>",
        "--remote-debugging-port=9222",
        f"--user-data-dir={tmp_path}",
    ]

    for unsafe_arg in unsafe_args:
        with pytest.raises(SidecarError) as exc_info:
            chromium.build_launch_args(executable, user_data_dir, "about:blank", extra_args=[unsafe_arg])

        error = assert_sidecar_error(exc_info, PROXY_LAUNCH_ARG_UNSAFE)
        encoded_error = json.dumps(error.to_dict(), sort_keys=True)
        assert "user:pass" not in encoded_error
        assert str(tmp_path) not in encoded_error


def test_proxy_proof_spki_trust_is_env_gated_and_public_payload_redacted(tmp_path, monkeypatch):
    strategy = HttpsProxyCertificateStrategy()
    executable = tmp_path / "chromium"
    executable.write_text("", encoding="utf-8")
    user_data_dir = tmp_path / "user-data"

    with pytest.raises(SidecarError) as unsafe_exc:
        chromium.build_launch_args(
            executable,
            user_data_dir,
            "about:blank",
            extra_args=[strategy.to_chromium_arg()],
        )
    assert_sidecar_error(unsafe_exc, PROXY_LAUNCH_ARG_UNSAFE)

    profile = create_profile(tmp_path)
    ProfileStore(tmp_path).update_proxy(
        profile["id"],
        {
            "proxyVersion": 1,
            "mode": "fixedServer",
            "protocol": "https",
            "host": "proxy.example.invalid",
            "port": 18443,
        },
    )
    fake_chromium = make_fake_chromium(tmp_path)
    argv_capture = tmp_path / "proxy-proof-spki-argv.json"
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_ARGV", str(argv_capture))
    monkeypatch.setenv(chromium.PROXY_PROOF_TRUST_ENABLED_ENV, "1")
    monkeypatch.setenv(chromium.PROXY_PROOF_SPKI_SHA256_ENV, strategy.spki_sha256)

    launch = chromium.launch(tmp_path, profile["id"])

    try:
        assert launch["status"] == "running"
        argv = json.loads(argv_capture.read_text(encoding="utf-8"))
        assert strategy.to_chromium_arg() in argv
        assert [arg for arg in argv if arg.startswith("--proxy-server=")] == [
            "--proxy-server=https://proxy.example.invalid:18443"
        ]
        public_surfaces = json.dumps(
            {
                "launch": launch,
                "status": chromium.status(tmp_path),
                "registry": (tmp_path / "profile-store" / "runtime" / "chromium-processes.json").read_text(
                    encoding="utf-8"
                ),
            },
            sort_keys=True,
        )
        assert strategy.spki_sha256 not in public_surfaces
        assert "ignore-certificate-errors" not in public_surfaces
        assert str(tmp_path) not in public_surfaces
    finally:
        chromium.stop(tmp_path, profile["id"])

    bad_profile = create_profile(tmp_path, name="Bad Proof Trust")
    ProfileStore(tmp_path).update_proxy(
        bad_profile["id"],
        {
            "proxyVersion": 1,
            "mode": "fixedServer",
            "protocol": "https",
            "host": "proxy.example.invalid",
            "port": 18443,
        },
    )
    bad_capture = tmp_path / "bad-proof-spki-argv.json"
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_ARGV", str(bad_capture))
    monkeypatch.setenv(chromium.PROXY_PROOF_SPKI_SHA256_ENV, "not-a-valid-spki-pin")

    with pytest.raises(SidecarError) as proof_exc:
        chromium.launch(tmp_path, bad_profile["id"])

    assert_sidecar_error(proof_exc, PROXY_PROOF_FAILED)
    assert not bad_capture.exists()
    assert chromium.status(tmp_path) == {"runningCount": 0, "profiles": [], "reconciled": []}


def test_masked_identity_launch_generates_extension_and_applies_cdp_before_registry_write(
    tmp_path, monkeypatch
):
    profile = create_profile(tmp_path)
    ProfileStore(tmp_path).update_identity(profile["id"], curated_preset("windows-10-chrome-120"))
    ProfileStore(tmp_path).update_proxy(
        profile["id"],
        {
            "proxyVersion": 1,
            "mode": "fixedServer",
            "protocol": "socks5",
            "host": "127.0.0.1",
            "port": 9050,
        },
    )
    fake_chromium = make_fake_chromium(tmp_path)
    argv_capture = tmp_path / "argv.json"
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_ARGV", str(argv_capture))
    user_data_path = tmp_path / profile["storage"]["userDataDir"]
    user_data_path.mkdir(parents=True, exist_ok=True)
    stale_active_port = user_data_path / "DevToolsActivePort"
    stale_active_port.write_text("65535\n/devtools/browser/stale\n", encoding="utf-8")

    calls = []

    def fake_discover_devtools_endpoint(user_data_dir, **kwargs):
        assert Path(user_data_dir) == user_data_path
        assert not stale_active_port.exists()
        assert chromium.RuntimeRegistry(tmp_path).read() == {}
        calls.append(("discover", kwargs))
        return "ws://127.0.0.1:1/devtools/browser/test"

    def fake_apply_identity_cdp_overrides(endpoint, overrides, **kwargs):
        assert endpoint == "ws://127.0.0.1:1/devtools/browser/test"
        assert "userAgent" in overrides
        assert "deviceMetrics" in overrides
        assert chromium.RuntimeRegistry(tmp_path).read() == {}
        calls.append(("apply", sorted(overrides), kwargs))
        return {"applied": ["userAgent", "deviceMetrics", "timezone", "locale"]}

    monkeypatch.setattr(chromium, "discover_devtools_endpoint", fake_discover_devtools_endpoint)
    monkeypatch.setattr(chromium, "apply_identity_cdp_overrides", fake_apply_identity_cdp_overrides)

    launch = chromium.launch(tmp_path, profile["id"])

    try:
        assert [call[0] for call in calls] == ["discover", "apply"]
        assert launch["profileId"] == profile["id"]
        assert launch["status"] == "running"
        assert launch["runningCount"] == 1
        assert set(launch) == {"profileId", "status", "pid", "startedAt", "userDataDir", "runningCount"}
        assert str(tmp_path) not in json.dumps(launch)
        assert "ws://" not in json.dumps(launch)
        assert "--remote-debugging-port" not in json.dumps(launch)

        argv = json.loads(argv_capture.read_text(encoding="utf-8"))
        joined_argv = "\n".join(argv)
        assert "--remote-debugging-port=0" in argv
        assert "--remote-allow-origins=*" in argv
        assert "--force-webrtc-ip-handling-policy=disable_non_proxied_udp" in argv
        assert [arg for arg in argv if arg.startswith("--proxy-server=")] == [
            "--proxy-server=socks5://127.0.0.1:9050"
        ]
        assert "direct://" not in joined_argv
        assert "--proxy-bypass-list" not in joined_argv
        load_extension = next(arg for arg in argv if arg.startswith("--load-extension="))
        disable_except = next(arg for arg in argv if arg.startswith("--disable-extensions-except="))
        assert load_extension.split("=", 1)[1] == disable_except.split("=", 1)[1]
        extension_dir = Path(load_extension.split("=", 1)[1])
        assert extension_dir.is_dir()
        assert (extension_dir / "manifest.json").is_file()
        assert profile["id"] not in str(extension_dir)
        assert "windows-10-chrome-120" not in joined_argv

        status = chromium.status(tmp_path)
        assert status["runningCount"] == 1
        assert status["profiles"][0] == {
            "profileId": profile["id"],
            "status": "running",
            "pid": launch["pid"],
            "startedAt": launch["startedAt"],
            "userDataDir": profile["storage"]["userDataDir"],
        }
        registry_payload = json.dumps(
            json.loads(
                (tmp_path / "profile-store" / "runtime" / "chromium-processes.json").read_text(
                    encoding="utf-8"
                )
            )
        )
        assert "ws://" not in registry_payload
        assert "--remote-debugging-port" not in registry_payload
        assert str(extension_dir) not in registry_payload
        assert_no_runtime_truth(read_profiles_payload(tmp_path)["profiles"][0])
    finally:
        chromium.stop(tmp_path, profile["id"])


def test_audit_open_launches_stopped_real_profile_with_forced_internal_cdp_and_safe_payload(
    tmp_path, monkeypatch
):
    profile = create_profile(tmp_path)
    ProfileStore(tmp_path).update_proxy(
        profile["id"],
        {
            "proxyVersion": 1,
            "mode": "fixedServer",
            "protocol": "http",
            "host": "proxy.example.invalid",
            "port": 18080,
        },
    )
    fake_chromium = make_fake_chromium(tmp_path)
    argv_capture = tmp_path / "argv.json"
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_ARGV", str(argv_capture))
    user_data_path = tmp_path / profile["storage"]["userDataDir"]
    user_data_path.mkdir(parents=True, exist_ok=True)
    stale_active_port = user_data_path / "DevToolsActivePort"
    stale_active_port.write_text("65535\n/devtools/browser/stale\n", encoding="utf-8")
    calls = []

    def fake_discover_devtools_endpoint(user_data_dir, **kwargs):
        assert Path(user_data_dir) == user_data_path
        assert not stale_active_port.exists()
        assert chromium.RuntimeRegistry(tmp_path).read() == {}
        calls.append(("discover", kwargs))
        return "ws://127.0.0.1:1/devtools/browser/test"

    def fail_apply_identity_cdp_overrides(*args, **kwargs):
        raise AssertionError("real identity audit should not apply identity CDP overrides")

    def fake_create_audit_page_target_endpoint(endpoint, **kwargs):
        assert endpoint == "ws://127.0.0.1:1/devtools/browser/test"
        assert kwargs["target_url"] == "https://browserleaks.com/webgl"
        assert kwargs["allowed_public_urls"] == {"https://browserleaks.com/webgl"}
        assert chromium.RuntimeRegistry(tmp_path).read() == {}
        calls.append(("open", kwargs))
        return object()

    monkeypatch.setattr(chromium, "discover_devtools_endpoint", fake_discover_devtools_endpoint)
    monkeypatch.setattr(chromium, "apply_identity_cdp_overrides", fail_apply_identity_cdp_overrides)
    monkeypatch.setattr(chromium, "create_audit_page_target_endpoint", fake_create_audit_page_target_endpoint)

    result = chromium.open_identity_audit_page(tmp_path, profile["id"], audit_page_payload(), audit_version=1)

    try:
        assert [call[0] for call in calls] == ["discover", "open"]
        assert result["auditVersion"] == 1
        assert result["profileId"] == profile["id"]
        assert result["pageId"] == "browserleaks-webgl"
        assert result["status"] == "opened"
        assert result["openedAt"].endswith("Z")
        assert result["launched"] is True
        assert result["runningCount"] == 1
        assert result["page"]["url"] == "https://browserleaks.com/webgl"
        assert set(result) == {
            "auditVersion",
            "profileId",
            "pageId",
            "status",
            "openedAt",
            "launched",
            "runningCount",
            "page",
        }
        assert "pid" not in json.dumps(result)
        assert "userDataDir" not in json.dumps(result)
        assert "ws://" not in json.dumps(result)
        assert "--remote-debugging-port" not in json.dumps(result)

        argv = json.loads(argv_capture.read_text(encoding="utf-8"))
        assert "--remote-debugging-port=0" in argv
        assert "--remote-allow-origins=*" in argv
        assert [arg for arg in argv if arg.startswith("--proxy-server=")] == [
            "--proxy-server=http://proxy.example.invalid:18080"
        ]
        assert "direct://" not in "\n".join(argv)
        assert "--proxy-bypass-list" not in "\n".join(argv)
        assert not any(arg.startswith("--load-extension=") for arg in argv)
        assert chromium.status(tmp_path)["runningCount"] == 1
        assert_no_runtime_truth(read_profiles_payload(tmp_path)["profiles"][0])
    finally:
        chromium.stop(tmp_path, profile["id"])


def test_audit_open_stopped_masked_identity_with_authenticated_proxy_composes_runtime_artifacts(
    tmp_path, monkeypatch
):
    profile = create_profile(tmp_path)
    ProfileStore(tmp_path).update_identity(profile["id"], curated_preset("windows-10-chrome-120"))
    ProfileStore(tmp_path).update_proxy(profile["id"], authenticated_http_proxy("https"))
    fake_chromium = make_fake_chromium(tmp_path)
    argv_capture = tmp_path / "audit-identity-proxy-argv.json"
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_ARGV", str(argv_capture))
    user_data_path = tmp_path / profile["storage"]["userDataDir"]
    user_data_path.mkdir(parents=True, exist_ok=True)
    stale_active_port = user_data_path / "DevToolsActivePort"
    stale_active_port.write_text("65535\n/devtools/browser/stale\n", encoding="utf-8")
    calls = []

    def fake_discover_devtools_endpoint(user_data_dir, **kwargs):
        assert Path(user_data_dir) == user_data_path
        assert not stale_active_port.exists()
        assert chromium.RuntimeRegistry(tmp_path).read() == {}
        calls.append(("discover", kwargs))
        return "ws://127.0.0.1:1/devtools/browser/test"

    def fake_apply_identity_cdp_overrides(endpoint, overrides, **kwargs):
        assert endpoint == "ws://127.0.0.1:1/devtools/browser/test"
        assert "userAgent" in overrides
        assert "deviceMetrics" in overrides
        assert chromium.RuntimeRegistry(tmp_path).read() == {}
        calls.append(("apply", sorted(overrides), kwargs))
        return {"applied": ["userAgent", "deviceMetrics", "timezone", "locale"]}

    def fake_create_audit_page_target_endpoint(endpoint, **kwargs):
        assert endpoint == "ws://127.0.0.1:1/devtools/browser/test"
        assert kwargs["target_url"] == "https://browserleaks.com/webgl"
        assert kwargs["allowed_public_urls"] == {"https://browserleaks.com/webgl"}
        assert chromium.RuntimeRegistry(tmp_path).read() == {}
        calls.append(("open", kwargs))
        return object()

    monkeypatch.setattr(chromium, "discover_devtools_endpoint", fake_discover_devtools_endpoint)
    monkeypatch.setattr(chromium, "apply_identity_cdp_overrides", fake_apply_identity_cdp_overrides)
    monkeypatch.setattr(chromium, "create_audit_page_target_endpoint", fake_create_audit_page_target_endpoint)

    result = chromium.open_identity_audit_page(tmp_path, profile["id"], audit_page_payload(), audit_version=1)

    try:
        assert [call[0] for call in calls] == ["discover", "apply", "open"]
        assert result["auditVersion"] == 1
        assert result["profileId"] == profile["id"]
        assert result["pageId"] == "browserleaks-webgl"
        assert result["status"] == "opened"
        assert result["openedAt"].endswith("Z")
        assert result["launched"] is True
        assert result["runningCount"] == 1
        assert set(result) == {
            "auditVersion",
            "profileId",
            "pageId",
            "status",
            "openedAt",
            "launched",
            "runningCount",
            "page",
        }
        assert "pid" not in json.dumps(result)
        assert "userDataDir" not in json.dumps(result)
        assert_chromium_payload_omits_forbidden_markers(
            result,
            extra_forbidden=(str(tmp_path), "profile-store/", "raw argv"),
        )

        argv = json.loads(argv_capture.read_text(encoding="utf-8"))
        joined_argv = "\n".join(argv)
        assert [arg for arg in argv if arg.startswith("--proxy-server=")] == [
            "--proxy-server=https://proxy.example.invalid:18443"
        ]
        assert argv.count("--remote-debugging-port=0") == 1
        assert argv.count("--remote-allow-origins=*") == 1
        assert argv.count("--force-webrtc-ip-handling-policy=disable_non_proxied_udp") == 1
        extension_dirs = assert_composed_extension_allowlist(argv)
        extension_allowlist = next(arg for arg in argv if arg.startswith("--load-extension=")).split("=", 1)[1]
        assert "direct://" not in joined_argv
        assert "--proxy-bypass-list" not in joined_argv
        assert "proxy-auth-user-sentinel" not in joined_argv
        assert "proxy-auth-password-sentinel" not in joined_argv
        assert "Proxy-Authorization" not in joined_argv
        assert "@proxy.example.invalid" not in joined_argv
        assert all(profile["id"] not in str(path) for path in extension_dirs)
        assert "windows-10-chrome-120" not in joined_argv

        status = chromium.status(tmp_path)
        assert status["runningCount"] == 1
        running_profile = status["profiles"][0]
        assert running_profile["profileId"] == profile["id"]
        assert running_profile["status"] == "running"
        assert running_profile["userDataDir"] == profile["storage"]["userDataDir"]
        assert_chromium_payload_omits_forbidden_markers(
            status,
            extra_forbidden=(
                str(tmp_path),
                extension_allowlist,
                *(str(path) for path in extension_dirs),
                "raw argv",
            ),
        )
        registry_payload = json.loads(
            (tmp_path / "profile-store" / "runtime" / "chromium-processes.json").read_text(
                encoding="utf-8"
            )
        )
        assert_chromium_payload_omits_forbidden_markers(
            registry_payload,
            extra_forbidden=(
                str(tmp_path),
                extension_allowlist,
                *(str(path) for path in extension_dirs),
                "raw argv",
            ),
        )

        stopped = chromium.stop(tmp_path, profile["id"])
        assert stopped["status"] == "stopped"
        assert stopped["runningCount"] == 0
        assert not chromium.is_process_alive(running_profile["pid"])
        assert chromium.status(tmp_path) == {"runningCount": 0, "profiles": [], "reconciled": []}
        assert_no_runtime_truth(read_profiles_payload(tmp_path)["profiles"][0])
    finally:
        chromium.stop(tmp_path, profile["id"])


def test_audit_open_applies_masked_identity_cdp_before_public_target_and_registry_write(
    tmp_path, monkeypatch
):
    profile = create_profile(tmp_path)
    ProfileStore(tmp_path).update_identity(profile["id"], curated_preset("windows-10-chrome-120"))
    fake_chromium = make_fake_chromium(tmp_path)
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    calls = []

    def fake_discover_devtools_endpoint(user_data_dir, **kwargs):
        assert chromium.RuntimeRegistry(tmp_path).read() == {}
        calls.append("discover")
        return "ws://127.0.0.1:1/devtools/browser/test"

    def fake_apply_identity_cdp_overrides(endpoint, overrides, **kwargs):
        assert endpoint == "ws://127.0.0.1:1/devtools/browser/test"
        assert "userAgent" in overrides
        assert chromium.RuntimeRegistry(tmp_path).read() == {}
        calls.append("apply")
        return {"applied": ["userAgent"]}

    def fake_create_audit_page_target_endpoint(endpoint, **kwargs):
        assert chromium.RuntimeRegistry(tmp_path).read() == {}
        assert kwargs["target_url"] == "https://browserleaks.com/webgl"
        calls.append("open")
        return object()

    monkeypatch.setattr(chromium, "discover_devtools_endpoint", fake_discover_devtools_endpoint)
    monkeypatch.setattr(chromium, "apply_identity_cdp_overrides", fake_apply_identity_cdp_overrides)
    monkeypatch.setattr(chromium, "create_audit_page_target_endpoint", fake_create_audit_page_target_endpoint)

    result = chromium.open_identity_audit_page(tmp_path, profile["id"], audit_page_payload(), audit_version=1)

    try:
        assert calls == ["discover", "apply", "open"]
        assert result["launched"] is True
        assert result["runningCount"] == 1
        assert chromium.status(tmp_path)["runningCount"] == 1
    finally:
        chromium.stop(tmp_path, profile["id"])


def test_audit_open_running_profile_without_cdp_returns_restart_guidance(tmp_path, monkeypatch):
    profile = create_profile(tmp_path)
    fake_chromium = make_fake_chromium(tmp_path)
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    launch = chromium.launch(tmp_path, profile["id"])
    assert launch["status"] == "running"

    def fail_discover_devtools_endpoint(*args, **kwargs):
        raise SidecarError(code=IDENTITY_CDP_FAILED, message="Identity CDP operation failed.")

    monkeypatch.setattr(chromium, "discover_devtools_endpoint", fail_discover_devtools_endpoint)

    try:
        with pytest.raises(SidecarError) as exc_info:
            chromium.open_identity_audit_page(tmp_path, profile["id"], audit_page_payload(), audit_version=1)

        error = assert_sidecar_error(exc_info, IDENTITY_AUDIT_FAILED)
        assert "Stop this profile" in error.message
        assert "ws://" not in error.to_dict()["message"]
        assert chromium.status(tmp_path)["runningCount"] == 1
    finally:
        chromium.stop(tmp_path, profile["id"])


def test_audit_open_target_failure_after_launch_stops_child_and_leaves_no_runtime_record(
    tmp_path, monkeypatch
):
    profile = create_profile(tmp_path)
    fake_chromium = make_fake_chromium(tmp_path)
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setattr(chromium, "GRACEFUL_STOP_TIMEOUT_SECONDS", 0.1)
    monkeypatch.setattr(chromium, "FORCE_STOP_TIMEOUT_SECONDS", 0.1)
    spawned_pids = []
    real_spawn = chromium._spawn_chromium

    def capture_spawn(args, *, owner_token):
        process = real_spawn(args, owner_token=owner_token)
        spawned_pids.append(process.pid)
        return process

    def fake_discover_devtools_endpoint(*args, **kwargs):
        return "ws://127.0.0.1:1/devtools/browser/test"

    def fail_create_audit_page_target_endpoint(*args, **kwargs):
        raise SidecarError(code=IDENTITY_CDP_FAILED, message="Identity CDP operation failed.")

    monkeypatch.setattr(chromium, "_spawn_chromium", capture_spawn)
    monkeypatch.setattr(chromium, "discover_devtools_endpoint", fake_discover_devtools_endpoint)
    monkeypatch.setattr(chromium, "create_audit_page_target_endpoint", fail_create_audit_page_target_endpoint)

    with pytest.raises(SidecarError) as exc_info:
        chromium.open_identity_audit_page(tmp_path, profile["id"], audit_page_payload(), audit_version=1)

    assert_sidecar_error(exc_info, IDENTITY_CDP_FAILED)
    assert spawned_pids
    assert not chromium.is_process_alive(spawned_pids[0])
    assert chromium.status(tmp_path) == {"runningCount": 0, "profiles": [], "reconciled": []}
    assert_no_runtime_truth(read_profiles_payload(tmp_path)["profiles"][0])


def test_extension_failure_happens_before_spawn_and_leaves_registry_empty(tmp_path, monkeypatch):
    profile = create_profile(tmp_path)
    ProfileStore(tmp_path).update_identity(profile["id"], curated_preset("windows-10-chrome-120"))
    fake_chromium = make_fake_chromium(tmp_path)
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))

    def fail_generate_identity_extension(*args, **kwargs):
        raise SidecarError(
            code=IDENTITY_EXTENSION_FAILED,
            message="Identity extension could not be prepared.",
        )

    def fail_if_spawned(*args, **kwargs):
        raise AssertionError("Chromium must not spawn after extension generation fails")

    monkeypatch.setattr(chromium, "generate_identity_extension", fail_generate_identity_extension)
    monkeypatch.setattr(chromium, "_spawn_chromium", fail_if_spawned)

    with pytest.raises(SidecarError) as exc_info:
        chromium.launch(tmp_path, profile["id"])

    error = assert_sidecar_error(exc_info, IDENTITY_EXTENSION_FAILED)
    assert str(tmp_path) not in error.message
    assert chromium.status(tmp_path) == {"runningCount": 0, "profiles": [], "reconciled": []}
    assert chromium.stop(tmp_path, profile["id"])["termination"] == "already-stopped"
    assert_no_runtime_truth(read_profiles_payload(tmp_path)["profiles"][0])


def test_proxy_auth_extension_failure_happens_before_spawn_and_leaves_registry_empty(tmp_path, monkeypatch):
    profile = create_profile(tmp_path)
    ProfileStore(tmp_path).update_proxy(profile["id"], authenticated_http_proxy("http"))
    fake_chromium = make_fake_chromium(tmp_path)
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))

    def fail_generate_proxy_auth_extension(*args, **kwargs):
        raise SidecarError(
            code=PROXY_AUTH_HELPER_FAILED,
            message="Proxy auth helper could not be prepared.",
        )

    def fail_if_spawned(*args, **kwargs):
        raise AssertionError("Chromium must not spawn after proxy auth extension generation fails")

    monkeypatch.setattr(chromium, "generate_proxy_auth_extension", fail_generate_proxy_auth_extension)
    monkeypatch.setattr(chromium, "_spawn_chromium", fail_if_spawned)

    with pytest.raises(SidecarError) as exc_info:
        chromium.launch(tmp_path, profile["id"])

    error = assert_sidecar_error(exc_info, PROXY_AUTH_HELPER_FAILED)
    encoded_error = json.dumps(error.to_dict(), sort_keys=True)
    assert "proxy-auth-user-sentinel" not in encoded_error
    assert "proxy-auth-password-sentinel" not in encoded_error
    assert str(tmp_path) not in encoded_error
    assert chromium.status(tmp_path) == {"runningCount": 0, "profiles": [], "reconciled": []}
    assert chromium.stop(tmp_path, profile["id"])["termination"] == "already-stopped"
    assert_no_runtime_truth(read_profiles_payload(tmp_path)["profiles"][0])


def test_cdp_failure_after_spawn_cleans_child_and_leaves_no_runtime_record(tmp_path, monkeypatch):
    profile = create_profile(tmp_path)
    ProfileStore(tmp_path).update_identity(profile["id"], curated_preset("windows-10-chrome-120"))
    fake_chromium = make_fake_chromium(tmp_path)
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setattr(chromium, "GRACEFUL_STOP_TIMEOUT_SECONDS", 0.1)
    monkeypatch.setattr(chromium, "FORCE_STOP_TIMEOUT_SECONDS", 0.1)

    real_spawn = chromium._spawn_chromium
    spawned_pids = []

    def capture_spawn(args, *, owner_token):
        process = real_spawn(args, owner_token=owner_token)
        spawned_pids.append(process.pid)
        return process

    def fake_discover_devtools_endpoint(*args, **kwargs):
        return "ws://127.0.0.1:1/devtools/browser/test"

    def fail_apply_identity_cdp_overrides(*args, **kwargs):
        raise SidecarError(
            code=IDENTITY_CDP_FAILED,
            message="Identity CDP operation failed.",
        )

    monkeypatch.setattr(chromium, "_spawn_chromium", capture_spawn)
    monkeypatch.setattr(chromium, "discover_devtools_endpoint", fake_discover_devtools_endpoint)
    monkeypatch.setattr(chromium, "apply_identity_cdp_overrides", fail_apply_identity_cdp_overrides)

    with pytest.raises(SidecarError) as exc_info:
        chromium.launch(tmp_path, profile["id"])

    error = assert_sidecar_error(exc_info, IDENTITY_CDP_FAILED)
    assert str(tmp_path) not in error.message
    assert spawned_pids
    assert not chromium.is_process_alive(spawned_pids[0])
    assert chromium.status(tmp_path) == {"runningCount": 0, "profiles": [], "reconciled": []}
    assert chromium.stop(tmp_path, profile["id"])["termination"] == "already-stopped"
    assert_no_runtime_truth(read_profiles_payload(tmp_path)["profiles"][0])


def test_status_reconciles_stale_registry_records_without_changing_profiles(tmp_path):
    profile = create_profile(tmp_path)
    runtime_dir = tmp_path / "profile-store" / "runtime"
    runtime_dir.mkdir(parents=True)
    registry_file = runtime_dir / "chromium-processes.json"
    registry_file.write_text(
        json.dumps(
            {
                "registryVersion": 1,
                "processes": {
                    profile["id"]: {
                        "profileId": profile["id"],
                        "pid": 99999999,
                        "startedAt": "2026-01-01T00:00:00.000Z",
                        "userDataDir": profile["storage"]["userDataDir"],
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    result = chromium.status(tmp_path)

    assert result["runningCount"] == 0
    assert result["profiles"] == []
    assert result["reconciled"] == [
        {
            "profileId": profile["id"],
            "status": "stopped",
            "stoppedAt": result["reconciled"][0]["stoppedAt"],
            "termination": "reconciled",
            "userDataDir": profile["storage"]["userDataDir"],
        }
    ]
    assert result["reconciled"][0]["stoppedAt"].endswith("Z")
    assert json.loads(registry_file.read_text(encoding="utf-8"))["processes"] == {}
    assert_no_runtime_truth(read_profiles_payload(tmp_path)["profiles"][0])


def test_invalid_registry_json_is_treated_as_transient_bookkeeping(tmp_path):
    profile = create_profile(tmp_path)
    registry_file = tmp_path / "profile-store" / "runtime" / "chromium-processes.json"
    registry_file.parent.mkdir(parents=True)
    registry_file.write_text("{not-json", encoding="utf-8")

    assert chromium.status(tmp_path) == {"runningCount": 0, "profiles": [], "reconciled": []}

    stopped = chromium.stop(tmp_path, profile["id"])
    assert stopped["termination"] == "already-stopped"
    assert stopped["runningCount"] == 0
    assert_no_runtime_truth(read_profiles_payload(tmp_path)["profiles"][0])


@pytest.mark.parametrize("bad_profile_id", [None, 42, "", "   "])
def test_launch_and_stop_reject_malformed_profile_ids(tmp_path, bad_profile_id):
    with pytest.raises(SidecarError) as launch_exc:
        chromium.launch(tmp_path, bad_profile_id)  # type: ignore[arg-type]
    assert_sidecar_error(launch_exc, INVALID_REQUEST)

    with pytest.raises(SidecarError) as stop_exc:
        chromium.stop(tmp_path, bad_profile_id)  # type: ignore[arg-type]
    assert_sidecar_error(stop_exc, INVALID_REQUEST)


def test_unknown_profile_id_uses_profile_store_not_found_error(tmp_path, monkeypatch):
    fake_chromium = make_fake_chromium(tmp_path)
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))

    with pytest.raises(SidecarError) as exc_info:
        chromium.launch(tmp_path, "missing-profile")

    assert_sidecar_error(exc_info, PROFILE_NOT_FOUND)


def test_missing_and_invalid_chromium_discovery_returns_typed_error(tmp_path, monkeypatch):
    profile = create_profile(tmp_path)
    missing_path = tmp_path / "missing-chromium"
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(missing_path))
    monkeypatch.setenv("PATH", str(tmp_path / "empty-path"))

    with pytest.raises(SidecarError) as exc_info:
        chromium.launch(tmp_path, profile["id"])

    error = assert_sidecar_error(exc_info, CHROMIUM_EXECUTABLE_NOT_FOUND)
    assert str(missing_path) not in error.message
    assert "THEPRIVATOR_CHROMIUM_PATH" in error.message


def test_missing_standard_chromium_names_return_typed_error(tmp_path, monkeypatch):
    profile = create_profile(tmp_path)
    monkeypatch.delenv("THEPRIVATOR_CHROMIUM_PATH", raising=False)
    monkeypatch.setenv("PATH", str(tmp_path / "empty-path"))

    with pytest.raises(SidecarError) as exc_info:
        chromium.launch(tmp_path, profile["id"])

    assert_sidecar_error(exc_info, CHROMIUM_EXECUTABLE_NOT_FOUND)


def test_launch_failure_does_not_leave_runtime_record_or_profile_runtime_fields(tmp_path, monkeypatch):
    profile = create_profile(tmp_path)
    fake_chromium = make_fake_chromium(tmp_path)
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_EXIT_IMMEDIATELY", "1")

    with pytest.raises(SidecarError) as exc_info:
        chromium.launch(tmp_path, profile["id"])

    error = assert_sidecar_error(exc_info, CHROMIUM_LAUNCH_FAILED)
    assert str(fake_chromium) not in error.message
    assert str(tmp_path) not in error.message
    assert chromium.status(tmp_path) == {"runningCount": 0, "profiles": [], "reconciled": []}
    assert_no_runtime_truth(read_profiles_payload(tmp_path)["profiles"][0])


def test_stop_forces_owned_process_tree_after_graceful_timeout(tmp_path, monkeypatch):
    profile = create_profile(tmp_path)
    fake_chromium = make_fake_chromium(tmp_path)
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_IGNORE_TERM", "1")
    monkeypatch.setattr(chromium, "GRACEFUL_STOP_TIMEOUT_SECONDS", 0.1)
    monkeypatch.setattr(chromium, "FORCE_STOP_TIMEOUT_SECONDS", 0.1)

    launch = chromium.launch(tmp_path, profile["id"])

    stopped = chromium.stop(tmp_path, profile["id"])

    assert stopped["profileId"] == profile["id"]
    assert stopped["status"] == "stopped"
    assert stopped["termination"] == "forced"
    assert stopped["runningCount"] == 0
    assert stopped["userDataDir"] == profile["storage"]["userDataDir"]
    assert chromium.status(tmp_path) == {"runningCount": 0, "profiles": [], "reconciled": []}
    assert not chromium.is_process_alive(launch["pid"])


def test_stop_already_stopped_profile_is_successful_and_safe(tmp_path):
    profile = create_profile(tmp_path)

    result = chromium.stop(tmp_path, profile["id"])

    assert result["profileId"] == profile["id"]
    assert result["status"] == "stopped"
    assert result["termination"] == "already-stopped"
    assert result["runningCount"] == 0
    assert result["userDataDir"] == profile["storage"]["userDataDir"]
    assert result["stoppedAt"].endswith("Z")


def _launched_profile(tmp_path, monkeypatch):
    """Launch a profile against the fake browser and return (store_root, id)."""
    monkeypatch.setenv(chromium.CHROMIUM_EXECUTABLE_ENV, str(make_fake_chromium(tmp_path)))
    store_root = tmp_path / "store"
    profile = ProfileStore(store_root).create("Stop Discipline")["profile"]
    chromium.launch(store_root, profile["id"])
    return store_root, profile["id"]


def test_stop_records_the_stop_before_killing_the_process(tmp_path, monkeypatch):
    """The registry write must land first, because it is the step that can fail.

    Killing first meant a failed write left the registry insisting a dead browser
    was still running, and the UI would then refuse to launch that profile again.
    """
    store_root, profile_id = _launched_profile(tmp_path, monkeypatch)
    registry_path = chromium.RuntimeRegistry(store_root).path
    observed_at_kill: dict[str, Any] = {}

    real_stop_tree = chromium._stop_process_tree

    def observing_stop_tree(pid: int) -> str:
        observed_at_kill["records"] = json.loads(registry_path.read_text(encoding="utf-8"))["processes"]
        return real_stop_tree(pid)

    monkeypatch.setattr(chromium, "_stop_process_tree", observing_stop_tree)
    chromium.stop(store_root, profile_id)

    assert profile_id not in observed_at_kill["records"], "registry still claimed the profile was running during the kill"


def test_stop_restores_the_record_when_the_process_survives(tmp_path, monkeypatch):
    """A profile that refuses both signals must stay visible to status and retry."""
    store_root, profile_id = _launched_profile(tmp_path, monkeypatch)

    def refuse_to_die(_pid: int) -> str:
        raise SidecarError(code=CHROMIUM_STOP_FAILED, message="Chromium stop failed.")

    monkeypatch.setattr(chromium, "_stop_process_tree", refuse_to_die)

    with pytest.raises(SidecarError) as exc_info:
        chromium.stop(store_root, profile_id)

    assert exc_info.value.code == CHROMIUM_STOP_FAILED
    assert profile_id in chromium.RuntimeRegistry(store_root).read(), "the surviving process was dropped from the registry"

    monkeypatch.setattr(chromium, "_stop_process_tree", lambda pid: "forced")
    chromium.stop(store_root, profile_id)


def test_registry_write_failure_is_reported_rather_than_swallowed(tmp_path, monkeypatch):
    """A silent bookkeeping failure leaves status lying about a stopped profile."""
    store_root, profile_id = _launched_profile(tmp_path, monkeypatch)

    def fail_replace(_source, _destination):
        raise OSError("simulated registry write failure")

    monkeypatch.setattr(chromium.os, "replace", fail_replace)

    with pytest.raises(SidecarError) as exc_info:
        chromium.stop(store_root, profile_id)

    assert exc_info.value.code == CHROMIUM_STOP_FAILED


def test_reconcile_does_not_kill_a_pid_that_is_no_longer_our_bridge(tmp_path, monkeypatch):
    """A recorded pid is not an identity.

    Reconciliation runs after reboots, when the OS has reused pids freely. Acting
    on the recorded pid alone would SIGKILL whatever inherited it -- along with
    its whole process group.
    """
    store_root = tmp_path / "store"
    ready_relative = "profile-store/runtime/proxy-bridges/profile-abc/bridge-1.ready.json"
    ready_path = store_root / ready_relative
    ready_path.parent.mkdir(parents=True, exist_ok=True)
    # The bridge is gone: its ready file survives but nothing holds the lock, and
    # some unrelated process now owns pid 424242.
    ready_path.write_text(json.dumps({"bridgeVersion": 1, "host": "127.0.0.1", "port": 1080, "pid": 424242}))

    record = chromium.RuntimeRecord(
        profile_id="11111111-1111-1111-1111-111111111111",
        pid=999999,
        started_at="2026-01-01T00:00:00.000Z",
        user_data_dir="profile-store/profiles/11111111-1111-1111-1111-111111111111/user-data",
        owner_token="token",
        proxy_bridge_pid=424242,
        proxy_bridge_ready_file=ready_relative,
    )
    killed: list[int] = []
    monkeypatch.setattr(chromium, "_stop_proxy_bridge_pid", lambda pid: killed.append(pid))

    chromium._stop_proxy_bridge_for_record(store_root, record)

    assert killed == [], "reconcile killed a pid it could not prove was still its bridge"


def test_reconcile_stops_a_bridge_that_still_holds_its_ready_file(tmp_path, monkeypatch):
    """The complementary case: a live bridge must still be stopped."""
    pytest.importorskip("fcntl")
    import fcntl

    store_root = tmp_path / "store"
    ready_relative = "profile-store/runtime/proxy-bridges/profile-abc/bridge-1.ready.json"
    ready_path = store_root / ready_relative
    ready_path.parent.mkdir(parents=True, exist_ok=True)
    ready_path.write_text(json.dumps({"bridgeVersion": 1, "host": "127.0.0.1", "port": 1080, "pid": os.getpid()}))

    record = chromium.RuntimeRecord(
        profile_id="11111111-1111-1111-1111-111111111111",
        pid=999999,
        started_at="2026-01-01T00:00:00.000Z",
        user_data_dir="profile-store/profiles/11111111-1111-1111-1111-111111111111/user-data",
        owner_token="token",
        proxy_bridge_pid=os.getpid(),
        proxy_bridge_ready_file=ready_relative,
    )
    killed: list[int] = []
    monkeypatch.setattr(chromium, "_stop_proxy_bridge_pid", lambda pid: killed.append(pid))

    holder = open(ready_path, "r+", encoding="utf-8")
    try:
        fcntl.flock(holder.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        chromium._stop_proxy_bridge_for_record(store_root, record)
    finally:
        holder.close()

    assert killed == [os.getpid()], "a live bridge was left running"


def test_records_written_before_ownership_tracking_are_left_alone(tmp_path, monkeypatch):
    """An orphan is recoverable; killing someone else's process tree is not."""
    record = chromium.RuntimeRecord(
        profile_id="11111111-1111-1111-1111-111111111111",
        pid=999999,
        started_at="2026-01-01T00:00:00.000Z",
        user_data_dir="profile-store/profiles/11111111-1111-1111-1111-111111111111/user-data",
        owner_token="token",
        proxy_bridge_pid=424242,
        proxy_bridge_ready_file=None,
    )
    killed: list[int] = []
    monkeypatch.setattr(chromium, "_stop_proxy_bridge_pid", lambda pid: killed.append(pid))

    chromium._stop_proxy_bridge_for_record(tmp_path, record)

    assert killed == []


def test_audit_collection_reports_skipped_pages_instead_of_overrunning(monkeypatch):
    """Exceeding the bridge budget gets the sidecar killed mid-collection.

    That orphans the browser it launched and leaves the UI believing nothing
    started, so pages not reached in time must report as unavailable and let the
    completed ones through.
    """
    pages = [
        {"id": f"checker-{index}", "label": f"Checker {index}", "category": "privacy",
         "url": f"https://example.invalid/{index}", "surfaces": ["canvas"], "requiresUserAction": False}
        for index in range(4)
    ]
    collected: list[str] = []

    def slow_collect(_endpoint, page, *, allowed_urls):
        collected.append(page["id"])
        clock["now"] += 40.0  # each page eats a large slice of the budget
        return chromium._audit_page_result(
            page, status="captured", title="ok", summary="ok", rows=[], notes=[]
        )

    clock = {"now": 0.0}
    monkeypatch.setattr(chromium.time, "monotonic", lambda: clock["now"])
    monkeypatch.setattr(chromium, "_collect_public_audit_target", slow_collect)

    results = chromium._collect_public_audit_targets(object(), pages)

    assert len(results) == len(pages), "every page must still be represented in the result"
    assert collected == ["checker-0", "checker-1", "checker-2"], "collection did not stop at the budget"
    assert [result["status"] for result in results] == ["captured", "captured", "captured", "unavailable"]
    assert "ran out of time" in results[-1]["summary"]


@pytest.mark.skipif(os.name != "posix", reason="process sessions are a POSIX concept")
def test_launched_browser_is_detached_from_the_sidecar_that_started_it(tmp_path, monkeypatch):
    """The browser must outlive the sidecar process that launched it.

    This used to be incidental -- the sidecar exited moments after launching, so
    Chromium was reparented anyway. Now that Rust keeps sidecar workers warm and
    recycles them, the browser is a live child of a process the pool may kill at
    any time, and only the new session keeps it alive.
    """
    monkeypatch.setenv(chromium.CHROMIUM_EXECUTABLE_ENV, str(make_fake_chromium(tmp_path)))
    store_root = tmp_path / "store"
    profile = ProfileStore(store_root).create("Detached")["profile"]

    chromium.launch(store_root, profile["id"])
    record = chromium.RuntimeRegistry(store_root).read()[profile["id"]]

    try:
        assert os.getsid(record.pid) != os.getsid(os.getpid()), (
            "the browser shares a session with the sidecar and would die with it"
        )
    finally:
        chromium.stop(store_root, profile["id"])


def _bulk_profiles(tmp_path, monkeypatch, count):
    monkeypatch.setenv(chromium.CHROMIUM_EXECUTABLE_ENV, str(make_fake_chromium(tmp_path)))
    store_root = tmp_path / "store"
    store = ProfileStore(store_root)
    return store_root, [store.create(f"Bulk {index}")["profile"]["id"] for index in range(count)]


def test_bulk_launch_reports_per_profile_outcomes(tmp_path, monkeypatch):
    """One bad profile must not stop the rest of the batch."""
    store_root, ids = _bulk_profiles(tmp_path, monkeypatch, 3)

    result = chromium.bulk_launch(store_root, [*ids, "11111111-1111-1111-1111-111111111111"], stagger_seconds=0)

    try:
        assert [entry["profileId"] for entry in result["launched"]] == ids
        assert [entry["profileId"] for entry in result["failed"]] == ["11111111-1111-1111-1111-111111111111"]
        assert result["failed"][0]["code"] == PROFILE_NOT_FOUND
        assert result["runningCount"] == 3
    finally:
        chromium.bulk_stop(store_root)


def test_bulk_launch_refuses_more_profiles_than_the_batch_limit(tmp_path, monkeypatch):
    store_root, _ids = _bulk_profiles(tmp_path, monkeypatch, 1)

    with pytest.raises(SidecarError) as exc_info:
        chromium.bulk_launch(store_root, [f"id-{index}" for index in range(20)])

    assert exc_info.value.code == INVALID_REQUEST


def test_bulk_stop_without_ids_stops_everything_running(tmp_path, monkeypatch):
    store_root, ids = _bulk_profiles(tmp_path, monkeypatch, 3)
    chromium.bulk_launch(store_root, ids, stagger_seconds=0)

    result = chromium.bulk_stop(store_root)

    assert sorted(entry["profileId"] for entry in result["stopped"]) == sorted(ids)
    assert result["runningCount"] == 0


def test_launch_uses_the_profile_start_urls_and_curated_flags(tmp_path, monkeypatch):
    """defaults.startUrl promised these; the launcher has to actually pass them."""
    monkeypatch.setenv(chromium.CHROMIUM_EXECUTABLE_ENV, str(make_fake_chromium(tmp_path)))
    argv_path = tmp_path / "argv.json"
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_ARGV", str(argv_path))
    store_root = tmp_path / "store"
    store = ProfileStore(store_root)
    profile_id = store.create("Start URLs")["profile"]["id"]
    store.update_launch(
        profile_id,
        {
            "startupBehavior": "customUrls",
            "startUrls": ["https://first.example/", "https://second.example/"],
            "args": ["--mute-audio", "--window-position=10,20"],
        },
    )

    chromium.launch(store_root, profile_id)
    try:
        argv = json.loads(argv_path.read_text(encoding="utf-8"))
        assert [arg for arg in argv if arg.startswith("https://")] == [
            "https://first.example/",
            "https://second.example/",
        ]
        assert "--mute-audio" in argv and "--window-position=10,20" in argv
        assert "about:blank" not in argv
    finally:
        chromium.stop(store_root, profile_id)


def test_restore_session_replaces_the_positional_url(tmp_path, monkeypatch):
    """Appending a URL as well would add a tab on every launch, not restore one."""
    monkeypatch.setenv(chromium.CHROMIUM_EXECUTABLE_ENV, str(make_fake_chromium(tmp_path)))
    argv_path = tmp_path / "argv.json"
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_ARGV", str(argv_path))
    store_root = tmp_path / "store"
    store = ProfileStore(store_root)
    profile_id = store.create("Restore")["profile"]["id"]
    store.update_launch(profile_id, {"startupBehavior": "restoreSession", "startUrls": [], "args": []})

    chromium.launch(store_root, profile_id)
    try:
        argv = json.loads(argv_path.read_text(encoding="utf-8"))
        assert "--restore-last-session" in argv
        assert not any(arg.startswith("http") for arg in argv)
        assert "about:blank" not in argv
    finally:
        chromium.stop(store_root, profile_id)
