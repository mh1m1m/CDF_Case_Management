# ADR-062: A bound paper ballot is superseded only after its member or the chair releases it (migration 2125)

- **Status:** Proposed (2026-10-18). CDF-264 (under CDF-197), a follow-up to CDF-262 (ADR-048, migration 2120). Implemented in migration 2125 (Rebase, after 2120, before 2130), pending security review. Synthetic reference implementation only.
- **Coordinator ruling (2026-10-18 19:08 UTC), on AGENT-09's observation O1 of PR #112:** "a bound paper ballot may not be superseded by N6 on the secretary's act alone; the secretary records the ABSENT fact, but superseding a bound ballot takes the chair's act or the member's own act as a second actor, fail-closed. This enforces F1 B′ (the vote belongs to the member alone)." Recorded as rule A-40.
- **Design confirmed (19:09 UTC):** release first. "The alternative (secretary's N6 opening a pending supersession) would let the secretary initiate against a member's ballot, which is the wrong direction; release-first keeps the second actor ahead of the secretary and the secretary never touches a vote." A released ballot stays confirmable by its member until N6.
- **Out of scope (ruled):** AGENT-09's O2, a mis-transcribed ballot with no correction after commit, is LOW and stays with Section 13's pre-attestation view. The member's decline below is a partial exit for it, not the correction path.
- **Protocol:** §19, §20, §29, §82, §83; owner Q&A N6 (Q60); DEC-AMB-008; ADR-048, ADR-061.

## Context

ADR-048 (2120) turns a signed paper ballot into a vote only by the member's own confirmation (F1 B′). It also lets another vote of the member's on the item supersede the ballot: their recusal, or the secretary's N6 record for a member not present (`ABSENT`, `UNABLE_TO_VOTE` or `RECUSED`, with a reason). AGENT-09 observed (O1) that the second path rests on the secretary's act alone. The secretary transcribed every ballot and so knows each choice. By recording a member absent and then recording them under N6, the secretary could set aside a chosen member's ballot. The act is reasoned and audited, and the member sees it as `SUPERSEDED`, but no second person takes part.

## Decision

### 1. N6 refuses a held ballot

- `api.record_vote_for_member` (N6) refuses `BALLOT_HELD` while the member holds a `PROVISIONAL` ballot bound to the item that nobody has released. The secretary still records attendance (the fact of absence).
- The settle trigger (`committee.settle_offline_ballot`) refuses the same thing as a backstop. A vote that is not the member's own (`source <> 'SELF'`) never settles a ballot nobody has released.
- The meeting view's `record_vote_for` leaves such a member out (flag == command).

### 2. The member's own act: `api.decline_offline_ballot(vote_item_id)`

- The member releases their own provisional ballot bound to the item. They may dispute it (they do not confirm it), or be unable to confirm it.
- Who they are is checked as for `api.confirm_offline_ballot`: a counting seat of their own, not replaced, still seated, and able to see the meeting's deliberation (`committee.lock_vote_item`). Presence is not required. Letting the ballot go casts nothing, and a member who is not present is the one N6 is for.
- It names no member, so nobody declines for another. It is refused `NO_PROVISIONAL_BALLOT` without such a ballot, and `BALLOT_RELEASED` once released.
- The flag is `capabilities.may_decline_ballot`. The audit event is `OFFLINE_BALLOT_DECLINED` (ids only).

### 3. The chair's act: `api.release_offline_ballot(vote_item_id, participant_id, reason)`

- The meeting's chair for rulings (`committee.meeting_chair_as`: the chair, cleared and attending, or an activated acting chair) releases the provisional ballot of a member who is not present, with a reason of 5 to 2,000 characters.
- It is never whoever runs the meeting (`committee.manages_meeting`), never the ballot's own member (theirs is the decline), and never anyone the ballot's workbook excludes from approving (`exchange.bcp_approver_excluded`: its importer, its preparer, an offline recorder, a conflict subject or an external account; A-36).
- A present member acts for themself (`MEMBER_PRESENT`). A second release is refused (`BALLOT_RELEASED`).
- The chair's list is `ballots_releasable_for`. The audit event is `OFFLINE_BALLOT_RELEASED` (ids only); the reason stays on the ballot row, which no application role reads.

### 4. The ballot after its release

- A release (`released_at`, `released_by`, `release_kind` `MEMBER` or `CHAIR`, and `release_reason` for the chair's) is made once, with nothing else changing, and is never changed or undone.
- `committee.protect_offline_ballot` allows exactly that one change. A check constraint ties a `MEMBER` release to the member and a `CHAIR` release to someone else with a reason.
- The ballot stays `PROVISIONAL`. Its member may still confirm it until a vote settles it, and `api.close_vote_item` still refuses `BALLOTS_UNCONFIRMED` until the secretary's N6 record supersedes it.
- The member reads who released it in `my_ballot.release`.

## Consequences

- Before 2125, a ballot set aside without its member involved the secretary alone. Now it always takes the member or the chair, and the chair's reason is kept.
- The secretary's path is otherwise unchanged. They record attendance and, once the ballot is released, the N6 record with its reason, as in 2120. A vote item still cannot close while a counting member's ballot waits.
- No role gains a permission. The two commands are granted to `authenticated` and decide everything themselves; nothing is widened before 2160.
- The meeting page shows the new controls once UX builds them. The commands, flags and view fields are ready (`declineOfflineBallot`, `releaseOfflineBallot`, `mayDeclineBallot`, `ballotsReleasableFor`, `myBallot.release`).
- Refusal texts: `BALLOT_HELD` and `BALLOT_RELEASED` are new. `BALLOTS_UNCONFIRMED` and `BALLOT_CHOICE_MISMATCH` now name the release.

## Known limitations

- A mis-transcribed ballot still has no correction after commit (O2, LOW, ruled out of scope): the member declines it and the secretary records them under N6, or they recuse.
- A chair who is absent or conflicted cannot release; the meeting's activated acting chair can. A ballot nobody releases holds the vote item open (fail-closed), as a member's unconfirmed ballot did in 2120.

## Production mapping

None new. The rule lives in the database's command functions and their tests, and carries over unchanged to RDS PostgreSQL. The BCP path remains a reference emulation (ADR-034, `PRODUCTION_SUBSTITUTION_REQUIRED`).

## Tests

The last describe of `tests/security/paper-ballots-2120.spec.ts` covers three cases:

- The secretary alone is refused (`BALLOT_HELD`, the flag too), and the chair's release, with its reason off the ledger, lets N6 follow.
- The member's own decline works attending or not, the member never releases their own ballot, and a released ballot stays confirmable.
- A chair the workbook excludes, as a conflict's subject or as a row's offline recorder, is refused (A-36). The trigger backstop holds, and so do the release's integrity probes.

2120's N6 test now releases first. There are unit tests for the gateway, the service and the i18n texts, and the meetings integration path.

## Requirements

N6 (Q60); DEC-AMB-008; ADR-048, ADR-061; the coordinator's ruling of 2026-10-18 19:08 UTC; CDF-264 (follow-up to CDF-262).
