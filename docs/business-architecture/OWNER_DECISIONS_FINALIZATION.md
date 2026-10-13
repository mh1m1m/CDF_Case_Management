# Owner Decisions: Finalization Set (DEC-F01 to DEC-F41)

> SYNTHETIC-DATA REFERENCE IMPLEMENTATION. This is the owner's authoritative answer, given on 2026-10-13 (02:54 UTC, in the rebase project thread), to the owner-decision list in the rebase final report (section 4). It is binding and is not to be asked again. Where a decision leaves a value `SOURCE_REQUIRED`, the system keeps a configurable default and the marker until an authoritative CDF source is supplied. How each decision is applied is recorded in ADR-040 (`architecture/adr/ADR-040-owner-finalization-decisions.md`).

The decision text below is the owner's, lightly reformatted.

## 1. Meetings and voting

- **DEC-F01: voting rule.** Simple majority of substantive votes cast: `APPROVE > REJECT`. `ABSTAIN`, `ABSENT`, `RECUSED` and `UNABLE_TO_VOTE` count as neither approve nor reject. Quorum is evaluated independently before a vote may become valid. The Chair has one ordinary vote and, where the applicable committee rule enables it, one additional casting vote, only in a tie. Committee-specific rules stay configurable and effective-dated.
- **DEC-F02: public-holiday calendar.** Never hard-code a holiday calendar as a permanent business rule. Business-day calculations use a configurable calendar service or table. Until an authoritative CDF calendar source is connected, the calendar is `SOURCE_REQUIRED`. Saudi public holidays and CDF-specific non-working days must be administrable without code changes.
- **DEC-F03: casting vote when the Chair is absent.** Casting-vote authority follows the effective committee seat and rule configuration. Default order:
  1. the Chair, if participating and eligible;
  2. the Deputy Chair acting as Chair, if formally activated for that meeting and the committee rule grants the acting Chair casting-vote authority;
  3. otherwise no casting vote is available, and the vote stays unresolved (tied) for further committee handling.

  Never transfer the casting vote automatically to the Secretary.

- **DEC-F04: conflict raised by another participant.** The Chair decides by default. If the Chair is the subject of the conflict, conflicted, absent or otherwise ineligible, the Deputy Chair decides, if eligible. If no eligible Chair or Deputy exists, the matter goes to the configured independent conflict authority. The person whose conflict is assessed never decides their own case. The rule stays configurable and effective-dated.
- **DEC-F05: hearing the subject of a conflict concern.** There is no automatic entitlement to a separate hearing solely because a conflict concern was raised. The assessor may request clarification or evidence where necessary. Do not create a mandatory hearing workflow unless governing policy requires it.

## 2. Witnesses and hearings

- **DEC-F06: excluding the subject or legal counsel.** Keep the fail-safe default `NO EXCLUSION` unless an authoritative legal or policy basis is configured for a specific hearing type. Any exception rule is `SOURCE_REQUIRED`. Do not create discretionary exclusion powers without an approved source.
- **DEC-F07: excluded witness access.** An excluded witness loses access to meeting logistics, packet materials and later meeting content, unless a separate purpose-bound entitlement exists. They keep only the information needed for a separately authorized action directed to them.

## 3. Direct referral

- **DEC-F08: maximum delegation period.** Delegation is always time-bound, but no maximum is invented: `MAX_SECTOR_APPROVAL_DELEGATION_DAYS = SOURCE_REQUIRED`. Every delegation requires effective-from, effective-to, delegator, delegate, scope, supporting evidence and an audit trail.
- **DEC-F09: second rejection.** A second rejection does not permanently close the referral. The originating sector may revise and resubmit again, or raise a formal objection or escalation. The system visibly offers the escalation or objection path after repeated rejection. No hard maximum on resubmissions unless policy later requires one.
- **DEC-F10: preliminary closure for infeasibility or lack of personal jurisdiction.** Not enabled as standalone preliminary closure outcomes until their authority and definitions are confirmed. Keep current behaviour, marked `SOURCE_REQUIRED`. The architecture may support configurable future outcomes without exposing them to users yet.

## 4. Decisions, sanctions and legal review

- **DEC-F11: sanction legal bases.** No legal bases are invented in code. The sanction catalogue supports legal basis, internal policy basis, effective dates, authority rule and legal-review requirement. The actual mappings stay `SOURCE_REQUIRED` until validated against applicable Saudi law, CDF work regulations, approved internal policies and the delegation framework.
- **DEC-F12: when legal review is required.** At minimum: disciplinary recommendations where the configured rule requires it; litigation or legal action; matters requiring legal justification; any item deliberately referred to Legal by the Committee Secretary or an authorized owner. The list is not exhaustive. Rules are configurable and effective-dated.
- **DEC-F13: authority rules beyond disciplinary sanctions.** The CEO is not hard-coded as universal authority. Build `ACTION / RECOMMENDATION TYPE → AUTHORITY RULE` with effective dates. Known disciplinary authority may be configured; every other mapping without an approved source stays `SOURCE_REQUIRED`.

## 5. Defence and grievances

- **DEC-F14: grievance window.** Default 30 days, configurable and effective-dated.
- **DEC-F15: when the grievance clock starts.** Not decision issuance. `GRIEVANCE_WINDOW_START = EFFECTIVE_NOTIFICATION / DELIVERY`: the clock starts when the employee is formally notified of, or delivered, the decision. Acknowledgement, where captured, is kept as evidence but is not required to start the period unless an authoritative rule says so. If the governing CDF rule states otherwise, configuration overrides this decision.
- **DEC-F16: rule changes after a window has started.** Keep current behaviour: a rule change does not retrospectively alter a grievance period that has already started. The applicable rule version is snapshotted when the window begins.
- **DEC-F17: default grievance admissibility decider.** The Secretary performs and records the initial admissibility assessment operationally, but is not automatically the substantive authority. The final admissibility authority is configurable as Secretary, Chair, Committee or external authority. Default for substantive rejection or non-admission: `COMMITTEE`, unless an authoritative committee rule says otherwise.
- **DEC-F18: defence response period.** Configurable; the actual duration is `SOURCE_REQUIRED`. No fixed CDF period is invented. Support default duration, extensions, suspension, rescheduling, late response, reason and audit.

## 6. Restricted cases: legal review and committee referral

- **DEC-F19: referral of a restricted case to the Investigation Committee.** Restricted or SECRET cases may be referred only after explicit approval by the case's Restricted Case Authority. After approval, only active, adequately cleared, conflict-free committee seats are snapshotted. Uncleared participants cannot discover the case, receive notifications, view the packet, attend, deliberate or vote. Policy value `AUTHORITY_APPROVAL_AND_CLEARED_SEATS`.
- **DEC-F20: legal review of a restricted case.** Each legal-review request on a restricted or SECRET case needs explicit Restricted Case Authority approval: request-specific, single-use, purpose-bound and audited. The named legal reviewer must still be adequately cleared, conflict-free and actively authorized. Any material expansion of packet scope needs renewed approval. Policy `AUTHORITY_APPROVAL_PER_REQUEST`.

## 7. Export

- **DEC-F21: export purpose catalogue.** A governed, configurable catalogue rather than free text only. Initial categories may include: committee proceeding; legal review; competent-authority decision; internal management review; records requirement; regulatory or external authority; authorized business need; other (justification required). The final list is administrable reference data.
- **DEC-F22: approved external domains.** None invented: `APPROVED_EXTERNAL_DOMAINS = SOURCE_REQUIRED`. Manual external addresses stay possible only through the governed external-email workflow.
- **DEC-F23: restricted-case external export.** Restricted Case Authority approval stays mandatory. Fail closed.
- **DEC-F24: export approval deadlock.** Separate policy administration (`EXPORT_POLICY_ADMIN`) from transaction approval (`EXPORT_SECOND_APPROVE`). A user never second-approves their own export: `REQUESTER ≠ SECOND_APPROVER`, with a configurable approval pool. If no independent eligible approver exists, fail closed and surface an administrative configuration warning. Never solve it by permitting self-approval.

## 8. Corrective actions

- **DEC-F25: due periods.** No universal fixed due period. A due date is required and chosen per action. Configurable defaults by corrective-action type; actual defaults `SOURCE_REQUIRED`.
- **DEC-F26: reminders and escalation.** Configurable reminder cadence, overdue threshold, escalation path and escalation recipients. No CDF values hard-coded before policy confirmation.
- **DEC-F27: completion evidence.** Completion requires supporting evidence where the action's configuration marks evidence as required. Evidence types may include document, revised procedure, screenshot or system evidence, training evidence, control evidence, other authorized artifact.
- **DEC-F28: owner.** The owner may be an internal user, an organizational unit, an authorized shared pool, or an external party where applicable. Assignment stays explicit and auditable.
- **DEC-F29: waiver.** Not active until an authorized waiver role or rule is configured. Stays fail closed: `CORRECTIVE_ACTION_WAIVE = SOURCE_REQUIRED`.

## 9. Business continuity workbook

- **DEC-F30: authorized continuity users.** Never inferred from broad system roles. An explicit `BCP_CONTINUITY_OPERATOR` entitlement or approved continuity-user registry; membership needs explicit authorization and audit. The named population is administrative configuration.
- **DEC-F31: staged-cell retention.** Not invented: `BCP_STAGING_RETENTION = SOURCE_REQUIRED`, configurable. After expiry, staging data follows secure deletion or disposition rules while required audit metadata is kept.

## 10. Catalogue and rationalization

- **DEC-F32: conflicting legacy status codes.** No catalogue is chosen arbitrarily. A conflict register identifies all 10 conflicting codes and their competing definitions. The 100-Q&A and approved business architecture take precedence where they resolve the semantics; otherwise `SOURCE_REQUIRED`. No conflicting code is authoritative merely because it appears first.
- **DEC-F33: S099 «تجميد قانوني».** Keep `S099 → LEGAL_HOLD` unless an authoritative source distinguishes a separate concept. Legal hold blocks disposition and destruction but does not by itself make the case invisible or halt every operational step, unless an applicable hold instruction says so.
- **DEC-F34: retiring WB-FRM artifacts.** No legacy WB-FRM artifact is retired until: (1) a replacement structured domain object exists; (2) a historical mapping exists; (3) a generated or document equivalent exists where needed; (4) migration and reporting compatibility is documented; (5) no active workflow depends on the old artifact. No form is retired solely because the new UX is better.
- **DEC-F35: DEC-35 option codes.** Keep configuration placeholders until the authoritative meanings and options are recovered: `SOURCE_REQUIRED`. Do not infer codes from similarly named statuses.

## 11. Notifications

- **DEC-F36: email provider.** The provider stays behind the existing port and adapter; no vendor hard-coded. The stub may remain. Final CDF mail relay or provider: `PRODUCTION_SUBSTITUTION_REQUIRED` until infrastructure supplies the approved endpoint and credentials.

## 12. P11-G4 evidence half

- **DEC-F37: proceed.** Build the evidence half now that #55's evidence commands are on main, under the next coordinator-assigned migration number. Preserve evidence authorization, provenance, chain of custody, immutable versions, audit and purpose-bound access.

## 13. P11-G7 case conflict access

- **DEC-F38: upheld conflict on the case itself.** An upheld conflict affecting a user's participation suspends that user's ordinary case-content access for the conflicted purpose. It does not necessarily remove unrelated lawful access from a separate, independently authorized purpose. Access is purpose-scoped: `CONFLICT → REVOKE/SUSPEND AFFECTED PURPOSE GRANTS`, never `CONFLICT → DELETE USER`. For committee participation the restriction is absolute for the affected proceeding or meeting: no packet, no attendance, no deliberation, no vote.

## 14. P11-G2 case closure

- **DEC-F39: case outcome.** The case carries a structured final outcome, separate from lifecycle status, drawn from configuration or reference data rather than free text only. It coexists with subject-level outcomes, allegation-level findings, sanctions, corrective actions and grievances.
- **DEC-F40: closure authority.** No single named closer. The operational case owner or an authorized role initiates closure; where the configured Delegation of Authority requires it, closure is routed for approval. Until the CDF DoA mapping is confirmed, `CASE_CLOSURE_APPROVAL_RULE = SOURCE_REQUIRED`. Supported paths: direct authorized closure, maker/approver closure, returned closure request. Closure never proceeds while mandatory actions remain open, unless through an explicitly authorized conditional or staged closure path.

## 15. P11-G3 preliminary corrective action

- **DEC-F41: corrective action from preliminary review.** The architecture may let a corrective action originate from preliminary Compliance review, but not automatically for every preliminary case: only where the configured business rule permits. The preliminary team may recommend a corrective action without escalating to the Investigation Committee where the matter needs no committee investigation or disciplinary action. Any authority or approval requirement for the action follows its corrective-action type. Configurable and auditable.

## Implementation instruction (owner)

Apply these decisions without redesigning already-cleared security primitives. For each decision: map it to the relevant ADR; update `SOURCE_REQUIRED` markers where resolved; keep unresolved source-dependent items explicit; create or update tests; update the final report and phase dashboard; reconcile the relevant Linear issue; and keep the Phase 12 UX assumptions consistent with these decisions.

Then, in order: hosted DEV validation for migrations 1830–2010; P11-G4 evidence half; P11-G2, P11-G3 and P11-G7 as enabled above; Phase 12 screens; final UX re-audit. The final UI stays work-led, case-homed, purpose-bound and guided by design.
