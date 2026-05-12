"""Tests for the sidecar Chromium lifecycle registry and process contract."""

import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping

import pytest

from theprivator_sidecar import chromium
from theprivator_sidecar.identity import curated_preset
from theprivator_sidecar.profiles import ProfileStore
from theprivator_sidecar.protocol import (
    CHROMIUM_ALREADY_RUNNING,
    CHROMIUM_EXECUTABLE_NOT_FOUND,
    CHROMIUM_LAUNCH_FAILED,
    IDENTITY_AUDIT_FAILED,
    IDENTITY_CDP_FAILED,
    IDENTITY_EXTENSION_FAILED,
    INVALID_REQUEST,
    PROFILE_NOT_FOUND,
    PROXY_LAUNCH_ARG_UNSAFE,
    PROXY_SOCKS_AUTH_UNSUPPORTED,
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


def test_socks_proxy_credentials_fail_before_executable_discovery_or_spawn(tmp_path, monkeypatch):
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

    def fail_discover_executable():
        raise AssertionError("SOCKS credential failure must happen before executable discovery")

    def fail_spawn(*args, **kwargs):
        raise AssertionError("SOCKS credential failure must happen before spawning Chromium")

    monkeypatch.setattr(chromium, "discover_executable", fail_discover_executable)
    monkeypatch.setattr(chromium, "_spawn_chromium", fail_spawn)

    with pytest.raises(SidecarError) as exc_info:
        chromium.launch(tmp_path, profile["id"])

    error = assert_sidecar_error(exc_info, PROXY_SOCKS_AUTH_UNSUPPORTED)
    encoded_error = json.dumps(error.to_dict(), sort_keys=True)
    assert "proxy-user-sentinel" not in encoded_error
    assert "proxy-password-sentinel" not in encoded_error
    assert chromium.RuntimeRegistry(tmp_path).read() == {}
    assert not (tmp_path / "profile-store" / "runtime").exists()
    stored_profile = read_profiles_payload(tmp_path)["profiles"][0]
    assert stored_profile["proxy"]["mode"] == "fixedServer"
    assert_no_runtime_truth(stored_profile)


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
