"""Tests for the sidecar-owned identity v1 contract."""

import copy
import json

import pytest

from theprivator_sidecar.identity import (
    CURATED_PRESETS,
    DEFAULT_REAL_IDENTITY,
    IDENTITY_VERSION,
    MAX_LANGUAGE_COUNT,
    SUPPORTED_MODES_BY_SURFACE,
    curated_preset,
    normalize_identity,
    validate_curated_presets,
    validate_identity,
    warnings_for_identity,
)
from theprivator_sidecar.protocol import (
    IDENTITY_INVALID,
    IDENTITY_PRESET_NOT_FOUND,
    IDENTITY_UNSUPPORTED_MODE,
    SidecarError,
)


EXPECTED_PRESET_IDS = {
    "windows-10-chrome-120",
    "windows-11-chrome-121",
    "macos-ventura-chrome-120",
    "ubuntu-linux-chrome-120",
}
EXPECTED_SURFACES = {
    "browser",
    "navigator",
    "screen",
    "locale",
    "canvas",
    "audio",
    "webgl",
    "webrtc",
}


def assert_identity_error(exc_info, code):
    error = exc_info.value
    assert isinstance(error, SidecarError)
    assert error.code == code
    assert error.recoverable is True
    assert error.detail_ref.startswith("sidecar-")
    assert error.message
    return error


def assert_json_safe(payload):
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    assert "Traceback" not in encoded
    return encoded


def with_change(identity, path, value):
    changed = copy.deepcopy(identity)
    target = changed
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    return changed


def warning_codes(identity):
    warnings = warnings_for_identity(identity)
    assert_json_safe(warnings)
    for warning in warnings:
        assert set(warning) == {"code", "message", "surface", "path"}
        assert isinstance(warning["code"], str) and warning["code"].startswith("IDENTITY_")
        assert isinstance(warning["message"], str) and warning["message"]
        assert warning["surface"] in EXPECTED_SURFACES
        assert isinstance(warning["path"], str) and warning["path"].startswith(warning["surface"])
    return {warning["code"] for warning in warnings}


def test_default_real_identity_validates_with_zero_warnings():
    normalized = validate_identity(DEFAULT_REAL_IDENTITY)

    assert normalized == DEFAULT_REAL_IDENTITY
    assert normalized["identityVersion"] == IDENTITY_VERSION
    assert normalized["label"] == "Real identity"
    assert normalized["presetId"] is None
    assert set(normalized) == {"identityVersion", "label", "presetId", *EXPECTED_SURFACES}
    assert {surface: normalized[surface]["mode"] for surface in EXPECTED_SURFACES} == {
        "browser": "real",
        "navigator": "real",
        "screen": "real",
        "locale": "real",
        "canvas": "real",
        "audio": "real",
        "webgl": "real",
        "webrtc": "real",
    }
    assert warning_codes(normalized) == set()
    assert_json_safe(normalized)


def test_curated_preset_table_has_stable_desktop_chromium_ids_only():
    assert set(CURATED_PRESETS) == EXPECTED_PRESET_IDS
    assert SUPPORTED_MODES_BY_SURFACE == {
        "browser": {"real", "masked", "custom"},
        "navigator": {"real", "masked", "custom"},
        "screen": {"real", "masked", "custom"},
        "locale": {"real", "masked", "custom"},
        "canvas": {"real", "noise"},
        "audio": {"real", "noise"},
        "webgl": {"real", "masked", "custom"},
        "webrtc": {"real", "masked", "custom"},
    }


@pytest.mark.parametrize("preset_id", sorted(EXPECTED_PRESET_IDS))
def test_curated_desktop_chromium_presets_validate_with_zero_warnings(preset_id):
    identity = curated_preset(preset_id)
    normalized = validate_identity(identity)

    assert normalized == identity
    assert normalized["presetId"] == preset_id
    assert normalized["identityVersion"] == IDENTITY_VERSION
    assert "Chrome/" in normalized["browser"]["userAgent"]
    assert normalized["browser"]["clientHints"]["mobile"] is False
    assert normalized["navigator"]["uaMobile"] is False
    assert normalized["screen"]["width"] >= normalized["screen"]["viewportWidth"]
    assert normalized["screen"]["height"] >= normalized["screen"]["viewportHeight"]
    assert normalized["canvas"] == {"mode": "noise", "noiseSeed": normalized["canvas"]["noiseSeed"]}
    assert normalized["audio"] == {"mode": "noise", "noiseSeed": normalized["audio"]["noiseSeed"]}
    assert warning_codes(normalized) == set()
    assert_json_safe(normalized)


def test_unknown_preset_id_raises_typed_recoverable_error():
    identity = with_change(DEFAULT_REAL_IDENTITY, ["presetId"], "missing-preset")

    with pytest.raises(SidecarError) as exc_info:
        normalize_identity(identity)

    assert_identity_error(exc_info, IDENTITY_PRESET_NOT_FOUND)


@pytest.mark.parametrize(
    ("identity", "code"),
    [
        ("not-an-object", IDENTITY_INVALID),
        ({"label": "missing version"}, IDENTITY_INVALID),
        (with_change(DEFAULT_REAL_IDENTITY, ["identityVersion"], 2), IDENTITY_INVALID),
        ({**DEFAULT_REAL_IDENTITY, "unknownSurface": {"mode": "real"}}, IDENTITY_INVALID),
        (with_change(curated_preset("windows-10-chrome-120"), ["browser", "mode"], "spoofed"), IDENTITY_UNSUPPORTED_MODE),
        (with_change(curated_preset("windows-10-chrome-120"), ["browser", "mode"], "noise"), IDENTITY_UNSUPPORTED_MODE),
        (with_change(DEFAULT_REAL_IDENTITY, ["canvas", "mode"], "custom"), IDENTITY_UNSUPPORTED_MODE),
        (with_change(curated_preset("windows-10-chrome-120"), ["locale", "languages"], ["en-US", "bad language"]), IDENTITY_INVALID),
        (with_change(curated_preset("windows-10-chrome-120"), ["locale", "timezoneId"], "not a timezone"), IDENTITY_INVALID),
        (with_change(curated_preset("windows-10-chrome-120"), ["screen", "width"], -1), IDENTITY_INVALID),
        (with_change(curated_preset("windows-10-chrome-120"), ["canvas", "noiseSeed"], 1.5), IDENTITY_INVALID),
        (with_change(curated_preset("windows-10-chrome-120"), ["webgl", "vendor"], ""), IDENTITY_INVALID),
    ],
)
def test_malformed_inputs_raise_typed_recoverable_errors(identity, code):
    with pytest.raises(SidecarError) as exc_info:
        normalize_identity(identity)

    assert_identity_error(exc_info, code)


def test_malformed_built_in_preset_table_fails_validation_with_detail_ref():
    malformed = {
        "broken-preset": with_change(DEFAULT_REAL_IDENTITY, ["browser", "mode"], "noise")
    }
    malformed["broken-preset"]["presetId"] = "broken-preset"

    with pytest.raises(SidecarError) as exc_info:
        validate_curated_presets(malformed)

    assert_identity_error(exc_info, IDENTITY_UNSUPPORTED_MODE)


def test_maximum_language_bounds_normalize_to_json_safe_lists():
    languages = ["en-US", "en-GB", "de-DE", "fr-FR", "es-ES", "it-IT", "pt-BR", "nl-NL"]
    assert len(languages) == MAX_LANGUAGE_COUNT
    identity = with_change(curated_preset("ubuntu-linux-chrome-120"), ["locale", "languages"], tuple(languages))

    normalized = normalize_identity(identity)

    assert normalized["locale"]["languages"] == languages
    assert isinstance(normalized["locale"]["languages"], list)
    assert warning_codes(normalized) == set()
    assert_json_safe(normalized)


def test_oversized_language_lists_are_rejected_before_persistence():
    identity = with_change(
        curated_preset("ubuntu-linux-chrome-120"),
        ["locale", "languages"],
        ["en-US"] * (MAX_LANGUAGE_COUNT + 1),
    )

    with pytest.raises(SidecarError) as exc_info:
        normalize_identity(identity)

    assert_identity_error(exc_info, IDENTITY_INVALID)


@pytest.mark.parametrize(
    ("identity", "expected_codes"),
    [
        (
            with_change(
                with_change(curated_preset("windows-10-chrome-120"), ["screen", "width"], 900),
                ["screen", "height"],
                1440,
            ),
            {"IDENTITY_DESKTOP_PORTRAIT_SCREEN"},
        ),
        (
            with_change(curated_preset("windows-10-chrome-120"), ["screen", "viewportWidth"], 2560),
            {"IDENTITY_VIEWPORT_EXCEEDS_SCREEN"},
        ),
        (
            with_change(curated_preset("windows-10-chrome-120"), ["navigator", "platform"], "MacIntel"),
            {"IDENTITY_UA_PLATFORM_MISMATCH"},
        ),
        (
            with_change(
                with_change(
                    curated_preset("windows-10-chrome-120"),
                    ["browser", "userAgent"],
                    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
                ),
                ["navigator", "uaMobile"],
                False,
            ),
            {"IDENTITY_MOBILE_FLAG_MISMATCH"},
        ),
        (
            with_change(
                with_change(curated_preset("windows-10-chrome-120"), ["navigator", "hardwareConcurrency"], 3),
                ["navigator", "deviceMemory"],
                3,
            ),
            {"IDENTITY_UNUSUAL_CPU", "IDENTITY_UNUSUAL_DEVICE_MEMORY"},
        ),
    ],
)
def test_suspicious_but_possible_overrides_return_warnings_without_hard_error(identity, expected_codes):
    normalized = normalize_identity(identity)

    assert expected_codes <= warning_codes(normalized)
    assert validate_identity(identity) == normalized
