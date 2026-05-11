"""Tests for the sidecar-owned persistent profile store."""

import copy
import json
from pathlib import Path
from typing import Any, Mapping

import pytest

from theprivator_sidecar.identity import DEFAULT_REAL_IDENTITY, curated_preset
from theprivator_sidecar.proxy import (
    CREDENTIAL_STATE_CONFIGURED,
    CREDENTIAL_STATE_NONE,
    DIRECT_PROXY_MODE,
    FIXED_SERVER_PROXY_MODE,
    PROXY_VERSION,
    default_proxy_config,
)
from theprivator_sidecar.profiles import (
    PROFILE_DELETE_FAILED,
    PROFILE_DUPLICATE_NAME,
    PROFILE_INVALID_NAME,
    PROFILE_NOT_FOUND,
    PROFILE_STORE_CORRUPT,
    PROFILE_STORE_WRITE_FAILED,
    ProfileRecord,
    ProfileStore,
    STORE_VERSION,
)
from theprivator_sidecar.protocol import (
    IDENTITY_INVALID,
    IDENTITY_UNSUPPORTED_MODE,
    INVALID_REQUEST,
    PROXY_INVALID,
    PROXY_PAC_UNSUPPORTED,
    SidecarError,
)


def assert_profile_error(exc_info, code):
    error = exc_info.value
    assert isinstance(error, SidecarError)
    assert error.code == code
    assert error.recoverable is True
    assert error.detail_ref.startswith("sidecar-")
    return error


def profile_names(result):
    return [profile["name"] for profile in result["profiles"]]


def assert_default_identity(profile: Mapping[str, Any]) -> None:
    assert profile["identity"] == DEFAULT_REAL_IDENTITY
    assert profile["identity"]["identityVersion"] == 1


def assert_public_direct_proxy(profile: Mapping[str, Any]) -> None:
    assert profile["proxy"] == {
        "proxyVersion": PROXY_VERSION,
        "mode": DIRECT_PROXY_MODE,
        "credentialState": CREDENTIAL_STATE_NONE,
        "summary": "Direct connection",
    }
    assert profile["defaults"]["proxyMode"] == DIRECT_PROXY_MODE


def assert_store_direct_proxy(profile: Mapping[str, Any]) -> None:
    assert profile["proxy"] == default_proxy_config()
    assert profile["defaults"]["proxyMode"] == DIRECT_PROXY_MODE


def assert_public_profile_has_no_proxy_credentials(profile: Mapping[str, Any]) -> None:
    encoded = json.dumps(profile, ensure_ascii=False, sort_keys=True)
    assert "credentials" not in profile["proxy"]
    assert "username" not in encoded
    assert "password" not in encoded
    assert "proxy-user-sentinel" not in encoded
    assert "proxy-pass-sentinel" not in encoded


def assert_no_runtime_or_absolute_truth(profile: Mapping[str, Any], root: Path) -> None:
    forbidden_keys = {
        "pid",
        "status",
        "process",
        "command",
        "debugPort",
        "remoteDebuggingPort",
        "remoteControlPort",
        "startedAt",
        "stoppedAt",
    }
    encoded = json.dumps(profile, ensure_ascii=False, sort_keys=True)
    assert forbidden_keys.isdisjoint(profile.keys())
    assert not any(f'"{key}"' in encoded for key in forbidden_keys)
    assert str(root) not in encoded
    assert not Path(profile["storage"]["profileDir"]).is_absolute()
    assert not Path(profile["storage"]["userDataDir"]).is_absolute()


def with_identity_change(identity: Mapping[str, Any], path: list[str], value: Any) -> dict[str, Any]:
    changed = copy.deepcopy(identity)
    target: dict[str, Any] = changed
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    return changed


def write_profiles_payload(root: Path, payload: Mapping[str, Any]) -> Path:
    store_file = root / "profile-store" / "profiles.json"
    store_file.parent.mkdir(parents=True)
    store_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return store_file


def v1_profile_payload(name: str = "Legacy") -> dict[str, Any]:
    payload = ProfileRecord.create(name).to_store_dict()
    payload.pop("identity", None)
    payload.pop("proxy", None)
    return payload


def v2_profile_payload(name: str = "Legacy", identity: Mapping[str, Any] | None = None) -> dict[str, Any]:
    payload = ProfileRecord.create(name).to_store_dict()
    payload.pop("proxy", None)
    if identity is not None:
        payload["identity"] = copy.deepcopy(identity)
    return payload


def public_equivalent_for_store_profile(store_profile: Mapping[str, Any], public_proxy: Mapping[str, Any]) -> dict[str, Any]:
    public = copy.deepcopy(dict(store_profile))
    public["proxy"] = dict(public_proxy)
    return public


def test_empty_store_returns_versioned_empty_collection(tmp_path):
    assert STORE_VERSION == 3
    result = ProfileStore(tmp_path).list()

    assert result == {"storeVersion": 3, "profiles": [], "count": 0}


def test_create_profile_persists_defaults_and_relative_storage_paths(tmp_path):
    store = ProfileStore(tmp_path)

    result = store.create("Research")

    assert result["storeVersion"] == 3
    assert result["count"] == 1
    assert len(result["profiles"]) == 1
    assert result["profile"] == result["profiles"][0]

    profile = result["profile"]
    assert profile["id"]
    assert profile["name"] == "Research"
    assert profile["createdAt"].endswith("Z")
    assert profile["updatedAt"].endswith("Z")
    assert profile["defaults"] == {
        "browser": "chromium",
        "startUrl": "about:blank",
        "proxyMode": "direct",
        "fingerprintMode": "disabled",
    }
    assert profile["storage"] == {
        "profileDir": f"profile-store/profiles/{profile['id']}",
        "userDataDir": f"profile-store/profiles/{profile['id']}/user-data",
    }
    assert_default_identity(profile)
    assert_public_direct_proxy(profile)
    assert_public_profile_has_no_proxy_credentials(profile)
    assert_no_runtime_or_absolute_truth(profile, tmp_path)
    assert not Path(profile["storage"]["profileDir"]).is_absolute()
    assert not Path(profile["storage"]["userDataDir"]).is_absolute()
    assert Path(tmp_path, profile["storage"]["userDataDir"]).is_dir()

    store_payload = json.loads(Path(tmp_path, "profile-store", "profiles.json").read_text())
    assert store_payload["storeVersion"] == STORE_VERSION
    stored_profile = store_payload["profiles"][0]
    assert_store_direct_proxy(stored_profile)
    assert public_equivalent_for_store_profile(stored_profile, profile["proxy"]) == profile
    assert "metadata" not in profile
    assert_no_runtime_or_absolute_truth(profile, tmp_path)

    reloaded = ProfileStore(tmp_path).list()
    assert reloaded["profiles"] == [profile]
    assert reloaded["count"] == 1


def test_v1_profiles_migrate_to_v3_with_default_identity_direct_proxy_and_rewrite(tmp_path):
    legacy_profile = v1_profile_payload("Legacy Research")
    store_file = write_profiles_payload(
        tmp_path,
        {"storeVersion": 1, "profiles": [legacy_profile]},
    )

    result = ProfileStore(tmp_path).list()

    profile = result["profiles"][0]
    assert result["storeVersion"] == 3
    assert profile["id"] == legacy_profile["id"]
    assert profile["name"] == "Legacy Research"
    assert profile["storage"] == legacy_profile["storage"]
    assert_default_identity(profile)
    assert_public_direct_proxy(profile)
    persisted = json.loads(store_file.read_text(encoding="utf-8"))
    stored_profile = persisted["profiles"][0]
    assert persisted["storeVersion"] == 3
    assert_store_direct_proxy(stored_profile)
    assert public_equivalent_for_store_profile(stored_profile, profile["proxy"]) == profile
    assert ProfileStore(tmp_path).list()["profiles"] == [profile]


def test_v2_profiles_migrate_to_v3_preserving_identity_storage_and_direct_proxy(tmp_path):
    identity = curated_preset("ubuntu-linux-chrome-120")
    legacy_profile = v2_profile_payload("Legacy Research", identity=identity)
    store_file = write_profiles_payload(
        tmp_path,
        {"storeVersion": 2, "profiles": [legacy_profile]},
    )

    result = ProfileStore(tmp_path).list()

    profile = result["profiles"][0]
    assert result["storeVersion"] == 3
    assert profile["id"] == legacy_profile["id"]
    assert profile["storage"] == legacy_profile["storage"]
    assert profile["identity"] == identity
    assert_public_direct_proxy(profile)
    persisted = json.loads(store_file.read_text(encoding="utf-8"))
    stored_profile = persisted["profiles"][0]
    assert persisted["storeVersion"] == 3
    assert stored_profile["identity"] == identity
    assert_store_direct_proxy(stored_profile)
    assert public_equivalent_for_store_profile(stored_profile, profile["proxy"]) == profile


def test_migration_write_failure_keeps_v1_file_and_returns_write_error(tmp_path, monkeypatch):
    legacy_payload = {"storeVersion": 1, "profiles": [v1_profile_payload("Legacy Research")]}
    store_file = write_profiles_payload(tmp_path, legacy_payload)
    original = store_file.read_text(encoding="utf-8")

    def fail_replace(source, destination):
        raise OSError("simulated migration replace failure")

    monkeypatch.setattr("theprivator_sidecar.profiles.os.replace", fail_replace)

    with pytest.raises(SidecarError) as exc_info:
        ProfileStore(tmp_path).list()

    assert_profile_error(exc_info, PROFILE_STORE_WRITE_FAILED)
    assert store_file.read_text(encoding="utf-8") == original


def test_migration_write_failure_keeps_v2_file_and_returns_write_error(tmp_path, monkeypatch):
    legacy_payload = {"storeVersion": 2, "profiles": [v2_profile_payload("Legacy Research")]}
    store_file = write_profiles_payload(tmp_path, legacy_payload)
    original = store_file.read_text(encoding="utf-8")

    def fail_replace(source, destination):
        raise OSError("simulated migration replace failure")

    monkeypatch.setattr("theprivator_sidecar.profiles.os.replace", fail_replace)

    with pytest.raises(SidecarError) as exc_info:
        ProfileStore(tmp_path).list()

    assert_profile_error(exc_info, PROFILE_STORE_WRITE_FAILED)
    assert store_file.read_text(encoding="utf-8") == original


def test_v1_records_missing_m001_fields_remain_corrupt_without_rewrite(tmp_path):
    payload = {"storeVersion": 1, "profiles": [{"id": v1_profile_payload()["id"], "name": "Missing"}]}
    store_file = write_profiles_payload(tmp_path, payload)
    original = store_file.read_text(encoding="utf-8")

    with pytest.raises(SidecarError) as exc_info:
        ProfileStore(tmp_path).list()

    assert_profile_error(exc_info, PROFILE_STORE_CORRUPT)
    assert store_file.read_text(encoding="utf-8") == original


def test_v2_record_missing_identity_raises_identity_error_without_rewrite(tmp_path):
    profile = v2_profile_payload("Broken")
    profile.pop("identity", None)
    payload = {"storeVersion": 2, "profiles": [profile]}
    store_file = write_profiles_payload(tmp_path, payload)
    original = store_file.read_text(encoding="utf-8")

    with pytest.raises(SidecarError) as exc_info:
        ProfileStore(tmp_path).list()

    assert_profile_error(exc_info, IDENTITY_INVALID)
    assert store_file.read_text(encoding="utf-8") == original


@pytest.mark.parametrize(
    ("mutate", "expected_code"),
    [
        (lambda profile: profile.pop("proxy", None), PROXY_INVALID),
        (
            lambda profile: profile.__setitem__(
                "proxy", {"proxyVersion": PROXY_VERSION, "mode": DIRECT_PROXY_MODE, "unexpected": True}
            ),
            PROXY_INVALID,
        ),
        (
            lambda profile: profile.__setitem__(
                "proxy", {"proxyVersion": PROXY_VERSION, "mode": "system"}
            ),
            PROXY_PAC_UNSUPPORTED,
        ),
        (
            lambda profile: profile.__setitem__(
                "proxy",
                {
                    "proxyVersion": PROXY_VERSION,
                    "mode": FIXED_SERVER_PROXY_MODE,
                    "protocol": "http",
                    "host": "proxy.example.invalid",
                    "port": 8080,
                    "credentials": {"username": "proxy-user-sentinel", "password": ""},
                },
            ),
            PROXY_INVALID,
        ),
    ],
)
def test_malformed_v3_proxy_store_fails_without_rewrite(tmp_path, mutate, expected_code):
    profile = ProfileRecord.create("Broken").to_store_dict()
    mutate(profile)
    payload = {"storeVersion": STORE_VERSION, "profiles": [profile]}
    store_file = write_profiles_payload(tmp_path, payload)
    original = store_file.read_text(encoding="utf-8")

    with pytest.raises(SidecarError) as exc_info:
        ProfileStore(tmp_path).list()

    assert_profile_error(exc_info, expected_code)
    assert store_file.read_text(encoding="utf-8") == original


def test_v3_record_missing_identity_raises_identity_error_without_rewrite(tmp_path):
    profile = ProfileRecord.create("Broken").to_store_dict()
    profile.pop("identity", None)
    payload = {"storeVersion": STORE_VERSION, "profiles": [profile]}
    store_file = write_profiles_payload(tmp_path, payload)
    original = store_file.read_text(encoding="utf-8")

    with pytest.raises(SidecarError) as exc_info:
        ProfileStore(tmp_path).list()

    assert_profile_error(exc_info, IDENTITY_INVALID)
    assert store_file.read_text(encoding="utf-8") == original


def test_unsupported_store_version_remains_corrupt_without_rewrite(tmp_path):
    payload = {"storeVersion": 999, "profiles": []}
    store_file = write_profiles_payload(tmp_path, payload)
    original = store_file.read_text(encoding="utf-8")

    with pytest.raises(SidecarError) as exc_info:
        ProfileStore(tmp_path).list()

    assert_profile_error(exc_info, PROFILE_STORE_CORRUPT)
    assert store_file.read_text(encoding="utf-8") == original


def test_optional_profile_metadata_round_trips_without_changing_storage_invariants(tmp_path):
    metadata = {
        "source": "legacy-theprivator",
        "format": "legacy-profile",
        "legacyFolder": "profile-one",
        "legacyName": "Research",
        "chromiumVersion": "116.0.0",
        "hasUserData": True,
    }
    profile = ProfileRecord.create("Imported", metadata=metadata)
    store_file = Path(tmp_path, "profile-store", "profiles.json")
    store_file.parent.mkdir(parents=True)
    store_file.write_text(
        json.dumps(
            {"storeVersion": STORE_VERSION, "profiles": [profile.to_store_dict()]},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    result = ProfileStore(tmp_path).list()

    stored_profile = result["profiles"][0]
    assert stored_profile["metadata"] == metadata
    assert_default_identity(stored_profile)
    assert stored_profile["storage"] == {
        "profileDir": f"profile-store/profiles/{stored_profile['id']}",
        "userDataDir": f"profile-store/profiles/{stored_profile['id']}/user-data",
    }
    assert not Path(stored_profile["storage"]["profileDir"]).is_absolute()
    assert not Path(stored_profile["storage"]["userDataDir"]).is_absolute()


def test_create_imported_profile_uses_canonical_validation_storage_and_metadata(tmp_path):
    store = ProfileStore(tmp_path)
    metadata = {
        "source": "legacy-theprivator",
        "format": "legacy-profile",
        "legacyFolder": "profile-one",
        "hasUserData": False,
    }

    result = store.create_imported("Imported", metadata=metadata)

    profile = result["profile"]
    assert profile["name"] == "Imported"
    assert profile["metadata"] == metadata
    assert_default_identity(profile)
    assert profile["storage"] == {
        "profileDir": f"profile-store/profiles/{profile['id']}",
        "userDataDir": f"profile-store/profiles/{profile['id']}/user-data",
    }
    assert Path(tmp_path, profile["storage"]["userDataDir"]).is_dir()
    assert ProfileStore(tmp_path).list()["profiles"] == [profile]


@pytest.mark.parametrize("name", ["Bad/Name", "Trailing "])
def test_create_imported_profile_reuses_name_validation(tmp_path, name):
    with pytest.raises(SidecarError) as exc_info:
        ProfileStore(tmp_path).create_imported(name, metadata={"source": "legacy-theprivator"})

    assert_profile_error(exc_info, PROFILE_INVALID_NAME)


def test_create_imported_profile_reuses_duplicate_name_validation(tmp_path):
    store = ProfileStore(tmp_path)
    store.create("Research")

    with pytest.raises(SidecarError) as exc_info:
        store.create_imported("research", metadata={"source": "legacy-theprivator"})

    assert_profile_error(exc_info, PROFILE_DUPLICATE_NAME)


def test_profile_metadata_must_be_json_safe_object(tmp_path):
    profile = ProfileRecord.create("Imported")
    payload = profile.to_store_dict()
    payload["metadata"] = ["not", "an", "object"]
    store_file = Path(tmp_path, "profile-store", "profiles.json")
    store_file.parent.mkdir(parents=True)
    store_file.write_text(
        json.dumps({"storeVersion": STORE_VERSION, "profiles": [payload]}),
        encoding="utf-8",
    )

    with pytest.raises(SidecarError) as exc_info:
        ProfileStore(tmp_path).list()

    assert_profile_error(exc_info, PROFILE_STORE_CORRUPT)


def test_profile_metadata_rejects_paths_proxy_like_values_and_debug_ports(tmp_path):
    unsafe_metadata_values = [
        {"source": "legacy-theprivator", "absolutePath": str(tmp_path / "secret")},
        {"source": "legacy-theprivator", "proxyUrl": "http://proxy.example.invalid"},
        {"source": "legacy-theprivator", "credentials": {"username": "proxy-user-sentinel"}},
        {"source": "legacy-theprivator", "remoteControlPort": 9222},
    ]

    for metadata in unsafe_metadata_values:
        with pytest.raises(SidecarError) as exc_info:
            ProfileRecord.create("Imported", metadata=metadata)
        assert_profile_error(exc_info, PROFILE_STORE_CORRUPT)


def test_list_sorts_profiles_case_insensitively_and_mutations_return_refreshed_arrays(tmp_path):
    store = ProfileStore(tmp_path)

    beta = store.create("beta")
    assert profile_names(beta) == ["beta"]
    alpha = store.create("Alpha")
    assert profile_names(alpha) == ["Alpha", "beta"]
    gamma = store.create("gamma")
    assert profile_names(gamma) == ["Alpha", "beta", "gamma"]

    beta_id = next(profile["id"] for profile in gamma["profiles"] if profile["name"] == "beta")
    identity = curated_preset("ubuntu-linux-chrome-120")
    identity_result = store.apply_identity_preset(beta_id, "ubuntu-linux-chrome-120")
    assert identity_result["warnings"] == []
    assert identity_result["profile"]["identity"] == identity

    renamed = store.update(beta_id, "Delta")

    assert renamed["profile"]["name"] == "Delta"
    assert renamed["profile"]["identity"] == identity
    assert profile_names(renamed) == ["Alpha", "Delta", "gamma"]
    assert renamed["count"] == 3


def test_update_identity_persists_suspicious_identity_and_returns_warnings(tmp_path):
    store = ProfileStore(tmp_path)
    profile = store.create("Research")["profile"]
    suspicious_identity = with_identity_change(
        with_identity_change(curated_preset("windows-10-chrome-120"), ["screen", "width"], 900),
        ["screen", "height"],
        1440,
    )

    result = store.update_identity(profile["id"], suspicious_identity)

    assert result["profile"]["identity"] == suspicious_identity
    warning_codes = {warning["code"] for warning in result["warnings"]}
    assert "IDENTITY_DESKTOP_PORTRAIT_SCREEN" in warning_codes
    assert result["profiles"] == [result["profile"]]
    reloaded = ProfileStore(tmp_path).list()["profiles"][0]
    assert reloaded["identity"] == suspicious_identity
    assert reloaded["updatedAt"] == result["profile"]["updatedAt"]


def test_invalid_identity_update_does_not_modify_store(tmp_path):
    store = ProfileStore(tmp_path)
    profile = store.create("Research")["profile"]
    store_file = tmp_path / "profile-store" / "profiles.json"
    original_payload = store_file.read_text(encoding="utf-8")
    invalid_identity = with_identity_change(DEFAULT_REAL_IDENTITY, ["canvas", "mode"], "custom")

    with pytest.raises(SidecarError) as exc_info:
        store.update_identity(profile["id"], invalid_identity)

    assert_profile_error(exc_info, IDENTITY_UNSUPPORTED_MODE)
    assert store_file.read_text(encoding="utf-8") == original_payload
    assert ProfileStore(tmp_path).list()["profiles"] == [profile]


def test_fixed_server_proxy_persists_credentials_only_in_private_store_dict(tmp_path):
    store = ProfileStore(tmp_path)
    profile = store.create("Research")["profile"]
    proxy = {
        "proxyVersion": PROXY_VERSION,
        "mode": FIXED_SERVER_PROXY_MODE,
        "protocol": "http",
        "host": " proxy.example.invalid ",
        "port": 8080,
        "credentials": {
            "username": "proxy-user-sentinel",
            "password": "proxy-pass-sentinel",
        },
    }

    result = store.update_proxy(profile["id"], proxy)

    public_profile = result["profile"]
    assert result["profiles"] == [public_profile]
    assert public_profile["defaults"]["proxyMode"] == FIXED_SERVER_PROXY_MODE
    assert public_profile["proxy"] == {
        "proxyVersion": PROXY_VERSION,
        "mode": FIXED_SERVER_PROXY_MODE,
        "protocol": "http",
        "host": "proxy.example.invalid",
        "port": 8080,
        "credentialState": CREDENTIAL_STATE_CONFIGURED,
        "summary": "http://proxy.example.invalid:8080",
    }
    assert_public_profile_has_no_proxy_credentials(public_profile)

    store_payload = json.loads((tmp_path / "profile-store" / "profiles.json").read_text(encoding="utf-8"))
    stored_profile = store_payload["profiles"][0]
    assert stored_profile["proxy"] == {
        "proxyVersion": PROXY_VERSION,
        "mode": FIXED_SERVER_PROXY_MODE,
        "protocol": "http",
        "host": "proxy.example.invalid",
        "port": 8080,
        "credentials": {
            "username": "proxy-user-sentinel",
            "password": "proxy-pass-sentinel",
        },
    }
    without_credentials = copy.deepcopy(stored_profile)
    without_credentials["proxy"].pop("credentials")
    encoded_without_credentials = json.dumps(without_credentials, ensure_ascii=False, sort_keys=True)
    assert "proxy-user-sentinel" not in encoded_without_credentials
    assert "proxy-pass-sentinel" not in encoded_without_credentials
    assert ProfileStore(tmp_path).list()["profiles"] == [public_profile]


@pytest.mark.parametrize(
    ("proxy_draft", "expected_code"),
    [
        (
            {"proxyVersion": PROXY_VERSION, "mode": DIRECT_PROXY_MODE, "unexpected": True},
            PROXY_INVALID,
        ),
        (
            {"proxyVersion": PROXY_VERSION, "mode": "system"},
            PROXY_PAC_UNSUPPORTED,
        ),
        (
            {
                "proxyVersion": PROXY_VERSION,
                "mode": FIXED_SERVER_PROXY_MODE,
                "protocol": "http",
                "host": "proxy.example.invalid",
                "port": 8080,
                "credentials": {"username": "", "password": "proxy-pass-sentinel"},
            },
            PROXY_INVALID,
        ),
    ],
)
def test_invalid_proxy_update_does_not_modify_store(tmp_path, proxy_draft, expected_code):
    store = ProfileStore(tmp_path)
    profile = store.create("Research")["profile"]
    store_file = tmp_path / "profile-store" / "profiles.json"
    original_payload = store_file.read_text(encoding="utf-8")

    with pytest.raises(SidecarError) as exc_info:
        store.update_proxy(profile["id"], proxy_draft)

    assert_profile_error(exc_info, expected_code)
    assert store_file.read_text(encoding="utf-8") == original_payload
    assert ProfileStore(tmp_path).list()["profiles"] == [profile]


def test_update_proxy_rejects_missing_non_string_profile_id(tmp_path):
    store = ProfileStore(tmp_path)
    with pytest.raises(SidecarError) as exc_info:
        store.update_proxy("", default_proxy_config())

    assert_profile_error(exc_info, INVALID_REQUEST)


def test_apply_identity_preset_persists_curated_identity_without_warnings(tmp_path):
    store = ProfileStore(tmp_path)
    profile = store.create("Research")["profile"]

    result = store.apply_identity_preset(profile["id"], "macos-ventura-chrome-120")

    assert result["warnings"] == []
    assert result["profile"]["identity"] == curated_preset("macos-ventura-chrome-120")
    assert result["profile"]["identity"]["presetId"] == "macos-ventura-chrome-120"
    assert ProfileStore(tmp_path).list()["profiles"] == [result["profile"]]


@pytest.mark.parametrize("bad_profile_id", [None, 42, "", "   "])
def test_identity_update_methods_reject_missing_non_string_profile_ids(tmp_path, bad_profile_id):
    store = ProfileStore(tmp_path)
    with pytest.raises(SidecarError) as update_exc:
        store.update_identity(bad_profile_id, DEFAULT_REAL_IDENTITY)  # type: ignore[arg-type]
    assert_profile_error(update_exc, INVALID_REQUEST)

    with pytest.raises(SidecarError) as preset_exc:
        store.apply_identity_preset(bad_profile_id, "windows-10-chrome-120")  # type: ignore[arg-type]
    assert_profile_error(preset_exc, INVALID_REQUEST)


@pytest.mark.parametrize(
    "name",
    [
        "",
        "   ",
        "a" * 101,
        "bad/name",
        "bad\x1fcontrol",
        "Trailing.",
        "Trailing ",
        " Leading",
        "CON",
        "NUL.txt",
        "COM1",
    ],
)
def test_invalid_profile_names_raise_typed_error(tmp_path, name):
    with pytest.raises(SidecarError) as exc_info:
        ProfileStore(tmp_path).create(name)

    assert_profile_error(exc_info, PROFILE_INVALID_NAME)


def test_missing_non_string_name_is_invalid_request(tmp_path):
    with pytest.raises(SidecarError) as exc_info:
        ProfileStore(tmp_path).create(None)  # type: ignore[arg-type]

    assert_profile_error(exc_info, "INVALID_REQUEST")


def test_duplicate_names_are_case_insensitive_for_create_and_update(tmp_path):
    store = ProfileStore(tmp_path)
    original = store.create("Research")["profile"]
    other = store.create("Other")["profile"]

    with pytest.raises(SidecarError) as create_exc:
        store.create("research")
    assert_profile_error(create_exc, PROFILE_DUPLICATE_NAME)

    with pytest.raises(SidecarError) as update_exc:
        store.update(other["id"], original["name"].upper())
    assert_profile_error(update_exc, PROFILE_DUPLICATE_NAME)


def test_update_unknown_profile_returns_not_found(tmp_path):
    with pytest.raises(SidecarError) as exc_info:
        ProfileStore(tmp_path).update("missing-id", "Renamed")

    assert_profile_error(exc_info, PROFILE_NOT_FOUND)


def test_delete_unknown_profile_returns_not_found(tmp_path):
    with pytest.raises(SidecarError) as exc_info:
        ProfileStore(tmp_path).delete("missing-id")

    assert_profile_error(exc_info, PROFILE_NOT_FOUND)


def test_delete_removes_record_without_deleting_browser_user_data(tmp_path):
    store = ProfileStore(tmp_path)
    profile = store.create("Disposable")["profile"]
    user_data_dir = Path(tmp_path, profile["storage"]["userDataDir"])
    marker = user_data_dir / "Session Storage" / "keep.txt"
    marker.parent.mkdir(parents=True)
    marker.write_text("browser-data", encoding="utf-8")

    result = store.delete(profile["id"])

    assert result == {"storeVersion": STORE_VERSION, "profiles": [], "count": 0}
    assert marker.read_text(encoding="utf-8") == "browser-data"
    reloaded = ProfileStore(tmp_path).list()
    assert reloaded["profiles"] == []


@pytest.mark.parametrize(
    "payload",
    [
        "{not-json",
        json.dumps({"storeVersion": STORE_VERSION, "profiles": "not-a-list"}),
        json.dumps({"storeVersion": 999, "profiles": []}),
        json.dumps({"storeVersion": STORE_VERSION, "profiles": [{"id": "not-a-uuid"}]}),
    ],
)
def test_corrupt_profiles_json_raises_typed_error_without_resetting(tmp_path, payload):
    store_file = Path(tmp_path, "profile-store", "profiles.json")
    store_file.parent.mkdir(parents=True)
    store_file.write_text(payload, encoding="utf-8")

    with pytest.raises(SidecarError) as exc_info:
        ProfileStore(tmp_path).list()

    assert_profile_error(exc_info, PROFILE_STORE_CORRUPT)
    assert store_file.read_text(encoding="utf-8") == payload


def test_write_failure_returns_typed_profile_store_write_error(tmp_path, monkeypatch):
    def fail_replace(source, destination):
        raise OSError("simulated replace failure")

    monkeypatch.setattr("theprivator_sidecar.profiles.os.replace", fail_replace)

    with pytest.raises(SidecarError) as exc_info:
        ProfileStore(tmp_path).create("Cannot Save")

    assert_profile_error(exc_info, PROFILE_STORE_WRITE_FAILED)


def test_delete_write_failure_returns_delete_failed_error(tmp_path, monkeypatch):
    store = ProfileStore(tmp_path)
    profile = store.create("Cannot Delete")["profile"]

    def fail_replace(source, destination):
        raise OSError("simulated replace failure")

    monkeypatch.setattr("theprivator_sidecar.profiles.os.replace", fail_replace)

    with pytest.raises(SidecarError) as exc_info:
        store.delete(profile["id"])

    assert_profile_error(exc_info, PROFILE_DELETE_FAILED)
