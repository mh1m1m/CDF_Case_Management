# Contradiction Register

> SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Not CDF production, not regulatory certification, and not final HR or legal conformance. Written 2026-10-13 for the owner appendix "CDF 200-Ambiguities Resolution Engine v1.0". Linear [CDF-204](https://linear.app/cdfcasemanagement/issue/CDF-204); the follow-on decisions DEC-AMB-013…015 and row AMB-251 were added the same day ([CDF-210](https://linear.app/cdfcasemanagement/issue/CDF-210)); the built state of migration 2070 and the suites the 2060 closure tests landed in were added on 2026-10-15 ([CDF-223](https://linear.app/cdfcasemanagement/issue/CDF-223)); the built state of the 93 rows placed in 2030/2040, 2050 and 2060, and of 6 rows that 2045 or 2065 touched, was re-checked on 2026-10-16 against main 0f59062, which the Hosted DEV (Supabase) run [38804164091](https://github.com/mh1m1m/CDF_Case_Management/actions/runs/38804164091) tested green ([CDF-224](https://linear.app/cdfcasemanagement/issue/CDF-224)). Generated from one data set with its companion files, so counts agree across them.

23 contradictions found while resolving the register (§30). Precedence is the appendix's §1: the 100 Q&A, then later owner decisions, then the business architecture, ADRs, governance documents, security decisions, implementation and catalogues. None needs a new owner question: each is resolved by a higher source, and the action names who changes what.

## CON-001

- **Source A:** DEC-F10 (do not enable NOT_FEASIBLE or NO_PERSONAL_JURISDICTION as preliminary outcomes); FINAL_REPORT.md §4 ("built: not offered")
- **Source B:** ADR-036 and migration 1980: both values are accepted by api.prepare_preliminary_recommendation and ACTIVE in config.status_dimension_value
- **Conflict:** The owner says not enabled; the code accepts them; the final report describes the code wrongly.
- **Authoritative resolution:** DEC-F10 governs (owner decision outranks implementation).
- **Action:** Deactivate the two PRELIMINARY_OUTCOME values and narrow the command check in 2030/2040 (never delete; existing rows keep their code). Correct FINAL_REPORT §4.

## CON-002

- **Source A:** DEC-F15 (grievance clock starts at effective notification / delivery)
- **Source B:** ADR-037 and migration 1990: the decision notice stores the window end at issue
- **Conflict:** The window can expire before the employee receives the decision.
- **Authoritative resolution:** DEC-F15 governs.
- **Action:** 2030/2040: record delivery; compute the window from delivery; keep the issue-time snapshot of the rule (DEC-F16).

## CON-003

- **Source A:** DEC-F24 (separate policy administration from second approval; configurable approval pool)
- **Source B:** ADR-032 consequences: EXPORT_POLICY_ADMIN and EXPORT_SECOND_APPROVE both only GRC Director (deadlock, fails closed)
- **Conflict:** Deadlock remains possible.
- **Authoritative resolution:** DEC-F24 governs.
- **Action:** 2030/2040: approval pool configuration and an administrative warning when no independent approver exists.

## CON-004

- **Source A:** DEC-F17 (default for substantive non-admission = COMMITTEE)
- **Source B:** Migration 1870 seed: Grievance Committee rule set admissibility_decider = SECRETARY
- **Conflict:** The Secretary currently decides non-admission alone.
- **Authoritative resolution:** DEC-F17 governs.
- **Action:** 2030/2040: new effective-dated rule-set version (COMMITTEE for non-admission); the old version stays for grievances already filed under it (DEC-F16 pattern).

## CON-005

- **Source A:** DEC-F02 (configurable calendar table, holidays administrable without code)
- **Source B:** Migration 1890 committee.add_business_days hard-codes Sunday–Thursday with no holidays; TARGET_WORKFLOW_STATE_MODEL §5 names config.setting
- **Conflict:** Holidays cannot be administered; the document names a different store.
- **Authoritative resolution:** DEC-F02 governs.
- **Action:** 2030/2040: calendar table and a function reading it; update TARGET_WORKFLOW_STATE_MODEL §5.

## CON-006

- **Source A:** DEC-F04 (chair → deputy → configured independent conflict authority)
- **Source B:** ADR-038 §5: chair, deputy only when the chair raised or is the subject; otherwise nobody decides (fail closed); no independent authority
- **Conflict:** Missing third tier; deputy not used when the chair is absent or ineligible for other reasons.
- **Authoritative resolution:** DEC-F04 governs.
- **Action:** 2030/2040: extend the decider resolution.

## CON-007

- **Source A:** ADR-019 §4 (committee.delegation: an alternate secretary acts only while recorded as acting)
- **Source B:** No committee.delegation table or command exists in migrations 1870–2010
- **Conflict:** The ADR describes something not built; DEC-F03 also needs a formal acting record for the chair.
- **Authoritative resolution:** Implementation gap; ADR-019 intent stands and DEC-F03 extends it.
- **Action:** 2030/2040: one acting-role record for chair and secretary per meeting; amend ADR-019 to point to it.

## CON-008

- **Source A:** DEC-F30 (explicit BCP_CONTINUITY_OPERATOR entitlement or registry; never inferred from roles)
- **Source B:** ADR-034 §10: BCP_IMPORT granted to Case Manager, Lead Investigator and GRC Director by role
- **Conflict:** Continuity use is role-derived.
- **Authoritative resolution:** DEC-F30 governs.
- **Action:** 2030/2040: explicit entitlement; role permission kept only as a prerequisite.

## CON-009

- **Source A:** DEC-F28 (owner may be a user, an organisational unit, a shared pool or an external party)
- **Source B:** ADR-033 §3: owner is a user holding CORRECTIVE_ACTION_OWN who passes the case gate
- **Conflict:** Unit, pool and external owners cannot be modelled.
- **Authoritative resolution:** DEC-F28 governs; the case-gate rule still applies to every person who acts for a unit or pool.
- **Action:** 2030/2040 or 2070: owner kinds with an accountable person per action.

## CON-010

- **Source A:** Q90, Q94 (each subject has separate grievance paths; a window per decision)
- **Source B:** ADR-024 implementation: one open grievance per subject link
- **Conflict:** A second decision's window may expire while the first grievance is open.
- **Authoritative resolution:** Q&A governs; derivation in the register (subject × decision).
- **Action:** 2030/2040: change the uniqueness to subject × contested decision.

## CON-011

- **Source A:** Owner decision IDs DEC-61 (restricted committee referral, ADR-018 §7) and DEC-62 (restricted legal review, ADR-022)
- **Source B:** UIUX audit register O17 §17.7: DEC-61 = Stitch project, DEC-62 = new case entities
- **Conflict:** Two different decisions share each ID.
- **Authoritative resolution:** Both stand; the IDs are ambiguous, the decisions are not.
- **Action:** Documentation: cite owner card decisions as "DEC-61 (owner card, restricted referral)" and audit items as "UX DEC-61"; add an alias note to ADR-016's README entry. No owner question.

## CON-012

- **Source A:** Rebase prompt and owner list: 140 statuses
- **Source B:** ADR-029: 150 statuses (Drive); ADR-035 keeps both lists
- **Conflict:** Two status lists with the same code range.
- **Authoritative resolution:** Resolved by ADR-035: both lists kept as separate catalogues (DEC-F32).
- **Action:** None; recorded for completeness.

## CON-013

- **Source A:** 140-status list codes S021–S023, S025–S028, S030, S099, S100
- **Source B:** Drive 150-status list: same codes, different meanings
- **Conflict:** Ten codes mean different statuses.
- **Authoritative resolution:** DEC-F32: the Q&A and business architecture decide semantics where they can; otherwise SOURCE_REQUIRED; S099 = LEGAL_HOLD (DEC-F33).
- **Action:** Keep code_conflict flags; list the 10 in SOURCE_REQUIRED_REGISTER.

## CON-014

- **Source A:** ADR-024 §4 and TARGET_WORKFLOW_STATE_MODEL §3.8 grievance outcomes (UPHOLD, AMEND_SANCTION, CANCEL_SANCTION, REINVESTIGATE, REFER_TO_AUTHORITY, OTHER)
- **Source B:** Migration 1910 grievance_outcome: the Q95 list (UPHOLD, MODIFY, CANCEL, RETURN_FOR_REINVESTIGATION, REQUEST_COMPLETION, INADMISSIBLE, REJECT_ON_MERITS, PARTIALLY_ACCEPT, CORRECTIVE_ACTION, DISCIPLINARY_ACTION, OTHER_AUTHORIZED_OUTCOME)
- **Conflict:** Documents and code use different vocabularies.
- **Authoritative resolution:** Q95 governs; the code matches it.
- **Action:** Update ADR-024 decision 4 and TARGET_WORKFLOW_STATE_MODEL §3.8 to the Q95 list.

## CON-015

- **Source A:** TARGET_DOMAIN_MODEL §2 (Grievance in committee.grievance; EmployeeNotice in decision.employee_notice)
- **Source B:** Migration 1910: grievance.grievance, grievance.defence_notice
- **Conflict:** The domain model names tables that do not exist.
- **Authoritative resolution:** Implementation is authoritative for physical names.
- **Action:** Update TARGET_DOMAIN_MODEL §2.

## CON-016

- **Source A:** TARGET_WORKFLOW_STATE_MODEL §3.5 (results APPROVED / REJECTED / TIED / NO_QUORUM)
- **Source B:** ADR-020: NO_DECISION added (all-abstain coordinator ruling)
- **Conflict:** The document omits a result.
- **Authoritative resolution:** ADR-020 governs.
- **Action:** Add NO_DECISION to §3.5.

## CON-017

- **Source A:** DEC-F12 (legal review required for configured rules, including matters requiring legal justification and deliberate referral)
- **Source B:** ADR-022 implementation: RULE basis only for sanction, legal action, external referral types (decision.legal_review_required)
- **Conflict:** The rule is hard-coded by item type.
- **Authoritative resolution:** DEC-F12 governs.
- **Action:** 2030/2040: effective-dated legal-review rule table.

## CON-018

- **Source A:** DEC-F13 (mappings without an approved source remain SOURCE_REQUIRED)
- **Source B:** ADR-023: the authority type is checked only for item types that have a rule; other item types pass with any authority type
- **Conflict:** Unsourced mappings are accepted silently (fail open).
- **Authoritative resolution:** DEC-F13 with the fail-safe rule (appendix §10): an item type with no rule is not submitted.
- **Action:** 2030/2040: refuse submission of item types without an authority rule.

## CON-019

- **Source A:** DEC-F18 (support extension, suspension, rescheduling of the defence period)
- **Source B:** Migration 1910: defence_notice.due_at fixed at issue; no extension command
- **Conflict:** Extensions are impossible.
- **Authoritative resolution:** DEC-F18 governs.
- **Action:** 2030/2040: append-only due-date change events.

## CON-020

- **Source A:** Q100 (manage the case fully through the workbook)
- **Source B:** ADR-034 §2: BCP-1 imports four sheets; committee, grievance and evidence workbooks are later increments
- **Conflict:** Continuity is partial.
- **Authoritative resolution:** Q100 is the target; BCP-1 is a first increment, not a contradiction of intent.
- **Action:** DEC-AMB-008 was decided on 2026-10-13 (option B; text in OWNER_DECISIONS_FROM_AMBIGUITIES.md). The committee workbook with paper ballots is migration 2120 (ADR-048). The grievance-scoped workbook is migration 2140 (ADR-050), after 2130, built in the PR-C tail or a follow-on PR at the rebase thread's call.

## CON-021

- **Source A:** Q13–Q15 role names (Compliance Section Manager, Governance & Corporate Compliance Department Director, Sector Head of Governance and Compliance)
- **Source B:** ADR-017 and code: COMPLIANCE_SECTION_MANAGER, GRC_DIRECTOR, GRC_SECTOR_HEAD; documents also say "Department Director" and "GRC Director"
- **Conflict:** Three names for the same roles can be misread as different approvers.
- **Authoritative resolution:** Same roles; GRC_DIRECTOR = the Department Director, GRC_SECTOR_HEAD = the Sector Head.
- **Action:** Add a glossary row to docs/business-architecture/README.md; Arabic labels under DEC-54.

## CON-022

- **Source A:** DEC-F40 (closure shall not proceed while mandatory actions remain open)
- **Source B:** CDF_CASE_V1 SCREEN_OUT and OUT_OF_JURISDICTION close with no guard on open proceedings (P11-G2 scoping)
- **Conflict:** Early closure can strand open proceedings and cut off grievances.
- **Authoritative resolution:** DEC-F40 governs.
- **Action:** 2060: closure guards apply to every path into CLOSURE.

## CON-023

- **Source A:** DEC-01 (restriction at creation needs an eligible Restricted Case Authority) and DEC-AMB-012 (decided 2026-10-13: restricted status may be lifted only through two-person control)
- **Source B:** Migration 0700 api.change_case_classification: is_restricted is set from the argument, a null counts as false, and RESTRICTED_CASE_GRANT is checked only when restricting
- **Conflict:** A CLASSIFICATION_CHANGE holder can widen a restricted case to every CASE_VIEW_ALL holder, and a null argument does it silently.
- **Authoritative resolution:** Fail closed: the security invariant and the owner decision outrank the implementation. Found by AGENT-09 while reviewing this register (PR #60).
- **Action:** CDF-206 (migration 2015, AGENT-09): a null keeps the current value and true→false is refused. Per DEC-AMB-012 that refusal stays until the two-person lift (migration 2130, ADR-049) is implemented and security-cleared; negative test T-AMB-145.
