# ADR-047: The committee continuity workbook and restore notices (migration 2110)

- **Status:** Proposed (2026-10-17). Linear CDF-252. Implemented in migration 2110 (Rebase PR-C, after 2100), pending security review. Synthetic reference implementation only.
- **Scope ruled by the coordinator** (2026-10-17 18:07 UTC, `/mnt/project-files/rebase/plan/2110_SIZING.md`): "2110 (ADR-047) = committee-proceeding scope + AMB-201 without votes + AMB-210 for all imports; AMB-211 to 2140 (ADR-050); CDF-245 to 2180 (ADR 060); AMB-201 paper minutes are a document reference until 2180."
- **Ambiguity rows** (owner-default answers from `docs/business-architecture/AMBIGUITY_REGISTER_200.md`):
  - AMB-201 (R2): outage meetings are recorded in a committee-scoped workbook imported by the secretary, original times kept, paper minutes as a source artifact; votes per DEC-AMB-008 (ballots are 2120, ADR-048).
  - AMB-210 (R3): on restoration, mandatory notices go out dated today with a reference to the original event; optional ones are skipped. `BCP_RESTORE_NOTIFY = MANDATORY_ONLY`.
- **Owner decision on AMB-201** (Fady, 2026-10-17 19:00 UTC, "Dual Institutional Record and Platform Attestation Model", binding): a committee workbook becomes authoritative only through two linked records, the final signed CDF minutes and, in the platform, the chair's (or a formally activated acting chair's) approval and each attending eligible member's own attestation, reconciled before commit. "Neither replaces the other." It supersedes the F2 default below. The model is built by migration 2115 (ADR-061); this migration refuses to submit a committee workbook until then.
- **Rulings recorded here:** F1, F2 and F3 (below); AGENT-09's items R1 to R5 from the early look, adopted as requirements; the split of 2110 and 2115 (coordinator, 19:13 UTC).
- **Protocol:** §12, §19, §29, §39, §45, §82, §83, §87; owner Q&A Q100; ADR-027, ADR-034; DEC-F30.

## Context

ADR-034 built the continuity workbook for one case (BCP-1): the case team records what happened during an outage, and after restoration a governed import replays each row through the command it would have used online, with a second person approving. Its §2 left the committee's offline work to a workbook scoped to a committee proceeding, because the Committee Secretary does not see the case (DEC-02, ADR-031) and the case team must not see committee deliberation.

Two gaps followed. A meeting held on paper had no way into the platform. And an import that replays commands also replays their notices, so a member would be told today, as if it had just happened, of a meeting held days ago, and would receive every optional notice too.

## Decision

### 1. Restore notices, every import (AMB-210)

- `BCP_RESTORE_NOTIFY` is CONFIGURED `MANDATORY_ONLY`, pinned to that one value by a check. Another value needs a migration and a source.
- While `api.apply_bcp_import` applies a row, `exchange.bcp_run` names it in a transaction-local setting. `notify.enqueue` believes the name only for a row resolved IMPORT, of an APPROVED batch the caller imports, that this very transaction has stamped as applying it (`applying_xact`, written once, only while the batch is APPROVED). **R3:** a transaction-local setting can be set by anyone, so the trust comes from the stamp, not the setting; a forged or stale name is ignored and the notice goes out as a live one.
- Inside an import an optional notice is skipped; a mandatory one goes out dated now, with `restored_row_id` and `original_event_at` on the outbox row. Both are immutable facts (`notify.protect_outbox`) and are read by the recipient under the existing outbox policy. The setting is cleared after each row, so the batch's own notices are live ones.
- `BCP_ROW_IMPORTED` counts the restore notices a row sent.

### 2. Continuity operators by scope (F1, DEC-F30; R1, R5)

- **F1 (ruled 18:07):** the secretary's import right is seat-based and no role gains a permission. ADR-034 §10's `BCP_IMPORT` grant to COMMITTEE_SECRETARY waits for 2160. The DEC-F30 registry entry is a further condition (owner decision, built in 2040).
- A registry entry now has a scope. `CASE` is the entry 2040 built, unchanged: `api.authorize_continuity_operator` still requires `BCP_IMPORT` and writes CASE entries only. `COMMITTEE_PROCEEDING` names one proceeding.
- `api.authorize_committee_continuity_operator(user, proceeding, authorization_reference, reason)`. Checks in order: FORBIDDEN without `BCP_CONTINUITY_ADMIN`; INVALID user_id unless ACTIVE; FORBIDDEN for oneself; `OPERATOR_EXTERNAL` for an external account (R5); `OPERATOR_NOT_SECRETARY` whether the proceeding is unknown, not OPEN, or the user holds no secretary or alternate-secretary seat on its committee now (one code, so the administrator learns nothing about proceedings); INVALID texts; `ALREADY_AUTHORIZED`. Revocation is 2040's `api.revoke_continuity_operator`.
- **The committee importer** (`exchange.bcp_committee_importer`): an internal account, seated now as the proceeding's committee secretary or alternate secretary, passing the proceeding's case gate, with a current COMMITTEE_PROCEEDING entry for that proceeding. It is checked at staging, by the batch insert trigger, at every step of the importer (`exchange.lock_bcp_batch`) and for seeing the batch at all. Losing the seat, the gate or the entry stops every step.
- **R1:** an entry satisfies only its own scope. A committee entry gives nothing outside its proceeding and nothing on a case workbook; a case entry gives nothing on a committee workbook.
- Audit: `BCP_OPERATOR_AUTHORIZED` (`ADMIN`) with the user, scope and proceeding ids.

### 3. The committee workbook BCP-C1 (AMB-201 without votes)

- **Template.** `BCP-C1` is reference data beside BCP-1, mirrored in `@cdf/contracts` (`BCP_COMMITTEE_TEMPLATE`) and kept equal by a database test; BCP-1 is untouched. The control row names the proceeding by id and by its committee's code, and the offline window is closed (`OFFLINE_TO` required). The empty workbook is committed as `infrastructure/bcp/BCP-C1_template.xlsx`, generated from the definition with bilingual labels and checked against it.
- **Namespace.** A batch has a `scope` (`CASE` or `COMMITTEE_PROCEEDING`) and, for a committee workbook, its proceeding; `case_id` stays the proceeding's case. Staging, provenance, re-import and revocation each work in the workbook's own namespace, so a workbook id staged for a proceeding never collides with one staged for its case and neither team learns of the other's workbook.
- **What it imports (F3, confirmed 19:13 as a declaration on the record):**
  - `09_MEETINGS` records a meeting already held, through `exchange.bcp_record_offline_meeting`. It applies the checks of `committee.insert_meeting` (secretary seat and gate, proceeding OPEN, case ACTIVE, purpose, mode, location, link, times) except the minimum-notice check, which governs scheduling ahead. **R2:** in its place, the meeting has ended (`MEETING_NOT_HELD`) and lies inside the workbook's offline window and after the referral (`OUTSIDE_OFFLINE_WINDOW`); staging marks a row that fails either INVALID. The meeting is created SCHEDULED, marked `held_offline`, with its original times and `paper_minutes_reference` (3 to 300 characters; the file attaches through ADR-061 and, as a source artifact, CDF-245 in 2180), and the participant snapshot taken at import. No grant, parameter or flag is added to `committee.insert_meeting` or `api.schedule_meeting`. Audit: `MEETING_RECORDED_OFFLINE` with ids, codes and the member count.
  - `11_CONFLICTS` raises a conflict noted on paper about a participant, through `api.raise_meeting_conflict` as the secretary; the concern then follows the online decision (DEC-F04). **R4:** the participant is resolved at staging among the proceeding's members and is never the importer (`OWN_CONFLICT`: one's own conflict is declared, never raised). The person a row is about never reads that row and is never an approver.
  - `10_ATTENDANCE`, `12_VOTES` and `22_DOCUMENT_INDEX` are recorded only (UNSUPPORTED). An import records no attendance and decides no conflict: N4 lets only a cleared participant be present, and each member declares and acknowledges for themselves. Votes are 2120 (DEC-AMB-008); the document index is 2180.
- **Who sees it (D4).** Its importer, while they remain the proceeding's committee importer, and its eligible approvers once submitted (none today, 3.4). Never the case team and never `BCP_IMPORT_APPROVE` holders. A committee workbook's batch events go to the ledger under no case, with the proceeding in the metadata, so the case team's ledger reads do not show them. Provenance of an imported meeting or concern is read by whoever can view that meeting or concern (never the concern's subject).
- **Who may never approve any batch** (`exchange.bcp_approver_excluded`, ADR-034 §7, R4, R5): its importer, its preparer, anyone who recorded a row offline, the subject of any conflict row, and any external account. For a case workbook this changes nobody (an external account holds no `BCP_IMPORT_APPROVE` since 2100, and a case row has no subject).
- **R5:** an external account is never authorized, never prepares or records a committee workbook (the preparer and every recorder must be an ACTIVE internal account seated on the committee and passing its gate), and never imports or approves one.

### 4. Who approves a committee workbook (F2): the official record, not this migration

- **The F2 default** (ruled 18:07, pending the owner): no approver until a source names one, behind a SOURCE_REQUIRED setting, with two seat-based options (the proceeding's chair or deputy chair; another secretary of the committee).
- **Superseded** by the owner's decision of 19:00: no single approver. The record is approved by the chair or a formally activated acting chair and attested by each attending eligible member, against the signed minutes, then reconciled and committed (ADR-061, migration 2115).
- **Until 2115:** a committee workbook stages, resolves, previews and cancels. `api.submit_bcp_import` and `api.decide_bcp_import` refuse it with `CONFLICT:OFFICIAL_RECORD_REQUIRED`; `exchange.bcp_eligible_approvers` names nobody for it; so no committee workbook is approved or applied. The F2 setting is not created. The apply path is tested under an owner-simulated approval.
- **No fallback.** Nothing here lets a case approver, a platform administrator or the importer approve a committee workbook (owner decision §11).

### 5. A lost committee workbook (AMB-205 in the proceeding's namespace)

- `api.revoke_committee_bcp_workbook(proceeding, workbook_id, incident_reference, reason)`, by the proceeding's committee importer only: NOT_FOUND unless the caller can view the proceeding; FORBIDDEN unless they are its committee importer; INVALID workbook_id; `WORKBOOK_REVOKED` if already revoked. It takes the staging lock of the same workbook in the proceeding's namespace.
- 2100's refusals then apply in that namespace: no copy is staged, and no batch of it moves on. A case revocation never touches a committee workbook of the same id, nor the reverse.
- Audit: `BCP_WORKBOOK_REVOCATION_RECORDED` (`BUSINESS`, under no case, naming the proceeding) and `BCP_WORKBOOK_REVOKED` (`SECURITY`).

### 6. Reads, grants and the catalogue

- `api.bcp_import_batch_view` gains the scope, the proceeding and whether a committee workbook still needs its official record; it never shows the rows about the viewer, and its capabilities follow the refusals above.
- No role gains a permission. No existing check is relaxed: the case workbook, `api.authorize_continuity_operator`, `committee.insert_meeting`, `api.schedule_meeting` and `api.raise_meeting_conflict` keep theirs. Replaced with the same signatures: `notify.enqueue`, `notify.protect_outbox`, `exchange.protect_bcp`, `exchange.is_continuity_operator`, `exchange.require_continuity_operator`, `exchange.lock_bcp_batch`, `exchange.bcp_cell_ok`, `exchange.bcp_eligible_approvers`, `exchange.bcp_execute_row`, `exchange.bcp_run`, `exchange.workbook_revoked`, `exchange.refuse_revoked_workbook`, `authz.can_view_bcp_import`, `authz.can_view_bcp_provenance`, the seven batch commands, `api.revoke_bcp_workbook` and `api.bcp_import_batch_view`. The `bcp_import_row` and `bcp_workbook_revocation` read policies are narrowed by scope.
- Helpers are not executable by application roles; `authz.is_bcp_committee_importer` is executable by `authenticated` because a policy calls it, and answers only about the caller.
- The catalogue: BCP_CONTINUITY names the two new commands; MEETING and NOTIFICATIONS note what 2110 delivers.
- **TS layer:** `@cdf/contracts` holds both templates (`BCP_TEMPLATES`), the batch scope and the two new row commands; `@cdf/validation` checks the control row and every row against the template the control row names (as `exchange.bcp_cell_ok` does); `readBcpWorkbook` reads a workbook only as the template the caller expects, so the case upload still accepts BCP-1 alone; the template generator writes either workbook. The gateway's batch list carries the scope and proceeding.

## Open questions and SOURCE_REQUIRED values

- The official record itself: ADR-061 (2115), including who may activate an acting chair for an imported record (owner card).
- "authorized continuity users" for the committee workbook beyond DEC-F30's registry, and the ADR-034 §10 `BCP_IMPORT` grant: 2160.
- Offline votes and attendance confirmed in person: 2120 (DEC-AMB-008).
- Lifting a workbook revocation after review (as ADR-046).

## Known limitations

- There is no screen for a committee workbook yet. The application's upload flow stages a case workbook only and refuses a committee workbook there (its control row has other columns); the committee upload and review screens come with the official record's screens (owner decision §13, UX).
- The participant snapshot of an imported meeting is taken at import, not at the original time: a member who left the committee since the meeting is not listed. The signed minutes and the record's declared roster (ADR-061) hold who attended.
- An imported meeting is SCHEDULED; the secretary opens it, records attendance once each member has declared in-platform, closes it and generates the minutes, as online.

## Consequences

- The committee's offline meetings and paper-noted conflicts can be staged and previewed now, by the proceeding's secretary alone, without the case team or the case approvers seeing them, and without anyone gaining a permission. Nothing of a committee workbook becomes authoritative before its official record exists.
- Every import sends restore notices only: mandatory ones dated now with their origin, optional ones skipped, in case and committee workbooks alike.
- Nothing is renamed or removed (DEC-35).
- PRODUCTION_SUBSTITUTION_REQUIRED: the workbook reader (ADR-034 D3) and the mail adapter that carries restore notices (ADR-025), as before.

## Production mapping

Tables, triggers and functions in PostgreSQL; they move to RDS PostgreSQL unchanged. The template file is static. No new service.

## Tests

- `tests/security/bcp-committee-2110.spec.ts`:
  - F1, R1, R5: who authorizes a committee entry, never for themselves, once, only for a secretary of the open proceeding, one refusal code; the case path unchanged; neither scope's entry satisfies the other's workbook; losing the entry stops the importer; an external account is never authorized, never prepares or records, never imports or approves.
  - AMB-201 owner decision: a committee workbook is never submitted (`OFFICIAL_RECORD_REQUIRED`), nobody is asked to approve it, and none forced to SUBMITTED could be approved.
  - D4: the case team and the case approvers see nothing of a committee workbook, in the tables or the ledger; workbook ids never collide across namespaces.
  - R2, F3, R4, AMB-210: a meeting stages only once ended, inside the window and after the referral; an approved workbook records the meeting held offline and raises the paper-noted conflict as the secretary, records no attendance, decides no conflict, and sends only restore notices; the subject never reads the row.
  - AMB-205: the importer revokes a lost committee workbook, nobody else can, and a case revocation never touches it.
- `tests/security/bcp-import.spec.ts`: restore notices on a case workbook (mandatory with their origin, optional skipped, the batch's own notices live); a restore setting naming a row this transaction did not stamp, or set by anyone outside an import, is ignored (R3); both templates equal `@cdf/contracts`; the application's cell rule equals the database's, BCP-C version cells included; grants.
- Unit: `@cdf/validation` and `@cdf/domain` BCP-C1 cases; `bcp-template.test.ts` for both committed templates.
- `api-idor.spec.ts` (the committee revocation probe; the committee authorization among the administrative commands), `audit-bypass.spec.ts` (walk steps for the two commands; `authz.is_bcp_committee_importer` documented), `purpose-read-models-2040.spec.ts` and `purpose-read-models.spec.ts` (the outbox's two restore columns, the batch view's new keys), `notifications.spec.ts`. The policy snapshot.

## Requirements

AMB-201, AMB-205, AMB-210; owner decision on AMB-201 (2026-10-17); DEC-F04, DEC-F30, DEC-02, DEC-35, DEC-AMB-008; ADR-025, ADR-027, ADR-031, ADR-034, ADR-046, ADR-061; Q100; CDF-252.
