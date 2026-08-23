"""Tests for the identity v2 surfaces: geolocation, media devices, port scan.

Masking is not monotonic -- a profile whose masked surfaces contradict each other
is more identifiable than one that masked nothing. So these tests care as much
about the cross-surface warnings as about each surface's own bounds.
"""

import copy

import pytest

from theprivator_sidecar.identity import (
    DEFAULT_REAL_IDENTITY,
    GEOLOCATION_COORDINATE_DECIMALS,
    IDENTITY_VERSION,
    SUPPORTED_MODES_BY_SURFACE,
    curated_preset,
    describe_surfaces,
    normalize_identity,
    warnings_for_identity,
)
from theprivator_sidecar.identity_runtime import build_identity_runtime_plan
from theprivator_sidecar.protocol import IDENTITY_INVALID, IDENTITY_UNSUPPORTED_MODE, SidecarError

V2_SURFACES = ("geolocation", "mediaDevices", "ports")


def with_surface(surface, payload):
    identity = copy.deepcopy(DEFAULT_REAL_IDENTITY)
    identity[surface] = payload
    return identity


def codes(identity):
    return {warning["code"] for warning in warnings_for_identity(identity)}


def test_a_v1_identity_is_upgraded_rather_than_rejected():
    """Every stored profile predates these surfaces; refusing them would make the
    library unreadable after an update."""
    v1 = {key: value for key, value in copy.deepcopy(DEFAULT_REAL_IDENTITY).items() if key not in V2_SURFACES}
    v1["identityVersion"] = 1

    normalized = normalize_identity(v1)

    assert normalized["identityVersion"] == IDENTITY_VERSION
    for surface in V2_SURFACES:
        assert normalized[surface]["mode"] == "real", f"{surface} should start inert"


def test_upgrading_a_v1_identity_changes_nothing_the_browser_can_see():
    v1 = {key: value for key, value in copy.deepcopy(DEFAULT_REAL_IDENTITY).items() if key not in V2_SURFACES}
    v1["identityVersion"] = 1

    plan = build_identity_runtime_plan(normalize_identity(v1))

    assert plan.extension_config == {}
    assert plan.cdp_overrides == {}
    assert plan.launch_flags == []


def test_geolocation_has_no_masked_mode():
    """Masked would mean "derive it from the proxy exit", which needs a geo-IP
    lookup inside the launch budget on every start -- leaking the exit to a third
    party in order to hide it from the page."""
    assert SUPPORTED_MODES_BY_SURFACE["geolocation"] == {"real", "custom"}

    with pytest.raises(SidecarError) as exc_info:
        normalize_identity(with_surface("geolocation", {"mode": "masked", "permission": "allow"}))

    assert exc_info.value.code == IDENTITY_UNSUPPORTED_MODE


def test_coordinates_are_rounded_because_precision_is_itself_a_signal():
    # A real device reports a handful of decimals; seventeen significant digits
    # marks a profile out more clearly than a wrong city would.
    normalized = normalize_identity(
        with_surface(
            "geolocation",
            {
                "mode": "custom",
                "permission": "allow",
                "latitude": 52.229676123456789,
                "longitude": 21.012228987654321,
                "accuracy": 50,
                "altitude": None,
            },
        )
    )["geolocation"]

    assert normalized["latitude"] == round(52.229676123456789, GEOLOCATION_COORDINATE_DECIMALS)
    assert normalized["longitude"] == round(21.012228987654321, GEOLOCATION_COORDINATE_DECIMALS)


@pytest.mark.parametrize(
    ("surface", "payload"),
    [
        ("geolocation", {"mode": "custom", "permission": "allow", "latitude": 91, "longitude": 0, "accuracy": 10}),
        ("geolocation", {"mode": "custom", "permission": "allow", "latitude": 0, "longitude": 181, "accuracy": 10}),
        ("geolocation", {"mode": "custom", "permission": "allow", "latitude": 0, "longitude": 0, "accuracy": 0}),
        ("geolocation", {"mode": "real", "permission": "sometimes"}),
        ("mediaDevices", {"mode": "custom", "videoInputs": 2, "audioInputs": 1, "audioOutputs": 1}),
        ("mediaDevices", {"mode": "custom", "videoInputs": 1, "audioInputs": 0, "audioOutputs": 1}),
        ("mediaDevices", {"mode": "custom", "videoInputs": 1, "audioInputs": 1, "audioOutputs": 9}),
        ("ports", {"mode": "custom", "allowedPorts": [0]}),
        ("ports", {"mode": "custom", "allowedPorts": [70000]}),
        ("ports", {"mode": "custom", "allowedPorts": list(range(1, 60))}),
    ],
)
def test_out_of_bounds_values_are_rejected(surface, payload):
    with pytest.raises(SidecarError) as exc_info:
        normalize_identity(with_surface(surface, payload))

    assert exc_info.value.code in {IDENTITY_INVALID, IDENTITY_UNSUPPORTED_MODE}


def test_allowed_ports_are_deduplicated_and_ordered():
    normalized = normalize_identity(with_surface("ports", {"mode": "custom", "allowedPorts": [5900, 3389, 3389]}))

    assert normalized["ports"]["allowedPorts"] == [3389, 5900]


def test_a_position_the_page_may_never_read_is_flagged():
    identity = with_surface(
        "geolocation",
        {"mode": "custom", "permission": "block", "latitude": 0.0, "longitude": 0.0, "accuracy": 50, "altitude": None},
    )

    assert "IDENTITY_GEOLOCATION_WITHOUT_PERMISSION" in codes(identity)


def test_a_position_on_the_wrong_continent_from_the_timezone_is_flagged():
    identity = copy.deepcopy(curated_preset("windows-10-chrome-120"))
    assert identity["locale"]["timezoneId"].startswith("America/")
    identity["geolocation"] = {
        "mode": "custom",
        "permission": "allow",
        "latitude": 52.23,  # Warsaw
        "longitude": 21.01,
        "accuracy": 50,
        "altitude": None,
    }

    assert "IDENTITY_GEOLOCATION_TIMEZONE_MISMATCH" in codes(identity)


def test_a_position_matching_the_timezone_region_is_not_flagged():
    identity = copy.deepcopy(curated_preset("windows-10-chrome-120"))
    identity["geolocation"] = {
        "mode": "custom",
        "permission": "allow",
        "latitude": 34.05,  # Los Angeles, still America/*
        "longitude": -118.24,
        "accuracy": 50,
        "altitude": None,
    }

    assert "IDENTITY_GEOLOCATION_TIMEZONE_MISMATCH" not in codes(identity)


def test_a_camera_with_no_microphone_is_flagged():
    identity = with_surface("mediaDevices", {"mode": "custom", "videoInputs": 1, "audioInputs": 1, "audioOutputs": 1})
    assert "IDENTITY_MEDIA_DEVICES_UNUSUAL" not in codes(identity)


def test_a_broad_port_allowlist_is_flagged():
    identity = with_surface("ports", {"mode": "custom", "allowedPorts": list(range(3000, 3025))})

    assert "IDENTITY_PORTS_ALLOWLIST_BROAD" in codes(identity)


def test_masked_media_devices_stay_the_same_across_launches():
    """A device list that changes on every launch is a stronger signal than an
    unusual one that stays put."""
    identity = with_surface("mediaDevices", {"mode": "masked", "noiseSeed": 12345})

    first = build_identity_runtime_plan(normalize_identity(identity)).extension_config["mediaDevices"]
    second = build_identity_runtime_plan(normalize_identity(identity)).extension_config["mediaDevices"]

    assert first == second


def test_every_curated_preset_is_warning_free_with_the_new_surfaces():
    # validate_curated_presets runs at import, so a preset that warns takes the
    # whole module down rather than just itself.
    for preset_id in ("windows-10-chrome-120", "windows-11-chrome-121", "macos-ventura-chrome-120", "ubuntu-linux-chrome-120"):
        assert warnings_for_identity(curated_preset(preset_id)) == []


def test_the_described_contract_matches_the_normalizer():
    described = describe_surfaces()

    assert described["identityVersion"] == IDENTITY_VERSION
    assert {surface["id"] for surface in described["surfaces"]} == set(SUPPORTED_MODES_BY_SURFACE)
    for surface in described["surfaces"]:
        assert sorted(SUPPORTED_MODES_BY_SURFACE[surface["id"]]) == surface["modes"]
