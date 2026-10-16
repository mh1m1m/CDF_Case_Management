# ADR-045: Case structure and corrections without rewriting a record (migration 2090)

- **Status:** Proposed (2026-10-15). Linear CDF-196 (rebase decision application) and CDF-227 (Security MEDIUM, §10). Implemented in migration 2090 (Rebase PR-C, first of 2090 to 2140, pending security review). Placement confirmed by the coordinator on 2026-10-15: "2090 Case structure and corrections (ADR-045), the ten rows as listed."
- **Ambiguity rows** (all R2; owner-default answers from `docs/business-architecture/AMBIGUITY_REGISTER_200.md`):
  - AMB-003: "Never merge physically. Record a typed link (DUPLICATE_OF or RELATED) between the cases and conclude the duplicate preliminary review with DUPLICATE. Evidence, history and access stay on each case; a link grants no access to the linked case." Test T-AMB-002.
  - AMB-004: "A real split creates a new case through an authorised command that references the source case; subjects and allegations are re-created with provenance; evidence is linked by reference only after a need-to-know check; the source history is untouched." Test T-AMB-003.
  - AMB-008: "Same referral and number; each submission is a numbered version whose submitted content is snapshotted. Nothing is overwritten."
  - AMB-027: "Withdrawal is a status (WITHDRAWN, reason, actor), never a delete. A split creates new allegations referencing the original, which becomes SUPERSEDED; evidence links are copied by reference."
  - AMB-032: "Unidentified: placeholder subject, no notice or sanction until identified (an audited change). Untraceable: proceeding suspended with a reason. Deceased: findings may be recorded for governance; sanction items refused."
  - AMB-033: "Correction is an audited new subject link; the wrong person's portal link is revoked in the same transaction and any notice already sent is logged as a privacy incident. Records are not rewritten." Test T-AMB-014.
  - AMB-045: "Overlaps are refused by constraint. A correction adds rows with a reason; past snapshots are never edited; a correction affecting a past proceeding is an annotation." Test T-AMB-023.
  - AMB-091: "The secretary issues a revised version; review restarts for all attending non-conflicted members; earlier versions are kept." Already built; pinned by a test.
  - AMB-093: "By an append-only correction record reviewed by the same attending non-conflicted members; the approved version stays." Test T-AMB-054.
  - AMB-223: "By an appended annotation with reason; originals stay."
- **Coordinator rulings:** restricted-case access never grows without its authority; reasons never go in audit metadata; no permission is widened before 2160; the portal belongs to AGENT-02 and the BFF never reads case tables, so the subject correction stays on the database side and the privacy-incident record carries no case content or reporter identity in anything that leaves the database.
- **CDF-227 (coordinator, 2026-10-15):** placed in 2090, the shape of CDF-225: "writer-side, those three events are recorded without the reason and without the reference; reader-side, corrective_action_view excludes reason and reference for an owner outside the case team so existing rows are covered; no event row rewritten; one negative test that walks every value in the owner's JSON."
- **Protocol:** §18–§22, §24, §29, §39, §65, §82, §83, §87.

## Context

Several records could only be changed by editing them in place, or not at all. Two duplicate cases could not be tied together. A case could not be split. An allegation could only be added. A subject placeholder could not be told apart from a known person, and a wrongly identified person kept their portal link and their notices. A referral's content was overwritten by each edit, so an earlier submission could not be read back (1880 kept only the events). A committee seat recorded wrongly, approved minutes with an error and a closed record with an error had no correction path.

ADR-005 (append-only ledger) and the register's answers all point the same way: add a row (a link, a status, a successor, an annotation) and keep the original readable to those who could read it.

## Decision

### 1. Case links (AMB-003)

- `case_mgmt.case_link`: a typed link from a case to another, `DUPLICATE_OF` or `RELATED` (and `SPLIT_FROM`, set only by §5). Ended with a reason, never deleted; a `SPLIT_FROM` link never ends. One active link of a type between two cases, in either direction; one active original per duplicate.
- `api.link_cases(case, linked_case, type, reason)`. Checks in order: the caller edits the case (`lock_editable_case`: NOT_FOUND, FORBIDDEN, `CASE_NOT_ACTIVE`); NOT_FOUND unless the caller can see the other case (so the command cannot probe for cases); INVALID linked_case_id (the same case); INVALID link_type; INVALID reason; `LINK_EXISTS`; `ALREADY_DUPLICATE`.
- `api.end_case_link(link, reason)`: NOT_FOUND unless the caller can see both cases; then the case edit check; `LINK_NOT_ENDABLE` (`SPLIT_FROM`); `LINK_ENDED`; INVALID reason.
- **A link grants no access (T-AMB-002).** It is readable only by someone who can see both cases (RLS). The audit events `CASE_LINKED` and `CASE_LINK_ENDED` sit on the case and carry the link type only, so the case team of one case never learns the other case's id from the ledger.
- **DUPLICATE needs the link.** A case closes with the outcome `DUPLICATE` only while it has an active `DUPLICATE_OF` link (catalogue S052, T1-B1.5-165: "link it to the original before closure"). Triggers on `case_closure_request` and `case_closure` check it at filing and again at approval, so ending the link in between stops the approval (`DUPLICATE_LINK_REQUIRED`). The preliminary review's DUPLICATE recommendation is unchanged: the case is closed through the closure path, where the link is checked.

### 2. Allegations: withdrawal and split (AMB-027)

- The allegation status gains `SUPERSEDED` (no value removed) and the column `supersedes_allegation_id`. `case_mgmt.allegation_status_change` records why and by whom an allegation was withdrawn or superseded (append-only).
- `api.withdraw_allegation(allegation, reason)`: NOT_FOUND, then the case edit check; `ALLEGATION_NOT_OPEN`; `ALLEGATION_IN_RECOMMENDATION`; INVALID reason. Findings, notices and evidence stay with it.
- `api.split_allegation(allegation, parts, reason)`: two to ten parts, each with a category, a description and optionally a subject on the case and references (the original's when omitted). Also refused with `ALLEGATION_HAS_FINDINGS`: the findings would no longer match what was alleged. The successors reference the original and its evidence links are copied by reference (same case, same evidence rows). The original becomes `SUPERSEDED`.
- **Frozen.** A withdrawn or superseded allegation never changes, and its content never changes while open either (a trigger; only the status, a subject set once, and references may be written). Nothing new hangs off it: no finding, evidence link, notice item or recommendation item (`ALLEGATION_WITHDRAWN`, `ALLEGATION_SUPERSEDED`).

### 3. Subject status (AMB-032)

- `case_mgmt.subject_status_event`: the subject's status over time; the latest is current, none means `IDENTIFIED`. `UNIDENTIFIED` (a placeholder), `UNTRACEABLE`, `DECEASED`, and `MISIDENTIFIED` (set only by §4, final).
- `api.record_subject_status(subject, status, reason)`: NOT_FOUND, then the case edit check; INVALID status (`MISIDENTIFIED` cannot be chosen); `SUBJECT_MISIDENTIFIED`; `SUBJECT_STATUS_UNCHANGED`; `SUBJECT_LINKED` (a subject with an active portal link is a known person and is never marked `UNIDENTIFIED`); INVALID reason. Re-identifying is the same audited change back to `IDENTIFIED`.
- **What a status refuses.** Only an `IDENTIFIED` subject receives a notice or a portal link (`SUBJECT_NOT_NOTIFIABLE`). A disciplinary sanction item names only an `IDENTIFIED` subject (`SUBJECT_NOT_SANCTIONABLE`), and no item names a `MISIDENTIFIED` one. Findings may still be recorded for every status but `MISIDENTIFIED` (governance).
- **Untraceable.** The proceeding is suspended with the new reason code `SUBJECT_UNTRACEABLE` through `api.update_proceeding_state` (codes only; labels in `packages/i18n`). The status does not suspend it automatically: other subjects may be traceable.

### 4. Correcting a wrongly identified subject (AMB-033)

- The correct subject is added first (`api.add_case_subject`). `api.correct_case_subject(wrong, correct, reason)`: NOT_FOUND, then the case edit check; INVALID correct_subject_id (null, the same subject, another case's, or `MISIDENTIFIED`); `SUBJECT_MISIDENTIFIED`; `SUBJECT_HAS_FINDINGS`; `SUBJECT_IN_RECOMMENDATION`; INVALID reason. Findings and recommendations that name the wrong person stand; they are corrected through reopening, never rewritten.
- In one transaction: the wrong person's portal links are revoked; their open notices are withdrawn and the open delivery tasks closed; their open allegations are re-stated about the correct subject (successors, evidence links copied by reference) and the originals superseded; the wrong subject becomes `MISIDENTIFIED`. `case_mgmt.subject_correction` records the counts.
- **T-AMB-014.** Afterwards the former holder gets NOT_FOUND on every notice, as for a notice that does not exist, and `api.my_defence_notices()` lists none.
- **Still conflicted.** `authz.has_conflict` counts a link revoked because its subject was `MISIDENTIFIED`, so the correction never opens the case to the person it was wrongly about.
- **Privacy incident.** When any notice had been issued to the wrong person, `case_mgmt.privacy_incident` records the kind (`NOTICE_TO_MISIDENTIFIED_SUBJECT`), the correction and the number of notices: ids and counts only, no name, label, notice text or reporter identity. It is read by security monitoring (`SECURITY_EVENT_VIEW`) and the case team, and leaves the database through no channel (no Sentry, Linear or Slack text). Audit `PRIVACY_INCIDENT_RECORDED` is a `SECURITY` event with the same ids and counts. PRODUCTION_SUBSTITUTION_REQUIRED: the CDF privacy incident process takes it from there.
- **Portal (AGENT-02).** Nothing in the portal or BFF changes: both already answer through the subject's active link. Two follow-ons are noted for the portal owner: a notification email queued before the correction carries no content and its deep link answers NOT_FOUND, but the production `NotificationSender` should re-check the link before sending; and a grievance the wrong person had filed stays readable to them as its grievant.

### 5. Splitting a case (AMB-004)

- `api.split_case(case, allegation_ids, title, summary, reason)`. Checks in order: the case edit check; FORBIDDEN without `CASE_CREATE`; INVALID allegation_ids (1 to 50, distinct, all on the case); INVALID title, summary, reason; `ALLEGATION_NOT_OPEN`, `ALLEGATION_IN_RECOMMENDATION`, `ALLEGATION_HAS_FINDINGS`; `SPLIT_LEAVES_NOTHING` (at least one open allegation stays on the source).
- The new case keeps the source's case type, classification, restriction and accountable authority (`owner_id`), with a new synthetic number, and a `SPLIT_FROM` link to the source. It starts at REGISTERED.
- **The team.** The source's active assignments of active accounts are carried, each passing the assignee rule on the new case (clearance, conflict across the family, role). A member whose account is suspended or deactivated is not carried; the count is in the audit event. No one gains a case they could not already work, and a restricted case keeps the same authority (no access grows without the RCA).
- **Re-created with provenance.** The chosen allegations' subjects are re-created on the new case (with their status, never a portal link or a notice); the allegations are re-created referencing the originals, which become `SUPERSEDED` on the source.
- **No evidence moves (T-AMB-003).** Evidence is linked into the new case only after a need-to-know check (AMB-004). Doing that in the split would grant each item to the new case's team, a widening, so the split copies no evidence, evidence link, history, grant, notice, portal link or reporter channel. Evidence stays on the source, where the carried team already reads it.
- **Conflicts follow the family.** `authz.has_conflict` looks at every case connected by `SPLIT_FROM` links, both ways: a conflict on one case of the family is a conflict on all of them. This is a narrowing. Every case gate pays for it, so `case_mgmt.split_family` takes a fast path: a case with no `SPLIT_FROM` link in either direction is its own family, returned without the recursive walk, and the answer is the same (pinned; coordinator, 2026-10-15 15:20, after UX timed the 2085 logistics sweep). Both functions are PL/pgSQL with plans kept for the session (`authz.has_conflict` with generic plans): as SQL functions called inside the SQL case gate they were planned again on every call, `authz.has_conflict` before 2090 too. Every conflict answer equals 2090's rule written in SQL over the full walk (pinned). On UX's sweep, alone on a fresh database: about 28 s, against about 33 s without 2090 and about 40 s with the SQL version.
- SOURCE_REQUIRED: when a case may be split (S090, S107). The command is the narrowing default until the owner answers. Audit `CASE_SPLIT` on the source (counts), `CASE_CREATED` with `basis = CASE_SPLIT` on the new case.

### 6. Referral submission versions (AMB-008, confirmed against 1880)

1880 recorded `SUBMITTED` and `RESUBMITTED` as events and let `api.update_referral` overwrite the content. `intake.referral_submission` now keeps the content of each submission and resubmission (title, summary, category, classification, sector, committee), numbered per referral, written by a trigger on the event in the same transaction. It is read as the referral is read (`authz.can_view_referral`). Same referral, same number, nothing overwritten. No command changes.

### 7. Committee membership corrections (AMB-045)

- Overlapping seats stay refused by the appointment command (1870). A seat is changed only by ending it and appointing anew.
- `api.annotate_committee_membership(membership, kind, reason)`: FORBIDDEN without `COMMITTEE_ADMIN`; NOT_FOUND; `SELF_CORRECTION` (no one corrects the record of their own seat); INVALID kind; INVALID reason. `committee.membership_correction` records the kind (`WRONG_HOLDER`, `WRONG_SEAT`, `WRONG_DATES`, `WRONG_REFERENCE`, `OTHER`), the reason and the number of proceeding snapshots that named the seat. Snapshots are never edited (T-AMB-023). Read with the registry. Audit `COMMITTEE_MEMBERSHIP_ANNOTATED` (`ADMIN`, no case).

### 8. Minutes: revised versions and corrections (AMB-091, AMB-093)

- AMB-091 is built (1890, 2030): a change request supersedes the version, the secretary issues a revised one, review restarts for every reviewer, and earlier versions are kept. A test pins it.
- `api.propose_minutes_correction(minutes, text, reason)` by the meeting's secretary, on approved or deemed-approved minutes: NOT_FOUND; FORBIDDEN or `CASE_NOT_ACTIVE` (`lock_managed_meeting`); `MINUTES_NOT_APPROVED`; `CORRECTION_IN_REVIEW`; `NO_CORRECTION_REVIEWERS`.
- `api.review_minutes_correction(correction, decision, comment)` by the minutes' reviewers (members present with no conflict, never the secretaries, re-checked at each review): every reviewer approves, or any one rejects with a comment. There is no deemed approval, and nothing is approved on the secretary's word alone.
- The approved version never changes (T-AMB-054). The case team reads an approved correction, as it reads approved minutes; the reviews are read with the deliberation.

### 9. Annotations on records past ACTIVE (AMB-223)

`api.annotate_archived_record(case, target_kind, annotation, reason)`: NOT_FOUND unless the caller can see the record; FORBIDDEN without `ARCHIVE_RECORD_ADMINISTER` in catalogue scope; `CASE_ACTIVE`; `RECORD_DISPOSED`; INVALID target_kind. `records.record_annotation` is append-only and read as the record is read. The original record never changes. Restricted records are outside the catalogue scope, so they take no annotation here (fail closed).

### 10. A disposition's reason stays with the case team (CDF-227)

When a replacement decision disposes of a frozen corrective action (DEC-AMB-014, migration 2030), `api.dispose_superseded_corrective_action` wrote the disposition's reason as the note of the `RETURNED`, `DUE_DATE_CHANGED` and `WAIVED` events it recorded on the action, and the replacement decision's document as the `WAIVED` event's reference. An action's history is read with the action (`corrective_action_event_read`, 1940), so an action owner outside the case team read both, although the disposition is the case team's: plan §4.1, and 2070's own view, give the owner no origin.

- **Writer side.** The command records the three events without the reason and without the document; both stay in `decision.corrective_action_disposition`, read by the case team only. The 1940 check that tied a document to every `WAIVED` event becomes a one-way check (only a `WAIVED` event carries one) and a trigger: a `WAIVED` event without a document is refused unless the same person recorded a `WAIVE` or `REPLACE_WITH_NEW_ACTION` disposition of the action in the same transaction, which cites it. Every waiver still has its document; the direct waiver (1940) still writes it on the event.
- **Reader side, so rows already written are covered.** `authz.corrective_event_withheld(event)` is true when the event is one a disposition wrote before 2090 (same action, recorded by the disposition's author, one of the three types, carrying its reason as the note or its document as the reference) and the caller can see the action but not the case. `corrective_action_event_read` leaves such a row out for that caller, and `api.corrective_action_view` returns it to them with its note and reference null. The case team reads every row and every value as before. No event row is rewritten.
- The ledger event `CORRECTIVE_ACTION_DISPOSED` is unchanged: its reason is in the reason column, read by the case team and oversight, and its metadata carries no reason.
- UX's migration 2096 (P12-3b) replaces `api.corrective_action_view` and must keep the exclusion; it builds against this shape.

### 11. Reads, audit and grants

- Every new table has RLS enabled with a select policy only, no write grants, and append-only or decide-once triggers that hold even for the table owner.
- Audit events carry ids, codes and counts; every reason stays in its row.
- No permission or role grant changes. Replaced with narrowing-only changes, keeping their signatures: `authz.has_conflict` (§4, §5), `api.dispose_superseded_corrective_action` and `api.corrective_action_view` (§10); the `corrective_action_event_read` policy is narrowed (§10). Helpers and triggers are not executable by application roles; `authz.corrective_event_withheld` is executable by `authenticated` because the policy calls it, and answers false for anyone who cannot see the action.
- The catalogue: `CASE_SPLIT` is implemented; CASE_DETAILS, COMMITTEE_REGISTRY, MEETING_MINUTES, RECORDS_RETRIEVAL and DIRECT_REFERRAL name their new commands, delivered in 2090.

## Open questions and SOURCE_REQUIRED values

- When a case may be split (S090, S107): SOURCE_REQUIRED; the command is the narrowing default.
- Linking evidence into a split case after a need-to-know check (AMB-004): not built; it would grant access per item and waits for 2160 and a decision on who checks need-to-know.
- Suspending a proceeding automatically when a subject is untraceable: not built; the case team suspends it with the reason.
- Screens and read models for these commands: UX, Phase 12.
- Portal follow-ons for AGENT-02 (§4): the production notification sender re-checks the subject link before sending; what the wrong person still reads as a grievant.
- A minutes correction whose reviewer loses eligibility while it is in review (a conflict declared, for instance) can no longer be approved. A remaining reviewer can still reject it; once every remaining reviewer has approved, it stays in review, and with no withdrawal command it refuses further corrections to those minutes (`CORRECTION_IN_REVIEW`). It fails closed: the approved minutes stand unchanged. A withdrawal path waits for a decision (noted in security review).

## Consequences

- Duplicates are tied to their original, cases and allegations can be split, allegations withdrawn, subjects marked as placeholders, untraceable or deceased, and a wrongly identified person corrected, all without rewriting a record or widening anyone's access.
- Closing a case as `DUPLICATE` now needs the link to the original first (one 2060 test updated).
- A disposition's `WAIVED` event no longer carries the replacement decision's document; the disposition does (one 2030 test updated, §10). An action owner outside the case team reads an event a disposition wrote before 2090 only through the view, without its note and reference.
- The allegation status gains a value and the `SUSPENSION_REASON` dimension gains `SUBJECT_UNTRACEABLE` (contracts and i18n updated). Nothing is renamed or removed (DEC-35).
- PRODUCTION_SUBSTITUTION_REQUIRED: the privacy incident hand-off (§4); case numbering uses `CDF-DEMO` in this synthetic build (§5).
- An adoption's defence-notice check leaves out a superseded allegation, as a withdrawn one, from migration 2092 (ADR-059, CDF-236): its successors carry the requirement.
- A subject correction is also refused with `ALLEGATION_HAS_FINDINGS` while an open allegation about the wrong subject carries any finding, whoever it names (`SUBJECT_HAS_FINDINGS` is answered first), from migration 2099 (CDF-247): as after a split, no superseded allegation carries a finding.
- A withdrawn allegation's findings stay with it (§2) but are put to no vote and no legal review, from migration 2099 (CDF-247): `api.open_vote_item`, `api.request_legal_review` and `api.approve_restricted_legal_review` refuse such a finding with `ALLEGATION_WITHDRAWN`, as R1 (2060) already leaves it out and CDF-213 refuses an item naming the allegation. Tests: `tests/security/findings-closed-allegations-2099.spec.ts` and the DEC-F20 block of `recommendations-authority.spec.ts`.

## Production mapping

Tables, triggers and functions in PostgreSQL; they move to RDS PostgreSQL unchanged. The privacy incident record is handed to the CDF privacy incident process in production. No new service.

## Tests

- `tests/security/case-structure-2090.spec.ts`:
  - Links: T-AMB-002 (no link row, no case and NOT_FOUND for the case team of either case; the event names the type only); typed, one of a type, one original, ended once, never deleted; DUPLICATE closure needs the link on the direct path, at filing and at approval.
  - Allegations: withdrawal (status, reason, nothing new hangs off it, immutable); content immutable while open; split (refusals, successors with provenance, evidence links by reference, superseded original); with findings, or in a recommendation.
  - Subject status: notices and portal links only for IDENTIFIED; findings still recorded; `SUBJECT_LINKED`; untraceable suspension reason; DECEASED refused on a sanction item.
  - Correction: T-AMB-014 (every notice path NOT_FOUND for the former holder; records added, not rewritten; the privacy incident read by security monitoring and the case team only, ids and counts only; still conflicted; MISIDENTIFIED final); refused with findings; no incident without a notice.
  - Split: T-AMB-003 (classification, link, team, re-created subjects and allegations, no evidence; a member assigned only to the new case sees nothing of the source); a restricted case's split keeps its classification, restriction and owner, and its viewers are within the source's (a grant on the source is not carried); conflicts across the family both ways; the family's fast path equal to the full walk, and every conflict answer equal to the walk's, on split (a chain, both directions) and unsplit cases; an inactive account not carried; FORBIDDEN without `CASE_CREATE`.
  - Referral versions; T-AMB-023 (membership annotation, snapshots unchanged, `SELF_CORRECTION`); AMB-091 pinned; T-AMB-054 (correction review, approved version unchanged, case team reads only an approved correction); records annotation; helpers internal.
- `api-idor.spec.ts`: probes for the ten case-scoped functions with eight outsiders; `annotate_committee_membership` joins the administrative commands.
- `audit-bypass.spec.ts`: walk steps for the eleven commands.
- `recommendations-authority.spec.ts` (CDF-227, §10): the three events carry neither the reason nor the document and the dispositions keep both; with events written as 2030 wrote them, every value of the owner's view and of the owner's table read is walked and holds neither, while the history is complete; the case team reads every row and value; no row rewritten; a non-`WAIVED` event with a document and a `WAIVED` event with no document and no disposition are refused.
- Updated: `case-closure-2060.spec.ts` (the DUPLICATE closure links the case first); `recommendations-authority.spec.ts` (the disposition's `WAIVED` event carries no document; the disposition does). The catalogue tests and the policy snapshot.

## Requirements

AMB-003, AMB-004, AMB-008, AMB-027, AMB-032, AMB-033, AMB-045, AMB-091, AMB-093, AMB-223; T-AMB-002, T-AMB-003, T-AMB-014, T-AMB-023, T-AMB-054; catalogue S052, S090, S107, T1-B1.5-165; ADR-005; CDF-196, CDF-227.
