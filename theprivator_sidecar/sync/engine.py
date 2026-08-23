"""Comparing a local store against a shared folder, and acting on the result.

The layout under the sync root:

    <root>/profiles/<id>/meta.json                      contested, ~500 bytes
                        lock.json                       advisory
                        payloads/<rev>-<sha[:16]>.tpkg  immutable

Exactly one file per profile is ever rewritten, and it is small. Payloads are
named after their own content, so two devices pushing at once both land their
bytes and neither destroys the other's -- only the metadata pointer is
contested, and losing that race is detectable and recoverable.

What is deliberately absent: this module never resolves a conflict on its own,
and never deletes a payload it did not just write. A folder backend cannot tell
"the other device deleted this" from "the other device has not uploaded it yet",
and acting on that guess is how a sync engine eats a library.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence

from ..profiles import ProfileStore, utc_now_iso
from ..protocol import SidecarError
from .folder_store import FolderRemoteStore, make_lock
from .merge import ProfileSides, SyncAction, decide
from .remote import RemoteStore
from .state import ProfileSyncState, SyncState, read_state, touch_run, write_state

SYNC_NOT_CONFIGURED = "SYNC_NOT_CONFIGURED"
SYNC_REMOTE_UNAVAILABLE = "SYNC_REMOTE_UNAVAILABLE"
SYNC_LOCK_HELD = "SYNC_LOCK_HELD"
SYNC_METADATA_INVALID = "SYNC_METADATA_INVALID"

META_VERSION = 1
MAX_META_BYTES = 64 * 1024
MAX_PAYLOADS_KEPT = 3

_META_FIELDS = frozenset({"version", "profileId", "revision", "name", "updatedAt", "deviceId", "payloadKey", "trashed"})


@dataclass(frozen=True)
class RemoteProfileMeta:
    profile_id: str
    revision: int
    name: str
    updated_at: str
    device_id: str
    payload_key: Optional[str]
    trashed: bool
    etag: Optional[str] = None

    def to_bytes(self) -> bytes:
        return json.dumps(
            {
                "version": META_VERSION,
                "profileId": self.profile_id,
                "revision": self.revision,
                "name": self.name,
                "updatedAt": self.updated_at,
                "deviceId": self.device_id,
                "payloadKey": self.payload_key,
                "trashed": self.trashed,
            },
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")


@dataclass(frozen=True)
class ProfilePlan:
    profile_id: str
    name: str
    action: SyncAction
    reason: str
    local_revision: Optional[int]
    remote_revision: Optional[int]
    base_revision: Optional[int]

    def as_dict(self) -> dict[str, Any]:
        return {
            "profileId": self.profile_id,
            "name": self.name,
            "action": self.action.value,
            "reason": self.reason,
            "localRevision": self.local_revision,
            "remoteRevision": self.remote_revision,
            "baseRevision": self.base_revision,
        }


def meta_key(profile_id: str) -> str:
    return f"profiles/{profile_id}/meta.json"


def lock_key(profile_id: str) -> str:
    return f"profiles/{profile_id}/lock.json"


def payload_key(profile_id: str, revision: int, digest: str) -> str:
    """Content-addressed, so two devices pushing at once cannot overwrite each
    other's bytes -- only the small metadata pointer is ever contested."""
    return f"profiles/{profile_id}/payloads/{revision}-{digest[:16]}.tpkg"


def parse_meta(raw: Optional[bytes], *, etag: Optional[str] = None) -> Optional[RemoteProfileMeta]:
    """Read one profile's remote metadata.

    Returns None for anything that is not a complete, well-formed record. That
    covers a file the syncing client has only half delivered, which is a normal
    transient state and must read as "not there yet" rather than as corruption.
    """
    if raw is None or len(raw) > MAX_META_BYTES:
        return None
    try:
        record = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(record, Mapping) or frozenset(record.keys()) != _META_FIELDS:
        return None
    if record.get("version") != META_VERSION:
        return None

    profile_id = record.get("profileId")
    revision = record.get("revision")
    name = record.get("name")
    updated_at = record.get("updatedAt")
    device_id = record.get("deviceId")
    key = record.get("payloadKey")

    if not isinstance(profile_id, str) or not profile_id or len(profile_id) > 64:
        return None
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        return None
    if not isinstance(name, str) or not name or len(name) > 128:
        return None
    if not isinstance(updated_at, str) or len(updated_at) > 40:
        return None
    if not isinstance(device_id, str) or len(device_id) > 64:
        return None
    if key is not None and (not isinstance(key, str) or len(key) > 200):
        return None
    if not isinstance(record.get("trashed"), bool):
        return None

    return RemoteProfileMeta(
        profile_id=profile_id,
        revision=revision,
        name=name,
        updated_at=updated_at,
        device_id=device_id,
        payload_key=key,
        trashed=record["trashed"],
        etag=etag,
    )


class SyncEngine:
    """Reads both sides and reports what would happen. Acting is a separate call.

    The split is deliberate: a folder backend gives no way to preview a change
    once it has been made, so the only honest "are you sure" is one computed
    before anything is written.
    """

    def __init__(self, store: ProfileStore, remote: RemoteStore, state: SyncState) -> None:
        self._store = store
        self._remote = remote
        self._state = state

    @property
    def state(self) -> SyncState:
        return self._state

    def plan(self) -> list[ProfilePlan]:
        local = _local_revisions(self._store)
        remote = self.read_remote_metadata()

        plans: list[ProfilePlan] = []
        for profile_id in sorted(set(local) | set(remote) | set(self._state.profiles)):
            local_entry = local.get(profile_id)
            remote_entry = remote.get(profile_id)
            base = self._state.for_profile(profile_id)

            decision = decide(
                ProfileSides(
                    local_revision=None if local_entry is None else local_entry["revision"],
                    remote_revision=None if remote_entry is None else remote_entry.revision,
                    base_revision=None if base is None else base.base_revision,
                    local_trashed=bool(local_entry and local_entry["trashed"]),
                    remote_trashed=bool(remote_entry and remote_entry.trashed),
                )
            )
            if decision.action is SyncAction.NOTHING:
                continue

            plans.append(
                ProfilePlan(
                    profile_id=profile_id,
                    name=(local_entry or {}).get("name") or (remote_entry.name if remote_entry else profile_id),
                    action=decision.action,
                    reason=decision.reason,
                    local_revision=None if local_entry is None else local_entry["revision"],
                    remote_revision=None if remote_entry is None else remote_entry.revision,
                    base_revision=None if base is None else base.base_revision,
                )
            )
        return plans

    def read_remote_metadata(self) -> dict[str, RemoteProfileMeta]:
        found: dict[str, RemoteProfileMeta] = {}
        for entry in self._remote.list("profiles"):
            if not entry.key.endswith("/meta.json"):
                continue
            meta = parse_meta(self._remote.get(entry.key), etag=entry.etag)
            if meta is None:
                # Half-delivered or written by something else. Skipping it means
                # the profile looks absent this run and is reconsidered next
                # time, which is the recoverable direction.
                continue
            if meta_key(meta.profile_id) != entry.key:
                # The id inside the record disagrees with the directory it sits
                # in -- a renamed folder, or a copied one. Trusting the record
                # would let one profile's metadata claim another's slot.
                continue
            found[meta.profile_id] = meta
        return found

    # -- writing -----------------------------------------------------------

    def push_metadata(
        self,
        *,
        profile_id: str,
        revision: int,
        name: str,
        device_id: str,
        payload: Optional[bytes],
        trashed: bool,
        expected_etag: Optional[str],
    ) -> RemoteProfileMeta:
        """Upload the payload, then point the metadata at it.

        Payload first, always. A pointer to bytes that have not arrived is a
        profile another device will try to pull and fail on; bytes with no
        pointer are merely unreferenced, and the next push cleans them up.
        """
        key: Optional[str] = None
        if payload is not None:
            digest = hashlib.sha256(payload).hexdigest()
            key = payload_key(profile_id, revision, digest)
            existing = self._remote.get(key)
            if existing is None:
                outcome = self._remote.put(key, payload, expected_etag=None)
                if not outcome.ok:
                    # Content-addressed, so losing this race means another device
                    # wrote the identical bytes. Nothing to do.
                    pass

        meta = RemoteProfileMeta(
            profile_id=profile_id,
            revision=revision,
            name=name,
            updated_at=utc_now_iso(),
            device_id=device_id,
            payload_key=key,
            trashed=trashed,
        )
        outcome = self._remote.put(meta_key(profile_id), meta.to_bytes(), expected_etag=expected_etag)
        if not outcome.ok:
            raise SidecarError(
                code=SYNC_LOCK_HELD,
                message="Another device updated this profile while it was being uploaded. Run sync again.",
            )
        return replace(meta, etag=outcome.etag)

    def prune_payloads(self, profile_id: str, *, keep_key: Optional[str]) -> int:
        """Drop superseded payloads, newest kept.

        A few are kept rather than one: a device that has not synced in a while
        may still be pointing at an older revision, and deleting the bytes it is
        about to pull turns a slow device into a broken one.
        """
        prefix = f"profiles/{profile_id}/payloads"
        entries = [entry for entry in self._remote.list(prefix) if entry.key.endswith(".tpkg")]
        if len(entries) <= MAX_PAYLOADS_KEPT:
            return 0

        def revision_of(key: str) -> int:
            name = key.rsplit("/", 1)[-1]
            head = name.split("-", 1)[0]
            return int(head) if head.isdigit() else 0

        ordered = sorted(entries, key=lambda entry: revision_of(entry.key), reverse=True)
        removed = 0
        for entry in ordered[MAX_PAYLOADS_KEPT:]:
            if entry.key == keep_key:
                continue
            if self._remote.delete(entry.key):
                removed += 1
        return removed

    # -- locks -------------------------------------------------------------

    def acquire(self, profile_id: str, *, device_id: str, device_label: str) -> bool:
        """Claim a profile, then read the claim back.

        A folder gives no atomic test-and-set, so the write is followed by a read
        of the nonce that was just written. Two devices claiming at once will see
        one nonce, and at most one of them will see its own.
        """
        lock = make_lock(device_id, device_label)
        if not self._remote.write_lock(lock_key(profile_id), lock):
            return False
        confirmed = self._remote.read_lock(lock_key(profile_id))
        return confirmed is not None and confirmed.nonce == lock.nonce

    def release(self, profile_id: str, *, device_id: str) -> bool:
        return self._remote.clear_lock(lock_key(profile_id), device_id=device_id)

    def holder(self, profile_id: str):
        return self._remote.read_lock(lock_key(profile_id))

    def take_over(self, profile_id: str) -> bool:
        """Release a lock regardless of who holds it.

        Only reached after the user has typed the holding device's label back,
        which is the one gate that distinguishes a machine that is never coming
        back from one that is merely slow.
        """
        return self._remote.clear_lock(lock_key(profile_id))

    # -- payloads ----------------------------------------------------------

    def fetch_payload(self, key: str) -> Optional[bytes]:
        """Read one payload, or None when it has not arrived yet."""
        return self._remote.get(key)

    def remove_metadata(self, profile_id: str) -> bool:
        """Drop a profile's pointer from the folder. Payloads are left alone."""
        return self._remote.delete(meta_key(profile_id))

    # -- state -------------------------------------------------------------

    def record_exchange(
        self,
        *,
        profile_id: str,
        revision: int,
        etag: Optional[str],
        payload_key_value: Optional[str],
    ) -> None:
        self._state = self._state.with_profile(
            ProfileSyncState(
                profile_id=profile_id,
                base_revision=revision,
                remote_etag=etag,
                last_synced_at=utc_now_iso(),
                payload_key=payload_key_value,
            )
        )

    def forget(self, profile_id: str) -> None:
        self._state = self._state.without_profile(profile_id)

    def finish(self, store_root: Path | str) -> SyncState:
        self._state = touch_run(self._state)
        write_state(store_root, self._state)
        return self._state


def _local_revisions(store: ProfileStore) -> dict[str, dict[str, Any]]:
    """Every profile this device has, live and trashed alike.

    The trash is included on purpose: a trashed profile still exists, and
    omitting it would make this device look as though it had deleted the profile
    outright, which propagates a permanent deletion the user never asked for.
    """
    found: dict[str, dict[str, Any]] = {}
    for collection, trashed in ((store.list(), False), (store.list_trash(), True)):
        for profile in collection.get("profiles", []):
            sync = profile.get("sync") or {}
            found[profile["id"]] = {
                "revision": int(sync.get("revision", 1)),
                "name": profile.get("name", ""),
                "trashed": trashed,
            }
    return found


def open_engine(store_root: Path | str) -> tuple[SyncEngine, SyncState]:
    """Build an engine from what this device has on disk."""
    state = read_state(store_root)
    if not state.enabled or not state.sync_root:
        raise SidecarError(
            code=SYNC_NOT_CONFIGURED,
            message="Profile synchronisation is not set up on this device yet.",
        )

    remote = FolderRemoteStore(state.sync_root)
    health = remote.health()
    if not health.reachable:
        raise SidecarError(code=SYNC_REMOTE_UNAVAILABLE, message=health.detail)

    store = ProfileStore(store_root)
    return SyncEngine(store, remote, state), state


def summarize(plans: Iterable[ProfilePlan]) -> dict[str, int]:
    counts = {action.value: 0 for action in SyncAction}
    for plan in plans:
        counts[plan.action.value] += 1
    return counts


def plans_as_list(plans: Sequence[ProfilePlan]) -> list[dict[str, Any]]:
    return [plan.as_dict() for plan in plans]
