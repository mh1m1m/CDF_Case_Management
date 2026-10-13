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

## 16. Ambiguity register: owner decisions DEC-AMB-001 to DEC-AMB-013

Given on 2026-10-13 (10:01 UTC, project timeline) on `OWNER_PACK.md` of the ambiguity register (PR #60). Every item takes the recommended option, and these decisions supersede the temporary fail-safe defaults. Fail-safes stay in place until the replacement rule and its negative tests are in the same migration. For DEC-AMB-012, the CDF-206 prohibition on lifting restriction stays until the two-person path is built and security-cleared. Placement: ADR-040 (2030, 2040), ADR-041 (2050), ADR-042 (2060), ADR-048 (2120), ADR-049 (2130).

- **DEC-AMB-001 → B.** Allow one reconsideration only where genuinely new evidence is presented. No unlimited grievance chain.
- **DEC-AMB-002 → B.** A closed case may be reopened by the applicable closure authority based on new evidence, with documented reason, approval, full audit trail, and retention recalculation.
- **DEC-AMB-003 → B.** If a conflict is discovered after a vote or decision, mark the affected item `TAINTED_BY_CONFLICT` and block downstream progression. The committee then determines whether a re-vote is required or the result may be confirmed. Confirmation is permitted only where the conflicted participation could not have changed the substantive result, with documented reasoning.
- **DEC-AMB-004 → C.** Grievance effect on sanction execution is configurable by sanction type. Irreversible or materially difficult-to-reverse sanctions remain suspended during the applicable grievance window and, if filed, until the grievance is resolved. Reversible sanctions may proceed according to the configured catalogue rule.
- **DEC-AMB-005 → B.** Permit access only to prior final disciplinary sanctions, through a purpose-bound extract initiated and managed by the Secretary. No unrelated case allegations, evidence, investigations, or full case history. Restricted-source cases remain subject to Restricted Case Authority controls.
- **DEC-AMB-006 → C.** Permit selected evidence through a purpose-bound Defence Packet, following review and redaction for reporter, witness, confidentiality, privilege, restricted information and other protected identities or content. This does not create general evidence access for the subject.
- **DEC-AMB-007 → A.** Committee meetings are not recorded. Approved minutes and associated structured meeting records are the official record. No Teams, audio or video recording functionality is enabled by default.
- **DEC-AMB-008 → B.** During an outage, substantive committee voting may use signed individual paper ballots. They are imported as provisional votes and must be confirmed by each relevant member through the platform after restoration before the vote becomes final. The Secretary may not cast `APPROVE` or `REJECT` on another member's behalf.
- **DEC-AMB-009 → A.** If a subject leaves employment during the case, continue the investigation through findings and recommendations. Applicable sanctions may be recorded but must not be shown as executable where the employment relationship no longer permits execution. Governance and corrective actions remain actionable.
- **DEC-AMB-010 → B.** An upheld conflict determination may be reversed by the next eligible decider in the DEC-F04 hierarchy, with documented reason and audit. Reversal applies prospectively to future meetings and actions only and does not retroactively validate participation in meetings from which the member was excluded.
- **DEC-AMB-011 → A.** A grievance outcome never makes the challenged disciplinary sanction more severe. It may uphold, reduce, modify in a non-more-severe manner, or cancel it. If genuinely new facts justify a potentially more severe sanction, that proceeds through the appropriate reinvestigation or new decision process with full due-process protections, not through the grievance.
- **DEC-AMB-012 → C.** Restricted status may be lifted only through two-person control: the case's Restricted Case Authority plus an independent second authorized approver. Require reason, audit, and a preview of the access population and permissions that would become available after declassification. No user may approve their own second approval.

DEC-AMB-013 was given on 2026-10-13 (14:40 UTC, project timeline) and confirmed as final at 14:43 ("remove it from future owner packs"). Placement: ADR-040 section 3 item 10, migration 2030 §3.10, with the downstream guards in 2040.

- **DEC-AMB-013 → A.** If a conflict of interest is discovered after the competent authority has already decided, and the conflicted member's participation could have changed the substantive voting result:
  1. Mark the affected vote/recommendation package `TAINTED_BY_CONFLICT`.
  2. Immediately block any further downstream action based on that decision.
  3. Reopen the affected committee decision round for a new vote excluding the conflicted member.
  4. Recalculate quorum and eligibility for the new round.
  5. Preserve the original vote, recommendation and authority decision as immutable historical records.
  6. After the committee completes the valid re-vote, submit the resulting recommendation/package to the competent authority for a new decision.
  7. The earlier authority decision is never edited or deleted; it is marked `SUPERSEDED`.
  8. Record the reason, conflict event, affected member, original result, new result, authority re-decision and complete audit lineage.
  9. No corrective action, sanction execution, decision notice or closure may proceed from the tainted decision while this remediation path is open.
  10. If the conflicted vote could not have changed the result, retain the existing DEC-AMB-003 confirmation path instead; do not force a re-vote unnecessarily.

  Do not route this through the ordinary closed-case reopening mechanism under DEC-AMB-002. This is remediation of a procedurally tainted decision chain, not a new-evidence reopening. Implement under migration 2030 with negative tests ensuring: a decisive tainted vote cannot be confirmed; a decided package can enter this controlled re-vote path only because of the validated conflict event; the conflicted member cannot participate; the prior authority decision remains immutable and is marked superseded only after the replacement decision; downstream execution remains blocked until the new authority decision is recorded.

  The three values that stay `SOURCE_REQUIRED` need governing sources, not design decisions: the sanction types suspended during a grievance, the sanction severity ranking, and the identity of the second approver for lifting restriction.

## 17. Phase 12 owner pack: DEC-04, DEC-05, DEC-11, DEC-12, DEC-13, DEC-18, DEC-19, DEC-22, DEC-36, DEC-48, DEC-49, DEC-51

Given on 2026-10-13 (14:43 UTC, project timeline) as "Approved owner decisions for the Phase 12 screens. Treat these as final owner decisions and remove them from the open-decision register once recorded." They replace the defaults the Phase 12 plan ran on. Placement: the UX thread's Phase 12 slices, migration 2150 (ADR-052: DEC-18, DEC-48, DEC-04 withdrawal) and migration 2160 (ADR-053: DEC-11, DEC-12, DEC-13, DEC-36); DEC-05, DEC-19, DEC-22, DEC-49 and DEC-51 apply to the screens and read models as built.

### S3

- **DEC-04: form RACI and withdrawal.** Preserve capability-based RACI rather than tying forms to generic job titles. For withdrawal:
  - `DRAFT` / not yet submitted: the authorized creator may withdraw/delete the draft according to normal draft handling.
  - Once formally submitted: do not hard-delete or erase the submission.
  - The originating authorized actor may submit a withdrawal request.
  - The system records: requested by; requested at; reason; current workflow state; approving/accepting authority where required.
  - Withdrawal does not erase prior audit history, submissions, approvals or evidence.
  - If a downstream governance proceeding has already materially begun, withdrawal of the source does not automatically terminate the proceeding.

  Keep access capability-driven and auditable.

- **DEC-05: four remaining S3 items.** Keep the four current rules/defaults already implemented unless one of them directly conflicts with a later confirmed owner decision, DEC-F decision, DEC-AMB decision, security invariant or purpose-bound access rule. Do not reopen them simply for Phase 12 UI work. If a genuine contradiction is discovered, raise only that specific contradiction rather than reopening DEC-05 as a whole.

- **DEC-19: snapshot vs reference in forms.** Use a hybrid model, with snapshot as the rule for decision-relevant data. At a material workflow event such as submission, approval, committee referral, vote opening, recommendation adoption, authority submission or final issuance, snapshot the data necessary to establish what the actor actually saw/approved at that moment. Live reference may remain for non-material current metadata where historical mutation cannot change the meaning of the completed action. Therefore `DECISION_RELEVANT_DATA = SNAPSHOT` and `NON_MATERIAL_REFERENCE_DATA = LIVE_REFERENCE_WHERE_SAFE`. Never allow later edits to silently rewrite the factual basis of a completed decision.

- **DEC-49: form gating and plan ownership.** Preserve today's workflow gates as the baseline, but ownership follows the business object/work item, not the legacy form. A form/component must not become an independent workflow owner simply because it exists in the catalogue. Use `CASE / PROCEEDING / TASK / ACTION OWNER → controls workflow`, not `FORM OWNER → controls workflow`. The 274-form catalogue remains a control catalogue, not a workflow-ownership model. Existing gates stay until explicitly replaced by a confirmed business rule.

### S4

- **DEC-22: My Work row fields.** Approve the proposed privacy-minimised design. A My Work row may show: action label; object/reference ID; non-sensitive code/type; status; received/created/due dates where authorized/configured; priority where configured. The case number is displayed only if the user has case-metadata visibility. Do not expose subject name, allegation text, reporter identity, sensitive case title or restricted-case existence unless independently authorized. A purpose-route user should be able to act without receiving additional case discovery.

- **DEC-18: server-side drafts.** Enable controlled server-side drafts for authenticated internal users, but not as an unrestricted global feature. Requirements: purpose-bound authorization; encrypted normal application storage; user-specific or authorized collaborative ownership; no browser/local-storage persistence; explicit draft status; configurable TTL/retention; automatic deletion/expiry where permitted; stale-version protection; audit of create/update/delete; drafts never count as official submissions; draft content must not appear in reporting, notifications or search as submitted content. Keep server drafts disabled for: anonymous whistleblowing submissions unless separately designed and approved; unauthenticated flows; evidence binaries; workflows where an approved security rule prohibits draft persistence. For restricted cases, the normal restricted-case authorization gates apply to drafts as well.

### S5

- **DEC-48: finding vocabularies.** Findings use governed, configurable and effective-dated vocabularies. Do not hard-code a speculative CDF finding catalogue. The vocabulary must support: code; Arabic name; English name; definition; applicable allegation/category; effective dates; active/inactive status; outcome semantics. Where no authoritative vocabulary exists: `SOURCE_REQUIRED`. Allow an authorized `OTHER` / exceptional finding only with mandatory rationale, without automatically creating new master-data vocabulary. The rebase Q&A and approved business architecture take precedence over legacy catalogue terminology.

- **DEC-51: Hijri dates on generated records.** Use dual-date presentation on formal generated records: Gregorian primary + Hijri secondary where the generated document benefits from an official/date-record presentation. Canonical system storage remains an unambiguous machine date/time representation; do not store the Hijri rendering as the authoritative underlying timestamp. UI operational screens may remain Gregorian-first unless a user display preference is later introduced. Example presentation: `13 October 2026 (2 Jumada I 1448H)`. Use an approved date-conversion implementation and do not manually hard-code conversions.

### S6: governance and reporting

- **DEC-11: oversight free text.** Do not provide unrestricted free-text case commentary in Oversight. Oversight should primarily use structured, governed information. Where narrative context is genuinely necessary, implement a separate controlled `OVERSIGHT_NOTE` with author, timestamp, purpose, classification, audit and appropriate access control. It must not become a shadow case file or a place to copy allegations/evidence. Default general free-text field remains hidden.

- **DEC-12: dual control on role grants.** Introduce risk-based dual control for privileged/sensitive access grants. Dual control is mandatory for grants that can materially expand access, including at least: role administration; clearance administration; restricted-case authorities; export-policy administration; second-approval authorities; committee administration where it can grant access; other privileged security/business-administration capabilities. Requirements: `REQUESTER ≠ APPROVER`; no self-approval. Routine low-risk business assignments may remain single-approver where configured. Revocation/lowering of access must not be delayed merely to satisfy dual control when immediate removal is required for security. All grant changes are audited and effective-dated.

- **DEC-13: clearance command and owner.** Build an explicit clearance-management capability, but keep the exact organizational owner configurable until confirmed by the governing authority/DoA. Do not let generic `ROLE_ADMIN`, technical admin or committee administration change clearance. Introduce a dedicated authority such as `CLEARANCE_ADMIN` with controlled commands for assign, increase, reduce, expire and revoke. Rules: clearance elevation requires authorized approval and full audit; lowering/revocation takes effect immediately; no self-approval; historical clearance state is retained; changing clearance immediately changes restricted-object eligibility; technical administrators receive no case-content rights from administering the platform. Exact named organizational owner: `SOURCE_REQUIRED`. Until an authorized holder is configured, the command remains fail closed.

- **DEC-36: reporting role and KPIs.** Build governed reporting capability. Do not implement a broad global `REPORTING_ROLE` that automatically grants case access. Use explicit reporting permissions and purpose-bound aggregate/read models. Reporting must support configurable KPIs such as: intake volume; source/channel; preliminary-review aging; referral turnaround; committee workload; meeting/voting/minutes timeliness; grievance volumes and outcomes; corrective-action status; overdue actions; closure aging; repeat issues/patterns; compliance with configured SLAs. Security requirements: no reporter identity in ordinary reporting; no unrestricted allegation/evidence text; restricted cases visible only according to clearance; suppression/aggregation rules remain `SOURCE_REQUIRED` where policy is missing; dashboard counts must not leak existence of hidden cases; drill-down requires the underlying authorization independently. Navigation: do not automatically create a sixth primary navigation area. For users who already have `Oversight`, surface Reporting inside Oversight. A standalone `Reporting` primary area may be shown only to users whose responsibilities are principally reporting and where the ≤5-primary-area rule remains satisfied.

Implementation direction (owner): these decisions unblock the Phase 12 governance/reporting design. Update `PHASE12_PLAN.md`, the owner-decision register, the relevant ADRs, the read-model requirements, the authorization matrix, the Phase 12 tests and the UX debt crosswalk, then proceed according to the existing Phase 12 slice order. Do not wait on `SOURCE_REQUIRED` values where a safe configurable architecture can already be built. The Phase 12 UI remains: work-led · case-homed · purpose-bound · guided-by-design.

## Implementation instruction (owner)

Apply these decisions without redesigning already-cleared security primitives. For each decision: map it to the relevant ADR; update `SOURCE_REQUIRED` markers where resolved; keep unresolved source-dependent items explicit; create or update tests; update the final report and phase dashboard; reconcile the relevant Linear issue; and keep the Phase 12 UX assumptions consistent with these decisions.

Then, in order: hosted DEV validation for migrations 1830–2010; P11-G4 evidence half; P11-G2, P11-G3 and P11-G7 as enabled above; Phase 12 screens; final UX re-audit. The final UI stays work-led, case-homed, purpose-bound and guided by design.
