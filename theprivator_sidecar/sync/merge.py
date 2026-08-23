"""Deciding what to do about one profile, as a pure function.

Everything here takes three numbers and returns a verdict. No filesystem, no
network, no clock -- which is what makes it testable exhaustively rather than by
staging scenarios, and it is the part where a mistake silently destroys a
profile someone spent an hour configuring.

The rule is a three-way comparison against ``base``: the revision this device
last agreed with the remote. Comparing only local against remote cannot tell
"they changed it" from "I changed it", and picking the higher number would make
every device that edits twice win over a device that edited once.

Deliberately *not* implemented: per-field merging. It needs a timestamp per
field, which the folder backend cannot supply honestly, and it produces profiles
that are a blend nobody asked for -- a fingerprint from one machine wearing a
proxy from another is a profile that matches neither expectation.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional


class SyncAction(str, Enum):
    NOTHING = "nothing"
    PUSH = "push"
    PULL = "pull"
    CONFLICT = "conflict"
    DELETE_LOCAL = "deleteLocal"
    DELETE_REMOTE = "deleteRemote"


class ConflictResolution(str, Enum):
    KEEP_LOCAL = "keepLocal"
    KEEP_REMOTE = "keepRemote"
    KEEP_BOTH = "keepBoth"


@dataclass(frozen=True)
class SyncDecision:
    action: SyncAction
    reason: str


@dataclass(frozen=True)
class ProfileSides:
    """One profile as each side sees it.

    ``None`` for a revision means that side has no such profile. ``base`` None
    means this device has never exchanged it, which is different from "the
    profile is gone" and must not be confused with it.
    """

    local_revision: Optional[int]
    remote_revision: Optional[int]
    base_revision: Optional[int]
    local_trashed: bool = False
    remote_trashed: bool = False


def decide(sides: ProfileSides) -> SyncDecision:
    """What to do about one profile."""
    local = sides.local_revision
    remote = sides.remote_revision
    base = sides.base_revision

    if local is None and remote is None:
        return SyncDecision(SyncAction.NOTHING, "Neither side has this profile.")

    if local is None:
        if base is None:
            return SyncDecision(SyncAction.PULL, "The remote has a profile this device has never seen.")
        if remote is not None and remote > base:
            # Deleted here, edited there. Deleting is the reversible half only
            # if the trash still holds it, and the remote edit is work that
            # would be thrown away, so the user decides.
            return SyncDecision(
                SyncAction.CONFLICT,
                "This device deleted the profile while another device changed it.",
            )
        if remote != base:
            # The remote is *behind* the state this device last agreed with it:
            # a restored folder. Deleting it would destroy something neither
            # side ever acknowledged.
            return SyncDecision(
                SyncAction.CONFLICT,
                "The remote copy is older than the last agreed state; the folder was restored.",
            )
        return SyncDecision(SyncAction.DELETE_REMOTE, "This device deleted a profile both sides agreed on.")

    if remote is None:
        if base is None:
            return SyncDecision(SyncAction.PUSH, "This device has a profile the remote has never seen.")
        if local > base:
            return SyncDecision(
                SyncAction.CONFLICT,
                "Another device deleted the profile while this device changed it.",
            )
        if local != base:
            return SyncDecision(
                SyncAction.CONFLICT,
                "This device's copy is older than the last agreed state; the store was restored.",
            )
        return SyncDecision(SyncAction.DELETE_LOCAL, "Another device deleted a profile both sides agreed on.")

    if sides.local_trashed and not sides.remote_trashed and remote > (base or 0):
        return SyncDecision(
            SyncAction.CONFLICT,
            "This device moved the profile to the trash while another device changed it.",
        )

    if base is None:
        if local == remote:
            # Same revision on both sides with no record of an exchange: the
            # usual cause is a restored device. Treating it as a conflict would
            # make a reinstall look like a disaster.
            return SyncDecision(SyncAction.NOTHING, "Both sides are already at the same revision.")
        return SyncDecision(
            SyncAction.CONFLICT,
            "Both sides have this profile but this device has no record of syncing it.",
        )

    if local == base and remote == base:
        return SyncDecision(SyncAction.NOTHING, "Nothing changed on either side.")
    if local > base and remote == base:
        return SyncDecision(SyncAction.PUSH, "Only this device changed the profile.")
    if remote > base and local == base:
        return SyncDecision(SyncAction.PULL, "Only another device changed the profile.")
    if local > base and remote > base:
        return SyncDecision(SyncAction.CONFLICT, "Both sides changed the profile since the last sync.")

    # Below base on either side means the recorded base is not a state either
    # side ever reached -- a restored backup, or a state file that outlived the
    # store it described. There is no safe automatic answer.
    return SyncDecision(
        SyncAction.CONFLICT,
        "The recorded sync point does not match either side; the store or the folder was restored.",
    )


@dataclass(frozen=True)
class ResolutionPlan:
    """What a chosen resolution actually does.

    ``keep_local_copy`` is the safety rail: a resolution that overwrites this
    device's data always moves the existing browsing data aside first. The user
    asked to prefer the other side, not to have this side erased -- and if they
    picked wrong, the only copy of a logged-in session is the one being replaced.
    """

    push_local: bool
    pull_remote: bool
    duplicate_as_new_profile: bool
    keep_local_copy: bool


def plan_resolution(resolution: ConflictResolution) -> ResolutionPlan:
    if resolution is ConflictResolution.KEEP_LOCAL:
        return ResolutionPlan(
            push_local=True,
            pull_remote=False,
            duplicate_as_new_profile=False,
            keep_local_copy=False,
        )
    if resolution is ConflictResolution.KEEP_REMOTE:
        return ResolutionPlan(
            push_local=False,
            pull_remote=True,
            duplicate_as_new_profile=False,
            keep_local_copy=True,
        )
    return ResolutionPlan(
        push_local=False,
        pull_remote=True,
        duplicate_as_new_profile=True,
        keep_local_copy=True,
    )
