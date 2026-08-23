"""Turning a decision into a change on this device's disk.

Everything here writes. The rules it follows exist because the failure mode is
not "sync did not work" but "the profile I was logged into is gone":

* Browsing data is **moved**, never deleted. A pull that replaces a profile
  first renames the existing user-data directory into ``conflicts/``. If the
  user picked the wrong side, the session they lost is still on the disk.
* A pull that fails part-way leaves the profile it was replacing intact. The
  new data is staged first and only swapped in once it is complete.
* Nothing is applied to a profile whose browser is running. Pulling the
  user-data directory out from under a live Chromium corrupts it.
"""

from __future__ import annotations

import shutil
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from .. import chromium
from ..profile_package import (
    PACKAGE_KIND_SYNC,
    export_profile_package,
    read_sync_package,
)
from ..profiles import ProfileStore, unique_profile_name, utc_now_iso
from ..protocol import JsonObject, SidecarError

SYNC_PROFILE_BUSY = "SYNC_PROFILE_BUSY"
SYNC_PAYLOAD_INVALID = "SYNC_PAYLOAD_INVALID"

CONFLICTS_DIR = "conflicts"


@dataclass(frozen=True)
class ApplyOutcome:
    profile_id: str
    name: str
    action: str
    kept_copy_at: Optional[str]

    def as_dict(self) -> JsonObject:
        return {
            "profileId": self.profile_id,
            "name": self.name,
            "action": self.action,
            # A relative name, never a path: the redaction perimeter treats an
            # absolute path as a leak, and the user only needs to know a copy
            # exists and what it is called.
            "keptCopyAs": self.kept_copy_at,
        }


def refuse_if_running(store_root: Path | str, profile_id: str) -> None:
    """Refuse to touch a profile whose browser is live.

    Replacing a running profile's user-data directory corrupts the running
    Chromium's databases, and the damage shows up minutes later as a browser
    that will not start.
    """
    status = chromium.status(store_root)
    running = {entry["profileId"] for entry in status.get("profiles", [])}
    if profile_id in running:
        raise SidecarError(
            code=SYNC_PROFILE_BUSY,
            message="Stop this profile's browser before syncing it.",
        )


def set_aside_user_data(store_root: Path | str, profile: Any) -> Optional[str]:
    """Move a profile's browsing data into conflicts/ and report the new name.

    Moved rather than copied: a profile directory is routinely hundreds of
    megabytes, and a copy would double the disk cost of every conflict on a
    machine that may be short of space in the first place.
    """
    source = Path(chromium.resolve_user_data_path(store_root, profile))
    if not source.exists():
        return None

    conflicts = Path(store_root) / CONFLICTS_DIR
    conflicts.mkdir(parents=True, exist_ok=True)
    # A timestamp alone is not unique: two conflicts on the same profile inside
    # one millisecond would land on the same name, and shutil.move onto an
    # existing directory nests rather than replaces -- losing the copy this rail
    # exists to keep.
    stamp = utc_now_iso().replace(":", "").replace("-", "").replace(".", "")
    target_name = f"{profile.id}-{stamp}-{uuid.uuid4().hex[:6]}"
    target = conflicts / target_name
    try:
        shutil.move(str(source), str(target))
    except OSError as error:
        raise SidecarError(
            code=SYNC_PAYLOAD_INVALID,
            message=f"The existing browsing data could not be set aside: {error.strerror or 'unknown error'}.",
        ) from error
    return target_name


def apply_pull(
    store_root: Path | str,
    payload: bytes,
    *,
    keep_local_copy: bool,
    as_new_profile: bool = False,
) -> ApplyOutcome:
    """Bring a remote payload onto this device.

    The payload names the profile it belongs to, so an existing local record is
    replaced in place rather than duplicated -- which is what keeps the same
    profile the same profile across machines.
    """
    with tempfile.TemporaryDirectory(prefix="theprivator-sync-pull-") as staging:
        return _apply_pull_staged(
            store_root,
            payload,
            Path(staging),
            keep_local_copy=keep_local_copy,
            as_new_profile=as_new_profile,
        )


def _apply_pull_staged(
    store_root: Path | str,
    payload: bytes,
    staging: Path,
    *,
    keep_local_copy: bool,
    as_new_profile: bool,
) -> ApplyOutcome:
    package = read_sync_package(payload, staging)
    if package.kind != PACKAGE_KIND_SYNC:
        raise SidecarError(
            code=SYNC_PAYLOAD_INVALID,
            message="That payload is a portable package, not a sync payload.",
        )

    store = ProfileStore(store_root)
    profile_id = package.sync["profileId"]
    existing = _find(store, profile_id)

    if existing is not None and not as_new_profile:
        refuse_if_running(store_root, profile_id)

    kept_as: Optional[str] = None
    if existing is not None and keep_local_copy and not as_new_profile:
        kept_as = set_aside_user_data(store_root, existing)

    if as_new_profile or existing is None:
        preferred = (
            f"{package.profile_name} (from another device)" if as_new_profile else package.profile_name
        )
        name = unique_profile_name(store.records(), preferred)
        created = store.create_synced_profile(
            name,
            identity=package.identity,
            proxy=package.proxy,
            profile_id=None if as_new_profile else profile_id,
            organization=package.sync["organization"],
            launch=package.sync["launch"],
            revision=package.sync["revision"],
        )
        record = store.get(created["profile"]["id"])
        _restore_payload(store_root, record, package)
        return ApplyOutcome(
            profile_id=record.id,
            name=record.name,
            action="created",
            kept_copy_at=kept_as,
        )

    store.update_identity(profile_id, package.identity)
    store.update_proxy(profile_id, package.proxy)
    store.update_organization(profile_id, package.sync["organization"])
    store.update_launch(profile_id, package.sync["launch"])
    if existing.name != package.profile_name:
        store.update(
            profile_id,
            unique_profile_name(
                store.records(),
                package.profile_name,
                exclude_ids=frozenset({profile_id}),
            ),
        )

    record = store.get(profile_id)
    _restore_payload(store_root, record, package)
    return ApplyOutcome(profile_id=record.id, name=record.name, action="updated", kept_copy_at=kept_as)


def build_push_payload(store_root: Path | str, profile_id: str) -> bytes:
    """Package one profile for upload.

    This is the existing export path with the sync discriminator set, so the
    ten-phase validator, the zip-bomb ceilings, the per-file checksums and the
    credential stripping all apply unchanged. A sync payload is not a special
    kind of archive that skips the checks.
    """
    with tempfile.TemporaryDirectory(prefix="theprivator-sync-push-") as temp_root:
        destination = Path(temp_root) / "payload.tpkg"
        export_profile_package(store_root, profile_id, destination, kind=PACKAGE_KIND_SYNC)
        return destination.read_bytes()


def _find(store: ProfileStore, profile_id: str):
    for profile in store.list()["profiles"]:
        if profile["id"] == profile_id:
            return store.get(profile_id)
    return None


def _restore_payload(store_root: Path | str, record: Any, package: Any) -> None:
    destination = Path(chromium.resolve_user_data_path(store_root, record))
    destination.mkdir(parents=True, exist_ok=True)
    package.restore_into(destination)
