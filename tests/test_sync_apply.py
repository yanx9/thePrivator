"""A profile making the trip from one device to another and back.

The assertions are about what survives, because the failure this guards against
is not "sync did not run" but "the profile I was logged into is gone".
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest

from theprivator_sidecar import chromium
from theprivator_sidecar.profile_package import PACKAGE_KIND_PORTABLE, export_profile_package
from theprivator_sidecar.profiles import ProfileStore
from theprivator_sidecar.protocol import SidecarError
from theprivator_sidecar.sync.apply import (
    CONFLICTS_DIR,
    SYNC_PAYLOAD_INVALID,
    apply_pull,
    build_push_payload,
    set_aside_user_data,
)


def device(tmp_path, name: str) -> tuple[Path, ProfileStore]:
    root = tmp_path / name
    root.mkdir()
    return root, ProfileStore(root)


def decompressed_members(payload: bytes) -> bytes:
    """Every member of the archive, uncompressed.

    Scanning the archive bytes directly proves nothing: the members are
    DEFLATE-compressed, so a plaintext secret inside one simply does not appear
    as plaintext in the file. A leak test that searches the compressed bytes
    passes whether or not the secret is there.
    """
    collected = bytearray()
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        for name in archive.namelist():
            collected.extend(name.encode("utf-8"))
            collected.extend(archive.read(name))
    return bytes(collected)


def seed_user_data(root: Path, store: ProfileStore, profile_id: str, contents: str) -> Path:
    record = store.get(profile_id)
    path = Path(chromium.resolve_user_data_path(root, record))
    path.mkdir(parents=True, exist_ok=True)
    (path / "Preferences").write_text(contents, encoding="utf-8")
    return path


class TestRoundTrip:
    def test_a_profile_arrives_on_the_second_device_with_the_same_id(self, tmp_path):
        """The same profile has to be the same profile everywhere. A new id on
        each pull would grow a duplicate on every run."""
        root_a, store_a = device(tmp_path, "a")
        created = store_a.create("Banking")["profile"]
        seed_user_data(root_a, store_a, created["id"], "device A data")

        payload = build_push_payload(root_a, created["id"])
        root_b, store_b = device(tmp_path, "b")
        outcome = apply_pull(root_b, payload, keep_local_copy=False)

        assert outcome.profile_id == created["id"]
        assert outcome.action == "created"
        assert [profile["id"] for profile in store_b.list()["profiles"]] == [created["id"]]

    def test_the_browsing_data_arrives_with_it(self, tmp_path):
        root_a, store_a = device(tmp_path, "a")
        created = store_a.create("Banking")["profile"]
        seed_user_data(root_a, store_a, created["id"], "device A data")

        payload = build_push_payload(root_a, created["id"])
        root_b, store_b = device(tmp_path, "b")
        apply_pull(root_b, payload, keep_local_copy=False)

        restored = Path(chromium.resolve_user_data_path(root_b, store_b.get(created["id"])))
        assert (restored / "Preferences").read_text(encoding="utf-8") == "device A data"

    def test_the_organization_and_launch_sections_survive_the_trip(self, tmp_path):
        root_a, store_a = device(tmp_path, "a")
        created = store_a.create("Banking")["profile"]
        store_a.update_organization(
            created["id"],
            {"folderId": None, "tags": ["eu", "finance"], "notes": "Berlin", "favorite": True, "color": None},
        )
        store_a.update_launch(
            created["id"],
            {"startupBehavior": "customUrls", "startUrls": ["https://example.test/"], "args": []},
        )

        payload = build_push_payload(root_a, created["id"])
        root_b, store_b = device(tmp_path, "b")
        apply_pull(root_b, payload, keep_local_copy=False)

        arrived = store_b.get(created["id"])
        assert arrived.organization["tags"] == ["eu", "finance"]
        assert arrived.organization["favorite"] is True
        assert arrived.organization["notes"] == "Berlin"
        assert arrived.launch["startUrls"] == ["https://example.test/"]

    def test_the_revision_arrives_rather_than_restarting_at_one(self, tmp_path):
        """Starting the history over would make the next comparison read as
        "this device went backwards", which the merge rules refuse to act on."""
        root_a, store_a = device(tmp_path, "a")
        created = store_a.create("Banking")["profile"]
        for index in range(4):
            store_a.update(created["id"], f"Banking {index}")
        expected = store_a.get(created["id"]).sync["revision"]

        payload = build_push_payload(root_a, created["id"])
        root_b, store_b = device(tmp_path, "b")
        apply_pull(root_b, payload, keep_local_copy=False)

        assert store_b.get(created["id"]).sync["revision"] == expected
        assert expected > 1

    def test_proxy_credentials_never_travel(self, tmp_path):
        """The payload is an artifact that lands in someone's Drive account. The
        export path strips credentials, and sync inherits that on purpose."""
        root_a, store_a = device(tmp_path, "a")
        created = store_a.create("Banking")["profile"]
        store_a.update_proxy(
            created["id"],
            {
                "proxyVersion": 1,
                "mode": "fixedServer",
                "protocol": "http",
                "host": "10.0.0.9",
                "port": 8080,
                "credentials": {"username": "someone", "password": "SENTINEL-PASSWORD-9137"},
            },
        )

        payload = build_push_payload(root_a, created["id"])
        contents = decompressed_members(payload)

        assert b"SENTINEL-PASSWORD-9137" not in contents
        assert b"someone" not in contents
        # The proxy itself must still travel -- stripping the credentials is not
        # the same as forgetting which server the profile uses.
        assert b"10.0.0.9" in contents


class TestUpdatingInPlace:
    def test_a_second_pull_updates_rather_than_duplicating(self, tmp_path):
        root_a, store_a = device(tmp_path, "a")
        created = store_a.create("Banking")["profile"]
        root_b, store_b = device(tmp_path, "b")
        apply_pull(root_b, build_push_payload(root_a, created["id"]), keep_local_copy=False)

        store_a.update(created["id"], "Banking EU")
        outcome = apply_pull(root_b, build_push_payload(root_a, created["id"]), keep_local_copy=False)

        assert outcome.action == "updated"
        assert len(store_b.list()["profiles"]) == 1
        assert store_b.get(created["id"]).name == "Banking EU"

    def test_the_existing_browsing_data_is_moved_aside_not_deleted(self, tmp_path):
        """If the user picked the wrong side, the session they lost is still on
        the disk."""
        root_a, store_a = device(tmp_path, "a")
        created = store_a.create("Banking")["profile"]
        seed_user_data(root_a, store_a, created["id"], "device A data")

        root_b, store_b = device(tmp_path, "b")
        apply_pull(root_b, build_push_payload(root_a, created["id"]), keep_local_copy=False)
        seed_user_data(root_b, store_b, created["id"], "device B session")

        outcome = apply_pull(root_b, build_push_payload(root_a, created["id"]), keep_local_copy=True)

        assert outcome.kept_copy_at is not None
        kept = root_b / CONFLICTS_DIR / outcome.kept_copy_at
        assert (kept / "Preferences").read_text(encoding="utf-8") == "device B session"

    def test_the_kept_copy_is_named_without_leaking_a_path(self, tmp_path):
        root_a, store_a = device(tmp_path, "a")
        created = store_a.create("Banking")["profile"]
        root_b, store_b = device(tmp_path, "b")
        apply_pull(root_b, build_push_payload(root_a, created["id"]), keep_local_copy=False)
        seed_user_data(root_b, store_b, created["id"], "device B session")

        outcome = apply_pull(root_b, build_push_payload(root_a, created["id"]), keep_local_copy=True)

        assert "/" not in (outcome.kept_copy_at or "")
        assert str(tmp_path) not in str(outcome.as_dict())

    def test_keeping_both_sides_makes_a_separate_profile(self, tmp_path):
        root_a, store_a = device(tmp_path, "a")
        created = store_a.create("Banking")["profile"]
        root_b, store_b = device(tmp_path, "b")
        apply_pull(root_b, build_push_payload(root_a, created["id"]), keep_local_copy=False)

        outcome = apply_pull(root_b, build_push_payload(root_a, created["id"]), keep_local_copy=True, as_new_profile=True)

        ids = {profile["id"] for profile in store_b.list()["profiles"]}
        assert len(ids) == 2
        assert outcome.profile_id != created["id"]
        names = {profile["name"] for profile in store_b.list()["profiles"]}
        assert any("another device" in name for name in names)


class TestRefusals:
    def test_a_portable_package_is_refused_as_a_sync_payload(self, tmp_path):
        """A portable package has no profile id, so applying it as a sync pull
        would have to guess which local profile it replaces."""
        root_a, store_a = device(tmp_path, "a")
        created = store_a.create("Banking")["profile"]
        destination = tmp_path / "portable.tpkg"
        export_profile_package(root_a, created["id"], destination, kind=PACKAGE_KIND_PORTABLE)

        root_b, _ = device(tmp_path, "b")
        with pytest.raises(SidecarError) as caught:
            apply_pull(root_b, destination.read_bytes(), keep_local_copy=False)

        assert caught.value.code == SYNC_PAYLOAD_INVALID

    def test_rubbish_bytes_are_refused_rather_than_half_applied(self, tmp_path):
        root_b, store_b = device(tmp_path, "b")

        with pytest.raises(SidecarError):
            apply_pull(root_b, b"this is not a zip archive", keep_local_copy=False)

        assert store_b.list()["profiles"] == []

    def test_a_name_collision_is_resolved_rather_than_refused(self, tmp_path):
        """Two devices can independently create "Banking" without either being
        wrong. Refusing the pull would strand the profile forever."""
        root_a, store_a = device(tmp_path, "a")
        created = store_a.create("Banking")["profile"]
        root_b, store_b = device(tmp_path, "b")
        store_b.create("Banking")

        outcome = apply_pull(root_b, build_push_payload(root_a, created["id"]), keep_local_copy=False)

        names = sorted(profile["name"] for profile in store_b.list()["profiles"])
        assert len(names) == 2
        assert outcome.name != "Banking"


class TestSetAside:
    def test_setting_aside_a_profile_with_no_data_is_not_an_error(self, tmp_path):
        root, store = device(tmp_path, "a")
        created = store.create("Banking")["profile"]
        # A never-launched profile has a directory but nothing meaningful in it.
        target = Path(chromium.resolve_user_data_path(root, store.get(created["id"])))
        if target.exists():
            for child in target.iterdir():
                child.unlink()

        assert set_aside_user_data(root, store.get(created["id"])) is not None

    def test_two_set_asides_do_not_collide(self, tmp_path):
        root, store = device(tmp_path, "a")
        created = store.create("Banking")["profile"]
        seed_user_data(root, store, created["id"], "first")
        first = set_aside_user_data(root, store.get(created["id"]))
        seed_user_data(root, store, created["id"], "second")
        second = set_aside_user_data(root, store.get(created["id"]))

        assert first is not None and second is not None
        assert (root / CONFLICTS_DIR / first / "Preferences").read_text() == "first"
        assert (root / CONFLICTS_DIR / second / "Preferences").read_text() == "second"
