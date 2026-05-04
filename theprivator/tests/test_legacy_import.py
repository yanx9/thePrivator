"""Tests for the sidecar-owned legacy profile scan contract."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from theprivator_sidecar.legacy_import import scan_legacy_profiles
from theprivator_sidecar.profiles import ProfileStore
from theprivator_sidecar.protocol import (
    INVALID_REQUEST,
    LEGACY_CONFIG_MALFORMED,
    LEGACY_CONFIG_MISSING,
    LEGACY_ROOT_INVALID,
    PROFILE_DUPLICATE_NAME,
    PROFILE_INVALID_NAME,
    SidecarError,
)


def write_config(profile_dir: Path, payload: object) -> None:
    profile_dir.mkdir(parents=True, exist_ok=True)
    (profile_dir / "config.json").write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )


def snapshot_tree(root: Path):
    if not root.exists():
        return []

    snapshot = []
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        rel = path.relative_to(root).as_posix()
        if path.is_symlink():
            snapshot.append(("symlink", rel, os.readlink(path)))
        elif path.is_file():
            snapshot.append(("file", rel, path.read_bytes()))
        elif path.is_dir():
            snapshot.append(("dir", rel, None))
        else:
            snapshot.append(("other", rel, None))
    return snapshot


def issue_codes(candidate):
    return [issue["code"] for issue in candidate["issues"]]


def assert_issue_shape(issue, code):
    assert issue["code"] == code
    assert issue["message"]
    assert issue["detailRef"].startswith("sidecar-")


def assert_scan_output_redacted(result, *forbidden_values):
    encoded = json.dumps(result, ensure_ascii=False, sort_keys=True)
    assert "Traceback" not in encoded
    assert "proxy_user" not in encoded
    assert "proxy_pass" not in encoded
    assert "proxyPassword" not in encoded
    assert "proxyUsername" not in encoded
    for value in forbidden_values:
        assert str(value) not in encoded


def assert_sidecar_error(exc_info, code):
    error = exc_info.value
    assert isinstance(error, SidecarError)
    assert error.code == code
    assert error.recoverable is True
    assert error.detail_ref.startswith("sidecar-")
    return error


def test_scan_success_returns_stable_opaque_candidates_and_safe_metadata_without_mutation(tmp_path, capsys):
    legacy_root = tmp_path / "legacy-root-should-not-leak"
    app_root = tmp_path / "app-root-should-not-leak"
    legacy_profile = legacy_root / "profile-one"
    write_config(
        legacy_profile,
        {
            "name": "Research",
            "chromium_version": "116.0.0",
            "version": "2",
            "rc_port": 9222,
            "proxy_user": "alice-should-not-leak",
            "proxy_pass": "secret-should-not-leak",
            "proxy_url": "proxy.example.invalid",
            "absolute_path": str(tmp_path / "legacy-secret-path"),
        },
    )
    (legacy_profile / "user-data" / "Default").mkdir(parents=True)
    (legacy_profile / "user-data" / "Default" / "Preferences").write_text(
        '{"browser":"data that must not be echoed"}',
        encoding="utf-8",
    )
    ProfileStore(app_root).create("Existing")
    before_legacy = snapshot_tree(legacy_root)
    before_store = ProfileStore(app_root).list()

    first = scan_legacy_profiles(str(legacy_root), app_root)
    second = scan_legacy_profiles(str(legacy_root), app_root)

    assert first["scanVersion"] == 1
    assert first["count"] == 1
    assert first["issues"] == []
    candidate = first["candidates"][0]
    assert candidate["legacyId"].startswith("legacy-")
    assert candidate["legacyId"] == second["candidates"][0]["legacyId"]
    assert str(legacy_root) not in candidate["legacyId"]
    assert candidate["legacyId"] != str(legacy_profile)
    assert candidate["folderName"] == "profile-one"
    assert candidate["legacyName"] == "Research"
    assert candidate["targetName"] == "Research"
    assert candidate["userData"] == {"status": "available"}
    assert candidate["issues"] == []
    assert candidate["metadata"] == {
        "source": "legacy-theprivator",
        "format": "legacy-profile",
        "formatVersion": "2",
        "legacyFolder": "profile-one",
        "legacyName": "Research",
        "chromiumVersion": "116.0.0",
        "remoteControlPort": 9222,
        "hasUserData": True,
    }
    assert ProfileStore(app_root).list() == before_store
    assert snapshot_tree(legacy_root) == before_legacy
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""
    assert_scan_output_redacted(
        first,
        legacy_root,
        app_root,
        "alice-should-not-leak",
        "secret-should-not-leak",
        "proxy.example.invalid",
        tmp_path / "legacy-secret-path",
        "data that must not be echoed",
    )


@pytest.mark.parametrize("legacy_root", [None, "", "   "])
def test_scan_rejects_missing_non_string_or_blank_legacy_root(tmp_path, legacy_root):
    with pytest.raises(SidecarError) as exc_info:
        scan_legacy_profiles(legacy_root, tmp_path / "app")  # type: ignore[arg-type]

    assert_sidecar_error(exc_info, INVALID_REQUEST)


@pytest.mark.parametrize("make_root", ["missing", "file"])
def test_scan_rejects_non_directory_legacy_root_with_typed_error(tmp_path, make_root):
    legacy_root = tmp_path / "missing-root"
    if make_root == "file":
        legacy_root.write_text("not a directory", encoding="utf-8")

    with pytest.raises(SidecarError) as exc_info:
        scan_legacy_profiles(str(legacy_root), tmp_path / "app")

    error = assert_sidecar_error(exc_info, LEGACY_ROOT_INVALID)
    assert str(legacy_root) not in error.to_dict()["message"]


def test_scan_flags_invalid_and_duplicate_target_names_without_sanitizing_or_suffixing(tmp_path):
    legacy_root = tmp_path / "legacy"
    app_root = tmp_path / "app"
    ProfileStore(app_root).create("Taken")
    write_config(legacy_root / "duplicate", {"name": "taken"})
    write_config(legacy_root / "invalid", {"name": "Trailing "})

    result = scan_legacy_profiles(legacy_root, app_root)

    candidates = {candidate["folderName"]: candidate for candidate in result["candidates"]}
    assert candidates["duplicate"]["targetName"] == "taken"
    assert issue_codes(candidates["duplicate"]) == [PROFILE_DUPLICATE_NAME]
    assert_issue_shape(candidates["duplicate"]["issues"][0], PROFILE_DUPLICATE_NAME)
    assert candidates["invalid"]["targetName"] == "Trailing "
    assert issue_codes(candidates["invalid"]) == [PROFILE_INVALID_NAME]
    assert_issue_shape(candidates["invalid"]["issues"][0], PROFILE_INVALID_NAME)


def test_scan_classifies_missing_and_malformed_configs_as_candidate_issues(tmp_path):
    legacy_root = tmp_path / "legacy"
    (legacy_root / "missing-config").mkdir(parents=True)
    malformed = legacy_root / "malformed-config"
    malformed.mkdir()
    (malformed / "config.json").write_text("{not-json", encoding="utf-8")

    result = scan_legacy_profiles(legacy_root, tmp_path / "app")

    candidates = {candidate["folderName"]: candidate for candidate in result["candidates"]}
    assert candidates["missing-config"]["targetName"] == "missing-config"
    assert issue_codes(candidates["missing-config"]) == [LEGACY_CONFIG_MISSING]
    assert candidates["malformed-config"]["targetName"] == "malformed-config"
    assert issue_codes(candidates["malformed-config"]) == [LEGACY_CONFIG_MALFORMED]
    assert_scan_output_redacted(result, legacy_root)


def test_scan_normalizes_wrong_config_field_types_to_safe_missing_values(tmp_path):
    legacy_root = tmp_path / "legacy"
    write_config(
        legacy_root / "typed-fields",
        {
            "name": 42,
            "chromium_version": {"not": "safe"},
            "version": ["bad"],
            "rc_port": "not-a-port",
        },
    )

    result = scan_legacy_profiles(legacy_root, tmp_path / "app")

    candidate = result["candidates"][0]
    assert candidate["folderName"] == "typed-fields"
    assert candidate["legacyName"] is None
    assert candidate["targetName"] == "typed-fields"
    assert candidate["metadata"] == {
        "source": "legacy-theprivator",
        "format": "legacy-profile",
        "legacyFolder": "typed-fields",
        "hasUserData": False,
    }
    assert candidate["userData"] == {"status": "missing"}


def test_scan_omits_path_like_config_name_and_version_fields_from_output(tmp_path):
    legacy_root = tmp_path / "legacy"
    secret_name = str(tmp_path / "home" / "alice" / "Profiles" / "Secret")
    secret_version = str(tmp_path / "chromium" / "secret-version")
    write_config(
        legacy_root / "path-like-name",
        {
            "name": secret_name,
            "version": secret_version,
            "chromium_version": "C:\\Users\\Alice\\Chrome",
        },
    )

    result = scan_legacy_profiles(legacy_root, tmp_path / "app")

    candidate = result["candidates"][0]
    assert candidate["legacyName"] is None
    assert candidate["targetName"] == "path-like-name"
    assert candidate["metadata"] == {
        "source": "legacy-theprivator",
        "format": "legacy-profile",
        "legacyFolder": "path-like-name",
        "hasUserData": False,
    }
    assert_scan_output_redacted(result, secret_name, secret_version, "C:\\Users\\Alice\\Chrome")


def test_scan_does_not_recurse_into_user_data_or_nested_legacy_directories(tmp_path, monkeypatch):
    legacy_root = tmp_path / "legacy"
    write_config(legacy_root / "top-level", {"name": "Top Level"})
    write_config(legacy_root / "container" / "nested-profile", {"name": "Nested Should Not Appear"})

    def fail_if_recursive_walk_is_used(self, pattern):  # pragma: no cover - exercised only on regression.
        raise AssertionError(f"scan must not recurse with rglob({pattern!r})")

    monkeypatch.setattr(Path, "rglob", fail_if_recursive_walk_is_used)

    result = scan_legacy_profiles(legacy_root, tmp_path / "app")

    encoded = json.dumps(result, sort_keys=True)
    assert "Nested Should Not Appear" not in encoded
    candidates = {candidate["folderName"]: candidate for candidate in result["candidates"]}
    assert set(candidates) == {"container", "top-level"}
    assert issue_codes(candidates["container"]) == [LEGACY_CONFIG_MISSING]
    assert candidates["top-level"]["issues"] == []


def test_empty_scan_ignores_files_and_returns_zero_candidates_without_creating_store(tmp_path):
    legacy_root = tmp_path / "legacy"
    app_root = tmp_path / "app"
    legacy_root.mkdir()
    (legacy_root / "readme.txt").write_text("not a profile", encoding="utf-8")

    result = scan_legacy_profiles(legacy_root, app_root)

    assert result == {"scanVersion": 1, "count": 0, "candidates": [], "issues": []}
    assert not app_root.exists()


def test_scan_surfaces_profile_store_corruption_from_duplicate_detection(tmp_path):
    legacy_root = tmp_path / "legacy"
    app_root = tmp_path / "app"
    write_config(legacy_root / "profile", {"name": "Profile"})
    store_file = app_root / "profile-store" / "profiles.json"
    store_file.parent.mkdir(parents=True)
    store_file.write_text("{not-json", encoding="utf-8")

    with pytest.raises(SidecarError) as exc_info:
        scan_legacy_profiles(legacy_root, app_root)

    assert_sidecar_error(exc_info, "PROFILE_STORE_CORRUPT")
    assert store_file.read_text(encoding="utf-8") == "{not-json"
