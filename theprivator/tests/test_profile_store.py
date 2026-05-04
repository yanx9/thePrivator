"""Tests for the sidecar-owned persistent profile store."""

import json
from pathlib import Path

import pytest

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
from theprivator_sidecar.protocol import SidecarError


def assert_profile_error(exc_info, code):
    error = exc_info.value
    assert isinstance(error, SidecarError)
    assert error.code == code
    assert error.recoverable is True
    assert error.detail_ref.startswith("sidecar-")
    return error


def profile_names(result):
    return [profile["name"] for profile in result["profiles"]]


def test_empty_store_returns_versioned_empty_collection(tmp_path):
    result = ProfileStore(tmp_path).list()

    assert result == {"storeVersion": STORE_VERSION, "profiles": [], "count": 0}


def test_create_profile_persists_defaults_and_relative_storage_paths(tmp_path):
    store = ProfileStore(tmp_path)

    result = store.create("Research")

    assert result["storeVersion"] == STORE_VERSION
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
    assert not Path(profile["storage"]["profileDir"]).is_absolute()
    assert not Path(profile["storage"]["userDataDir"]).is_absolute()
    assert Path(tmp_path, profile["storage"]["userDataDir"]).is_dir()

    store_payload = json.loads(Path(tmp_path, "profile-store", "profiles.json").read_text())
    assert store_payload["storeVersion"] == STORE_VERSION
    assert store_payload["profiles"] == [profile]
    assert "metadata" not in profile
    assert "status" not in profile
    assert "isActive" not in profile
    assert "process" not in profile

    reloaded = ProfileStore(tmp_path).list()
    assert reloaded["profiles"] == [profile]
    assert reloaded["count"] == 1


def test_optional_profile_metadata_round_trips_without_changing_storage_invariants(tmp_path):
    metadata = {
        "source": "legacy-theprivator",
        "format": "legacy-profile",
        "legacyFolder": "profile-one",
        "legacyName": "Research",
        "chromiumVersion": "116.0.0",
        "remoteControlPort": 9222,
        "hasUserData": True,
    }
    profile = ProfileRecord.create("Imported", metadata=metadata)
    store_file = Path(tmp_path, "profile-store", "profiles.json")
    store_file.parent.mkdir(parents=True)
    store_file.write_text(
        json.dumps(
            {"storeVersion": STORE_VERSION, "profiles": [profile.to_dict()]},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    result = ProfileStore(tmp_path).list()

    stored_profile = result["profiles"][0]
    assert stored_profile["metadata"] == metadata
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
    payload = profile.to_dict()
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


def test_list_sorts_profiles_case_insensitively_and_mutations_return_refreshed_arrays(tmp_path):
    store = ProfileStore(tmp_path)

    beta = store.create("beta")
    assert profile_names(beta) == ["beta"]
    alpha = store.create("Alpha")
    assert profile_names(alpha) == ["Alpha", "beta"]
    gamma = store.create("gamma")
    assert profile_names(gamma) == ["Alpha", "beta", "gamma"]

    beta_id = next(profile["id"] for profile in gamma["profiles"] if profile["name"] == "beta")
    renamed = store.update(beta_id, "Delta")

    assert renamed["profile"]["name"] == "Delta"
    assert profile_names(renamed) == ["Alpha", "Delta", "gamma"]
    assert renamed["count"] == 3


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
