"""The sync commands, as the NDJSON layer sees them.

Everything the frontend can ask for goes through here, and everything here
returns a plain dictionary the redaction perimeter has already been taught to
check. Two rules shape the shapes below:

* **No absolute path ever leaves this module.** The sync root is the only
  absolute path the frontend supplies, and it is reported back as a folder name
  and a boolean rather than in full.
* **Nothing destructive happens without being asked twice.** `run` never
  resolves a conflict, and taking over another device's lock requires its
  user-chosen label to be typed back.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping, Optional

from ..profiles import ProfileStore
from ..protocol import INVALID_REQUEST, JsonObject, SidecarError
from .apply import ApplyOutcome, apply_pull, build_push_payload, refuse_if_running
from .engine import (
    SYNC_NOT_CONFIGURED,
    SyncEngine,
    open_engine,
    plans_as_list,
    summarize,
)
from .folder_store import FolderRemoteStore
from .merge import ConflictResolution, SyncAction, plan_resolution
from .state import (
    SyncState,
    normalize_device_label,
    read_state,
    state_as_public_dict,
    write_state,
)

SYNC_ROOT_REFUSED = "SYNC_ROOT_REFUSED"
SYNC_CONFLICT_UNRESOLVED = "SYNC_CONFLICT_UNRESOLVED"
SYNC_LOCK_STALE = "SYNC_LOCK_STALE"


def status(store_root: str) -> JsonObject:
    state = read_state(store_root)
    result = state_as_public_dict(state)
    if state.enabled and state.sync_root:
        health = FolderRemoteStore(state.sync_root).health()
        result["reachable"] = health.reachable
        result["writable"] = health.writable
        result["detail"] = health.detail
    else:
        result["reachable"] = False
        result["writable"] = False
        result["detail"] = "Profile synchronisation is not set up on this device yet."
    return result


def configure(store_root: str, params: Mapping[str, Any]) -> JsonObject:
    """Point this device at a folder, or turn sync off."""
    enabled = params.get("enabled")
    if not isinstance(enabled, bool):
        raise SidecarError(code=INVALID_REQUEST, message="Sync enabled must be true or false.")

    state = read_state(store_root)
    label = normalize_device_label(params.get("deviceLabel"), fallback=state.device_label or "This device")

    if not enabled:
        # The state is kept rather than cleared: turning sync back on later
        # should resume where it left off, not re-conflict every profile.
        write_state(store_root, SyncState(
            version=state.version,
            device_id=state.device_id or ProfileStore(store_root).device_id,
            device_label=label,
            sync_root=state.sync_root,
            enabled=False,
            last_run_at=state.last_run_at,
            profiles=state.profiles,
        ))
        return status(store_root)

    folder = params.get("folder")
    if not isinstance(folder, str) or not folder.strip():
        raise SidecarError(code=INVALID_REQUEST, message="A sync folder is required.")

    resolved = _validated_sync_root(folder, store_root)
    health = FolderRemoteStore(resolved).health()
    if not health.reachable or not health.writable:
        raise SidecarError(code=SYNC_ROOT_REFUSED, message=health.detail)

    write_state(store_root, SyncState(
        version=state.version,
        device_id=state.device_id or ProfileStore(store_root).device_id,
        device_label=label,
        sync_root=str(resolved),
        enabled=True,
        last_run_at=state.last_run_at,
        # A different folder describes different exchanges, so the record of
        # what was agreed with the old one would be a lie about the new one.
        profiles=state.profiles if state.sync_root == str(resolved) else {},
    ))
    return status(store_root)


def plan(store_root: str) -> JsonObject:
    engine, _ = open_engine(store_root)
    plans = engine.plan()
    return {
        "plans": plans_as_list(plans),
        "counts": summarize(plans),
    }


def run(store_root: str) -> JsonObject:
    """Do everything that needs no decision, and report what still does.

    Conflicts are never resolved here. A folder cannot say which edit came
    first, and a sync that silently picks a winner is a sync that loses work
    without anybody noticing until much later.
    """
    engine, state = open_engine(store_root)
    store = ProfileStore(store_root)
    device_id = state.device_id or store.device_id

    applied: list[JsonObject] = []
    conflicts: list[JsonObject] = []
    failures: list[JsonObject] = []

    remote = engine.read_remote_metadata()
    for entry in engine.plan():
        if entry.action is SyncAction.CONFLICT:
            conflicts.append(entry.as_dict())
            continue
        try:
            applied.append(
                _perform(
                    engine,
                    store,
                    store_root,
                    entry,
                    remote=remote,
                    device_id=device_id,
                    device_label=state.device_label,
                )
            )
        except SidecarError as error:
            # One profile failing must not stop the other nine. The code travels
            # so the UI can say which ones need attention.
            failures.append({"profileId": entry.profile_id, "name": entry.name, "code": error.code})

    final_state = engine.finish(store_root)
    return {
        "applied": applied,
        "conflicts": conflicts,
        "failures": failures,
        "status": {**state_as_public_dict(final_state), "reachable": True, "writable": True, "detail": "ok"},
    }


def resolve(store_root: str, params: Mapping[str, Any]) -> JsonObject:
    """Apply a decision the user made about one conflicted profile."""
    profile_id = _required_id(params.get("profileId"))
    raw = params.get("resolution")
    try:
        resolution = ConflictResolution(raw)
    except ValueError:
        raise SidecarError(
            code=INVALID_REQUEST,
            message="A conflict resolution must be keepLocal, keepRemote, or keepBoth.",
        ) from None

    engine, state = open_engine(store_root)
    store = ProfileStore(store_root)
    device_id = state.device_id or store.device_id
    steps = plan_resolution(resolution)
    remote = engine.read_remote_metadata().get(profile_id)

    if steps.push_local:
        outcome = _push(engine, store, store_root, profile_id, device_id=device_id, expected=remote)
    else:
        if remote is None or remote.payload_key is None:
            raise SidecarError(
                code=SYNC_CONFLICT_UNRESOLVED,
                message="The other device has not uploaded this profile's data yet.",
            )
        payload = engine.fetch_payload(remote.payload_key)
        if payload is None:
            raise SidecarError(
                code=SYNC_CONFLICT_UNRESOLVED,
                message="The other device's copy of this profile has not arrived yet.",
            )
        result = apply_pull(
            store_root,
            payload,
            keep_local_copy=steps.keep_local_copy,
            as_new_profile=steps.duplicate_as_new_profile,
        )
        if not steps.duplicate_as_new_profile:
            engine.record_exchange(
                profile_id=profile_id,
                revision=remote.revision,
                etag=remote.etag,
                payload_key_value=remote.payload_key,
            )
        outcome = result.as_dict()

    engine.finish(store_root)
    return {"resolved": outcome, "resolution": resolution.value}


def force_release_lock(store_root: str, params: Mapping[str, Any]) -> JsonObject:
    """Take over a lock another device left behind.

    The confirmation is the device label, typed back. A stale lock and a lock
    held by a machine that is mid-write look identical from here, so the only
    honest gate is one that requires the user to have read who holds it.
    """
    profile_id = _required_id(params.get("profileId"))
    confirmation = params.get("confirmDeviceLabel")

    engine, _ = open_engine(store_root)
    holder = engine.holder(profile_id)
    if holder is None:
        return {"released": False, "reason": "Nothing holds this profile."}

    if not isinstance(confirmation, str) or confirmation.strip() != holder.device_label:
        raise SidecarError(
            code=SYNC_LOCK_STALE,
            message=f'Type "{holder.device_label}" to take over this profile from that device.',
        )

    engine.take_over(profile_id)
    return {"released": True, "previousHolder": holder.device_label}


def prepare(store_root: str, params: Mapping[str, Any]) -> JsonObject:
    """Fetch one profile's data before launching it.

    Launch does not download. A first pull of a 200 MB profile would blow
    through the launch budget and surface as a timeout with no explanation, so
    fetching is its own command with its own budget.
    """
    profile_id = _required_id(params.get("profileId"))
    engine, state = open_engine(store_root)
    refuse_if_running(store_root, profile_id)

    remote = engine.read_remote_metadata().get(profile_id)
    if remote is None or remote.payload_key is None:
        return {"prepared": False, "reason": "This profile has nothing waiting on the other devices."}

    payload = engine.fetch_payload(remote.payload_key)
    if payload is None:
        return {"prepared": False, "reason": "The data has not finished arriving yet."}

    outcome = apply_pull(store_root, payload, keep_local_copy=True)
    engine.record_exchange(
        profile_id=profile_id,
        revision=remote.revision,
        etag=remote.etag,
        payload_key_value=remote.payload_key,
    )
    engine.finish(store_root)
    return {"prepared": True, **outcome.as_dict()}


# -- internals -------------------------------------------------------------


def _perform(
    engine: SyncEngine,
    store: ProfileStore,
    store_root: str,
    entry: Any,
    *,
    remote: Mapping[str, Any],
    device_id: str,
    device_label: str,
) -> JsonObject:
    action = entry.action
    known = remote.get(entry.profile_id)

    if action is SyncAction.PUSH:
        return _push(engine, store, store_root, entry.profile_id, device_id=device_id, expected=known)

    if action is SyncAction.PULL:
        if known is None or known.payload_key is None:
            raise SidecarError(
                code=SYNC_CONFLICT_UNRESOLVED,
                message="The other device has not uploaded this profile's data yet.",
            )
        payload = engine.fetch_payload(known.payload_key)
        if payload is None:
            raise SidecarError(
                code=SYNC_CONFLICT_UNRESOLVED,
                message="The other device's copy has not arrived yet.",
            )
        result: ApplyOutcome = apply_pull(store_root, payload, keep_local_copy=True)
        engine.record_exchange(
            profile_id=entry.profile_id,
            revision=known.revision,
            etag=known.etag,
            payload_key_value=known.payload_key,
        )
        return result.as_dict()

    if action is SyncAction.DELETE_REMOTE:
        engine.remove_metadata(entry.profile_id)
        engine.forget(entry.profile_id)
        return {"profileId": entry.profile_id, "name": entry.name, "action": "removedFromFolder"}

    if action is SyncAction.DELETE_LOCAL:
        refuse_if_running(store_root, entry.profile_id)
        # Trashed, not erased. The other device deleted it, but this device's
        # user may not have been the one who decided that.
        store.delete(entry.profile_id)
        engine.forget(entry.profile_id)
        return {"profileId": entry.profile_id, "name": entry.name, "action": "movedToTrash"}

    return {"profileId": entry.profile_id, "name": entry.name, "action": "skipped"}


def _push(
    engine: SyncEngine,
    store: ProfileStore,
    store_root: str,
    profile_id: str,
    *,
    device_id: str,
    expected: Any,
) -> JsonObject:
    record = store.get(profile_id)
    payload = build_push_payload(store_root, profile_id)
    meta = engine.push_metadata(
        profile_id=profile_id,
        revision=int(record.sync.get("revision", 1)),
        name=record.name,
        device_id=device_id,
        payload=payload,
        trashed=record.is_trashed,
        expected_etag=expected.etag if expected is not None else None,
    )
    engine.record_exchange(
        profile_id=profile_id,
        revision=meta.revision,
        etag=meta.etag,
        payload_key_value=meta.payload_key,
    )
    engine.prune_payloads(profile_id, keep_key=meta.payload_key)
    return {"profileId": profile_id, "name": record.name, "action": "uploaded", "keptCopyAs": None}


def _required_id(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SidecarError(code=INVALID_REQUEST, message="Profile id is required.")
    return value


def _validated_sync_root(folder: str, store_root: str) -> Path:
    """The only absolute path the frontend supplies, checked hard.

    A sync root inside the profile store would make the engine sync its own
    working files, and the home directory or the filesystem root would put a
    profiles/ tree somewhere the user would never think to look for it.
    """
    try:
        resolved = Path(folder).expanduser().resolve()
    except (OSError, RuntimeError) as error:
        raise SidecarError(code=SYNC_ROOT_REFUSED, message="That folder could not be read.") from error

    if not resolved.exists() or not resolved.is_dir():
        raise SidecarError(code=SYNC_ROOT_REFUSED, message="That folder does not exist.")

    store_path = Path(store_root).expanduser().resolve()
    if resolved == store_path or store_path in resolved.parents or resolved in store_path.parents:
        raise SidecarError(
            code=SYNC_ROOT_REFUSED,
            message="Choose a folder outside the profile store.",
        )

    if resolved == Path(resolved.anchor) or resolved == Path.home():
        raise SidecarError(
            code=SYNC_ROOT_REFUSED,
            message="Choose a folder inside your synced drive, not the drive root or your home folder.",
        )

    return resolved


def is_configured(store_root: str) -> bool:
    state = read_state(store_root)
    return bool(state.enabled and state.sync_root)


def not_configured_error() -> SidecarError:
    return SidecarError(
        code=SYNC_NOT_CONFIGURED,
        message="Profile synchronisation is not set up on this device yet.",
    )
