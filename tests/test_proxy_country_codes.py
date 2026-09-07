"""Assigned country codes must stay compatible with the UI's strict contract."""
from itertools import product
from pathlib import Path
import re
import string

import pytest

from theprivator_sidecar import proxy_check as check


@pytest.mark.parametrize("code, expected", [("ZZ", None), ("NL", "NL")])
def test_public_exit_country_code_requires_an_assigned_code(code, expected):
    observation = check._public_exit_from_payload({
        "status": "success", "query": "203.0.113.1",
        "country": "Netherlands", "countryCode": code,
    })
    assert observation is not None
    assert observation["location"]["countryCode"] == expected
    result = check._proved_ip_hiding(observation)
    assert result["publicExitIpClaimed"] is True
    assert result["publicExitIp"] == "203.0.113.1"
    assert result["publicExitLocation"]["countryCode"] == expected
    assert result["publicExitLocation"]["country"] == "Netherlands"


@pytest.mark.parametrize("code", ["nl", "Nl", " NL ", "NL\n", "NＬ", "NLD", "", None, 42, ["NL"], {"code": "NL"}])
def test_country_code_tokens_are_not_repaired(code):
    assert check._optional_country_code(code) is None


def test_backend_country_code_acceptance_matches_ui_assigned_codes():
    # Read the source only in tests; the sidecar must not depend on TS at runtime.
    source = (Path(__file__).resolve().parents[1] / "src/sidecar/countries.ts").read_text()
    match = re.search(r'new Set\("([A-Z ]+)"\.split\(" "\)\)', source)
    assert match is not None, "Update this parity check if the UI's code-list format changes"
    assigned_codes = set(match.group(1).split())
    assert len(assigned_codes) == 249
    for letters in product(string.ascii_uppercase, repeat=2):
        code = "".join(letters)
        assert check._optional_country_code(code) == (code if code in assigned_codes else None)
