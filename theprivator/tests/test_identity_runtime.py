"""Tests for S02 identity-to-runtime launch artifact planning."""

import copy
import json
from pathlib import Path

import pytest

from theprivator_sidecar.identity import DEFAULT_REAL_IDENTITY, IDENTITY_VERSION, curated_preset, warnings_for_identity
from theprivator_sidecar.protocol import IDENTITY_EXTENSION_FAILED, IDENTITY_INVALID, SidecarError
from theprivator_sidecar.identity_extension import (
    CONFIG_SCRIPT_NAME,
    PROTECTOR_SCRIPT_NAME,
    generate_identity_extension,
    validate_identity_extension,
)
from theprivator_sidecar.identity_runtime import RUNTIME_PLAN_SCHEMA_VERSION, build_identity_runtime_plan


FORBIDDEN_GENERATED_TEXT = (
    "DevToolsActivePort",
    "ws://",
    "--remote-debugging-port",
    "debugPort",
    "Traceback",
    "Identity Profile Should Not Leak",
    # The generated content script runs in the page's MAIN world, so its text is
    # part of what a site can reach. Naming the technique there tells a checker
    # what to look for, which is the opposite of the point.
    "fingerprint",
)


def assert_sidecar_error(exc_info: pytest.ExceptionInfo[SidecarError], code: str) -> SidecarError:
    error = exc_info.value
    assert error.code == code
    assert error.recoverable is True
    assert error.detail_ref.startswith("sidecar-")
    assert error.message
    assert "Traceback" not in error.message
    return error


def assert_json_safe(payload):
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    assert "Traceback" not in encoded
    return encoded


def read_generated_files(extension_dir: Path) -> dict[str, str]:
    return {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted(extension_dir.iterdir())
        if path.is_file()
    }


def test_curated_preset_maps_to_bounded_extension_cdp_and_webrtc_artifacts():
    identity = curated_preset("ubuntu-linux-chrome-120")
    assert warnings_for_identity(identity) == []

    plan = build_identity_runtime_plan(identity)

    assert plan.requires_extension is True
    assert plan.requires_cdp is True
    assert plan.extension_config == {
        "schemaVersion": RUNTIME_PLAN_SCHEMA_VERSION,
        "navigator": {
            "platform": "Linux x86_64",
            "hardwareConcurrency": 8,
            "deviceMemory": 8,
            "userAgentData": {
                "platform": "Linux",
                "platformVersion": "",
                "architecture": "x86",
                "mobile": False,
                "model": "",
                "bitness": "64",
                "brands": [
                    {"brand": "Chromium", "version": "120"},
                    {"brand": "Google Chrome", "version": "120"},
                    {"brand": "Not=A?Brand", "version": "99"},
                ],
                "fullVersionList": [
                    {"brand": "Chromium", "version": "120.0.0.0"},
                    {"brand": "Google Chrome", "version": "120.0.0.0"},
                    {"brand": "Not=A?Brand", "version": "99.0.0.0"},
                ],
                "fullVersion": "120.0.0.0",
                "wow64": False,
            },
        },
        "locale": {
            "locale": "en-US",
            "languages": ["en-US", "en"],
            "timezoneId": "America/New_York",
        },
        "screen": {
            "width": 1920,
            "height": 1080,
            "viewportWidth": 1920,
            "viewportHeight": 1032,
            "colorDepth": 24,
            "pixelRatio": 1.0,
        },
        "canvas": {"enabled": True, "noiseSeed": 120030},
        "audio": {"enabled": True, "noiseSeed": 120031},
        "webgl": {
            "enabled": True,
            "vendor": "Google Inc. (Intel)",
            "renderer": "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
            "noiseSeed": 120032,
        },
        "webrtc": {"policy": "disableNonProxiedUdp"},
    }
    assert plan.cdp_overrides["userAgent"] == {
        "userAgent": identity["browser"]["userAgent"],
        "acceptLanguage": "en-US,en",
        "platform": "Linux x86_64",
        "userAgentMetadata": {
            "platform": "Linux",
            "platformVersion": "",
            "architecture": "x86",
            "mobile": False,
            "model": "",
            "bitness": "64",
            "brands": [
                {"brand": "Chromium", "version": "120"},
                {"brand": "Google Chrome", "version": "120"},
                {"brand": "Not=A?Brand", "version": "99"},
            ],
            "fullVersionList": [
                {"brand": "Chromium", "version": "120.0.0.0"},
                {"brand": "Google Chrome", "version": "120.0.0.0"},
                {"brand": "Not=A?Brand", "version": "99.0.0.0"},
            ],
            "fullVersion": "120.0.0.0",
            "wow64": False,
        },
    }
    assert plan.extension_config["navigator"]["userAgentData"] == plan.cdp_overrides["userAgent"]["userAgentMetadata"]
    assert plan.cdp_overrides["locale"] == {"locale": "en-US"}
    assert plan.cdp_overrides["timezone"] == {"timezoneId": "America/New_York"}
    assert plan.cdp_overrides["deviceMetrics"] == {
        "width": 1920,
        "height": 1032,
        "deviceScaleFactor": 1.0,
        "mobile": False,
        "screenWidth": 1920,
        "screenHeight": 1080,
    }
    assert plan.launch_flags == [
        "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "--lang=en-US",
        "--window-size=1920,1032",
        "--force-device-scale-factor=1.0",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ]
    assert "label" not in plan.to_dict()
    assert_json_safe(plan.to_dict())


def test_user_agent_metadata_prefers_browser_client_hints_and_falls_back_to_navigator_fields():
    identity = curated_preset("windows-10-chrome-120")
    identity["browser"]["clientHints"] = {
        "platform": "Windows",
        "platformVersion": "11.0.0",
        "mobile": False,
        "model": "",
    }

    plan = build_identity_runtime_plan(identity)

    expected_metadata = {
        "platform": "Windows",
        "platformVersion": "11.0.0",
        "architecture": "x86",
        "mobile": False,
        "model": "",
        "bitness": "64",
        "brands": [
            {"brand": "Chromium", "version": "120"},
            {"brand": "Google Chrome", "version": "120"},
            {"brand": "Not=A?Brand", "version": "99"},
        ],
        "fullVersionList": [
            {"brand": "Chromium", "version": "120.0.0.0"},
            {"brand": "Google Chrome", "version": "120.0.0.0"},
            {"brand": "Not=A?Brand", "version": "99.0.0.0"},
        ],
        "fullVersion": "120.0.0.0",
        "wow64": False,
    }
    assert plan.extension_config["navigator"]["userAgentData"] == expected_metadata
    assert plan.cdp_overrides["userAgent"]["userAgentMetadata"] == expected_metadata


def test_default_real_identity_maps_to_noop_runtime_plan():
    plan = build_identity_runtime_plan(DEFAULT_REAL_IDENTITY)

    assert plan.requires_extension is False
    assert plan.requires_cdp is False
    assert plan.extension_config == {}
    assert plan.cdp_overrides == {}
    assert plan.launch_flags == []
    assert plan.to_dict() == {
        "identityVersion": IDENTITY_VERSION,
        "presetId": None,
        "requiresExtension": False,
        "requiresCdp": False,
        "extensionConfig": {},
        "cdpOverrides": {},
        "launchFlags": [],
    }


def test_extension_generation_writes_main_world_document_start_config_before_protector(tmp_path):
    plan = build_identity_runtime_plan(curated_preset("ubuntu-linux-chrome-120"))

    artifact = generate_identity_extension(tmp_path, "profile/../id", plan)

    assert artifact.extension_dir.is_dir()
    assert artifact.profile_key.startswith("profile-")
    assert "/" not in artifact.profile_key
    assert artifact.files == ["manifest.json", CONFIG_SCRIPT_NAME, PROTECTOR_SCRIPT_NAME]
    manifest = json.loads((artifact.extension_dir / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["manifest_version"] == 3
    content_script = manifest["content_scripts"][0]
    assert content_script["js"] == [CONFIG_SCRIPT_NAME, PROTECTOR_SCRIPT_NAME]
    assert content_script["run_at"] == "document_start"
    assert content_script["world"] == "MAIN"
    assert content_script["all_frames"] is True
    assert content_script["match_about_blank"] is True

    generated = read_generated_files(artifact.extension_dir)
    assert "fetch(" not in generated[CONFIG_SCRIPT_NAME]
    assert "config.json" not in generated[CONFIG_SCRIPT_NAME]
    assert "__THEPRIVATOR_IDENTITY_CONFIG__" in generated[CONFIG_SCRIPT_NAME]
    assert "Object.freeze" in generated[CONFIG_SCRIPT_NAME]
    assert "Navigator.prototype" in generated[PROTECTOR_SCRIPT_NAME]
    assert "Screen.prototype" in generated[PROTECTOR_SCRIPT_NAME]
    assert "RTCPeerConnection" in generated[PROTECTOR_SCRIPT_NAME]
    assert "getHighEntropyValues" in generated[PROTECTOR_SCRIPT_NAME]
    assert "fullVersionList" in generated[PROTECTOR_SCRIPT_NAME]
    assert "uaFullVersion" in generated[PROTECTOR_SCRIPT_NAME]
    assert "getFloatFrequencyData" in generated[PROTECTOR_SCRIPT_NAME]
    assert "Number.isFinite(array[i])" in generated[PROTECTOR_SCRIPT_NAME]
    combined = "\n".join(generated.values())
    for forbidden in FORBIDDEN_GENERATED_TEXT:
        assert forbidden not in combined
    assert str(tmp_path) not in combined
    validate_identity_extension(artifact.extension_dir)


def test_extension_generation_replaces_stale_profile_directory_and_keeps_errors_redacted(tmp_path):
    plan = build_identity_runtime_plan(curated_preset("windows-10-chrome-120"))
    first = generate_identity_extension(tmp_path, "profile-id", plan)
    stale = first.extension_dir / "stale.txt"
    stale.write_text("stale", encoding="utf-8")

    second = generate_identity_extension(tmp_path, "profile-id", plan)

    assert second.extension_dir == first.extension_dir
    assert not stale.exists()

    occupied_root = tmp_path / "not-a-directory"
    occupied_root.write_text("file", encoding="utf-8")
    with pytest.raises(SidecarError) as exc_info:
        generate_identity_extension(occupied_root, "profile-id", plan)

    error = assert_sidecar_error(exc_info, IDENTITY_EXTENSION_FAILED)
    assert error.message == "Identity extension could not be prepared."
    assert str(occupied_root) not in error.message
    assert "profile-id" not in error.message


def test_extension_validation_rejects_missing_files_invalid_manifest_and_unsafe_config(tmp_path):
    plan = build_identity_runtime_plan(curated_preset("macos-ventura-chrome-120"))
    artifact = generate_identity_extension(tmp_path, "profile-id", plan)

    (artifact.extension_dir / PROTECTOR_SCRIPT_NAME).unlink()
    with pytest.raises(SidecarError) as missing_exc:
        validate_identity_extension(artifact.extension_dir)
    assert_sidecar_error(missing_exc, IDENTITY_EXTENSION_FAILED)

    artifact = generate_identity_extension(tmp_path, "profile-id", plan)
    (artifact.extension_dir / "manifest.json").write_text("{not-json", encoding="utf-8")
    with pytest.raises(SidecarError) as manifest_exc:
        validate_identity_extension(artifact.extension_dir)
    assert_sidecar_error(manifest_exc, IDENTITY_EXTENSION_FAILED)

    unsafe_config = copy.deepcopy(plan.extension_config)
    unsafe_config["debugPort"] = 9222
    with pytest.raises(SidecarError) as unsafe_exc:
        generate_identity_extension(tmp_path, "profile-id", unsafe_config)
    error = assert_sidecar_error(unsafe_exc, IDENTITY_EXTENSION_FAILED)
    assert "debugPort" not in error.message
    assert "9222" not in error.message

    invalid_seed = copy.deepcopy(plan.extension_config)
    invalid_seed["audio"]["noiseSeed"] = "not-a-number"
    with pytest.raises(SidecarError) as seed_exc:
        generate_identity_extension(tmp_path, "profile-id", invalid_seed)
    assert_sidecar_error(seed_exc, IDENTITY_EXTENSION_FAILED)

    invalid_webrtc = copy.deepcopy(plan.extension_config)
    invalid_webrtc["webrtc"]["policy"] = "leakLocalIps"
    with pytest.raises(SidecarError) as webrtc_exc:
        generate_identity_extension(tmp_path, "profile-id", invalid_webrtc)
    assert_sidecar_error(webrtc_exc, IDENTITY_EXTENSION_FAILED)

    invalid_uadata = copy.deepcopy(plan.extension_config)
    invalid_uadata["navigator"]["userAgentData"]["brands"] = [{"brand": "Chromium"}]
    with pytest.raises(SidecarError) as uadata_exc:
        generate_identity_extension(tmp_path, "profile-id", invalid_uadata)
    assert_sidecar_error(uadata_exc, IDENTITY_EXTENSION_FAILED)


def test_runtime_mapping_rejects_invalid_identity_before_artifact_planning():
    invalid_identity = copy.deepcopy(DEFAULT_REAL_IDENTITY)
    invalid_identity["browser"] = {"mode": "masked", "userAgent": "bad\x00ua"}

    with pytest.raises(SidecarError) as exc_info:
        build_identity_runtime_plan(invalid_identity)

    assert_sidecar_error(exc_info, IDENTITY_INVALID)


def test_runtime_and_extension_modules_do_not_import_legacy_fingerprint_dataclasses():
    """These modules must not couple to the legacy GUI package.

    The check is on imports and the legacy type names, not on the word
    "fingerprint" appearing anywhere. Banning the word bans it from comments too,
    and these are the fingerprinting modules -- a comment explaining why a local
    page probing its own host is not a fingerprinting attempt is exactly the kind
    of prose that belongs here.
    """
    for relative in ("theprivator_sidecar/identity_runtime.py", "theprivator_sidecar/identity_extension.py"):
        source = Path(relative).read_text(encoding="utf-8")
        assert "ChromiumProfile" not in source
        assert "FingerprintConfig" not in source
        assert "profile_manager" not in source
        assert "from theprivator." not in source
        assert "import theprivator." not in source
        assert "theprivator.core" not in source
        assert "theprivator.utils" not in source
