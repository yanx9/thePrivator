"""Two stores and one shared folder, on one machine, with no network and no mocks.

This is the shape the feature actually ships in, so it is the shape it is tested
in. The second half injects the faults real syncing clients produce -- truncated
files, conflicted copies, stale locks, clock skew, names that resolve to nothing
-- because a sync engine that only works on a quiet folder is a sync engine that
works until the second device wakes up.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from theprivator_sidecar.profiles import ProfileStore
from theprivator_sidecar.protocol import SidecarError
from theprivator_sidecar.sync.engine import (
    RemoteProfileMeta,
    SyncEngine,
    lock_key,
    meta_key,
    parse_meta,
    payload_key,
    summarize,
)
from theprivator_sidecar.sync.folder_store import FolderRemoteStore, make_lock
from theprivator_sidecar.sync.merge import SyncAction
from theprivator_sidecar.sync.state import SyncState, read_state, write_state


@pytest.fixture()
def shared(tmp_path):
    root = tmp_path / "shared"
    root.mkdir()
    return FolderRemoteStore(root)


def device(tmp_path, name: str) -> ProfileStore:
    root = tmp_path / name
    root.mkdir()
    return ProfileStore(root)


def engine(store: ProfileStore, shared: FolderRemoteStore, device_id: str, state: SyncState | None = None):
    return SyncEngine(store, shared, state or SyncState(device_id=device_id, device_label=f"Device {device_id}"))


def revision_of(store: ProfileStore, profile_id: str) -> int:
    for profile in store.list()["profiles"]:
        if profile["id"] == profile_id:
            return int(profile["sync"]["revision"])
    raise AssertionError(f"no profile {profile_id}")


def publish(eng: SyncEngine, store: ProfileStore, profile_id: str, device_id: str, payload: bytes = b"payload"):
    """Push one profile the way a real run would, and record the exchange."""
    name = next(p["name"] for p in store.list()["profiles"] if p["id"] == profile_id)
    revision = revision_of(store, profile_id)
    existing = eng.read_remote_metadata().get(profile_id)
    meta = eng.push_metadata(
        profile_id=profile_id,
        revision=revision,
        name=name,
        device_id=device_id,
        payload=payload,
        trashed=False,
        expected_etag=existing.etag if existing else None,
    )
    eng.record_exchange(
        profile_id=profile_id,
        revision=revision,
        etag=meta.etag,
        payload_key_value=meta.payload_key,
    )
    return meta


class TestFirstExchange:
    def test_a_new_profile_is_planned_for_push(self, tmp_path, shared):
        store = device(tmp_path, "a")
        created = store.create("Banking")["profile"]

        plans = engine(store, shared, "device-a").plan()

        assert [plan.action for plan in plans] == [SyncAction.PUSH]
        assert plans[0].profile_id == created["id"]

    def test_pushing_writes_the_payload_before_the_pointer_to_it(self, tmp_path, shared):
        """A pointer to bytes that have not arrived is a profile the other
        device tries to pull and fails on."""
        store = device(tmp_path, "a")
        created = store.create("Banking")["profile"]
        eng = engine(store, shared, "device-a")

        meta = publish(eng, store, created["id"], "device-a")

        assert meta.payload_key is not None
        assert shared.get(meta.payload_key) == b"payload"
        assert parse_meta(shared.get(meta_key(created["id"]))) is not None

    def test_the_other_device_plans_a_pull(self, tmp_path, shared):
        first = device(tmp_path, "a")
        created = first.create("Banking")["profile"]
        publish(engine(first, shared, "device-a"), first, created["id"], "device-a")

        second = device(tmp_path, "b")
        plans = engine(second, shared, "device-b").plan()

        assert [plan.action for plan in plans] == [SyncAction.PULL]
        assert plans[0].name == "Banking"

    def test_a_profile_both_sides_know_about_needs_nothing(self, tmp_path, shared):
        store = device(tmp_path, "a")
        created = store.create("Banking")["profile"]
        eng = engine(store, shared, "device-a")
        publish(eng, store, created["id"], "device-a")

        assert eng.plan() == []


class TestOngoingChanges:
    def test_a_local_edit_is_planned_for_push_and_nothing_else(self, tmp_path, shared):
        store = device(tmp_path, "a")
        created = store.create("Banking")["profile"]
        eng = engine(store, shared, "device-a")
        publish(eng, store, created["id"], "device-a")

        store.update(created["id"], "Banking EU")
        plans = eng.plan()

        assert [plan.action for plan in plans] == [SyncAction.PUSH]

    def test_deleting_here_while_another_device_edits_asks_instead_of_deleting(self, tmp_path, shared):
        """A device holding a sync record but no profile has deleted it. When the
        other side edited in the meantime, propagating the deletion would throw
        away work that device never saw."""
        first = device(tmp_path, "a")
        created = first.create("Banking")["profile"]
        first_engine = engine(first, shared, "device-a")
        publish(first_engine, first, created["id"], "device-a")

        second = device(tmp_path, "b")
        second_engine = engine(second, shared, "device-b")
        second_engine.record_exchange(
            profile_id=created["id"],
            revision=revision_of(first, created["id"]),
            etag=first_engine.read_remote_metadata()[created["id"]].etag,
            payload_key_value=None,
        )

        first.update(created["id"], "Banking EU")
        publish(first_engine, first, created["id"], "device-a")

        assert [plan.action for plan in second_engine.plan()] == [SyncAction.CONFLICT]

    def test_deleting_here_after_both_sides_agreed_deletes_remotely(self, tmp_path, shared):
        first = device(tmp_path, "a")
        created = first.create("Banking")["profile"]
        first_engine = engine(first, shared, "device-a")
        publish(first_engine, first, created["id"], "device-a")

        second = device(tmp_path, "b")
        second_engine = engine(second, shared, "device-b")
        second_engine.record_exchange(
            profile_id=created["id"],
            revision=revision_of(first, created["id"]),
            etag=first_engine.read_remote_metadata()[created["id"]].etag,
            payload_key_value=None,
        )

        assert [plan.action for plan in second_engine.plan()] == [SyncAction.DELETE_REMOTE]

    def test_edits_on_both_sides_are_reported_as_a_conflict_not_resolved(self, tmp_path, shared):
        """The engine never picks a winner. A folder cannot say which edit came
        first, and guessing throws away someone's work silently."""
        first = device(tmp_path, "a")
        created = first.create("Banking")["profile"]
        first_engine = engine(first, shared, "device-a")
        publish(first_engine, first, created["id"], "device-a")

        agreed = revision_of(first, created["id"])
        etag = first_engine.read_remote_metadata()[created["id"]].etag

        second = device(tmp_path, "b")
        second_engine = engine(second, shared, "device-b")
        second_engine.record_exchange(profile_id=created["id"], revision=agreed, etag=etag, payload_key_value=None)
        second.create("Banking")  # the same profile, as this device holds it
        local_id = second.list()["profiles"][0]["id"]
        second_engine.record_exchange(profile_id=local_id, revision=agreed, etag=etag, payload_key_value=None)

        first.update(created["id"], "Renamed on A")
        publish(first_engine, first, created["id"], "device-a")
        second.update(local_id, "Renamed on B")

        actions = {plan.action for plan in second_engine.plan()}
        assert SyncAction.CONFLICT in actions


class TestContestedWrites:
    def test_a_stale_pointer_write_is_refused_rather_than_overwriting(self, tmp_path, shared):
        """Losing the metadata race must be visible. Overwriting would erase the
        other device's pointer and orphan the payload it just uploaded."""
        store = device(tmp_path, "a")
        created = store.create("Banking")["profile"]
        eng = engine(store, shared, "device-a")
        first = publish(eng, store, created["id"], "device-a")

        # Another device lands its own pointer in the meantime.
        other = RemoteProfileMeta(
            profile_id=created["id"],
            revision=99,
            name="From the other device",
            updated_at="2026-01-01T00:00:00.000Z",
            device_id="device-b",
            payload_key=None,
            trashed=False,
        )
        shared.put(meta_key(created["id"]), other.to_bytes(), expected_etag=first.etag)

        with pytest.raises(SidecarError):
            eng.push_metadata(
                profile_id=created["id"],
                revision=2,
                name="Stale",
                device_id="device-a",
                payload=b"payload",
                trashed=False,
                expected_etag=first.etag,
            )

        assert parse_meta(shared.get(meta_key(created["id"]))).name == "From the other device"

    def test_two_devices_pushing_at_once_both_keep_their_payload(self, tmp_path, shared):
        """Payload names are content addresses, so the bytes never collide --
        only the small pointer is contested, and that is recoverable."""
        store = device(tmp_path, "a")
        created = store.create("Banking")["profile"]
        eng = engine(store, shared, "device-a")

        eng.push_metadata(
            profile_id=created["id"],
            revision=2,
            name="Banking",
            device_id="device-a",
            payload=b"bytes from A",
            trashed=False,
            expected_etag=None,
        )
        keys = {entry.key for entry in shared.list(f"profiles/{created['id']}/payloads")}

        # B uploads different bytes for the same revision.
        digest_b = payload_key(created["id"], 2, __import__("hashlib").sha256(b"bytes from B").hexdigest())
        shared.put(digest_b, b"bytes from B", expected_etag=None)

        assert len(keys | {digest_b}) == 2
        assert shared.get(digest_b) == b"bytes from B"


class TestPayloadRetention:
    def test_superseded_payloads_are_pruned_but_a_few_are_kept(self, tmp_path, shared):
        """A device that has not synced in a while may still be pointing at an
        older revision; deleting what it is about to pull turns a slow device
        into a broken one."""
        store = device(tmp_path, "a")
        created = store.create("Banking")["profile"]
        eng = engine(store, shared, "device-a")
        for revision in range(1, 8):
            shared.put(
                payload_key(created["id"], revision, f"{revision:016x}"),
                f"payload {revision}".encode(),
                expected_etag=None,
            )

        removed = eng.prune_payloads(created["id"], keep_key=None)

        remaining = sorted(entry.key for entry in shared.list(f"profiles/{created['id']}/payloads"))
        assert removed == 4
        assert len(remaining) == 3
        assert all("-000000000000000" in key for key in remaining)

    def test_pruning_never_removes_the_payload_just_written(self, tmp_path, shared):
        store = device(tmp_path, "a")
        created = store.create("Banking")["profile"]
        eng = engine(store, shared, "device-a")
        for revision in range(1, 8):
            shared.put(payload_key(created["id"], revision, f"{revision:016x}"), b"x", expected_etag=None)
        keep = payload_key(created["id"], 1, f"{1:016x}")

        eng.prune_payloads(created["id"], keep_key=keep)

        assert shared.get(keep) is not None

    def test_pruning_does_nothing_when_there_is_little_to_prune(self, tmp_path, shared):
        store = device(tmp_path, "a")
        created = store.create("Banking")["profile"]

        assert engine(store, shared, "device-a").prune_payloads(created["id"], keep_key=None) == 0


class TestLocks:
    def test_a_claim_is_confirmed_by_reading_back_its_own_nonce(self, tmp_path, shared):
        """A folder has no atomic test-and-set, so the write is followed by a
        read: two devices claiming at once will see one nonce, and at most one
        of them sees its own."""
        store = device(tmp_path, "a")
        eng = engine(store, shared, "device-a")

        assert eng.acquire("profile-1", device_id="device-a", device_label="Laptop A")

    def test_a_second_device_is_refused_rather_than_queued(self, tmp_path, shared):
        store = device(tmp_path, "a")
        engine(store, shared, "device-a").acquire("profile-1", device_id="device-a", device_label="Laptop A")

        second = engine(device(tmp_path, "b"), shared, "device-b")
        assert not second.acquire("profile-1", device_id="device-b", device_label="Desktop B")

    def test_the_holder_is_reported_by_the_label_the_user_chose(self, tmp_path, shared):
        store = device(tmp_path, "a")
        eng = engine(store, shared, "device-a")
        eng.acquire("profile-1", device_id="device-a", device_label="Laptop A")

        holder = eng.holder("profile-1")

        assert holder is not None and holder.device_label == "Laptop A"
        assert os.uname().nodename not in json.dumps(
            json.loads((shared.root / lock_key("profile-1")).read_text())
        )

    def test_a_stale_lock_is_never_broken_automatically(self, tmp_path, shared):
        """A machine that never came back leaves a lock forever. Breaking it on a
        timer means a device that was merely slow gets its work overwritten;
        taking it over is the user's decision, confirmed by device label."""
        shared.write_lock(lock_key("profile-1"), make_lock("device-gone", "Old laptop"))
        eng = engine(device(tmp_path, "b"), shared, "device-b")

        assert not eng.acquire("profile-1", device_id="device-b", device_label="Desktop B")
        assert eng.holder("profile-1").device_label == "Old laptop"

    def test_releasing_only_affects_this_device_s_own_claim(self, tmp_path, shared):
        shared.write_lock(lock_key("profile-1"), make_lock("device-b", "Desktop B"))
        eng = engine(device(tmp_path, "a"), shared, "device-a")

        assert not eng.release("profile-1", device_id="device-a")
        assert eng.holder("profile-1") is not None


class TestFaultInjection:
    """Everything a real syncing client does on a bad day."""

    def test_a_truncated_metadata_file_reads_as_absent_rather_than_corrupt(self, tmp_path, shared):
        # Drive presents names before contents arrive. The profile must simply
        # look absent this run and be reconsidered next time.
        path = shared.root / meta_key("profile-1")
        path.parent.mkdir(parents=True)
        path.write_bytes(b'{"version": 1, "profileId": "prof')

        assert engine(device(tmp_path, "a"), shared, "device-a").read_remote_metadata() == {}

    def test_a_metadata_file_with_an_unexpected_key_is_ignored(self, tmp_path, shared):
        path = shared.root / meta_key("profile-1")
        path.parent.mkdir(parents=True)
        path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "profileId": "profile-1",
                    "revision": 2,
                    "name": "Banking",
                    "updatedAt": "2026-01-01T00:00:00.000Z",
                    "deviceId": "device-b",
                    "payloadKey": None,
                    "trashed": False,
                    "somethingNewer": True,
                }
            )
        )

        assert engine(device(tmp_path, "a"), shared, "device-a").read_remote_metadata() == {}

    def test_metadata_whose_id_disagrees_with_its_directory_is_ignored(self, tmp_path, shared):
        """A copied folder would otherwise let one profile's record claim
        another profile's slot."""
        path = shared.root / meta_key("profile-1")
        path.parent.mkdir(parents=True)
        path.write_bytes(
            RemoteProfileMeta(
                profile_id="a-completely-different-id",
                revision=2,
                name="Banking",
                updated_at="2026-01-01T00:00:00.000Z",
                device_id="device-b",
                payload_key=None,
                trashed=False,
            ).to_bytes()
        )

        assert engine(device(tmp_path, "a"), shared, "device-a").read_remote_metadata() == {}

    def test_a_syncthing_conflict_copy_is_not_read_as_a_second_profile(self, tmp_path, shared):
        store = device(tmp_path, "a")
        created = store.create("Banking")["profile"]
        eng = engine(store, shared, "device-a")
        publish(eng, store, created["id"], "device-a")

        directory = shared.root / f"profiles/{created['id']}"
        (directory / "meta.sync-conflict-20260101-120000-ABCDEFG.json").write_bytes(
            (directory / "meta.json").read_bytes()
        )

        assert list(eng.read_remote_metadata()) == [created["id"]]

    def test_clock_skew_does_not_change_any_decision(self, tmp_path, shared):
        """Two machines sharing a folder do not share a clock. Nothing here may
        order by time."""
        store = device(tmp_path, "a")
        created = store.create("Banking")["profile"]
        eng = engine(store, shared, "device-a")
        publish(eng, store, created["id"], "device-a")
        before = eng.plan()

        for path in shared.root.rglob("*"):
            if path.is_file():
                os.utime(path, (0, 0))

        assert eng.plan() == before

    def test_a_file_that_vanishes_between_listing_and_reading_is_skipped(self, tmp_path, shared, monkeypatch):
        store = device(tmp_path, "a")
        created = store.create("Banking")["profile"]
        eng = engine(store, shared, "device-a")
        publish(eng, store, created["id"], "device-a")

        real_get = shared.get
        monkeypatch.setattr(shared, "get", lambda key: None if key.endswith("meta.json") else real_get(key))

        assert eng.read_remote_metadata() == {}

    def test_an_empty_metadata_file_reads_as_absent(self, tmp_path, shared):
        path = shared.root / meta_key("profile-1")
        path.parent.mkdir(parents=True)
        path.write_bytes(b"")

        assert engine(device(tmp_path, "a"), shared, "device-a").read_remote_metadata() == {}

    def test_a_trashed_profile_is_not_reported_as_deleted(self, tmp_path, shared):
        """A trashed profile still exists. Reporting it as gone would propagate a
        permanent deletion the user never asked for."""
        store = device(tmp_path, "a")
        created = store.create("Banking")["profile"]
        eng = engine(store, shared, "device-a")
        publish(eng, store, created["id"], "device-a")
        store.delete(created["id"])

        actions = {plan.action for plan in eng.plan()}

        assert SyncAction.DELETE_REMOTE not in actions


class TestSummaries:
    def test_the_summary_counts_every_action_including_the_absent_ones(self, tmp_path, shared):
        store = device(tmp_path, "a")
        store.create("One")
        store.create("Two")

        counts = summarize(engine(store, shared, "device-a").plan())

        assert counts["push"] == 2
        assert counts["conflict"] == 0
        assert set(counts) == {action.value for action in SyncAction}


class TestStateRoundTrip:
    def test_state_survives_a_write_and_read(self, tmp_path):
        root = tmp_path / "store"
        root.mkdir()
        state = SyncState(device_id="device-a", device_label="Laptop A", sync_root=str(tmp_path), enabled=True)

        write_state(root, state)
        read_back = read_state(root)

        assert read_back.device_label == "Laptop A"
        assert read_back.enabled
        assert read_back.sync_root == str(tmp_path)

    def test_state_is_written_owner_only(self, tmp_path):
        """It records the sync folder path and the device label."""
        root = tmp_path / "store"
        root.mkdir()

        write_state(root, SyncState(device_id="device-a", device_label="Laptop A"))

        assert oct((root / "sync-state.json").stat().st_mode)[-3:] == "600"

    def test_a_damaged_state_reads_as_never_synced_rather_than_failing(self, tmp_path):
        """The safe direction: every profile then looks new on both sides and is
        reported as a conflict, instead of the feature refusing to run."""
        root = tmp_path / "store"
        root.mkdir()
        (root / "sync-state.json").write_text("{ not json")

        assert read_state(root).profiles == {}

    def test_a_state_from_a_newer_build_is_not_trusted(self, tmp_path):
        root = tmp_path / "store"
        root.mkdir()
        (root / "sync-state.json").write_text(json.dumps({"version": 99, "profiles": {"a": {"baseRevision": 4}}}))

        assert read_state(root).profiles == {}


class TestNoSecretReachesTheSharedFolder:
    """The top risk of this whole feature.

    A sync folder is somebody's Drive account. A proxy password that lands there
    is in a third party's version history, and no later fix takes it back.
    """

    SENTINEL_PASSWORD = "proxy-password-sentinel-74d86415"
    SENTINEL_USERNAME = "proxy-user-sentinel-e2e33f73"

    def _folder_bytes(self, shared) -> bytes:
        """Every byte under the sync root, with archives uncompressed.

        Reading the files raw would prove nothing about the archives: a DEFLATE
        member does not contain its plaintext, so a scan of the compressed bytes
        passes whether or not the secret is inside.
        """
        import io
        import zipfile

        collected = bytearray()
        for path in sorted(shared.root.rglob("*")):
            if not path.is_file():
                continue
            collected.extend(path.name.encode("utf-8"))
            raw = path.read_bytes()
            collected.extend(raw)
            if path.suffix == ".tpkg":
                try:
                    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                        for name in archive.namelist():
                            collected.extend(name.encode("utf-8"))
                            collected.extend(archive.read(name))
                except zipfile.BadZipFile:
                    # A payload the syncing client has only half delivered. Its
                    # raw bytes are already in the scan above, which is the most
                    # that can be said about it.
                    pass
        return bytes(collected)

    def test_a_proxy_password_never_reaches_the_sync_folder(self, tmp_path, shared):
        from theprivator_sidecar.sync.apply import build_push_payload

        root = tmp_path / "a"
        root.mkdir()
        store = ProfileStore(root)
        created = store.create("Banking")["profile"]
        store.update_proxy(
            created["id"],
            {
                "proxyVersion": 1,
                "mode": "fixedServer",
                "protocol": "http",
                "host": "10.0.0.9",
                "port": 8080,
                "credentials": {
                    "username": self.SENTINEL_USERNAME,
                    "password": self.SENTINEL_PASSWORD,
                },
            },
        )

        eng = engine(store, shared, "device-a")
        publish(eng, store, created["id"], "device-a", payload=build_push_payload(root, created["id"]))

        contents = self._folder_bytes(shared)
        assert self.SENTINEL_PASSWORD.encode() not in contents
        assert self.SENTINEL_USERNAME.encode() not in contents

    def test_the_scan_would_notice_a_secret_that_did_reach_the_folder(self, tmp_path, shared):
        """Without this, the test above passes on an empty folder and on a
        folder full of passwords alike."""
        shared.put("profiles/a/meta.json", self.SENTINEL_PASSWORD.encode(), expected_etag=None)

        assert self.SENTINEL_PASSWORD.encode() in self._folder_bytes(shared)

    def test_the_scan_looks_inside_archives_not_only_at_them(self, tmp_path, shared):
        import io
        import zipfile

        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", json.dumps({"password": self.SENTINEL_PASSWORD}))
        raw = buffer.getvalue()
        assert self.SENTINEL_PASSWORD.encode() not in raw, "the fixture must be compressed to be meaningful"

        shared.put("profiles/a/payloads/1-abcdef0123456789.tpkg", raw, expected_etag=None)

        assert self.SENTINEL_PASSWORD.encode() in self._folder_bytes(shared)

    def test_the_device_hostname_never_reaches_the_sync_folder(self, tmp_path, shared):
        """The label is user-chosen precisely so the machine's real name stays
        on the machine."""
        root = tmp_path / "a"
        root.mkdir()
        store = ProfileStore(root)
        created = store.create("Banking")["profile"]
        eng = engine(store, shared, "device-a")
        publish(eng, store, created["id"], "device-a")
        eng.acquire(created["id"], device_id="device-a", device_label="Laptop A")

        assert os.uname().nodename.encode() not in self._folder_bytes(shared)
