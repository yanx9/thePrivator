"""Tests for HTTP/HTTPS proxy-auth helper generation and launch composition."""

import json
import sys
from pathlib import Path
from typing import Any, Mapping

import pytest

from theprivator_sidecar import chromium
from theprivator_sidecar.identity import curated_preset
from theprivator_sidecar.profiles import ProfileStore
from theprivator_sidecar.protocol import CHROMIUM_LAUNCH_FAILED, PROXY_AUTH_HELPER_FAILED, SidecarError
from theprivator_sidecar.proxy import PROXY_VERSION
from theprivator_sidecar.proxy_auth_extension import (
    CONFIG_GLOBAL_NAME,
    CONFIG_SCRIPT_NAME,
    MANIFEST_NAME,
    WORKER_SCRIPT_NAME,
    generate_proxy_auth_extension,
    validate_proxy_auth_extension,
)
from theprivator_sidecar.proxy_runtime import build_proxy_runtime_plan

SENTINEL_USERNAME = "proxy-auth-user-sentinel"
SENTINEL_PASSWORD = "proxy-auth-password-sentinel-\"\\-☃"
SENTINEL_VALUES = (SENTINEL_USERNAME, SENTINEL_PASSWORD)


def authenticated_http_proxy(protocol="http", **overrides):
    proxy = {
        "proxyVersion": PROXY_VERSION,
        "mode": "fixedServer",
        "protocol": protocol,
        "host": "Proxy.Example.Invalid",
        "port": 18080,
        "credentials": {
            "username": SENTINEL_USERNAME,
            "password": SENTINEL_PASSWORD,
        },
    }
    proxy.update(overrides)
    return proxy


def make_fake_chromium(tmp_path: Path) -> Path:
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
                "def handle_term(signum, frame):",
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


def create_profile(tmp_path: Path, name: str = "Proxy Auth") -> Mapping[str, Any]:
    return ProfileStore(tmp_path).create(name)["profile"]


def read_generated_config(extension_dir: Path) -> Mapping[str, Any]:
    text = (extension_dir / CONFIG_SCRIPT_NAME).read_text(encoding="utf-8")
    prefix = f"self.{CONFIG_GLOBAL_NAME}=Object.freeze("
    suffix = ");\n"
    assert text.startswith(prefix)
    assert text.endswith(suffix)
    return json.loads(text[len(prefix) : -len(suffix)])


def assert_sidecar_error(exc_info: pytest.ExceptionInfo[SidecarError], code: str) -> SidecarError:
    error = exc_info.value
    assert error.code == code
    assert error.recoverable is True
    assert error.detail_ref.startswith("sidecar-")
    encoded = json.dumps(error.to_dict(), ensure_ascii=False, sort_keys=True)
    assert "Traceback" not in encoded
    assert "proxy-auth-extensions" not in encoded
    for sentinel in SENTINEL_VALUES:
        assert sentinel not in encoded
    return error


@pytest.mark.parametrize("protocol", ["http", "https"])
def test_authenticated_proxy_generates_redacted_auth_extension_artifact(tmp_path, protocol):
    proxy = authenticated_http_proxy(protocol)
    plan = build_proxy_runtime_plan(proxy)
    assert plan.requires_auth_helper is True
    assert plan.launch_args == [f"--proxy-server={protocol}://proxy.example.invalid:18080"]

    artifact = generate_proxy_auth_extension(tmp_path, "profile-id", proxy, plan)

    encoded_public = json.dumps(artifact.to_public_dict(), sort_keys=True)
    assert SENTINEL_USERNAME not in encoded_public
    assert SENTINEL_PASSWORD not in encoded_public
    assert "proxy-auth-extensions" not in encoded_public
    assert artifact.extension_dir.is_dir()
    assert sorted(path.name for path in artifact.extension_dir.iterdir()) == sorted(
        [MANIFEST_NAME, CONFIG_SCRIPT_NAME, WORKER_SCRIPT_NAME]
    )
    assert artifact.profile_key.startswith("profile-")
    assert "profile-id" not in str(artifact.extension_dir)

    manifest = json.loads((artifact.extension_dir / MANIFEST_NAME).read_text(encoding="utf-8"))
    assert manifest["permissions"] == ["webRequest", "webRequestAuthProvider"]
    assert manifest["host_permissions"] == ["<all_urls>"]
    assert manifest["background"] == {"service_worker": WORKER_SCRIPT_NAME}

    config = read_generated_config(artifact.extension_dir)
    assert config["protocol"] == protocol
    assert config["challenger"] == {"host": "proxy.example.invalid", "port": 18080}
    assert config["credentials"] == {"username": SENTINEL_USERNAME, "password": SENTINEL_PASSWORD}
    assert "☃" not in (artifact.extension_dir / CONFIG_SCRIPT_NAME).read_text(encoding="utf-8")

    worker = (artifact.extension_dir / WORKER_SCRIPT_NAME).read_text(encoding="utf-8")
    assert "details.isProxy !== true" in worker
    assert "return {};" in worker
    assert "return { cancel: true };" in worker
    assert "usedChallenges.has(key)" in worker
    assert "authCredentials" in worker
    validate_proxy_auth_extension(artifact.extension_dir)


def test_proxy_auth_extension_rejects_mismatched_runtime_plan(tmp_path):
    plan = build_proxy_runtime_plan(authenticated_http_proxy("http"))
    mismatched_proxy = authenticated_http_proxy("https")

    with pytest.raises(SidecarError) as exc_info:
        generate_proxy_auth_extension(tmp_path, "profile-id", mismatched_proxy, plan)

    assert_sidecar_error(exc_info, PROXY_AUTH_HELPER_FAILED)


def test_proxy_auth_extension_rejects_missing_credentials_and_socks4_proxy(tmp_path):
    plan = build_proxy_runtime_plan(authenticated_http_proxy("http"))
    missing_credentials = authenticated_http_proxy("http")
    missing_credentials.pop("credentials")
    socks4_proxy = authenticated_http_proxy("socks4")

    for proxy in (missing_credentials, socks4_proxy):
        with pytest.raises(SidecarError) as exc_info:
            generate_proxy_auth_extension(tmp_path, "profile-id", proxy, plan)

        assert_sidecar_error(exc_info, PROXY_AUTH_HELPER_FAILED)


def test_proxy_auth_extension_validation_rejects_tampered_artifacts(tmp_path):
    artifact = generate_proxy_auth_extension(
        tmp_path,
        "profile-id",
        authenticated_http_proxy("http"),
        build_proxy_runtime_plan(authenticated_http_proxy("http")),
    )

    worker_path = artifact.extension_dir / WORKER_SCRIPT_NAME
    worker_path.write_text("chrome.webRequest.onAuthRequired.addListener(() => ({}));\n", encoding="utf-8")

    with pytest.raises(SidecarError) as exc_info:
        validate_proxy_auth_extension(artifact.extension_dir)

    assert_sidecar_error(exc_info, PROXY_AUTH_HELPER_FAILED)


def test_chromium_extension_arg_composition_accepts_identity_proxy_and_rejects_unsafe_paths(tmp_path):
    identity_dir = tmp_path / "identity-extension"
    proxy_dir = tmp_path / "proxy-auth-extension"
    identity_dir.mkdir()
    proxy_dir.mkdir()
    executable = tmp_path / "chromium"
    user_data_dir = tmp_path / "user-data"

    extension_args = chromium._extension_launch_args([identity_dir, proxy_dir])

    assert extension_args == [
        f"--load-extension={identity_dir},{proxy_dir}",
        f"--disable-extensions-except={identity_dir},{proxy_dir}",
    ]
    launch_args = chromium.build_launch_args(executable, user_data_dir, "about:blank", extra_args=extension_args)
    assert launch_args.count(extension_args[0]) == 1
    assert launch_args.count(extension_args[1]) == 1

    unsafe_args = [
        "--load-extension=relative-extension",
        f"--load-extension={tmp_path / 'missing-extension'}",
        f"--disable-extensions-except={identity_dir},",
        f"--load-extension={identity_dir},relative-extension",
    ]
    for unsafe_arg in unsafe_args:
        with pytest.raises(SidecarError) as exc_info:
            chromium.build_launch_args(executable, user_data_dir, "about:blank", extra_args=[unsafe_arg])

        assert_sidecar_error(exc_info, CHROMIUM_LAUNCH_FAILED)


def test_credentialed_http_launch_uses_auth_helper_without_argv_or_payload_secret(tmp_path, monkeypatch):
    profile = create_profile(tmp_path)
    ProfileStore(tmp_path).update_proxy(profile["id"], authenticated_http_proxy("http"))
    fake_chromium = make_fake_chromium(tmp_path)
    argv_capture = tmp_path / "argv.json"
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_ARGV", str(argv_capture))

    launch = chromium.launch(tmp_path, profile["id"])

    try:
        assert launch["status"] == "running"
        encoded_launch = json.dumps(launch, sort_keys=True)
        for sentinel in SENTINEL_VALUES:
            assert sentinel not in encoded_launch
        assert str(tmp_path) not in encoded_launch

        argv = json.loads(argv_capture.read_text(encoding="utf-8"))
        joined = "\n".join(argv)
        assert [arg for arg in argv if arg.startswith("--proxy-server=")] == [
            "--proxy-server=http://proxy.example.invalid:18080"
        ]
        assert "direct://" not in joined
        assert "@" not in next(arg for arg in argv if arg.startswith("--proxy-server="))
        for sentinel in SENTINEL_VALUES:
            assert sentinel not in joined

        load_extension = next(arg for arg in argv if arg.startswith("--load-extension="))
        disable_except = next(arg for arg in argv if arg.startswith("--disable-extensions-except="))
        assert load_extension.split("=", 1)[1] == disable_except.split("=", 1)[1]
        extension_dirs = [Path(value) for value in load_extension.split("=", 1)[1].split(",")]
        assert len(extension_dirs) == 1
        assert (extension_dirs[0] / MANIFEST_NAME).is_file()
        assert (extension_dirs[0] / WORKER_SCRIPT_NAME).is_file()
    finally:
        chromium.stop(tmp_path, profile["id"])


def test_identity_and_proxy_auth_extensions_compose_with_webrtc_and_cdp_flags(tmp_path, monkeypatch):
    profile = create_profile(tmp_path)
    store = ProfileStore(tmp_path)
    store.update_identity(profile["id"], curated_preset("windows-10-chrome-120"))
    store.update_proxy(profile["id"], authenticated_http_proxy("https", port=18443))
    fake_chromium = make_fake_chromium(tmp_path)
    argv_capture = tmp_path / "argv.json"
    monkeypatch.setenv("THEPRIVATOR_CHROMIUM_PATH", str(fake_chromium))
    monkeypatch.setenv("THEPRIVATOR_FAKE_CHROMIUM_ARGV", str(argv_capture))

    def fake_discover_devtools_endpoint(user_data_dir, **kwargs):
        return "ws://127.0.0.1:1/devtools/browser/test"

    def fake_apply_identity_cdp_overrides(endpoint, overrides, **kwargs):
        assert "userAgent" in overrides
        assert chromium.RuntimeRegistry(tmp_path).read() == {}
        return {"applied": ["userAgent"]}

    monkeypatch.setattr(chromium, "discover_devtools_endpoint", fake_discover_devtools_endpoint)
    monkeypatch.setattr(chromium, "apply_identity_cdp_overrides", fake_apply_identity_cdp_overrides)

    launch = chromium.launch(tmp_path, profile["id"])

    try:
        assert launch["status"] == "running"
        argv = json.loads(argv_capture.read_text(encoding="utf-8"))
        joined = "\n".join(argv)
        assert "--remote-debugging-port=0" in argv
        assert "--force-webrtc-ip-handling-policy=disable_non_proxied_udp" in argv
        assert [arg for arg in argv if arg.startswith("--proxy-server=")] == [
            "--proxy-server=https://proxy.example.invalid:18443"
        ]
        load_args = [arg for arg in argv if arg.startswith("--load-extension=")]
        disable_args = [arg for arg in argv if arg.startswith("--disable-extensions-except=")]
        assert len(load_args) == 1
        assert len(disable_args) == 1
        assert load_args[0].split("=", 1)[1] == disable_args[0].split("=", 1)[1]
        extension_dirs = [Path(value) for value in load_args[0].split("=", 1)[1].split(",")]
        assert len(extension_dirs) == 2
        assert all(path.is_dir() for path in extension_dirs)
        assert sum((path / WORKER_SCRIPT_NAME).is_file() for path in extension_dirs) == 1
        assert sum((path / "identity_protector.js").is_file() for path in extension_dirs) == 1
        for sentinel in SENTINEL_VALUES:
            assert sentinel not in joined
        assert "direct://" not in joined

        status = chromium.status(tmp_path)
        assert status["runningCount"] == 1
        assert status["profiles"] == [
            {
                "profileId": profile["id"],
                "status": "running",
                "pid": launch["pid"],
                "startedAt": launch["startedAt"],
                "userDataDir": profile["storage"]["userDataDir"],
            }
        ]
        encoded_status = json.dumps(status, sort_keys=True)
        encoded_registry = (tmp_path / "profile-store" / "runtime" / "chromium-processes.json").read_text(
            encoding="utf-8"
        )
        redacted_runtime_surfaces = [encoded_status, encoded_registry]
        for surface in redacted_runtime_surfaces:
            assert "ws://" not in surface
            assert "--remote-debugging-port" not in surface
            assert "proxy-auth-extensions" not in surface
            for extension_dir in extension_dirs:
                assert str(extension_dir) not in surface
            for sentinel in SENTINEL_VALUES:
                assert sentinel not in surface

        stopped = chromium.stop(tmp_path, profile["id"])
        assert stopped["status"] == "stopped"
        assert stopped["termination"] in {"graceful", "reconciled"}
        assert stopped["runningCount"] == 0
        assert chromium.status(tmp_path) == {"runningCount": 0, "profiles": [], "reconciled": []}
    finally:
        chromium.stop(tmp_path, profile["id"])
