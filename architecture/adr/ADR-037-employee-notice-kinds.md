# ADR-037: Kinds of employee notice, and the decision notice that starts the grievance window

- **Status:** Proposed (2026-10-12). Linear CDF-198 (Phase 11, gap P11-G5), CDF-193, CDF-194. Implemented in migration 1990 (local, pending security review). Amends ADR-024 and closes gap P11-G5 of ADR-035.
- **Protocol:** §19–§22, §29, §39, §87, §88; owner Q&A Q89, Q90, Q94; rebase prompt §53 (employee defence) and §58 (grievance window); ADR-023, ADR-024, ADR-025, ADR-035.

## Context

Migration 1910 gave each case subject one kind of notice, the defence notice: permitted allegations, a due date, an acknowledgement and a response. The rebase prompt says the employee also receives a rights notice and acknowledges notices (§53), and that the grievance window is 30 days by default, configurable and effective-dated (§58, Q94). The owner's catalogues name a rights notice at the start of an investigation (S092; T6-B1.1-036, T6-B1.1-121) and a decision notice that starts the grievance window (T11-B4.1-229, T4-B1.3-125). The baseline form WB-FRM-17 "Decision Notice" records the decision, the delivery and a grievance deadline. None of these could be told apart from a defence notice (ADR-035, gap P11-G5).

1910 measures a grievance from the contested decision date the grievant or the secretary gives, under the Grievance Committee rule set in force on the submission date. Nothing records when the employee was told of the decision.

## Decision

1. **A notice has a kind: RIGHTS, DEFENCE or DECISION.** `grievance.defence_notice.kind` defaults to DEFENCE, so every existing notice keeps its meaning and `api.issue_defence_notice` is unchanged. Only a defence notice has a due date (the not-null becomes a check by kind) and only a defence notice takes a response. A trigger on `grievance.defence_response` refuses the others, so the portal, the issuer's recorded response and the continuity import refuse alike, and a rights or decision notice can never be RESPONDED. Every kind is acknowledged with `api.acknowledge_defence_notice`. The kind and the decision fields never change once issued (the 1910 protect trigger covers the new columns).
2. **Rights notice.** `api.issue_rights_notice(subject, text, allegations)` tells the subject their procedural rights. The issuer may show allegations against that subject, or none, since the scope may be withheld at the start. Audit `RIGHTS_NOTICE_ISSUED`.
3. **Decision notice.** `api.issue_decision_notice(subject, authority_decision, text)` tells the subject a competent-authority decision (ADR-023) that concerns them.
   - The decision must be on the subject's case. A decision elsewhere, or none, answers `INVALID authority_decision_id` alike.
   - An item the committee approved must name the subject, or apply to the whole case (Q89).
   - A decision that returns the package to the committee is not notified (`DECISION_NOT_FINAL`): the revised package gets its own decision.
   - One notice per subject and decision (`ALREADY_NOTIFIED`).
   - Audit `DECISION_NOTICE_ISSUED`.
4. **The decision notice starts the grievance window (Q94).** The notice stores three things from when it is issued: the Grievance Committee rule set in force, its window in days, and the moment the window ends. With no rule set, or one without a window, nothing is issued (`NO_RULE_SET`). The subject sees the end of the window with the notice (`api.my_defence_notices`), the baseline form's grievance deadline.
5. **A grievance on a decision notice is measured against that window.** `api.file_grievance_on_decision_notice(notice, grounds)` is the portal path for the subject behind the notice's active link; anybody else gets NOT_FOUND. It is LINKED and keeps `api.file_grievance`'s rules: through the portal, one open grievance per subject, received first by the Grievance Committee Secretary. The grievance stores the notice and takes the notice's rule set, window and admissibility decider. Its contested decision date is the authority's decision date. It is late when filed after the window ends, and late is a flag, never a refusal. A grievance filed without a notice (`api.file_grievance`, `api.record_grievance`) keeps 1910's rule.
6. **Who issues.** The same predicate and checks as a defence notice (`authz.can_manage_defence`, case visible, case ACTIVE). Like a defence notice, the command starts by checking that the caller can see the case, so in practice the people who edit the case issue it. A committee secretary who cannot see the case is answered NOT_FOUND, as for `api.issue_defence_notice`.
7. **Notifications (ADR-025).** Two mandatory templates, RIGHTS_NOTICE_ISSUED and DECISION_NOTICE_ISSUED (in app and by email), reach the subject only through the active portal link, with ids only. The defence notice keeps DEFENCE_NOTICE_ISSUED. The due-date reminder already skips notices without a due date.
8. **The catalogue follows (ADR-035).** S092 (both lists) maps to RIGHTS_NOTICE_ISSUED. The P11-G5 references are cleared, and the four control items name the command for their kind. The employee notice and grievance submission modules list the new commands and record 1990. The gap register marks P11-G5 closed.

## Consequences

- The three notices the catalogues name are each a command with its own audit event. The decision notice records the window it started, so a deadline told to the employee does not move when the rule changes afterwards.
- A grievance's lateness now has two sources: the notice's window when filed on a notice, the rule in force on the submission date otherwise. The grievance row says which (`decision_notice_id`).
- The data the finality flag needs (GRIEVANCE_FINALITY, FINAL_NOT_GRIEVABLE) now exists: a decision notice, the end of its window, and the grievances filed on it. The flag stays PLANNED: computing it, and guarding case closure with it, belong to the case-closure decision (gap P11-G2) the owner has not made.
- Known limitations:
  - A grievance received off the platform is still recorded by the secretary with the date they give. The secretary cannot see the notice, so it is not linked.
  - There is still no command to withdraw a notice of any kind (as in 1910).

## Production mapping

Columns, constraints, a trigger and functions in PostgreSQL; they move to RDS PostgreSQL unchanged. The employee portal account remains `PRODUCTION_SUBSTITUTION_REQUIRED` (prototype identity provider; production uses the CDF corporate IdP), as in ADR-024.

## Open questions (SOURCE_REQUIRED)

1. From when does the grievance window run: from issue (the default here), from delivery to the employee, or from the employee's acknowledgement of receipt?
2. Does a change of the Grievance Committee rule set apply to a window already started? Here it does not: the notice's rule governs a grievance filed on it.

## Requirements

Owner Q&A Q89, Q90, Q94; rebase prompt §53, §58; FORM_CATALOGUE_RATIONALIZATION.md §6 (P11-G5); baseline form WB-FRM-17; CDF-198, CDF-193, CDF-194.
