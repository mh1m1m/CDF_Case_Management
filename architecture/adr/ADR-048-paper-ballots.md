# ADR-048: Paper ballots of a committee meeting held offline (migration 2120)

- **Status:** Proposed (2026-10-18). Linear CDF-262 (child of CDF-197). Implemented in migration 2120 (Rebase, after 2117), pending security review. Synthetic reference implementation only.
- **Owner decision (binding):** DEC-AMB-008, AMB-200, option B (Fady, 2026-10-13): "During an outage, substantive committee voting may use signed individual paper ballots. They are imported as provisional votes and must be confirmed by each relevant member through the platform after restoration before the vote becomes final. The Secretary may not cast `APPROVE` or `REJECT` on another member's behalf." The owner decision on AMB-201 (2026-10-17, ADR-061) also binds it: "The minutes attachment alone must not create a substantive vote in the system" (§6), and each attending member attests the record personally (§5).
- **Placement (coordinator ruling, 2026-10-18 15:44 UTC):** "Split. Yes: 2117 = closed proceeding + CDF-226 … then 2120 = paper ballots (ADR-048)." The design note is `/mnt/project-files/rebase/plan/2120_DESIGN.md`.
- **Forks ruled by the coordinator (15:44 UTC), recorded as rule A-39:**
  - **F1, model B′:** "the vote row is created only by the member's own confirm_offline_ballot … Record gate = ballot consistency (BALLOT_WITHOUT_ATTENDANCE) + the 2115 attestation. A″ is refused" (A″ would have written the vote in the secretary's transaction). ADR-061 carries the one amendment line.
  - **F2, narrow:** "attendance must match the attested roster; cast_vote and revise_vote refuse OFFLINE_BALLOT_ONLY; meeting_view replacement is accepted in 2120's size".
  - **F3:** the importer sees the 12_VOTES rows; the approver sees counts only.
  - **F4:** no notice in 2120. The PROPOSED text ("a ballot awaits your confirmation") is in the design note and was sent to the notification registers.
- **Protocol:** §12, §18–§20, §29, §39, §45, §82, §83, §87; owner Q&A Q59–Q63 and N6 (Q60); ADR-034, ADR-047, ADR-061; T-AMB-118.

## Context

ADR-047 (2110) brought a committee's offline meetings into the platform through the committee workbook BCP-C1, and recorded its 12_VOTES sheet only. ADR-061 (2115) made the workbook authoritative only on its official record: the signed minutes, the chair's approval and each attending member's attestation. Votes remained outside: a meeting held offline could be recorded, but what its members decided could not, and Q60 bars the secretary from recording a substantive vote for a member.

DEC-AMB-008 lets the committee vote on signed individual paper ballots during an outage, provided each member confirms their own ballot in the platform after restoration and the secretary never casts a vote for them.

## Decision

### 1. The workbook BCP-C2

- A new template version, `BCP-C2`, is reference data copied from BCP-C1 with one change: 12_VOTES is a data sheet with the command `record_offline_ballot`. One row per signed ballot: `MEETING_REF` (the workbook's meeting row), `PARTICIPANT` (the member's email), `TARGET_KIND` (`FINDING`, `PACKAGE` or `RECOMMENDATION_ITEM`), `TARGET_ID`, `CHOICE` (`APPROVE`, `REJECT`, `ABSTAIN` or `RECUSED`) and `BALLOT_REFERENCE` (the paper's own reference, 3 to 300 characters).
- BCP-C1 is unchanged and its 12_VOTES stays recorded only (DEC-35: no catalogue row is renamed or removed). `@cdf/contracts` mirrors BCP-C2 as `BCP_COMMITTEE_BALLOT_TEMPLATE`, kept equal by a database test; the empty workbook is committed as `infrastructure/bcp/BCP-C2_template.xlsx`.

### 2. Staging (who a ballot can belong to)

- `api.stage_bcp_import` resolves each ballot's member to `ballot_user_id`, among the proceeding's voting and alternate members only (never a secretary seat, so never the importer, nor a member set aside at referral; `PARTICIPANT` otherwise). It checks that the target belongs to the proceeding in the form its vote takes (`exchange.bcp_ballot_target_ok`: a finding in the committee's scope, a package voted as a whole, or an item of a package voted item by item; `TARGET_ID` otherwise), and refuses a second ballot of the same member on the same target (`DUPLICATE_BALLOT`). A ballot is never a conflict row: `subject_user_id` stays empty.

### 3. The official record gates the ballots (F1)

- **E1:** every ballot to import names the record's one meeting row, as every conflict row does (`exchange.bcp_record_meeting_row`).
- **`BALLOT_WITHOUT_ATTENDANCE`:** a new reconciliation discrepancy (`exchange.bcp_record_discrepancies`) for a ballot whose member's roster line is missing, not attending, a secretary seat, or no longer eligible. It blocks submission, approval and commit like any other discrepancy. The member's own attestation of the record is their attestation of their ballot with it (AMB-201 §5); nobody attests for another.

### 4. The commit writes a provisional ballot, never a vote

- `exchange.bcp_record_offline_ballot` runs each check again at commit, on the platform as it stands: the meeting is the workbook's, held offline and not yet reopened; the ballot was signed while it was held (`ORIGINAL_EVENT_AT`); the member sits in a voting seat; the target is still what the meeting voted on. A finding still current, of an allegation not withdrawn, recorded before the meeting began. A package still `VOTING`, unchanged since the meeting began (`TARGET_CHANGED`), whose vote for that round has not been opened online (`VOTE_ALREADY_OPENED`), and whose re-vote does not exclude the member (`EXCLUDED_BY_CONFLICT`). An item still `ACTIVE`. The package's round is frozen on the ballot.
- It inserts one `committee.offline_ballot` row, `PROVISIONAL`, and nothing else: no vote row, no count, no attendance. It is reachable only from an approved import's row, as the importer running the meeting (no grant).
- `committee.offline_ballot`: RLS enabled, no policy, no grant to any application role (as `committee.vote`). It is never deleted or truncated. A provisional ballot changes once to bind to a vote item and once to settle (`CONFIRMED`, `SUPERSEDED` or `LAPSED`), and nothing else ever changes (`committee.protect_offline_ballot`).

### 5. Binding, confirming and settling

- **Binding:** a vote item opened in the meeting held offline on a ballot's target (in the same round, for a package) binds the provisional ballot (`OFFLINE_BALLOTS_BOUND`, ids and the count).
- **Confirming (`api.confirm_offline_ballot(vote_item_id, choice)`):** the member's own act, in their own transaction (DEC-AMB-008). It applies every check `api.cast_vote` makes (a voting or activated alternate member, not replaced, seat current, declared no conflict, present, the item open, no vote yet), then requires their own provisional ballot bound to that item (`NO_PROVISIONAL_BALLOT`) and the choice they read on it (`BALLOT_CHOICE_MISMATCH`; the ballot stays provisional). It writes the member's own `SELF` vote with the ballot's choice and the paper time as `original_event_at`, and the ballot becomes `CONFIRMED` (`OFFLINE_BALLOT_CONFIRMED`, ids only). The caller is the member by construction: the secretary has no path to it.
- **Superseding:** another vote of the member's on the item settles the ballot `SUPERSEDED` (`OFFLINE_BALLOT_SUPERSEDED`): their recusal for a conflict, or the secretary's N6 record for a member not present (`ABSENT`, `UNABLE_TO_VOTE` or `RECUSED`, with its reason; never `APPROVE` or `REJECT`).
- **Lapsing:** a ballot still provisional when its item closes, or when its meeting closes or is cancelled, becomes `LAPSED` and never counts (`OFFLINE_BALLOTS_LAPSED`, ids and the count).

### 6. The vote is final only when every ballot is settled

- `api.close_vote_item` refuses `BALLOTS_UNCONFIRMED` while a counting member's ballot on the item is still provisional (`committee.offline_ballot_blocks`: the member still counts there and no re-vote excludes them). Otherwise a ballot whose member is not recorded present would lapse with no act of theirs and no reasoned record. `VOTES_OUTSTANDING` still comes first for a member present who has not voted.

### 7. The meeting held offline (F2)

- In a meeting held offline, `api.cast_vote` and `api.revise_vote` refuse `OFFLINE_BALLOT_ONLY`: every substantive vote comes from a confirmed paper ballot. Recusal and the secretary's N6 records stay.
- `api.record_attendance` records a member `PRESENT` only if the committed record's roster shows their line attended (`OFFLINE_ROSTER_MISMATCH`, `committee.offline_roster_attended`).

### 8. Who reads the ballots (F3, secrecy)

- **Before commit:** a committee workbook's 12_VOTES rows are its importer's alone, in the table (`bcp_import_row_read`, through `authz.can_view_bcp_ballot_rows`) and in `api.bcp_import_batch_view`. The chair who approves the record reads every other row, and the ballots only as `counts.ballots`. A case workbook's rows are unchanged.
- **After commit:** `api.meeting_view` gives each vote item its ballots counted by state (never a choice); the caller's own ballot with its choice (`my_ballot`), to that member only; to the meeting's runner while the item is open, the counting members whose ballot still waits (`ballots_unconfirmed_for`); `held_offline`; and the flag `may_confirm_ballot`, equal to the command. `may_vote` and `may_revise` mirror F2, and the roster's `may_record_present` mirrors the attended roster. `api.vote_item_status` gives the counts and the caller's own ballot.
- Provenance of an imported ballot is read by its member and by whoever runs its meeting (`authz.can_view_offline_ballot`).
- Q61 to Q63 and AMB-201 test 18: no ledger row carries a choice or the paper's reference; a choice is shown only to its member, and to others only as the vote's own after close under the existing secrecy rules.

### 9. Grants and the catalogue

- New helpers are not executable by application roles. `authz.can_view_offline_ballot` and `authz.can_view_bcp_ballot_rows` are executable by `authenticated` because a policy and a read call them, and answer only about the caller. `api.confirm_offline_ballot` is granted to `authenticated`; the database decides who may use it.
- No role gains a permission and nothing is widened before 2160. Replaced with the same signatures: `api.stage_bcp_import`, `exchange.bcp_execute_row`, `authz.can_view_bcp_provenance`, `exchange.bcp_record_meeting_row`, `exchange.bcp_record_discrepancies`, `api.bcp_import_batch_view`, `api.cast_vote`, `api.revise_vote`, `api.record_attendance`, `api.close_vote_item`, `api.meeting_view` and `api.vote_item_status`. The `bcp_import_row_read` policy is narrowed.
- The catalogue: BCP_CONTINUITY names the new command; MEETING notes what 2120 delivers.
- **TS layer:** `@cdf/contracts` holds BCP-C2, the ballot statuses and choices, the new view fields and `BALLOT_WITHOUT_ATTENDANCE`; `@cdf/validation` checks BCP-C2 rows and the confirmation; the meetings service and gateway carry `confirmOfflineBallot` and map the new fields (missing keys read as no ballots); the template generator writes BCP-C2; the refusals have Arabic and English words.

## Narrowings beyond the ruled items (fail closed, for review)

- `BALLOTS_UNCONFIRMED` (section 6).
- `TARGET_CHANGED`: a target that changed after the meeting began, or a package whose round may have, refuses at commit.
- The confirmation carries the choice the member read (`BALLOT_CHOICE_MISMATCH`).
- F3 applies to every committee workbook's 12_VOTES rows, BCP-C1's recorded-only rows included, so since 2120 the chair no longer reads a BCP-C1 votes row either (the 2115 test is changed to say so).
- `counts.ballots` on the batch view.

## Open questions and SOURCE_REQUIRED values

- The notice that a ballot awaits its member's confirmation (F4): PROPOSED text with the notification registers, for the owner.
- Each member's own view of their ballot before they attest the record: the read-model migration that ships with the Section 13 UI (ADR-061 §9).

## Known limitations

- There is no page to confirm a ballot yet. The command, its flag and the view fields are complete; the control on the meeting page is UX work. Until then a member confirms only through the API, and a meeting held offline with ballots completes only that way.
- My Work's `VOTE_OPEN` row is unchanged: it does not yet say that a ballot waits for confirmation.
- A member present without a ballot on an item can only recuse there (F2); a member who disputes their ballot simply does not confirm it, and the secretary records them under N6 when they are not present.
- A ballot whose target is never opened as a vote item in the meeting lapses when the meeting closes.
- A tie is broken by the chair's casting vote online, as for any vote.
- A meeting held offline without a committed record cannot record its members present (F2), so it holds no vote.
- Re-vote exclusion of a ballot is enforced at commit and in `committee.offline_ballot_blocks`; it is not exercised end to end by a test.

## Consequences

- A committee's paper votes during an outage reach the platform, and count only through each member's own confirmation; the secretary transcribes, the chair approves the record, and neither can make a vote.
- One table, one command, four audit actions; nothing renamed or removed (DEC-35). No permission or role is granted.
- PRODUCTION_SUBSTITUTION_REQUIRED: the workbook reader (ADR-034 D3), as before. Nothing new.

## Production mapping

Tables, triggers and functions in PostgreSQL; they move to RDS PostgreSQL unchanged. The template file is static. No new service.

## Tests

- `tests/security/paper-ballots-2120.spec.ts`: T-AMB-118 end to end (staged, previewed, committed provisional with no vote, bound, refused online, confirmed by each member at the paper time, the item then closes; the ledger has ids only); no secretary path (confirm, cast and N6 `APPROVE`/`REJECT` refused; no application role reads the table); `BALLOTS_UNCONFIRMED` and N6 superseding; lapsing and integrity probes; binding by target; F2 roster; a meeting held online unchanged; the record gate (`BALLOT_WITHOUT_ATTENDANCE`); F3 rows and counts and provenance readers; staging refusals; commit and dry-run refusals; the commit re-check.
- `tests/security/bcp-import.spec.ts` (templates equal `@cdf/contracts`; the ballot import calls no command and writes only the ballot), `bcp-committee-record-2115.spec.ts` (the chair's row count), `api-idor.spec.ts` (`confirm_offline_ballot` probe), `audit-bypass.spec.ts` (the walk confirms a ballot; the two helpers documented), the view-shape specs (`without2120`), `tests/integration/mirrors.spec.ts` (`BALLOT_WITHOUT_ATTENDANCE`), `tests/integration/meetings.spec.ts` (the whole path refuses `NO_PROVISIONAL_BALLOT`). Unit: validation, gateway, service, template and i18n label tests. The policy snapshot.

## Requirements

DEC-AMB-008 (AMB-200); the owner decision on AMB-201 (§5, §6); Q59–Q63, N6; DEC-35; ADR-034, ADR-047, ADR-061; T-AMB-118; CDF-262 (child of CDF-197).
