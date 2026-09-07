from pathlib import Path

import pytest

from theprivator_sidecar import chromium
from theprivator_sidecar.profiles import ProfileStore
from theprivator_sidecar.protocol import SidecarError


def test_duplicate_copies_configuration_and_browser_data_with_new_identity(tmp_path):
    store = ProfileStore(tmp_path)
    source = store.create("Research")["profile"]
    store.update_organization(source["id"], {"notes": "First\nSecond", "folderId": "Work", "tags": ["sample"]})
    directory = tmp_path / source["storage"]["userDataDir"]
    (directory / "Default").mkdir()
    (directory / "Default" / "synthetic.txt").write_text("synthetic browser data")
    result = store.duplicate(source["id"])
    clone = result["profile"]
    assert clone["id"] != source["id"]
    assert clone["name"] == "Research copy"
    assert clone["organization"]["notes"] == "First\nSecond"
    assert clone["lifecycle"]["launchCount"] == 0
    copied = tmp_path / clone["storage"]["userDataDir"] / "Default" / "synthetic.txt"
    assert copied.read_text() == "synthetic browser data"
    copied.write_text("independent")
    assert (directory / "Default" / "synthetic.txt").read_text() == "synthetic browser data"
    assert store.duplicate(source["id"])["profile"]["name"] == "Research copy 2"


def test_duplicate_rejects_running_profile_before_writes(tmp_path, monkeypatch):
    store = ProfileStore(tmp_path)
    source = store.create("Research")["profile"]
    def reject(*args):
        raise SidecarError(code="PORTABILITY_PROFILE_BUSY", message="Stop profile first.")
    monkeypatch.setattr(chromium, "ensure_profile_stopped_for_portability", reject)
    with pytest.raises(SidecarError):
        store.duplicate(source["id"])
    assert store.list()["count"] == 1


def test_duplicate_rolls_back_on_unsafe_browser_tree(tmp_path):
    store = ProfileStore(tmp_path)
    source = store.create("Research")["profile"]
    directory = tmp_path / source["storage"]["userDataDir"]
    (directory / "outside").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(SidecarError):
        store.duplicate(source["id"])
    assert store.list()["count"] == 1
    assert len(list((tmp_path / "profile-store" / "profiles").iterdir())) == 1
