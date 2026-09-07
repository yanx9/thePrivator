"""Cookie import regression tests using synthetic browser-export data only."""

import json
import sqlite3

import pytest

from theprivator_sidecar import cookies
from theprivator_sidecar.profiles import ProfileStore
from theprivator_sidecar.protocol import PORTABILITY_COOKIE_FILE_INVALID, SidecarError


def browser_cookie(**changes):
    raw = {
        "name": "synthetic-session",
        "value": "synthetic-value",
        "domain": ".example.invalid",
        "path": "/",
        "secure": True,
        "httpOnly": True,
        "hostOnly": False,
        "session": False,
        "sameSite": "Lax",
        "expirationDate": 13_462_401_644.75,
        "storeId": "0",
    }
    raw.update(changes)
    return raw


def import_json(tmp_path, payload):
    source = tmp_path / "cookies.json"
    source.write_text(json.dumps(payload), encoding="utf-8")
    return cookies._read_import_payload(source)


def test_import_browser_array_preserves_unix_epoch_and_flags(tmp_path):
    payload = import_json(tmp_path, [browser_cookie()])
    assert payload.cookies == [
        cookies.CookieDTO(
            domain=".example.invalid",
            host_only=False,
            path="/",
            name="synthetic-session",
            value="synthetic-value",
            secure=True,
            http_only=True,
            expires_unix=13_462_401_644,
            same_site="lax",
        )
    ]
    assert (
        cookies.chrome_time_to_unix(
            cookies.unix_time_to_chrome(payload.cookies[0].expires_unix)
        )
        == 13_462_401_644
    )
    assert payload.skipped_count == 0


@pytest.mark.parametrize("expiry", [None, 1_900_000_000.25])
def test_browser_session_cookie_has_no_expiry(tmp_path, expiry):
    raw = browser_cookie(session=True)
    if expiry is None:
        del raw["expirationDate"]
    else:
        raw["expirationDate"] = expiry
    assert import_json(tmp_path, [raw]).cookies[0].expires_unix is None


@pytest.mark.parametrize(
    "expiry",
    [
        float("nan"),
        float("inf"),
        -float("inf"),
        True,
        "1900000000",
        -0.5,
        253_402_300_799.5,
    ],
)
def test_browser_invalid_expiry_is_a_safe_validation_error(tmp_path, expiry):
    with pytest.raises(SidecarError) as error:
        import_json(tmp_path, [browser_cookie(expirationDate=expiry)])
    assert error.value.code == PORTABILITY_COOKIE_FILE_INVALID
    assert "synthetic" not in error.value.message


@pytest.mark.parametrize(
    "same_site, expected",
    [
        ("Lax", "lax"),
        ("STRICT", "strict"),
        ("Strict", "strict"),
        ("Unspecified", "unspecified"),
        ("unspecified", "unspecified"),
        ("no_restriction", "no_restriction"),
    ],
)
def test_browser_same_site_variants(tmp_path, same_site, expected):
    assert (
        import_json(tmp_path, [browser_cookie(sameSite=same_site)]).cookies[0].same_site
        == expected
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"session": "true"},
        {"session": False, "expirationDate": None},
        {"secure": 1},
        {"httpOnly": "false"},
        {"hostOnly": None},
        {"sameSite": "invalid"},
        {"path": "relative"},
        {"name": "bad\nname"},
    ],
)
def test_browser_invalid_fields_reject_entire_import(tmp_path, changes):
    with pytest.raises(SidecarError) as error:
        import_json(tmp_path, [browser_cookie(), browser_cookie(**changes)])
    assert error.value.code == PORTABILITY_COOKIE_FILE_INVALID


@pytest.mark.parametrize("row", [None, "cookie", 12, []])
def test_browser_non_object_rows_rejected(tmp_path, row):
    with pytest.raises(SidecarError):
        import_json(tmp_path, [row])


@pytest.mark.parametrize("host_only", [True, False])
def test_browser_scope_normalized_before_dedup_and_db_export(tmp_path, host_only):
    root = tmp_path / "store"
    profile = ProfileStore(root).create("Synthetic")["profile"]
    source = tmp_path / "cookies.json"
    value = "  synthetic=值;+/%  "
    source.write_text(json.dumps([
        browser_cookie(domain=".example.invalid", hostOnly=host_only),
        browser_cookie(domain="example.invalid", hostOnly=host_only, value=value),
    ]))
    expected_domain = "example.invalid" if host_only else ".example.invalid"
    parsed = cookies._read_import_payload(source)
    assert [cookie.domain for cookie in parsed.cookies] == [expected_domain] * 2
    result = cookies.replace_cookies(root, profile["id"], source)
    assert result["importedCount"] == 1
    assert result["skippedCount"] == 1
    assert result["warnings"][0]["code"] == "IMPORT_DUPLICATE_REPLACED"
    database = root / profile["storage"]["userDataDir"] / "Default" / "Network" / "Cookies"
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT host_key, value FROM cookies").fetchall() == [
            (expected_domain, value)
        ]
    destination = tmp_path / "export.json"
    exported = cookies.export_cookies(root, profile["id"], destination, "json")
    assert exported["exportedCount"] == 1
    round_trip = cookies._read_import_payload(destination).cookies[0]
    assert round_trip.domain == expected_domain
    assert round_trip.host_only is host_only
    assert round_trip.value == value
    assert cookies.replace_cookies(root, profile["id"], destination)["importedCount"] == 1
    cookies.export_cookies(root, profile["id"], destination, "json")
    assert cookies._read_import_payload(destination).cookies == [round_trip]


@pytest.mark.parametrize("metadata", [
    {"partitionKey": {"topLevelSite": "https://synthetic.invalid", "hasCrossSiteAncestor": True}},
    {"partitionKey": "https://synthetic.invalid"},
    {"partitionKey": {}},
    {"partitionKey": ""},
    {"partitionKey": False},
    {"partitioned": True},
    {"partitioned": "false"},
    {"partitioned": 0},
    {"partitioned": None},
    {"partitionKeyOpaque": True},
    {"partitionKeyOpaque": "false"},
    {"partitionKey": {"topLevelSite": "https://synthetic.invalid"}, "partitioned": False},
])
def test_browser_partition_metadata_rejected_without_mutating_db(tmp_path, metadata):
    root = tmp_path / "store"
    profile = ProfileStore(root).create("Synthetic")["profile"]
    source = tmp_path / "cookies.json"
    source.write_text(json.dumps([browser_cookie(name="synthetic-existing")]))
    cookies.replace_cookies(root, profile["id"], source)
    database = root / profile["storage"]["userDataDir"] / "Default" / "Network" / "Cookies"
    with sqlite3.connect(database) as connection:
        before = connection.execute("SELECT * FROM cookies").fetchall()
    source.write_text(json.dumps([
        browser_cookie(name="synthetic-new"),
        browser_cookie(value="synthetic-secret", **metadata),
    ]))
    with pytest.raises(SidecarError) as error:
        cookies.replace_cookies(root, profile["id"], source)
    assert error.value.code == PORTABILITY_COOKIE_FILE_INVALID
    assert error.value.message == "Cookie import file is invalid."
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT * FROM cookies").fetchall() == before
    destination = tmp_path / "export.json"
    cookies.export_cookies(root, profile["id"], destination, "json")
    assert [cookie.name for cookie in cookies._read_import_payload(destination).cookies] == [
        "synthetic-existing"
    ]


@pytest.mark.parametrize("metadata", [
    {}, {"partitioned": False}, {"partitionKey": None},
    {"partitionKeyOpaque": False},
    {"partitioned": False, "partitionKey": None, "partitionKeyOpaque": False},
])
def test_browser_explicit_unpartitioned_metadata_accepted(tmp_path, metadata):
    assert import_json(tmp_path, [browser_cookie(**metadata)]).cookies[0].value == "synthetic-value"


def test_empty_browser_array(tmp_path):
    assert import_json(tmp_path, []).cookies == []


def test_existing_formats_and_package_contract_unchanged(tmp_path):
    dto = cookies.CookieDTO(
        "example.invalid", True, "/", "synthetic", "value", False, False, 1_900_000_000
    )
    text, _ = cookies._serialize_cookies([dto], cookies.FORMAT_THEPRIVATOR_JSON)
    assert import_json(tmp_path, json.loads(text)).cookies == [dto]
    assert cookies.parse_theprivator_cookie_payload_bytes(text.encode()).cookies == [
        dto
    ]
    with pytest.raises(SidecarError):
        cookies.parse_theprivator_cookie_payload_bytes(
            json.dumps([browser_cookie()]).encode()
        )
    raw = json.loads(text)
    raw["cookies"][0]["storeId"] = "0"
    with pytest.raises(SidecarError):
        import_json(tmp_path, raw)
    source = tmp_path / "cookies.txt"
    source.write_text(
        "example.invalid\tFALSE\t/\tFALSE\t1900000000\tsynthetic\tvalue\n"
    )
    parsed = cookies._read_import_payload(source).cookies[0]
    assert parsed.expires_unix == dto.expires_unix
    assert parsed.host_only is True


@pytest.mark.parametrize("expiry", [0, 253_402_300_799, 13_462_401_644.75])
def test_browser_expiry_round_trip_through_sqlite(tmp_path, expiry):
    root = tmp_path / "store"
    profile = ProfileStore(root).create("Synthetic")["profile"]
    source = tmp_path / "cookies.json"
    source.write_text(json.dumps([browser_cookie(expirationDate=expiry)]))
    result = cookies.replace_cookies(root, profile["id"], source)
    assert result["importedCount"] == 1
    database = (
        root / profile["storage"]["userDataDir"] / "Default" / "Network" / "Cookies"
    )
    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT expires_utc, is_secure, is_httponly, samesite FROM cookies"
        ).fetchone()
    assert row == (cookies.unix_time_to_chrome(int(expiry)), 1, 1, 1)
