"""Tests for the sidecar-owned ThePrivator .tpkg profile package contract."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import sqlite3
import stat
import zipfile
from pathlib import Path
from typing import Any, Mapping

import pytest

from theprivator_sidecar import chromium, profile_package
from theprivator_sidecar.identity import DEFAULT_REAL_IDENTITY
from theprivator_sidecar.main import handle_request_line
from theprivator_sidecar.profile_package import (
    COOKIE_MEMBER,
    MANIFEST_MEMBER,
    PACKAGE_FORMAT,
    PACKAGE_VERSION,
    PAYLOAD_PREFIX,
    export_profile_package,
    import_profile_package,
)
from theprivator_sidecar.profiles import ProfileStore, STORE_VERSION, utc_now_iso
from theprivator_sidecar.protocol import (
    PORTABILITY_PACKAGE_CHECKSUM_MISMATCH,
    PORTABILITY_PACKAGE_INVALID,
    PORTABILITY_PACKAGE_TOO_LARGE,
    PORTABILITY_PACKAGE_UNSUPPORTED_VERSION,
    PORTABILITY_PROFILE_BUSY,
    SidecarError,
)
from theprivator_sidecar.proxy import FIXED_SERVER_PROXY_MODE, PROXY_VERSION

COOKIE_DOMAIN_SENTINEL = ".secret-cookie-domain.invalid"
COOKIE_NAME_SENTINEL = "session_cookie_name_sentinel"
COOKIE_VALUE_SENTINEL = "cookie-value-sentinel-7cf2e61d"
PROXY_USER_SENTINEL = "proxy-user-sentinel-37a4a1"
PROXY_PASSWORD_SENTINEL = "proxy-password-sentinel-92f631"
SECRET_MARKERS = (
    COOKIE_DOMAIN_SENTINEL,
    COOKIE_NAME_SENTINEL,
    COOKIE_VALUE_SENTINEL,
    PROXY_USER_SENTINEL,
    PROXY_PASSWORD_SENTINEL,
)
PUBLIC_FORBIDDEN_MARKERS = (
    *SECRET_MARKERS,
    "credentials",
    "username",
    "password",
    "DevToolsActivePort",
    "SingletonLock",
    "Default/Network/Cookies",
    "manifest.json",
    "theprivator-cookies.json",
    "Traceback",
)


def assert_sidecar_error(exc_info: pytest.ExceptionInfo[SidecarError], code: str) -> SidecarError:
    error = exc_info.value
    assert error.code == code
    assert error.recoverable is True
    assert error.detail_ref.startswith("sidecar-")
    assert "Traceback" not in error.message
    return error


def assert_public_package_payload_safe(payload: Any, *, store_root: Path) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    assert str(store_root) not in encoded
    for marker in PUBLIC_FORBIDDEN_MARKERS:
        assert marker not in encoded
    return encoded


def fixed_proxy_with_credentials() -> Mapping[str, Any]:
    return {
        "proxyVersion": PROXY_VERSION,
        "mode": FIXED_SERVER_PROXY_MODE,
        "protocol": "http",
        "host": "proxy.example.invalid",
        "port": 8080,
        "credentials": {
            "username": PROXY_USER_SENTINEL,
            "password": PROXY_PASSWORD_SENTINEL,
        },
    }


def create_profile_with_payload(store_root: Path, name: str = "Research") -> Mapping[str, Any]:
    store = ProfileStore(store_root)
    profile = store.create(name)["profile"]
    store.update_proxy(profile["id"], fixed_proxy_with_credentials())
    profile = ProfileStore(store_root).list()["profiles"][0]
    user_data_dir = store_root / profile["storage"]["userDataDir"]
    (user_data_dir / "Default").mkdir(parents=True, exist_ok=True)
    (user_data_dir / "Default" / "Preferences").write_text(
        '{"browser":"portable-preferences"}',
        encoding="utf-8",
    )
    (user_data_dir / "Local State").write_text("portable-local-state", encoding="utf-8")
    (user_data_dir / "DevToolsActivePort").write_text("9222\n/devtools/browser/secret\n", encoding="utf-8")
    (user_data_dir / "SingletonLock").write_text("runtime lock", encoding="utf-8")
    write_cookie_db(user_data_dir)
    return profile


def write_cookie_db(user_data_dir: Path) -> Path:
    db_path = user_data_dir / "Default" / "Network" / "Cookies"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    try:
        connection.execute(
            """
            CREATE TABLE cookies (
              creation_utc INTEGER NOT NULL,
              host_key TEXT NOT NULL,
              top_frame_site_key TEXT NOT NULL DEFAULT '',
              name TEXT NOT NULL,
              value TEXT NOT NULL,
              encrypted_value BLOB NOT NULL DEFAULT '',
              path TEXT NOT NULL,
              expires_utc INTEGER NOT NULL,
              is_secure INTEGER NOT NULL,
              is_httponly INTEGER NOT NULL,
              last_access_utc INTEGER NOT NULL,
              has_expires INTEGER NOT NULL DEFAULT 1,
              is_persistent INTEGER NOT NULL DEFAULT 1,
              priority INTEGER NOT NULL DEFAULT 1,
              samesite INTEGER NOT NULL DEFAULT -1,
              source_scheme INTEGER NOT NULL DEFAULT 0,
              source_port INTEGER NOT NULL DEFAULT -1,
              is_same_party INTEGER NOT NULL DEFAULT 0,
              last_update_utc INTEGER NOT NULL DEFAULT 0,
              source_type INTEGER NOT NULL DEFAULT 0,
              has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0,
              UNIQUE(host_key, top_frame_site_key, name, path)
            )
            """
        )
        connection.execute(
            """
            INSERT INTO cookies (
              creation_utc, host_key, top_frame_site_key, name, value, encrypted_value,
              path, expires_utc, is_secure, is_httponly, last_access_utc,
              has_expires, is_persistent, priority, samesite, source_scheme,
              source_port, is_same_party, last_update_utc, source_type,
              has_cross_site_ancestor
            ) VALUES (?, ?, '', ?, ?, ?, '/', 0, 1, 1, 0, 0, 0, 1, -1, 2, 443, 0, 0, 0, 0)
            """,
            (0, COOKIE_DOMAIN_SENTINEL, COOKIE_NAME_SENTINEL, COOKIE_VALUE_SENTINEL, b""),
        )
        connection.commit()
    finally:
        connection.close()
    return db_path


def read_cookie_rows(user_data_dir: Path) -> list[Mapping[str, Any]]:
    connection = sqlite3.connect(user_data_dir / "Default" / "Network" / "Cookies")
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            "SELECT host_key, name, value, path, is_secure, is_httponly FROM cookies ORDER BY host_key, path, name"
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        connection.close()


def read_package(package_path: Path) -> tuple[dict[str, Any], dict[str, bytes]]:
    with zipfile.ZipFile(package_path, "r") as archive:
        members = {name: archive.read(name) for name in archive.namelist()}
    return json.loads(members[MANIFEST_MEMBER].decode("utf-8")), members


def request_line(payload: Mapping[str, Any]) -> str:
    return json.dumps(payload) + "\n"


def minimal_cookie_payload() -> bytes:
    return (
        json.dumps(
            {
                "format": "theprivator.cookies",
                "version": 1,
                "cookies": [],
            },
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def minimal_manifest(**overrides: Any) -> dict[str, Any]:
    cookie_bytes = minimal_cookie_payload()
    manifest: dict[str, Any] = {
        "format": PACKAGE_FORMAT,
        "version": PACKAGE_VERSION,
        "createdAt": "2026-01-01T00:00:00.000Z",
        "profile": {
            "name": "Imported",
            "identity": copy.deepcopy(DEFAULT_REAL_IDENTITY),
            "proxy": {"proxyVersion": PROXY_VERSION, "mode": "direct"},
            "proxySummary": {
                "proxyVersion": PROXY_VERSION,
                "mode": "direct",
                "credentialState": "none",
                "summary": "Direct connection",
            },
        },
        "cookies": {
            "member": COOKIE_MEMBER,
            "format": "theprivator.cookies",
            "version": 1,
            "byteCount": len(cookie_bytes),
            "sha256": hashlib.sha256(cookie_bytes).hexdigest(),
            "cookieCount": 0,
            "skippedCount": 0,
        },
        "payload": {"prefix": PAYLOAD_PREFIX, "fileCount": 0, "byteCount": 0, "files": []},
        "warnings": [],
    }
    manifest.update(overrides)
    return manifest


def write_package(path: Path, manifest: Mapping[str, Any], *, extra_members: Mapping[str, bytes] | None = None) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(MANIFEST_MEMBER, json.dumps(manifest, sort_keys=True).encode("utf-8"))
        archive.writestr(COOKIE_MEMBER, minimal_cookie_payload())
        for name, content in (extra_members or {}).items():
            archive.writestr(name, content)


def test_export_profile_package_writes_versioned_manifest_cookies_payload_and_redacted_result(tmp_path):
    profile = create_profile_with_payload(tmp_path)
    package_path = tmp_path / "research.tpkg"

    result = export_profile_package(tmp_path, profile["id"], package_path)

    assert result["packageVersion"] == PACKAGE_VERSION
    assert result["format"] == PACKAGE_FORMAT
    assert result["operation"] == "export"
    assert result["profileId"] == profile["id"]
    assert result["profileName"] == "Research"
    assert result["cookieCount"] == 1
    assert result["payloadFileCount"] == 2
    assert result["payloadByteCount"] > 0
    warning_codes = {warning["code"] for warning in result["warnings"]}
    assert {"PACKAGE_PAYLOAD_RUNTIME_SKIPPED", "PACKAGE_PAYLOAD_COOKIE_DB_SKIPPED"} <= warning_codes
    assert_public_package_payload_safe(result, store_root=tmp_path)

    manifest, members = read_package(package_path)
    assert set(members) == {
        MANIFEST_MEMBER,
        COOKIE_MEMBER,
        f"{PAYLOAD_PREFIX}Default/Preferences",
        f"{PAYLOAD_PREFIX}Local State",
    }
    assert manifest["format"] == PACKAGE_FORMAT
    assert manifest["version"] == PACKAGE_VERSION
    assert manifest["profile"]["name"] == "Research"
    assert manifest["profile"]["proxy"] == {
        "proxyVersion": PROXY_VERSION,
        "mode": FIXED_SERVER_PROXY_MODE,
        "protocol": "http",
        "host": "proxy.example.invalid",
        "port": 8080,
    }
    assert manifest["profile"]["proxySummary"]["credentialState"] == "none"
    assert "credentials" not in json.dumps(manifest["profile"]["proxy"], sort_keys=True)
    assert manifest["cookies"]["member"] == COOKIE_MEMBER
    assert manifest["cookies"]["sha256"] == hashlib.sha256(members[COOKIE_MEMBER]).hexdigest()
    assert manifest["payload"]["fileCount"] == 2
    for entry in manifest["payload"]["files"]:
        member = entry["member"]
        assert member in members
        assert entry["sha256"] == hashlib.sha256(members[member]).hexdigest()

    manifest_text = json.dumps(manifest, ensure_ascii=False, sort_keys=True)
    assert str(tmp_path) not in manifest_text
    assert PROXY_USER_SENTINEL not in manifest_text
    assert PROXY_PASSWORD_SENTINEL not in manifest_text
    assert COOKIE_VALUE_SENTINEL not in manifest_text
    cookie_payload = json.loads(members[COOKIE_MEMBER].decode("utf-8"))
    assert cookie_payload["cookies"][0]["domain"] == COOKIE_DOMAIN_SENTINEL
    assert cookie_payload["cookies"][0]["name"] == COOKIE_NAME_SENTINEL
    assert cookie_payload["cookies"][0]["value"] == COOKIE_VALUE_SENTINEL
    for member_name, content in members.items():
        if member_name == COOKIE_MEMBER:
            continue
        assert COOKIE_VALUE_SENTINEL.encode("utf-8") not in content


def test_import_profile_package_validates_then_creates_copy_and_restores_payload_cookies(tmp_path):
    source_profile = create_profile_with_payload(tmp_path, name="Research")
    package_path = tmp_path / "research.tpkg"
    export_profile_package(tmp_path, source_profile["id"], package_path)

    result = import_profile_package(tmp_path, package_path)

    assert result["operation"] == "import"
    assert result["format"] == PACKAGE_FORMAT
    assert result["nameConflictResolved"] is True
    assert result["profileName"] == "Research Copy"
    assert result["cookieCount"] == 1
    assert result["importedCookieCount"] == 1
    assert result["payloadFileCount"] == 2
    assert_public_package_payload_safe(result, store_root=tmp_path)

    profiles = ProfileStore(tmp_path).list()["profiles"]
    assert [profile["name"] for profile in profiles] == ["Research", "Research Copy"]
    imported_profile = next(profile for profile in profiles if profile["id"] == result["profileId"])
    assert imported_profile["metadata"] == {
        "source": "profile-package",
        "format": PACKAGE_FORMAT,
        "formatVersion": "1",
        "originalName": "Research",
        "hasUserData": True,
    }
    assert imported_profile["proxy"] == {
        "proxyVersion": PROXY_VERSION,
        "mode": FIXED_SERVER_PROXY_MODE,
        "protocol": "http",
        "host": "proxy.example.invalid",
        "port": 8080,
        "credentialState": "none",
        "summary": "http://proxy.example.invalid:8080",
    }

    imported_user_data = tmp_path / imported_profile["storage"]["userDataDir"]
    assert (imported_user_data / "Default" / "Preferences").read_text(encoding="utf-8") == '{"browser":"portable-preferences"}'
    assert (imported_user_data / "Local State").read_text(encoding="utf-8") == "portable-local-state"
    assert not (imported_user_data / "DevToolsActivePort").exists()
    assert not (imported_user_data / "SingletonLock").exists()
    assert read_cookie_rows(imported_user_data) == [
        {
            "host_key": COOKIE_DOMAIN_SENTINEL,
            "name": COOKIE_NAME_SENTINEL,
            "value": COOKIE_VALUE_SENTINEL,
            "path": "/",
            "is_secure": 1,
            "is_httponly": 1,
        }
    ]

    stored_payload = json.loads((tmp_path / "profile-store" / "profiles.json").read_text(encoding="utf-8"))
    stored_imported = next(profile for profile in stored_payload["profiles"] if profile["id"] == result["profileId"])
    assert stored_payload["storeVersion"] == STORE_VERSION
    assert "credentials" not in stored_imported["proxy"]
    assert PROXY_USER_SENTINEL not in json.dumps(stored_imported, sort_keys=True)
    assert PROXY_PASSWORD_SENTINEL not in json.dumps(stored_imported, sort_keys=True)


def test_import_checksum_failure_happens_before_profile_mutation_and_does_not_echo_paths(tmp_path):
    source_root = tmp_path / "source-root"
    source_profile = create_profile_with_payload(source_root, name="Research")
    good_package = tmp_path / "good.tpkg"
    export_profile_package(source_root, source_profile["id"], good_package)
    bad_package = tmp_path / "bad.tpkg"
    with zipfile.ZipFile(good_package, "r") as source, zipfile.ZipFile(bad_package, "w") as destination:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename == COOKIE_MEMBER:
                data = b"tampered-cookie-payload"
            destination.writestr(info, data)

    import_root = tmp_path / "import-root-should-not-leak"
    with pytest.raises(SidecarError) as exc_info:
        import_profile_package(import_root, bad_package)

    error = assert_sidecar_error(exc_info, PORTABILITY_PACKAGE_CHECKSUM_MISMATCH)
    assert str(import_root) not in json.dumps(error.to_dict(), sort_keys=True)
    assert not (import_root / "profile-store" / "profiles.json").exists()


@pytest.mark.parametrize(
    ("mutate", "expected_code"),
    [
        (lambda manifest: manifest.__setitem__("version", 999), PORTABILITY_PACKAGE_UNSUPPORTED_VERSION),
        (lambda manifest: manifest.__setitem__("payload", {"prefix": PAYLOAD_PREFIX, "fileCount": 0, "byteCount": profile_package.MAX_PAYLOAD_BYTES + 1, "files": []}), PORTABILITY_PACKAGE_TOO_LARGE),
    ],
)
def test_import_rejects_unsupported_version_and_oversized_manifest_counts(tmp_path, mutate, expected_code):
    manifest = minimal_manifest()
    mutate(manifest)
    package_path = tmp_path / "invalid.tpkg"
    write_package(package_path, manifest)

    with pytest.raises(SidecarError) as exc_info:
        import_profile_package(tmp_path / "store", package_path)

    assert_sidecar_error(exc_info, expected_code)
    assert not (tmp_path / "store" / "profile-store" / "profiles.json").exists()


def test_import_rejects_missing_required_member_without_profile_mutation(tmp_path):
    package_path = tmp_path / "missing-cookie.tpkg"
    with zipfile.ZipFile(package_path, "w") as archive:
        archive.writestr(MANIFEST_MEMBER, json.dumps(minimal_manifest(), sort_keys=True).encode("utf-8"))

    with pytest.raises(SidecarError) as exc_info:
        import_profile_package(tmp_path / "store", package_path)

    assert_sidecar_error(exc_info, PORTABILITY_PACKAGE_INVALID)
    assert not (tmp_path / "store" / "profile-store" / "profiles.json").exists()


@pytest.mark.parametrize("member_name", ["payload/../evil", "payload/C:/evil", "payload/bad\\evil"])
def test_import_rejects_traversal_absolute_and_backslash_payload_members(tmp_path, member_name):
    package_path = tmp_path / "bad-member.tpkg"
    write_package(package_path, minimal_manifest(), extra_members={member_name: b"evil"})

    with pytest.raises(SidecarError) as exc_info:
        import_profile_package(tmp_path / "store", package_path)

    assert_sidecar_error(exc_info, PORTABILITY_PACKAGE_INVALID)
    assert not (tmp_path / "store" / "profile-store" / "profiles.json").exists()


def test_import_rejects_symlink_payload_entries_before_profile_mutation(tmp_path):
    payload = b"not followed"
    member = f"{PAYLOAD_PREFIX}Default/Preferences"
    manifest = minimal_manifest(
        payload={
            "prefix": PAYLOAD_PREFIX,
            "fileCount": 1,
            "byteCount": len(payload),
            "files": [
                {
                    "path": "Default/Preferences",
                    "member": member,
                    "byteCount": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
            ],
        }
    )
    package_path = tmp_path / "symlink-payload.tpkg"
    symlink_info = zipfile.ZipInfo(member)
    symlink_info.external_attr = (stat.S_IFLNK | 0o777) << 16
    with zipfile.ZipFile(package_path, "w") as archive:
        archive.writestr(MANIFEST_MEMBER, json.dumps(manifest, sort_keys=True).encode("utf-8"))
        archive.writestr(COOKIE_MEMBER, minimal_cookie_payload())
        archive.writestr(symlink_info, payload)

    with pytest.raises(SidecarError) as exc_info:
        import_profile_package(tmp_path / "store", package_path)

    assert_sidecar_error(exc_info, "PORTABILITY_PACKAGE_PAYLOAD_FAILED")
    assert not (tmp_path / "store" / "profile-store" / "profiles.json").exists()


def test_export_rejects_running_profile_with_existing_stopped_guard(tmp_path):
    profile = create_profile_with_payload(tmp_path)
    record = chromium.RuntimeRecord(
        profile_id=profile["id"],
        pid=os.getpid(),
        started_at=utc_now_iso(),
        user_data_dir=profile["storage"]["userDataDir"],
        owner_token="test-owner",
    )
    chromium.RuntimeRegistry(tmp_path).write({profile["id"]: record})

    with pytest.raises(SidecarError) as exc_info:
        export_profile_package(tmp_path, profile["id"], tmp_path / "busy.tpkg")

    assert_sidecar_error(exc_info, PORTABILITY_PROFILE_BUSY)
    assert not (tmp_path / "busy.tpkg").exists()


def test_profile_package_dispatch_returns_only_safe_diagnostics_and_dto_fields(tmp_path):
    profile = create_profile_with_payload(tmp_path)
    destination = tmp_path / "dispatch-export.tpkg"

    response, diagnostics = handle_request_line(
        request_line(
            {
                "id": "pkg-export",
                "method": "portability.profile_package.export",
                "params": {
                    "storeRoot": str(tmp_path),
                    "profileId": profile["id"],
                    "destinationPath": str(destination),
                },
            }
        )
    )

    assert response["ok"] is True
    assert response["id"] == "pkg-export"
    assert response["result"]["operation"] == "export"
    assert diagnostics[0] == {
        "event": "sidecar.request",
        "requestId": "pkg-export",
        "method": "portability.profile_package.export",
        "status": "ok",
        "durationMs": diagnostics[0]["durationMs"],
        "errorCode": None,
        "detailRef": None,
    }
    combined = json.dumps({"response": response, "diagnostics": diagnostics}, ensure_ascii=False, sort_keys=True)
    assert str(tmp_path) not in combined
    assert str(destination) not in combined
    for marker in PUBLIC_FORBIDDEN_MARKERS:
        assert marker not in combined

    diagnostic_log = tmp_path / "profile-store" / "diagnostics" / "events.jsonl"
    assert diagnostic_log.is_file()
    log_text = diagnostic_log.read_text(encoding="utf-8")
    assert "portability.profile_package.export" in log_text
    assert str(tmp_path) not in log_text
    assert str(destination) not in log_text
    for marker in PUBLIC_FORBIDDEN_MARKERS:
        assert marker not in log_text
