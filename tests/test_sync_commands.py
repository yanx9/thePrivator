"""The sync commands as the frontend reaches them: through NDJSON dispatch.

Two devices and one folder, driven entirely by request dictionaries. Nothing is
mocked, so a command that works here works in the app -- and a response that
leaks a path fails here rather than in a screenshot.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from theprivator_sidecar.main import dispatch
from theprivator_sidecar.profiles import ProfileStore
from theprivator_sidecar.protocol import SidecarError, SidecarRequest


def call(method: str, store_root: Path, **params):
    request = SidecarRequest(id="req-1", method=method, params={"storeRoot": str(store_root), **params})
    return dispatch(request)


@pytest.fixture()
def two_devices(tmp_path):
    shared = tmp_path / "drive"
    shared.mkdir()
    first = tmp_path / "a"
    first.mkdir()
    second = tmp_path / "b"
    second.mkdir()
    return shared, first, second


def enable(store_root: Path, shared: Path, label: str):
    return call("sync.configure", store_root, enabled=True, folder=str(shared), deviceLabel=label)


class TestConfiguration:
    def test_sync_starts_off(self, two_devices):
        _, first, _ = two_devices

        status = call("sync.status", first)

        assert status["enabled"] is False
        assert status["configured"] is False

    def test_enabling_reports_the_folder_by_name_and_never_by_path(self, two_devices):
        """The sync root is the only absolute path the frontend supplies, and the
        redaction perimeter treats an absolute path in a response as a leak."""
        shared, first, _ = two_devices

        status = enable(first, shared, "Laptop A")

        assert status["enabled"] is True
        assert status["folderName"] == "drive"
        assert str(shared) not in json.dumps(status)

    def test_the_device_label_is_the_one_the_user_chose(self, two_devices):
        shared, first, _ = two_devices

        assert enable(first, shared, "Laptop A")["deviceLabel"] == "Laptop A"

    def test_a_folder_inside_the_profile_store_is_refused(self, two_devices):
        """Syncing the store into itself would have the engine sync its own
        working files."""
        _, first, _ = two_devices
        inside = first / "profile-store" / "nested"
        inside.mkdir(parents=True)

        with pytest.raises(SidecarError) as caught:
            call("sync.configure", first, enabled=True, folder=str(inside), deviceLabel="Laptop A")

        assert caught.value.code == "SYNC_ROOT_REFUSED"

    def test_a_folder_that_does_not_exist_is_refused_rather_than_created(self, two_devices):
        """Creating it silently hides a typo until the user wonders why the
        other machine sees nothing."""
        _, first, _ = two_devices

        with pytest.raises(SidecarError):
            call("sync.configure", first, enabled=True, folder=str(first / "nope"), deviceLabel="Laptop A")

    def test_turning_sync_off_keeps_what_was_already_agreed(self, two_devices):
        """Turning it back on should resume, not re-conflict every profile."""
        shared, first, _ = two_devices
        enable(first, shared, "Laptop A")
        ProfileStore(first).create("Banking")
        call("sync.run", first)
        before = call("sync.status", first)["trackedProfiles"]

        call("sync.configure", first, enabled=False)
        after = call("sync.status", first)

        assert before == 1
        assert after["enabled"] is False
        assert after["trackedProfiles"] == 1


class TestPlanningAndRunning:
    def test_planning_before_configuring_says_so(self, two_devices):
        _, first, _ = two_devices

        with pytest.raises(SidecarError) as caught:
            call("sync.plan", first)

        assert caught.value.code == "SYNC_NOT_CONFIGURED"

    def test_a_new_profile_is_planned_and_then_uploaded(self, two_devices):
        shared, first, _ = two_devices
        enable(first, shared, "Laptop A")
        created = ProfileStore(first).create("Banking")["profile"]

        planned = call("sync.plan", first)
        assert planned["counts"]["push"] == 1
        assert planned["plans"][0]["profileId"] == created["id"]

        result = call("sync.run", first)
        assert [entry["action"] for entry in result["applied"]] == ["uploaded"]
        assert result["conflicts"] == []

    def test_the_second_device_receives_it(self, two_devices):
        shared, first, second = two_devices
        enable(first, shared, "Laptop A")
        created = ProfileStore(first).create("Banking")["profile"]
        call("sync.run", first)

        enable(second, shared, "Desktop B")
        result = call("sync.run", second)

        assert [entry["action"] for entry in result["applied"]] == ["created"]
        assert [p["id"] for p in ProfileStore(second).list()["profiles"]] == [created["id"]]
        assert ProfileStore(second).list()["profiles"][0]["name"] == "Banking"

    def test_running_twice_changes_nothing_the_second_time(self, two_devices):
        """A sync that keeps finding work to do on an unchanged library is a
        sync that is rewriting things for no reason."""
        shared, first, _ = two_devices
        enable(first, shared, "Laptop A")
        ProfileStore(first).create("Banking")
        call("sync.run", first)

        second_run = call("sync.run", first)

        assert second_run["applied"] == []
        assert second_run["conflicts"] == []

    def test_an_edit_on_one_device_reaches_the_other(self, two_devices):
        shared, first, second = two_devices
        enable(first, shared, "Laptop A")
        created = ProfileStore(first).create("Banking")["profile"]
        call("sync.run", first)
        enable(second, shared, "Desktop B")
        call("sync.run", second)

        ProfileStore(first).update(created["id"], "Banking EU")
        call("sync.run", first)
        call("sync.run", second)

        assert ProfileStore(second).get(created["id"]).name == "Banking EU"

    def test_a_conflict_is_reported_and_left_alone(self, two_devices):
        """The engine never picks a winner; that decision belongs to whoever
        knows which edit mattered."""
        shared, first, second = two_devices
        enable(first, shared, "Laptop A")
        created = ProfileStore(first).create("Banking")["profile"]
        call("sync.run", first)
        enable(second, shared, "Desktop B")
        call("sync.run", second)

        ProfileStore(first).update(created["id"], "Renamed on A")
        call("sync.run", first)
        ProfileStore(second).update(created["id"], "Renamed on B")

        result = call("sync.run", second)

        assert [entry["profileId"] for entry in result["conflicts"]] == [created["id"]]
        assert result["applied"] == []
        assert ProfileStore(second).get(created["id"]).name == "Renamed on B"


class TestResolving:
    def _conflicted(self, shared, first, second):
        enable(first, shared, "Laptop A")
        created = ProfileStore(first).create("Banking")["profile"]
        call("sync.run", first)
        enable(second, shared, "Desktop B")
        call("sync.run", second)
        ProfileStore(first).update(created["id"], "Renamed on A")
        call("sync.run", first)
        ProfileStore(second).update(created["id"], "Renamed on B")
        call("sync.run", second)
        return created["id"]

    def test_keeping_the_local_side_uploads_it(self, two_devices):
        shared, first, second = two_devices
        profile_id = self._conflicted(shared, first, second)

        result = call("sync.resolve", second, profileId=profile_id, resolution="keepLocal")

        assert result["resolved"]["action"] == "uploaded"
        assert ProfileStore(second).get(profile_id).name == "Renamed on B"

    def test_keeping_the_remote_side_takes_it_but_sets_the_local_data_aside(self, two_devices):
        """The user asked to prefer the other side, not to have this one erased.
        The only copy of a logged-in session may be the one being replaced."""
        shared, first, second = two_devices
        profile_id = self._conflicted(shared, first, second)

        result = call("sync.resolve", second, profileId=profile_id, resolution="keepRemote")

        assert ProfileStore(second).get(profile_id).name == "Renamed on A"
        assert result["resolved"]["keptCopyAs"] is not None
        assert (second / "conflicts" / result["resolved"]["keptCopyAs"]).exists()

    def test_keeping_both_leaves_two_profiles(self, two_devices):
        shared, first, second = two_devices
        profile_id = self._conflicted(shared, first, second)

        call("sync.resolve", second, profileId=profile_id, resolution="keepBoth")

        names = sorted(p["name"] for p in ProfileStore(second).list()["profiles"])
        assert len(names) == 2
        assert "Renamed on B" in names

    def test_an_unknown_resolution_is_refused(self, two_devices):
        shared, first, second = two_devices
        profile_id = self._conflicted(shared, first, second)

        with pytest.raises(SidecarError) as caught:
            call("sync.resolve", second, profileId=profile_id, resolution="justPickOne")

        assert caught.value.code == "INVALID_REQUEST"

    def test_resolving_clears_the_conflict(self, two_devices):
        shared, first, second = two_devices
        profile_id = self._conflicted(shared, first, second)

        call("sync.resolve", second, profileId=profile_id, resolution="keepRemote")

        assert call("sync.run", second)["conflicts"] == []


class TestLockTakeover:
    def test_taking_over_requires_the_holding_device_s_label(self, two_devices):
        """A stale lock and a lock held by a machine mid-write look identical
        from here, so the gate is one the user has to read to pass."""
        shared, first, second = two_devices
        enable(first, shared, "Laptop A")
        created = ProfileStore(first).create("Banking")["profile"]
        call("sync.run", first)

        from theprivator_sidecar.sync.engine import open_engine

        engine, _ = open_engine(str(first))
        engine.acquire(created["id"], device_id="device-a", device_label="Laptop A")

        enable(second, shared, "Desktop B")
        with pytest.raises(SidecarError) as caught:
            call("sync.lock.forceRelease", second, profileId=created["id"], confirmDeviceLabel="wrong")

        assert caught.value.code == "SYNC_LOCK_STALE"
        assert "Laptop A" in caught.value.message

    def test_the_right_label_releases_it(self, two_devices):
        shared, first, second = two_devices
        enable(first, shared, "Laptop A")
        created = ProfileStore(first).create("Banking")["profile"]
        call("sync.run", first)

        from theprivator_sidecar.sync.engine import open_engine

        engine, _ = open_engine(str(first))
        engine.acquire(created["id"], device_id="device-a", device_label="Laptop A")

        enable(second, shared, "Desktop B")
        result = call("sync.lock.forceRelease", second, profileId=created["id"], confirmDeviceLabel="Laptop A")

        assert result["released"] is True
        assert result["previousHolder"] == "Laptop A"

    def test_releasing_nothing_is_not_an_error(self, two_devices):
        shared, first, _ = two_devices
        enable(first, shared, "Laptop A")

        result = call("sync.lock.forceRelease", first, profileId="not-locked", confirmDeviceLabel="anything")

        assert result["released"] is False


class TestPrepare:
    def test_preparing_a_profile_with_nothing_waiting_says_so(self, two_devices):
        shared, first, _ = two_devices
        enable(first, shared, "Laptop A")
        created = ProfileStore(first).create("Banking")["profile"]

        result = call("sync.prepare", first, profileId=created["id"])

        assert result["prepared"] is False

    def test_preparing_fetches_the_other_device_s_data(self, two_devices):
        """Launch does not download. A first pull of a large profile inside the
        launch budget surfaces as a timeout with no explanation."""
        shared, first, second = two_devices
        enable(first, shared, "Laptop A")
        created = ProfileStore(first).create("Banking")["profile"]
        call("sync.run", first)

        enable(second, shared, "Desktop B")
        result = call("sync.prepare", second, profileId=created["id"])

        assert result["prepared"] is True
        assert [p["id"] for p in ProfileStore(second).list()["profiles"]] == [created["id"]]


class TestResponsesStayInsideTheRedactionPerimeter:
    def test_no_response_carries_an_absolute_path(self, two_devices):
        shared, first, second = two_devices
        enable(first, shared, "Laptop A")
        created = ProfileStore(first).create("Banking")["profile"]

        responses = [
            call("sync.status", first),
            call("sync.plan", first),
            call("sync.run", first),
            call("sync.prepare", first, profileId=created["id"]),
        ]

        for response in responses:
            body = json.dumps(response)
            assert str(shared) not in body
            assert str(first) not in body
            assert str(Path.home()) not in body

    def test_no_response_carries_the_machine_hostname(self, two_devices):
        import os

        shared, first, _ = two_devices
        enable(first, shared, "Laptop A")
        ProfileStore(first).create("Banking")

        body = json.dumps([call("sync.status", first), call("sync.run", first)])

        assert os.uname().nodename not in body
