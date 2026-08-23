"""The merge decision, checked over its whole input space.

It is a pure function of three small numbers, so the space is enumerable rather
than sampled: every combination below a small bound is checked against the
properties that must hold, and the interesting cases are also spelled out by
name so a failure says what broke rather than which tuple broke.
"""

from __future__ import annotations

import itertools

import pytest

from theprivator_sidecar.sync.merge import (
    ConflictResolution,
    ProfileSides,
    SyncAction,
    decide,
    plan_resolution,
)

REVISIONS = [None, 1, 2, 3]


def sides(local, remote, base, **flags):
    return ProfileSides(local_revision=local, remote_revision=remote, base_revision=base, **flags)


class TestFirstContact:
    def test_a_profile_only_this_device_has_is_pushed(self):
        assert decide(sides(1, None, None)).action is SyncAction.PUSH

    def test_a_profile_only_the_remote_has_is_pulled(self):
        assert decide(sides(None, 1, None)).action is SyncAction.PULL

    def test_a_profile_neither_side_has_needs_nothing(self):
        assert decide(sides(None, None, None)).action is SyncAction.NOTHING

    def test_the_same_revision_on_both_sides_with_no_record_is_left_alone(self):
        """A restored device sees its own profiles arrive from the folder. That
        is a reinstall, not a disaster, and reporting a conflict for every
        profile would make it look like one."""
        assert decide(sides(4, 4, None)).action is SyncAction.NOTHING

    def test_different_revisions_with_no_record_is_a_conflict_not_a_guess(self):
        # Picking the higher number would let a device that edited twice beat a
        # device that edited once, whatever the edits were.
        assert decide(sides(5, 3, None)).action is SyncAction.CONFLICT


class TestOrdinaryFlow:
    def test_nothing_changed_means_nothing_happens(self):
        assert decide(sides(3, 3, 3)).action is SyncAction.NOTHING

    def test_a_local_edit_is_pushed(self):
        assert decide(sides(4, 3, 3)).action is SyncAction.PUSH

    def test_a_remote_edit_is_pulled(self):
        assert decide(sides(3, 4, 3)).action is SyncAction.PULL

    def test_edits_on_both_sides_are_a_conflict(self):
        assert decide(sides(4, 5, 3)).action is SyncAction.CONFLICT

    def test_a_bigger_local_edit_still_does_not_beat_a_remote_edit(self):
        """Revisions count edits, not importance. Three local edits against one
        remote edit is still two people's work."""
        assert decide(sides(9, 4, 3)).action is SyncAction.CONFLICT


class TestDeletion:
    def test_deleting_locally_deletes_remotely_when_both_agreed(self):
        assert decide(sides(None, 3, 3)).action is SyncAction.DELETE_REMOTE

    def test_a_remote_deletion_deletes_locally_when_both_agreed(self):
        assert decide(sides(3, None, 3)).action is SyncAction.DELETE_LOCAL

    def test_deleting_here_while_they_edited_asks_rather_than_deletes(self):
        assert decide(sides(None, 5, 3)).action is SyncAction.CONFLICT

    def test_editing_here_while_they_deleted_asks_rather_than_deletes(self):
        assert decide(sides(5, None, 3)).action is SyncAction.CONFLICT

    def test_trashing_here_while_they_edited_asks(self):
        """The trash is recoverable, but propagating it would delete their work
        on a machine that never agreed to it."""
        decision = decide(sides(3, 5, 3, local_trashed=True))

        assert decision.action is SyncAction.CONFLICT


class TestRestoredBackups:
    def test_a_local_revision_below_the_recorded_base_is_a_conflict(self):
        """A restored store is behind a base it once reached. Pushing it would
        overwrite the remote with older data and look like silent loss."""
        assert decide(sides(2, 3, 3)).action is SyncAction.CONFLICT

    def test_a_remote_revision_below_the_recorded_base_is_a_conflict(self):
        assert decide(sides(3, 2, 3)).action is SyncAction.CONFLICT


class TestProperties:
    all_cases = [
        sides(local, remote, base)
        for local, remote, base in itertools.product(REVISIONS, repeat=3)
    ]

    def test_every_combination_produces_a_decision(self):
        assert len(self.all_cases) == 64
        for case in self.all_cases:
            assert decide(case).action in set(SyncAction)

    def test_every_decision_explains_itself(self):
        for case in self.all_cases:
            reason = decide(case).reason
            assert reason and reason[0].isupper() and reason.endswith(".")

    def test_the_decision_is_symmetric_under_swapping_the_sides(self):
        """Sync has no privileged side. Whatever this device concludes about the
        remote, the remote must conclude the mirror image about this device --
        otherwise two devices act on the same state in incompatible ways."""
        mirror = {
            SyncAction.PUSH: SyncAction.PULL,
            SyncAction.PULL: SyncAction.PUSH,
            SyncAction.DELETE_LOCAL: SyncAction.DELETE_REMOTE,
            SyncAction.DELETE_REMOTE: SyncAction.DELETE_LOCAL,
            SyncAction.CONFLICT: SyncAction.CONFLICT,
            SyncAction.NOTHING: SyncAction.NOTHING,
        }
        for case in self.all_cases:
            here = decide(case).action
            there = decide(sides(case.remote_revision, case.local_revision, case.base_revision)).action
            assert there is mirror[here], f"{case} produced {here} here but {there} there"

    def test_data_is_only_destroyed_when_both_sides_agreed_on_what_it_was(self):
        """Every automatic deletion must be traceable to a state both sides
        acknowledged. Anything else has to be a conflict the user resolves."""
        for case in self.all_cases:
            action = decide(case).action
            if action is SyncAction.DELETE_LOCAL:
                assert case.base_revision is not None and case.local_revision == case.base_revision
            if action is SyncAction.DELETE_REMOTE:
                assert case.base_revision is not None and case.remote_revision == case.base_revision

    def test_an_unchanged_side_is_never_asked_to_overwrite_the_other(self):
        for case in self.all_cases:
            action = decide(case).action
            if action is SyncAction.PUSH and case.base_revision is not None:
                assert case.local_revision is not None and case.local_revision > case.base_revision
            if action is SyncAction.PULL and case.base_revision is not None:
                assert case.remote_revision is not None and case.remote_revision > case.base_revision

    def test_nothing_is_only_returned_when_the_sides_actually_agree(self):
        for case in self.all_cases:
            if decide(case).action is SyncAction.NOTHING:
                assert case.local_revision == case.remote_revision


class TestResolutionPlans:
    def test_keeping_the_local_side_pushes_it(self):
        plan = plan_resolution(ConflictResolution.KEEP_LOCAL)

        assert plan.push_local and not plan.pull_remote

    def test_keeping_the_remote_side_never_erases_the_local_data(self):
        """The user asked to prefer the other side, not to destroy this one. The
        only copy of a logged-in session may be the one being replaced."""
        plan = plan_resolution(ConflictResolution.KEEP_REMOTE)

        assert plan.pull_remote
        assert plan.keep_local_copy

    def test_keeping_both_makes_a_second_profile_rather_than_a_blend(self):
        plan = plan_resolution(ConflictResolution.KEEP_BOTH)

        assert plan.duplicate_as_new_profile
        assert plan.keep_local_copy

    @pytest.mark.parametrize("resolution", list(ConflictResolution))
    def test_no_resolution_both_pushes_and_pulls(self, resolution):
        plan = plan_resolution(resolution)

        assert not (plan.push_local and plan.pull_remote)

    @pytest.mark.parametrize("resolution", list(ConflictResolution))
    def test_every_resolution_moves_the_profile_somewhere(self, resolution):
        plan = plan_resolution(resolution)

        assert plan.push_local or plan.pull_remote
