"""The folder backend, tested against what real syncing clients actually do.

Every case here corresponds to a thing Drive, Dropbox or Syncthing does in
normal operation: leave a conflicted copy, present a name whose contents have
not arrived, rewrite an mtime, or drop a file halfway through. A backend that
only works when nothing goes wrong is a backend that works until the second
device joins.
"""

from __future__ import annotations

import json
import os
import stat

import pytest

from theprivator_sidecar.protocol import SidecarError
from theprivator_sidecar.sync.folder_store import (
    SYNC_ROOT_INVALID,
    FolderRemoteStore,
    is_conflict_artifact,
    make_lock,
)


@pytest.fixture()
def store(tmp_path):
    root = tmp_path / "sync"
    root.mkdir()
    return FolderRemoteStore(root)


def test_health_reports_a_missing_folder_rather_than_creating_one(tmp_path):
    """Creating it silently would hide a typo in the path until the user
    wondered why the other machine sees nothing."""
    health = FolderRemoteStore(tmp_path / "nope").health()

    assert not health.reachable
    assert not (tmp_path / "nope").exists()


def test_health_reports_a_read_only_folder_as_reachable_but_not_writable(store):
    os.chmod(store.root, stat.S_IRUSR | stat.S_IXUSR)
    try:
        health = store.health()
    finally:
        os.chmod(store.root, stat.S_IRWXU)

    assert health.reachable
    assert not health.writable


def test_health_leaves_no_probe_file_behind(store):
    store.health()

    assert list(store.root.iterdir()) == []


def test_a_written_object_reads_back_byte_for_byte(store):
    payload = b"\x00\xff binary \xc3\xa9"
    outcome = store.put("profiles/a/meta.json", payload, expected_etag=None)

    assert outcome.ok
    assert store.get("profiles/a/meta.json") == payload


def test_a_missing_object_reads_as_none_rather_than_raising(store):
    assert store.get("profiles/a/meta.json") is None


def test_a_first_write_requires_that_nothing_is_there(store):
    store.put("profiles/a/meta.json", b"first", expected_etag=None)

    outcome = store.put("profiles/a/meta.json", b"second", expected_etag=None)

    assert not outcome.ok
    assert outcome.current_etag is not None
    assert store.get("profiles/a/meta.json") == b"first"


def test_a_conditional_write_succeeds_on_the_etag_that_was_read(store):
    first = store.put("profiles/a/meta.json", b"first", expected_etag=None)

    outcome = store.put("profiles/a/meta.json", b"second", expected_etag=first.etag)

    assert outcome.ok
    assert store.get("profiles/a/meta.json") == b"second"


def test_a_conditional_write_loses_against_a_write_that_landed_first(store):
    first = store.put("profiles/a/meta.json", b"first", expected_etag=None)
    store.put("profiles/a/meta.json", b"from the other device", expected_etag=first.etag)

    outcome = store.put("profiles/a/meta.json", b"stale", expected_etag=first.etag)

    assert not outcome.ok
    assert store.get("profiles/a/meta.json") == b"from the other device"


def test_the_etag_is_content_not_time(store):
    """Two machines sharing a folder do not share a clock, and syncing clients
    rewrite mtimes as they please. Ordering by time silently prefers whichever
    device runs fast."""
    written = store.put("profiles/a/meta.json", b"same bytes", expected_etag=None)
    path = store.root / "profiles/a/meta.json"

    os.utime(path, (1, 1))
    unchanged = store.list("profiles/a")[0].etag
    assert unchanged == written.etag

    path.write_bytes(b"different bytes")
    assert store.list("profiles/a")[0].etag != written.etag


def test_a_partial_write_is_never_visible_under_the_final_name(store, monkeypatch):
    """A syncing client watching this directory must not catch a half-written
    file and upload it as though it were complete."""
    seen: list[bytes] = []
    real_replace = os.replace

    def recording_replace(source, destination):
        # Whatever is under the final name at the moment of the swap is what a
        # watcher could have uploaded.
        target = store.root / "profiles/a/meta.json"
        seen.append(target.read_bytes() if target.exists() else b"")
        return real_replace(source, destination)

    monkeypatch.setattr(os, "replace", recording_replace)
    store.put("profiles/a/meta.json", b"complete payload", expected_etag=None)

    assert seen == [b""]
    assert store.get("profiles/a/meta.json") == b"complete payload"


def test_a_failed_write_leaves_no_partial_file(store, monkeypatch):
    def failing_replace(source, destination):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(os, "replace", failing_replace)
    with pytest.raises(SidecarError):
        store.put("profiles/a/meta.json", b"payload", expected_etag=None)

    leftovers = [path.name for path in (store.root / "profiles/a").iterdir()]
    assert leftovers == []


def test_objects_are_written_owner_only(store):
    store.put("profiles/a/meta.json", b"payload", expected_etag=None)

    mode = (store.root / "profiles/a/meta.json").stat().st_mode
    assert stat.S_IMODE(mode) == 0o600


def test_listing_skips_a_syncthing_conflict_copy(store):
    store.put("profiles/a/meta.json", b"ours", expected_etag=None)
    (store.root / "profiles/a/meta.sync-conflict-20260101-120000-ABCDEFG.json").write_bytes(b"theirs")

    keys = [entry.key for entry in store.list("profiles")]

    assert keys == ["profiles/a/meta.json"]


def test_listing_skips_a_drive_numbered_copy(store):
    store.put("profiles/a/meta.json", b"ours", expected_etag=None)
    (store.root / "profiles/a/meta (1).json").write_bytes(b"theirs")

    keys = [entry.key for entry in store.list("profiles")]

    assert keys == ["profiles/a/meta.json"]


def test_listing_skips_a_conflicted_directory_not_only_a_conflicted_file(store):
    store.put("profiles/a/meta.json", b"ours", expected_etag=None)
    stray = store.root / "profiles/a.sync-conflict-20260101-120000-ABCDEFG"
    stray.mkdir()
    (stray / "meta.json").write_bytes(b"theirs")

    keys = [entry.key for entry in store.list("profiles")]

    assert keys == ["profiles/a/meta.json"]


@pytest.mark.parametrize(
    "name",
    [
        "meta.sync-conflict-20260101-120000-ABCDEFG.json",
        "meta (1).json",
        "meta (12).json",
        "profile (conflicted copy 2026-01-01).json",
        ".~tmp-meta.json",
    ],
)
def test_known_client_debris_is_recognised(name):
    assert is_conflict_artifact(name)


@pytest.mark.parametrize("name", ["meta.json", "1-abc123def4567890.tpkg", "lock.json", "a-b_c.json"])
def test_real_names_are_not_mistaken_for_debris(name):
    assert not is_conflict_artifact(name)


def test_listing_survives_a_file_that_vanishes_between_listing_and_reading(store, monkeypatch):
    """Drive presents names before their contents arrive, and another device can
    delete while a listing is in flight."""
    store.put("profiles/a/meta.json", b"ours", expected_etag=None)
    store.put("profiles/b/meta.json", b"theirs", expected_etag=None)

    real_stat = os.stat

    def flaky_stat(path, *args, **kwargs):
        if str(path).endswith("profiles/b/meta.json"):
            raise FileNotFoundError(2, "No such file or directory")
        return real_stat(path, *args, **kwargs)

    monkeypatch.setattr(os, "stat", flaky_stat)
    keys = [entry.key for entry in store.list("profiles")]

    assert keys == ["profiles/a/meta.json"]


def test_listing_an_absent_prefix_is_empty_rather_than_an_error(store):
    assert store.list("profiles") == []


def test_a_truncated_object_still_reads_as_bytes_for_the_caller_to_reject(store):
    """Rejecting it here would leave the engine unable to tell "unreadable" from
    "not there yet", and the two need different handling."""
    (store.root / "profiles").mkdir()
    (store.root / "profiles/a").mkdir()
    (store.root / "profiles/a/meta.json").write_bytes(b'{"revision": 3, "profi')

    assert store.get("profiles/a/meta.json") == b'{"revision": 3, "profi'


def test_deleting_reports_whether_anything_was_there(store):
    store.put("profiles/a/meta.json", b"payload", expected_etag=None)

    assert store.delete("profiles/a/meta.json")
    assert not store.delete("profiles/a/meta.json")


@pytest.mark.parametrize(
    "key",
    [
        "../escape.json",
        "profiles/../../escape.json",
        "/absolute.json",
        "profiles\\a\\meta.json",
        "profiles/./meta.json",
        "",
        "profiles/" + "x" * 300,
    ],
)
def test_a_key_that_could_escape_the_sync_root_is_refused(store, key):
    """The root is the only absolute path the frontend supplies, and keys are
    built from ids that ultimately came from another machine."""
    with pytest.raises(SidecarError) as caught:
        store.get(key)

    assert caught.value.code == SYNC_ROOT_INVALID


def test_writing_outside_the_root_is_refused_before_anything_is_created(store, tmp_path):
    target = tmp_path / "escaped.json"

    with pytest.raises(SidecarError):
        store.put("../escaped.json", b"payload", expected_etag=None)

    assert not target.exists()


class TestLocks:
    def test_an_unheld_lock_reads_as_none(self, store):
        assert store.read_lock("profiles/a/lock.json") is None

    def test_a_lock_records_the_label_the_user_chose_and_no_hostname(self, store):
        lock = make_lock("device-a", "Laptop A")
        store.write_lock("profiles/a/lock.json", lock)

        read = store.read_lock("profiles/a/lock.json")
        assert read is not None
        assert read.device_label == "Laptop A"
        assert os.uname().nodename not in (store.root / "profiles/a/lock.json").read_text()

    def test_a_second_device_cannot_take_a_held_lock(self, store):
        store.write_lock("profiles/a/lock.json", make_lock("device-a", "Laptop A"))

        assert not store.write_lock("profiles/a/lock.json", make_lock("device-b", "Desktop B"))
        held = store.read_lock("profiles/a/lock.json")
        assert held is not None and held.device_id == "device-a"

    def test_the_holder_may_refresh_its_own_lock(self, store):
        store.write_lock("profiles/a/lock.json", make_lock("device-a", "Laptop A"))

        assert store.write_lock("profiles/a/lock.json", make_lock("device-a", "Laptop A"))

    def test_a_device_cannot_clear_a_lock_that_moved_on(self, store):
        """A slow device coming back must not release a claim someone else is
        now relying on."""
        store.write_lock("profiles/a/lock.json", make_lock("device-b", "Desktop B"))

        assert not store.clear_lock("profiles/a/lock.json", device_id="device-a")
        assert store.read_lock("profiles/a/lock.json") is not None

    def test_an_unconditional_clear_is_the_deliberate_takeover(self, store):
        store.write_lock("profiles/a/lock.json", make_lock("device-b", "Desktop B"))

        assert store.clear_lock("profiles/a/lock.json")
        assert store.read_lock("profiles/a/lock.json") is None

    def test_a_half_written_lock_reads_as_absent(self, store):
        (store.root / "profiles/a").mkdir(parents=True)
        (store.root / "profiles/a/lock.json").write_bytes(b'{"deviceId": "device-a", "devic')

        assert store.read_lock("profiles/a/lock.json") is None

    def test_a_lock_missing_a_field_reads_as_absent_rather_than_half_valid(self, store):
        (store.root / "profiles/a").mkdir(parents=True)
        (store.root / "profiles/a/lock.json").write_text(json.dumps({"deviceId": "device-a"}))

        assert store.read_lock("profiles/a/lock.json") is None

    def test_an_absurdly_long_label_reads_as_absent(self, store):
        (store.root / "profiles/a").mkdir(parents=True)
        (store.root / "profiles/a/lock.json").write_text(
            json.dumps(
                {
                    "deviceId": "device-a",
                    "deviceLabel": "L" * 500,
                    "acquiredAt": "2026-01-01T00:00:00.000Z",
                    "nonce": "abc",
                }
            )
        )

        assert store.read_lock("profiles/a/lock.json") is None

    def test_each_claim_carries_a_fresh_nonce(self, store):
        """The nonce is how a device confirms the claim it reads back is its own
        rather than a same-device claim from another moment."""
        first = make_lock("device-a", "Laptop A")
        second = make_lock("device-a", "Laptop A")

        assert first.nonce != second.nonce
