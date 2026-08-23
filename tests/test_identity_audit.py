"""Tests for the guided public identity audit catalog contract."""

import copy
import json
import re
from pathlib import Path

import pytest

from theprivator_sidecar.identity import curated_preset
from theprivator_sidecar.identity_audit import (
    AUDIT_CATALOG,
    AUDIT_SURFACES,
    AuditPage,
    audit_catalog_payload,
    audit_plan_for_profile,
    build_audit_plan,
    get_audit_page,
    open_audit_page_for_profile,
    validate_audit_catalog,
)
from theprivator_sidecar.chromium import _safe_audit_result_text
from theprivator_sidecar.profiles import ProfileRecord, ProfileStore
from theprivator_sidecar.protocol import (
    IDENTITY_AUDIT_FAILED,
    IDENTITY_AUDIT_PAGE_NOT_FOUND,
    IDENTITY_INVALID,
    SidecarError,
)


EXPECTED_PAGE_URLS = {
    "browserleaks-client-hints": "https://browserleaks.com/client-hints",
    "browserleaks-javascript": "https://browserleaks.com/javascript",
    "browserleaks-canvas": "https://browserleaks.com/canvas",
    "browserleaks-webgl": "https://browserleaks.com/webgl",
    "browserleaks-webrtc": "https://browserleaks.com/webrtc",
    "pixelscan-fingerprint-check": "https://pixelscan.net/fingerprint-check",
    "browserscan-browser-checker": "https://www.browserscan.net/browser-checker",
    "amiunique-fingerprint": "https://amiunique.org/fingerprint",
    "cover-your-tracks": "https://coveryourtracks.eff.org/",
}
FORBIDDEN_MARKERS = (
    "/tmp/secret-store",
    "127.0.0.1",
    "Sensitive Verifier Profile",
    "DevToolsActivePort",
    "debug-port",
    "9222",
    "ws://",
    "target-",
    "targetId",
    "--user-data-dir",
    "Traceback",
    "guaranteed undetectability",
    "universal green",
)


def assert_sidecar_error(exc_info, code):
    error = exc_info.value
    assert isinstance(error, SidecarError)
    assert error.code == code
    assert error.recoverable is True
    assert error.detail_ref.startswith("sidecar-")
    assert error.message
    return error


def encoded(payload) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def changed_catalog_page(page: AuditPage, **overrides) -> AuditPage:
    data = {
        "page_id": page.page_id,
        "label": page.label,
        "category": page.category,
        "url": page.url,
        "surfaces": page.surfaces,
        "comparison_note": page.comparison_note,
        "requires_user_action": page.requires_user_action,
    }
    data.update(overrides)
    return AuditPage(**data)


def test_catalog_has_stable_page_ids_and_exact_https_urls():
    payload = audit_catalog_payload()

    assert [page["id"] for page in payload] == list(EXPECTED_PAGE_URLS)
    assert {page.page_id: page.url for page in AUDIT_CATALOG} == EXPECTED_PAGE_URLS
    assert all(page["url"].startswith("https://") for page in payload)
    assert all(page["surfaces"] for page in payload)
    assert set().union(*(set(page["surfaces"]) for page in payload)) == set(AUDIT_SURFACES)


def test_catalog_copy_is_manual_advisory_and_redacted():
    payload = audit_catalog_payload()
    combined = encoded(payload)

    assert "manual" in combined.lower()
    assert "advisory" in combined.lower()
    assert "stable per-profile altered signature" in combined
    assert "pass or fail" in combined.lower()
    for marker in FORBIDDEN_MARKERS:
        assert marker not in combined


def test_get_audit_page_returns_copy_and_unknown_ids_are_typed():
    page = get_audit_page("browserleaks-webgl")
    page["label"] = "mutated"

    assert get_audit_page("browserleaks-webgl")["label"] == "BrowserLeaks WebGL"
    with pytest.raises(SidecarError) as exc_info:
        get_audit_page("missing-page")

    error = assert_sidecar_error(exc_info, IDENTITY_AUDIT_PAGE_NOT_FOUND)
    assert "missing-page" not in encoded(error.to_dict())


@pytest.mark.parametrize(
    "candidate_page",
    [
        changed_catalog_page(AUDIT_CATALOG[0], page_id=AUDIT_CATALOG[1].page_id),
        changed_catalog_page(AUDIT_CATALOG[0], url="http://browserleaks.com/client-hints"),
        changed_catalog_page(AUDIT_CATALOG[0], url="file:///tmp/checker.html"),
        changed_catalog_page(AUDIT_CATALOG[0], url="https://127.0.0.1/client-hints"),
        changed_catalog_page(AUDIT_CATALOG[0], surfaces=()),
        changed_catalog_page(AUDIT_CATALOG[0], surfaces=("browser", "unknown")),
        changed_catalog_page(AUDIT_CATALOG[0], label="Debug DevToolsActivePort"),
        changed_catalog_page(AUDIT_CATALOG[0], comparison_note="guaranteed undetectability"),
    ],
)
def test_malformed_catalog_entries_fail_typed_validation(candidate_page):
    candidate = list(AUDIT_CATALOG)
    candidate[0] = candidate_page

    with pytest.raises(SidecarError) as exc_info:
        validate_audit_catalog(tuple(candidate))

    error = assert_sidecar_error(exc_info, IDENTITY_AUDIT_FAILED)
    combined = encoded(error.to_dict())
    for marker in FORBIDDEN_MARKERS:
        assert marker not in combined


def test_build_audit_plan_normalizes_identity_and_returns_safe_expected_rows(tmp_path):
    profile = ProfileRecord.create("Sensitive Verifier Profile")
    profile = profile.with_identity(curated_preset("ubuntu-linux-chrome-120"))
    profile_payload = profile.to_dict()
    profile_payload["storage"] = {
        "profileDir": "/tmp/secret-store/profile",
        "userDataDir": "/tmp/secret-store/profile/user-data",
    }

    plan = build_audit_plan(profile_payload)

    assert plan["auditVersion"] == 1
    assert [page["id"] for page in plan["pages"]] == list(EXPECTED_PAGE_URLS)
    assert len(plan["copy"]) == 3
    javascript_page = next(page for page in plan["pages"] if page["id"] == "browserleaks-javascript")
    assert {row["surface"] for row in javascript_page["expectedRows"]} >= {"browser", "navigator", "screen", "locale"}
    assert any("Mozilla/5.0" in row["expected"] for row in javascript_page["expectedRows"])
    canvas_page = next(page for page in plan["pages"] if page["id"] == "browserleaks-canvas")
    assert canvas_page["expectedRows"] == [
        {
            "surface": "canvas",
            "label": "Canvas",
            "expected": "Stable per-profile altered signature from configured noise.",
            "guidance": "Do not compare against a known hash; check that repeated visits with this profile remain stable.",
        }
    ]
    assert list(tmp_path.rglob("*")) == []

    combined = encoded(plan)
    for marker in FORBIDDEN_MARKERS:
        assert marker not in combined


def test_build_audit_plan_redacts_unsafe_configured_identity_text():
    identity = copy.deepcopy(curated_preset("ubuntu-linux-chrome-120"))
    identity["browser"]["userAgent"] = "Mozilla ws://127.0.0.1:9222 DevToolsActivePort --user-data-dir=/tmp/secret-store"
    identity["webgl"]["vendor"] = "targetId vendor"
    identity["webgl"]["renderer"] = "Traceback renderer"

    combined = encoded(build_audit_plan({"identity": identity}))

    for marker in FORBIDDEN_MARKERS:
        assert marker not in combined
    assert "[redacted]" in combined


def test_build_audit_plan_propagates_malformed_identity_errors_without_partial_guidance():
    identity = copy.deepcopy(curated_preset("ubuntu-linux-chrome-120"))
    identity["screen"]["width"] = -1

    with pytest.raises(SidecarError) as exc_info:
        build_audit_plan({"identity": identity, "name": "Sensitive Verifier Profile"})

    assert_sidecar_error(exc_info, IDENTITY_INVALID)


def test_audit_plan_for_profile_reads_store_without_launching_or_writing_runtime(tmp_path):
    profile = ProfileStore(tmp_path).create("Sensitive Verifier Profile")["profile"]
    ProfileStore(tmp_path).apply_identity_preset(profile["id"], "ubuntu-linux-chrome-120")
    store_file = tmp_path / "profile-store" / "profiles.json"
    before_store = store_file.read_text(encoding="utf-8")

    plan = audit_plan_for_profile(tmp_path, profile["id"])

    assert plan["auditVersion"] == 1
    assert [page["id"] for page in plan["pages"]] == list(EXPECTED_PAGE_URLS)
    assert not (tmp_path / "profile-store" / "runtime").exists()
    assert store_file.read_text(encoding="utf-8") == before_store
    combined = encoded(plan)
    assert "Sensitive Verifier Profile" not in combined
    for marker in FORBIDDEN_MARKERS:
        assert marker not in combined


def test_open_audit_page_for_profile_delegates_catalog_page_without_runtime_write(tmp_path, monkeypatch):
    profile = ProfileStore(tmp_path).create("Audit Open Profile")["profile"]
    calls = []

    def fake_open_identity_audit_page(store_root, profile_id, page, *, audit_version):
        calls.append((store_root, profile_id, page, audit_version))
        assert page["id"] == "browserleaks-webgl"
        assert page["url"] == EXPECTED_PAGE_URLS["browserleaks-webgl"]
        assert any(row["surface"] == "webgl" for row in page["expectedRows"])
        return {
            "auditVersion": audit_version,
            "profileId": profile_id,
            "pageId": page["id"],
            "status": "opened",
            "openedAt": "2026-01-01T00:00:00.000Z",
            "launched": False,
            "runningCount": 1,
            "page": page,
        }

    monkeypatch.setattr("theprivator_sidecar.chromium.open_identity_audit_page", fake_open_identity_audit_page)

    result = open_audit_page_for_profile(tmp_path, profile["id"], "browserleaks-webgl")

    assert result["pageId"] == "browserleaks-webgl"
    assert len(calls) == 1
    assert not (tmp_path / "profile-store" / "runtime").exists()
    combined = encoded(result)
    for marker in FORBIDDEN_MARKERS:
        assert marker not in combined


def test_open_audit_page_for_profile_unknown_page_id_is_typed_and_does_not_open(tmp_path, monkeypatch):
    profile = ProfileStore(tmp_path).create("Audit Unknown Profile")["profile"]

    def fail_if_opened(*args, **kwargs):
        raise AssertionError("unknown audit pages must not reach Chromium")

    monkeypatch.setattr("theprivator_sidecar.chromium.open_identity_audit_page", fail_if_opened)

    with pytest.raises(SidecarError) as exc_info:
        open_audit_page_for_profile(tmp_path, profile["id"], "missing-page")

    assert_sidecar_error(exc_info, IDENTITY_AUDIT_PAGE_NOT_FOUND)
    assert not (tmp_path / "profile-store" / "runtime").exists()


# --- Redaction drift between the sidecar and the TypeScript client -----------
#
# The client independently hard-rejects unsafe audit copy, and it rejects the
# whole nine-page snapshot rather than the offending field. So a marker the
# sidecar fails to redact does not leak -- it destroys the entire audit result
# for the user. These tests prove the sidecar's redaction is a superset of the
# client's reject list by reading that list out of client.ts, so the two cannot
# drift apart silently again.

CLIENT_SOURCE = Path(__file__).resolve().parents[1] / "src" / "sidecar" / "client.ts"


def client_audit_reject_markers() -> list[str]:
    source = CLIENT_SOURCE.read_text(encoding="utf-8")
    assert "function containsUnsafeAuditText" in source, "client.ts no longer defines the audit reject list"
    block = source.split("function containsUnsafeAuditText", 1)[1].split("].some((marker)", 1)[0]
    markers = re.findall(r'"([^"]+)"', block)
    assert len(markers) >= 20, f"parsed too few markers from client.ts ({len(markers)}); the parser is stale"
    return markers


def client_would_reject(value: str) -> bool:
    """Mirror of containsUnsafeAuditText in src/sidecar/client.ts."""
    lowered = value.lower()
    if any(marker in lowered for marker in client_audit_reject_markers()):
        return True
    if re.search(r"\b(?:file|ws|wss)://", value, re.IGNORECASE):
        return True
    if re.search(r"(?:^|\s)(?:/[A-Za-z0-9._-]+){2,}", value) or re.search(r"[A-Za-z]:[\\/][^\s]+", value):
        return True
    return False


def test_python_audit_redaction_covers_the_client_reject_list():
    for marker in client_audit_reject_markers():
        captured = f"checker page reported {marker} in its output"
        redacted = _safe_audit_result_text(captured, fallback="Result unavailable.")

        assert not client_would_reject(redacted), (
            f"sidecar left {marker!r} un-redacted as {redacted!r}; "
            "the client would reject the entire audit snapshot"
        )


@pytest.mark.parametrize(
    "captured",
    [
        "path C:\\Windows\\System32\\drivers",
        "path D:/data/profile",
        "see file:///etc/passwd",
        "ws://127.0.0.1:9222/devtools/browser",
        "endpoint at /usr/share/app/data",
        "bare scheme ws://",
    ],
)
def test_python_audit_redaction_covers_the_client_path_and_scheme_rules(captured):
    redacted = _safe_audit_result_text(captured, fallback="Result unavailable.")

    assert not client_would_reject(redacted), f"{captured!r} survived as {redacted!r}"


def test_audit_redaction_keeps_ordinary_checker_copy_readable():
    """Redaction must not be so broad that a normal result becomes unusable."""
    captured = "Canvas fingerprint matches the masked profile value."

    assert _safe_audit_result_text(captured, fallback="Result unavailable.") == captured
