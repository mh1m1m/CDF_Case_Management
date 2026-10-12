# ADR-024: Grievance proceedings, employee defence and the independence firewall

- **Status:** Proposed (2026-10-12). Linear CDF-193, CDF-194.
- **Protocol:** §19–§22, §39, §87; owner Q&A Q37, Q45–Q46, Q90–Q96.

## Decision

1. A grievance is a GRIEVANCE proceeding inside the same case, LINKED to a decision or STANDALONE; a grievance with no prior case creates a case with `source_type = DIRECT_GRIEVANCE` (Q91).
2. Channels: EMPLOYEE_PORTAL, EMAIL, PHYSICAL, SECRETARY_ENTRY, BCP_IMPORT, OTHER, with the original received date preserved. The Grievance Committee Secretary receives it first (Q92) and records formal admissibility; the deciding party is configurable (SECRETARY / CHAIR / COMMITTEE) (Q93).
3. Window: 30 days by default, effective-dated in the GC rule set; late filings are flagged LATE_GRIEVANCE, not silently rejected (Q94).
4. Outcomes are combinable (UPHOLD, AMEND_SANCTION, CANCEL_SANCTION, REINVESTIGATE, REFER_TO_AUTHORITY, OTHER) (Q95). Reinvestigation can go to the same IC, a new team, a new or external investigator, or a technical investigation (Q96).
5. **Firewall:** anyone who held a voting seat in an IC proceeding of the case cannot hold a voting GC seat in that case's grievance; they may be invited as WITNESS / EXPERT / INFORMATION_PROVIDER (Q45–Q46). Enforced at snapshot creation and in `authz.can_participate_meeting`.
6. Employee notices are content-minimal; the subject submits defence via the employee portal or the Secretary uploads it; each subject has their own path in multi-subject cases (Q90).

## Implementation notes (migration 1910)

- Schema `grievance`: `subject_portal_link`, `defence_notice`, `defence_notice_item`, `defence_response`, `grievance`, `admissibility_assessment`, `grievance_outcome`. All RLS-enabled, read-only to `authenticated`, written only by `api.*` commands that audit in the same transaction.
- **Defence (Q90).** The case team links a subject to an employee account (`api.link_subject_portal_account`; never a case-team member, one active link per subject, revocable). A notice snapshots only that subject's allegations. The subject reads their own notices through `api.my_defence_notices()` and the defence tables' RLS (`authz.is_portal_subject`), acknowledges and responds through the portal; the issuer records responses from other channels with the original date and a document reference. Responses are append-only and flagged late after the due date. The subject never gains case access.
- **Grievance intake (Q91–Q92, Q94).** The grievant files from the portal against their own linked subject (`api.file_grievance`), or the Grievance Committee Secretary records it (`api.record_grievance`): LINKED by case number (an unknown and an uncleared number answer alike) or STANDALONE, which opens a new `DIRECT_GRIEVANCE` case with a named owner. The GC rule set in force on the original submission date is stored with the grievance; lateness is a flag (`is_late`), never a rejection. One open grievance per subject link.
- **Admissibility (Q93).** The secretary assesses; when the stored rule names SECRETARY the assessment decides, otherwise the grievance waits for the CHAIR (chair or deputy chair, case gate) or for a COMMITTEE decision with its decision reference. The assessment is internal: the grievant cannot read it (`authz.can_view_grievance_assessment`).
- **Admission opens the GRIEVANCE committee proceeding** through `committee.open_committee_proceeding`, so the N9 firewall snapshot and the case gate apply exactly as for any referral: an Investigation Committee voter of the case becomes a non-voting, firewall-restricted member and is not invited to meetings.
- **Outcomes (Q95–Q96).** `api.record_grievance_outcome` needs a CLOSED, APPROVED vote item of the grievance's proceeding, used once. Outcomes combine unless they contradict (UPHOLD or REJECT_ON_MERITS with MODIFY, CANCEL, PARTIALLY_ACCEPT or RETURN_FOR_REINVESTIGATION; MODIFY with CANCEL); INADMISSIBLE is only an admissibility decision. RETURN_FOR_REINVESTIGATION names a path and opens a REINVESTIGATION proceeding whose parent is the grievance proceeding.
- Attachments are document references until evidence registration (UX S2) merges. Notices to employees will be sent by the notification engine (phase 8) without case content. `PRODUCTION_SUBSTITUTION_REQUIRED`: the employee portal account uses the prototype identity provider; production uses the CDF corporate IdP.
- Tests: `tests/security/grievance-defence.spec.ts`, the grievance IDOR probes and the audit walk; `isLateGrievance` and `grievanceOutcomesValid` in `@cdf/domain`.

## Requirements

Q37, Q45–Q46, Q90–Q96; negative test N9.
