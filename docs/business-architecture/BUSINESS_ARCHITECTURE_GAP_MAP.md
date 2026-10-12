# Business Architecture Gap Map (current → target)

> **Classification:** SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Not CDF production, not a regulatory certification, not final HR or legal conformance.
> Alias: `CURRENT_TO_TARGET_GAP_MAP.md` (playbook name). Inputs: the rebase meta-prompt, the 100-question owner Q&A, the implementation playbook, the CRM status catalogue (150 statuses) and the CRM forms document. The 274-item form catalogue is **SOURCE_REQUIRED** (not found in Drive, project files or the repository).
> Inspected baseline: `main` at migration `20261007001810`; local `pnpm test:db` 402/402 passing.

## Classification legend

| Code              | Meaning                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------- |
| KEEP              | Fits the target as is.                                                                       |
| EXTEND            | Fits; needs additive columns, rows or commands.                                              |
| REFACTOR          | Behaviour is right but its shape must change (non-destructive, compatibility kept).          |
| REPLACE           | A new structure supersedes it; the old one is kept read-only until a human-approved cutover. |
| MIGRATE           | Data or reference values move to a new structure via an additive backfill.                   |
| DEPRECATE         | Kept working, no new use, removal needs a human decision (§88).                              |
| NEW               | Does not exist today.                                                                        |
| BLOCKED_BY_POLICY | Design is ready; the governing CDF value or rule is not supplied.                            |
| SOURCE_REQUIRED   | A source document is missing; the value is configurable and flagged.                         |

## 1. Intake and case formation

| Area                          | Current (evidence)                                                                    | Target                                                                                                                                                                                                                                       | Class            | Phase |
| ----------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----- |
| Whistleblowing portal         | `intake.report`, `public_api.submit_report`, HMAC secret, rate limit (ADR-004, §23)   | Unchanged; becomes intake path `WHISTLEBLOWING`.                                                                                                                                                                                             | KEEP             | –     |
| Case source                   | `case_record.case_type`; every case comes from a report via `create_case_from_report` | `case_record.source_type` = WHISTLEBLOWING / DIRECT_REFERRAL / DIRECT_GRIEVANCE / OTHER_AUTHORIZED_SOURCE; backfill WHISTLEBLOWING; `case_type` kept.                                                                                        | EXTEND + MIGRATE | 2     |
| Direct referral by sector     | None. `REFERRER` role exists with no command path.                                    | `intake.referral` + history; preparer → sector head (or delegate) → IC Secretary ACCEPT / RETURN_FOR_COMPLETION / REJECT; resubmission and objection.                                                                                        | NEW              | 4     |
| Sectors and sector heads      | None (`iam.user_profile` has no org unit).                                            | `iam.sector`, `iam.sector_membership` (HEAD/MEMBER), `iam.sector_delegation` (REFERRAL_APPROVAL, effective-dated, evidence).                                                                                                                 | NEW              | 4     |
| Preliminary Compliance review | `SCREENING` / `TRIAGE` / `JURISDICTION` states with `report_triage`                   | A `PRELIMINARY_REVIEW` proceeding per whistleblowing case: preparer (investigator / Compliance Section Manager / GRC Director), Director review (no self-review), GRC Sector Head approval, structured return reasons, configurable routing. | REFACTOR + NEW   | 4     |
| Direct grievance intake       | None                                                                                  | Grievance proceeding inside a case (standalone case with `source_type = DIRECT_GRIEVANCE`).                                                                                                                                                  | NEW              | 7     |

## 2. Case structure

| Area                  | Current                                                              | Target                                                                                                                                                                                                                               | Class         | Phase |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ----- |
| Case record           | `case_mgmt.case_record` (UUID + `CDF-…` number, classification)      | Kept as the container. Gains `source_type`.                                                                                                                                                                                          | KEEP + EXTEND | 2     |
| Proceedings           | None; one `workflow_instance` per case                               | `case_mgmt.proceeding` (PRELIMINARY_REVIEW, INVESTIGATION, COMMITTEE_INVESTIGATION, LEGAL_REVIEW, AUTHORITY_DECISION, GRIEVANCE, REINVESTIGATION, CORRECTIVE_ACTION) with parent link, status, waiting / suspension reason, outcome. | NEW           | 2     |
| Subjects              | `case_person` with role SUBJECT (no category, no allegation linkage) | `case_mgmt.case_subject` (person, category EMPLOYEE / CONTRACTOR / OTHER_AUTHORIZED, sector).                                                                                                                                        | NEW           | 2     |
| Allegations           | `case_mgmt.allegation` (case-level)                                  | Gains `subject_id`, policy / law reference, status kept.                                                                                                                                                                             | EXTEND        | 2     |
| Findings              | Free text in workflow comments / forms                               | `case_mgmt.finding` per allegation × subject (SUBSTANTIATED / NOT_SUBSTANTIATED / PARTIALLY / INCONCLUSIVE).                                                                                                                         | NEW           | 2     |
| Evidence ↔ allegation | Evidence belongs to case only                                        | `case_mgmt.evidence_link` (evidence → allegation / finding). Does not touch `authz.can_view_evidence` (S2).                                                                                                                          | NEW           | 2     |
| Multi-subject cases   | Possible as data, not modelled                                       | First-class (subjects, allegations, findings, recommendation scope).                                                                                                                                                                 | NEW           | 2     |

## 3. Workflow and status

| Area                      | Current                                                             | Target                                                                                                                                                       | Class              | Phase |
| ------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ----- |
| Workflow engine           | Data-driven `workflow.*` (ADR-007), CDF_CASE_V1, 15 linear states   | Engine kept. One workflow instance per **proceeding**; case stage derived. CDF_CASE_V1 stays for existing cases.                                             | KEEP + EXTEND      | 2–6   |
| Post-investigation states | `FINDINGS` … `CORRECTIVE_ACTION` transitions exist but are disabled | Replaced by committee, recommendation, legal review and authority decision proceedings.                                                                      | REPLACE            | 5–6   |
| Status vocabulary         | 15 states; CRM catalogue has 150 statuses                           | Multi-dimensional status (stage, proceeding status, waiting reason, suspension reason, flags, outcome, legal, records). See `CRM_STATUS_RATIONALIZATION.md`. | REFACTOR + MIGRATE | 11    |
| Legacy status mapping     | None                                                                | `config.legacy_status_map` (150 rows) for BCP import and reporting.                                                                                          | NEW                | 10–11 |
| SLAs                      | `config.setting` placeholders                                       | Effective-dated rule sets per committee; business-day calendar SOURCE_REQUIRED.                                                                              | EXTEND             | 5     |

## 4. Committees, meetings, voting, minutes

| Area                  | Current                                                      | Target                                                                                                                                                                                                                    | Class                | Phase |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----- |
| Committee registry    | None. Roles COMMITTEE_CHAIR / MEMBER / SECRETARY are global. | `committee.committee` (INVESTIGATION, GRIEVANCE), formations, seats.                                                                                                                                                      | NEW                  | 2     |
| Membership            | Global role assignment                                       | `committee.membership` effective-dated per seat (CHAIR, DEPUTY_CHAIR, SECRETARY, ALTERNATE_SECRETARY, MEMBER, ALTERNATE_MEMBER). Global roles become capability hints only.                                               | REPLACE (roles kept) | 2–3   |
| Rule sets             | `COMMITTEE_QUORUM` setting, SOURCE_REQUIRED                  | `committee.rule_set` effective-dated: quorum type/value, casting vote, minutes window (3 business days), deemed approval, grievance window (30 days), admissibility decider.                                              | MIGRATE + NEW        | 2     |
| Committee proceeding  | `COMMITTEE` workflow state; COMMITTEE grant scope            | `committee.committee_proceeding` with immutable member and rule snapshots.                                                                                                                                                | NEW                  | 5     |
| Meetings              | None                                                         | `committee.meeting` IN_PERSON / TEAMS / HYBRID, agenda, invitees, `MeetingProvider` port (manual URL; M365 adapter PRODUCTION_SUBSTITUTION_REQUIRED).                                                                     | NEW                  | 5     |
| Conflict of interest  | `case_mgmt.conflict_check` per case                          | Kept for case staff. Adds per-meeting `meeting_conflict_declaration` (PENDING / NO_CONFLICT / CONFLICT_DECLARED) enforced in the DB.                                                                                      | KEEP + NEW           | 5     |
| Attendance and quorum | None                                                         | `attendance` with source and original event time; quorum computed from non-conflicted eligible members.                                                                                                                   | NEW                  | 5     |
| Voting                | None                                                         | `vote_item` (target: finding / recommendation / sanction / corrective action / package / final package), `vote`, separate casting vote, secrecy until close, secretary may record only ABSENT / UNABLE_TO_VOTE / RECUSED. | NEW                  | 5     |
| Minutes               | None (WB-FRM forms only)                                     | Generated snapshot + narrative, member review, DEEMED_APPROVED after the window.                                                                                                                                          | NEW                  | 5     |

## 5. Recommendations, legal review, authority decisions

| Area                   | Current                                                         | Target                                                                                                                                | Class                 | Phase |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----- |
| Recommendation package | None                                                            | `decision.recommendation_package` + items (9 types) scoped to subjects / allegations / case.                                          | NEW                   | 6     |
| Sanction catalogue     | None                                                            | `decision.sanction_catalogue` governed; free text → PROPOSED_UNVERIFIED. Legal basis SOURCE_REQUIRED.                                 | NEW + SOURCE_REQUIRED | 6     |
| Legal review           | `LEGAL_REVIEWER` role, REVIEW grant scope                       | Purpose-bound legal review request with secretary-selected packet items; opinion; conflict returns to committee, both preserved.      | REFACTOR + NEW        | 6     |
| Competent authority    | `FINAL_DISCIPLINARY_AUTHORITY` setting, DECISION_AUTHORITY role | Configurable `authority_type` + `action_authority_rule`; decision recorded by Secretary with source document (Q82, no maker-checker). | MIGRATE + NEW         | 6     |
| Corrective actions     | `CORRECTIVE_ACTION` state (disabled), IMPLEMENTATION_OWNER role | `decision.corrective_action` with owner, due date, evidence of completion.                                                            | NEW                   | 6     |

## 6. Grievance and employee defence

| Area                        | Current                                   | Target                                                                                                                                                    | Class | Phase |
| --------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----- |
| Grievance                   | None                                      | Grievance proceeding (LINKED / STANDALONE), 6 channels, admissibility (configurable decider), 30-day window, combinable outcomes, reinvestigation routes. | NEW   | 7     |
| Independence firewall       | None                                      | DB predicate: an IC decision-making member on the case cannot hold a voting GC seat on that case's grievance.                                             | NEW   | 7     |
| Employee notice and defence | None                                      | `employee_notice`, `defence_submission` via portal or secretary upload.                                                                                   | NEW   | 7     |
| Employee portal             | None (whistleblowing portal is anonymous) | Authenticated employee surface inside investigation-web (separate route group), subject sees only own notices.                                            | NEW   | 7     |

## 7. Cross-cutting

| Area                  | Current                                                                      | Target                                                                                                                                       | Class           | Phase |
| --------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----- |
| Authorization         | `authz.*` role + grant + task + records catalogue (ADR-014, ADR-016)         | Adds committee-seat, meeting, packet and sector predicates. Global committee roles stop implying access.                                     | EXTEND          | 3     |
| Grant scopes          | TRIAGE / CASE / COMMITTEE / REVIEW / AUDIT; `has_active_grant` ignores scope | COMMITTEE scope satisfied by proceeding membership; REVIEW by legal packets. Scope enforcement per DEC-02.                                   | REFACTOR        | 3     |
| Purpose-bound packets | Records catalogue items, break-glass                                         | Snapshot packets for legal, authority, grievance, export (ADR-031). Evidence-in-packet waits for S2 merge.                                   | NEW             | 6     |
| Audit                 | `audit.record_event` hash chain                                              | New domain events (REFERRAL_CREATED … BCP_IMPORT_COMPLETED), same ledger.                                                                    | KEEP + EXTEND   | 2–10  |
| Notifications         | None (only email-less in-app hints)                                          | `notify` schema: 4 layers, IN_APP + EMAIL, content-minimal outbox; `NotificationSender` port.                                                | NEW             | 8     |
| Export / email        | None                                                                         | `exchange` schema: export request, items, preview, per-object authz, justification, configurable second approval.                            | NEW             | 9     |
| BCP workbook          | None                                                                         | Portable workbook 00_README … 26_IMPORT_AUDIT, stable IDs, validate → diff → approve → transactional import, provenance.                     | NEW             | 10    |
| Forms                 | `forms.*` engine with WB-FRM-01..19 (ADR-011)                                | Kept as the user-form engine; 188 catalogue items rationalized into modules (see `FORM_CATALOGUE_RATIONALIZATION.md`).                       | KEEP + REFACTOR | 11    |
| Navigation / UX       | UX redesign S0–S2 (ADR-016)                                                  | Areas My Work / Intake / Cases / My Committees / Records / Oversight / Administration / Reporting; `CDFWorkflowGuide` + consequence preview. | EXTEND          | 12    |
| Records and retention | `records.*` (ADR-013/014), S2h retention queue in flight                     | Unchanged; proceedings and packets register into the catalogue.                                                                              | KEEP            | –     |

## 8. Policy and source gaps

| Item                                    | Class             | Default used                                        |
| --------------------------------------- | ----------------- | --------------------------------------------------- |
| 274-item form catalogue (12 tracks)     | SOURCE_REQUIRED   | Rationalization covers the 188 items available.     |
| Quorum rule per committee               | BLOCKED_BY_POLICY | MAJORITY_ELIGIBLE (owner default from Q&A).         |
| Business-day calendar (minutes window)  | SOURCE_REQUIRED   | Sun–Thu, no holiday table; configurable.            |
| Sanction legal basis per catalogue item | SOURCE_REQUIRED   | Codes seeded, `legal_basis` null and flagged.       |
| Competent authority per action type     | BLOCKED_BY_POLICY | DISCIPLINARY_SANCTION → CEO, flagged OWNER_DEFAULT. |
| Grievance window                        | OWNER_DEFAULT     | 30 days, effective-dated.                           |
| Retention periods                       | BLOCKED_BY_POLICY | ADR-016 D8; unchanged.                              |

## 9. What is not touched

The rebase does not modify any S2 function while the UX S2 PR is open: `api.my_work_items`, `authz.can_view_evidence`, `api.register_evidence_version`, `authz.can_download_report_attachment`, reporter conversation commands, `api.case_history` / roster, `assign_retention_class`. Nothing is dropped; no migration is destructive.
