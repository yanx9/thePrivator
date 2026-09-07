import pytest

from theprivator_sidecar.profile_sections import normalize_organization
from theprivator_sidecar.protocol import SidecarError


def test_notes_preserve_multiline_text_and_named_folders():
    value = {"notes": "First\nSecond\r\n\tIndented", "folderId": "Work_2026"}
    normalized = normalize_organization(value)
    assert normalized["notes"] == value["notes"]
    assert normalized["folderId"] == "Work_2026"


@pytest.mark.parametrize("value", ["bad\x00note", "bad\x1bnote", "bad\x7fnote"])
def test_notes_still_reject_unsafe_control_characters(value):
    with pytest.raises(SidecarError):
        normalize_organization({"notes": value})


@pytest.mark.parametrize("value", ["../escape", "with/slash", "with space", "x" * 65])
def test_folders_remain_bounded_route_safe_identifiers(value):
    with pytest.raises(SidecarError):
        normalize_organization({"folderId": value})
