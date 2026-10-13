# Owner Decisions from the Ambiguity Register

> SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Not CDF production, not regulatory certification, and not final HR or legal conformance. Written 2026-10-13 for the owner appendix "CDF 200-Ambiguities Resolution Engine v1.0". Linear [CDF-204](https://linear.app/cdfcasemanagement/issue/CDF-204). Generated from one data set with its companion files, so counts agree across them.

Only R5 items: 12 decisions covering 12 register rows (4.8% of 250). Everything else is resolved from evidence, configuration or a source request.

**All 12 were decided on 2026-10-13.** Fady took the recommended option every time and added his own tightening to DEC-AMB-003, 006, 008, 011 and 012. His decision text is reproduced below unedited. The decisions supersede the temporary fail-safe defaults; a fail-safe that is built today stays until the replacement rule and its negative tests are in place.

## Decision record

**Decision owner:** Fady, 2026-10-13 10:01 UTC, in the project chat (message cmsg_01CvgBgRZnhwQfVHsucbRcQy6cPRqWxWNqjVfydn1oBNMs), relayed by the coordinator. The coordinator confirmed the placements with the rebase thread at 10:06 UTC.

**Instructions given with the decisions (verbatim):**

> These twelve decisions now supersede their temporary fail-safe defaults.
>
> Do not weaken existing fail-safe behaviour before the replacement rule and its negative tests are in place.
>
> For DEC-AMB-012 specifically, keep the current CDF-206 fail-safe prohibition on `restricted=true → false` until the two-person approval path is implemented and security-cleared.

**In Arabic (verbatim), with an English rendering:**

> أعتمد جميع الخيارات الموصى بها، وليس الـdefaults المؤقتة.

(I approve all the recommended options, not the temporary defaults.)

> ولا أرى حاجة الآن لانتظار الوثائق التسع كي يبدأ Claude بالـPhase 12؛ القيم التي تعتمد فعلًا على DoA أو لوائح العمل أو سياسة السجلات تبقى `SOURCE_REQUIRED` كما حددت المراجعة.

(I see no need now to wait for the nine documents before Claude starts Phase 12; values that truly depend on the DoA, the work regulations or the records policy stay `SOURCE_REQUIRED` as the review set them.)

Not included, because they are already decided (DEC-F01–F41, DEC-01…DEC-68 approved items, Q1–Q100) or already open in the UX audit register and not re-asked: DEC-05, DEC-12, DEC-13, DEC-16, DEC-18, DEC-23, DEC-24, DEC-25, DEC-26, DEC-36, DEC-40, DEC-41, DEC-44, DEC-45, DEC-54, DEC-63, DEC-67.

| Decision                                                                                   | Register rows | Decided                | Placement                                                           | Until it lands                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------ | ------------- | ---------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEC-AMB-001 A second grievance against a final grievance outcome                           | AMB-145       | Option B (recommended) | Rebase PR-A, migration 2040                                         | Built today: only an open grievance blocks another (1990), and the Secretary can record one at any time (1910). 2040 adds the decided limit (CDF-207).                                                                                          |
| DEC-AMB-002 Reopening a closed case                                                        | AMB-218       | Option B (recommended) | Rebase PR-B, 2060 (P11-G2 case closure)                             | Reopening stays disabled (REOPEN_CASE, 0600).                                                                                                                                                                                                   |
| DEC-AMB-003 A conflict of interest discovered after a vote or after the authority decision | AMB-051       | Option B (recommended) | Rebase PR-A, migration 2030                                         | Nothing flags a vote or decision when a conflict comes to light later; 2030 adds the decided rule.                                                                                                                                              |
| DEC-AMB-004 Whether a grievance suspends execution of a sanction                           | AMB-110       | Option C (recommended) | Rebase PR-A, migration 2040                                         | No sanction is held back for a grievance yet; 2040 adds the per-type rule.                                                                                                                                                                      |
| DEC-AMB-005 Visibility of a subject's history in other cases                               | AMB-034       | Option B (recommended) | Rebase PR-B, 2050 (P11-G4 evidence half)                            | No cross-case view (built today).                                                                                                                                                                                                               |
| DEC-AMB-006 Evidence disclosure to the subject for the defence                             | AMB-159       | Option C (recommended) | Rebase PR-B, 2050 (P11-G4 evidence half)                            | Defence notices carry allegations only (built today, ADR-024).                                                                                                                                                                                  |
| DEC-AMB-007 Recording committee meetings                                                   | AMB-068       | Option A (recommended) | Rebase PR-A, migration 2030                                         | No recording function exists, so the decision is how the platform already behaves; 2030 records it without code.                                                                                                                                |
| DEC-AMB-008 Committee votes during an outage                                               | AMB-200       | Option B (recommended) | Migration 2120 (BCP committee workbook with paper ballots, ADR-048) | No BCP sheet imports a vote: 12_VOTES has no command and stages UNSUPPORTED (1960).                                                                                                                                                             |
| DEC-AMB-009 A subject who leaves employment during the case                                | AMB-031       | Option A (recommended) | Rebase PR-A, migration 2040                                         | Nothing marks a subject who has left employment; 2040 adds the decided rule.                                                                                                                                                                    |
| DEC-AMB-010 Review of an upheld conflict decision                                          | AMB-055       | Option B (recommended) | Rebase PR-A, migration 2030                                         | No review: an upheld conflict keeps the member out of later meetings of the proceeding (built today).                                                                                                                                           |
| DEC-AMB-011 Whether a grievance outcome may make the sanction more severe                  | AMB-149       | Option A (recommended) | Rebase PR-A, migration 2040                                         | No severity check on a grievance outcome yet; 2040 adds the decided rule.                                                                                                                                                                       |
| DEC-AMB-012 Lifting a case's restricted status                                             | AMB-234       | Option C (recommended) | Migration 2130 (two-person lift of restricted status, ADR-049)      | Built today on main: reclassification can lift restriction (0700). CDF-206 (PR #61, migration 2015, AGENT-09) makes null keep the value and refuses restricted=true → false; that refusal stays until 2130 is implemented and security-cleared. |

## DEC-AMB-001 — A second grievance against a final grievance outcome

Register rows: AMB-145. Status: decided on 2026-10-13, option B.

**Decision (Fady, verbatim):**

> DEC-AMB-001 → B — Allow one reconsideration only where genuinely new evidence is presented. No unlimited grievance chain.

**Placement:** Rebase PR-A, migration 2040.

**Until it lands:** Built today: only an open grievance blocks another (1990), and the Secretary can record one at any time (1910). 2040 adds the decided limit (CDF-207).

**Context:**
The Q&A defines one grievance against a decision (Q91–Q96) but says nothing about contesting the grievance outcome itself. Without a rule a decision never becomes final; with a hard bar, new evidence found later has no route.

**Option A — No second internal grievance**
Impact: The grievance outcome is final inside CDF; finality is simple and closure (P11-G2) can rely on it.

**Option B — One reconsideration on new evidence only**
Impact: One further request, admissible only if it shows evidence that was not available before; a Grievance Committee decision on admissibility; finality comes after that.

**Option C — Configurable multi-stage grievance**
Impact: Any number of stages set per committee rule; most flexible, hardest to make final and to explain to employees.

**Recommended:** Option B

**Why:** Keeps finality while giving a remedy for genuinely new evidence; the data model already links grievances to decisions, so B adds one admissibility check.

**Temporary default (superseded on 2026-10-13):** No second grievance (option A behaviour), with the data model able to add B later.

## DEC-AMB-002 — Reopening a closed case

Register rows: AMB-218. Status: decided on 2026-10-13, option B.

**Decision (Fady, verbatim):**

> DEC-AMB-002 → B — A closed case may be reopened by the applicable closure authority based on new evidence, with documented reason, approval, full audit trail, and retention recalculation.

**Placement:** Rebase PR-B, 2060 (P11-G2 case closure).

**Until it lands:** Reopening stays disabled (REOPEN_CASE, 0600).

**Context:**
REOPEN_CASE exists in the old workflow but is disabled; ADR-013 resets retention on reopening. Closure (P11-G2, DEC-F40) is being built now, so the reopening rule decides whether closure is final.

**Option A — Reopen only through a grievance or reinvestigation outcome**
Impact: No standalone reopening; new matters become new cases linked to the old one.

**Option B — Reopen by the closure authority on new evidence, with reason and approval**
Impact: The same authority that approves closure under the DoA approves reopening; retention is reset; audited.

**Option C — Reopen by the case owner alone**
Impact: Fastest; weakest control over closed records.

**Recommended:** Option B

**Why:** Matches the closure model (maker/approver under the DoA) and keeps reopening rare and visible without forcing artificial new cases.

**Temporary default (superseded on 2026-10-13):** Reopening stays disabled; new information opens a new linked case.

## DEC-AMB-003 — A conflict of interest discovered after a vote or after the authority decision

Register rows: AMB-051. Status: decided on 2026-10-13, option B.

**Decision (Fady, verbatim):**

> DEC-AMB-003 → B — If a conflict is discovered after a vote/decision, mark the affected item `TAINTED_BY_CONFLICT` and block downstream progression. The committee then determines whether a re-vote is required or the result may be confirmed. Confirmation is permitted only where the conflicted participation could not have changed the substantive result, with documented reasoning.

**Placement:** Rebase PR-A, migration 2030.

**Until it lands:** Nothing flags a vote or decision when a conflict comes to light later; 2030 adds the decided rule.

**Context:**
Q42 bars a conflicted member from voting, and DEC-F38 suspends affected access, but nothing says what happens to a vote already cast or a decision already made when the conflict comes to light later.

**Option A — Automatically void the affected vote**
Impact: The vote item is invalidated and must be repeated; any later step built on it (adoption, legal review, authority decision) is reopened.

**Option B — Flag the vote and let the committee decide**
Impact: The item is marked tainted; the chair (or DEC-F04 decider) puts it to the committee, which re-votes without the member or confirms the result if the conflicted vote could not have changed it; downstream steps wait.

**Option C — Record only, no effect**
Impact: The conflict is noted; the result stands.

**Recommended:** Option B

**Why:** Avoids voiding sound decisions on a technicality while never letting a tainted vote pass silently; the "could not have changed the result" test is mechanical and auditable.

**Temporary default (superseded on 2026-10-13):** Flag the item TAINTED_BY_CONFLICT and block further downstream steps until the committee acts (fail safe).

## DEC-AMB-004 — Whether a grievance suspends execution of a sanction

Register rows: AMB-110. Status: decided on 2026-10-13, option C.

**Decision (Fady, verbatim):**

> DEC-AMB-004 → C — Grievance effect on sanction execution is configurable by sanction type. Irreversible/materially difficult-to-reverse sanctions remain suspended during the applicable grievance window and, if filed, until the grievance is resolved. Reversible sanctions may proceed according to the configured catalogue rule.

**Placement:** Rebase PR-A, migration 2040.

**Until it lands:** No sanction is held back for a grievance yet; 2040 adds the per-type rule.

**Setting the decision needs:** `SANCTION_GRIEVANCE_SUSPENSION (per sanction type) = SOURCE_REQUIRED (default: suspended)`, listed in SOURCE_REQUIRED_REGISTER.md and CONFIGURATION_REQUIREMENTS.md.

**Context:**
The grievance window runs from delivery (DEC-F15). If a termination or demotion is executed during the window, a successful grievance may not be able to undo it.

**Option A — No suspension**
Impact: Sanctions execute on decision; a successful grievance is remedied afterwards.

**Option B — Suspend all sanctions until the window ends or the grievance is decided**
Impact: Strongest protection; delays every sanction by at least the window.

**Option C — Configurable by sanction type**
Impact: Irreversible sanctions (for example termination, demotion) wait; reversible ones (for example a warning) execute; set per catalogue entry.

**Recommended:** Option C

**Why:** Protects grievance rights where harm is irreversible without delaying minor sanctions; it fits the sanction catalogue fields required by DEC-F11.

**Temporary default (superseded on 2026-10-13):** Sanctions marked irreversible in the catalogue do not show as executable while a grievance window or grievance is open; others proceed.

## DEC-AMB-005 — Visibility of a subject's history in other cases

Register rows: AMB-034. Status: decided on 2026-10-13, option B.

**Decision (Fady, verbatim):**

> DEC-AMB-005 → B — Permit access only to prior final disciplinary sanctions, through a purpose-bound extract initiated/managed by the Secretary. No unrelated case allegations, evidence, investigations, or full case history. Restricted-source cases remain subject to Restricted Case Authority controls.

**Placement:** Rebase PR-B, 2050 (P11-G4 evidence half).

**Until it lands:** No cross-case view (built today).

**Context:**
Severity decisions may depend on prior sanctions, but cross-case lookup breaks case isolation (ADR-014) and §40 search rules.

**Option A — No cross-case visibility**
Impact: Each case stands alone; prior sanctions reach the committee only if someone brings them as evidence.

**Option B — Prior final sanctions only, through the secretary**
Impact: The secretary may request a purpose-bound extract of the subject's final sanctions (no case content) for a packet; audited; not available on restricted cases without that case's authority.

**Option C — Full cross-case history for the committee**
Impact: Simplest for the committee; exposes unrelated allegations and investigations.

**Recommended:** Option B

**Why:** Gives the committee the one fact progressive discipline needs while keeping other cases invisible.

**Temporary default (superseded on 2026-10-13):** No cross-case visibility (option A).

## DEC-AMB-006 — Evidence disclosure to the subject for the defence

Register rows: AMB-159. Status: decided on 2026-10-13, option C.

**Decision (Fady, verbatim):**

> DEC-AMB-006 → C — Permit selected evidence through a purpose-bound Defence Packet, following review/redaction for reporter, witness, confidentiality, privilege, restricted information and other protected identities/content. This does not create general evidence access for the subject.

**Placement:** Rebase PR-B, 2050 (P11-G4 evidence half).

**Until it lands:** Defence notices carry allegations only (built today, ADR-024).

**Context:**
Defence notices carry allegations only (ADR-024). Disclosing evidence helps a fair defence but can identify the reporter or witnesses.

**Option A — Allegations only**
Impact: Subject answers the allegations; evidence stays internal.

**Option B — A summary of evidence written by the case team**
Impact: Subject sees a reviewed summary; identification risk depends on the writer.

**Option C — Selected evidence in a purpose-bound defence packet**
Impact: The secretary selects items, a reviewer checks for identifying content, restricted cases need the Restricted Case Authority; every view audited.

**Recommended:** Option C

**Why:** Purpose-bound packets already exist (ADR-031); adding a DEFENCE purpose with an identity check gives fairness without broad disclosure.

**Temporary default (superseded on 2026-10-13):** Allegations only (option A).

## DEC-AMB-007 — Recording committee meetings

Register rows: AMB-068. Status: decided on 2026-10-13, option A.

**Decision (Fady, verbatim):**

> DEC-AMB-007 → A — Committee meetings are not recorded. Approved minutes and associated structured meeting records are the official record. No Teams/audio/video recording functionality should be enabled by default.

**Placement:** Rebase PR-A, migration 2030.

**Today:** No recording function exists, so the decision is how the platform already behaves; 2030 records it without code.

**Context:**
Meetings can run on Teams (ADR-020). A recording is sensitive personal data and could involve a new processor; the minutes are currently the record.

**Option A — Never recorded; minutes are the record**
Impact: No extra data or processor; relies on minutes quality.

**Option B — Recorded with consent, stored as restricted evidence**
Impact: Full record; needs consent text, storage, retention and a processor decision.

**Option C — Configurable per meeting type (for example hearings only)**
Impact: Flexible; more rules to govern.

**Recommended:** Option A

**Why:** Nothing in the Q&A asks for recordings, and A needs no new processor or retention class; B or C can follow if policy requires it.

**Temporary default (superseded on 2026-10-13):** No recording function.

## DEC-AMB-008 — Committee votes during an outage

Register rows: AMB-200. Status: decided on 2026-10-13, option B.

**Decision (Fady, verbatim):**

> DEC-AMB-008 → B — During an outage, substantive committee voting may use signed individual paper ballots. They are imported as provisional votes and must be confirmed by each relevant member through the platform after restoration before the vote becomes final. The Secretary may not cast `APPROVE` or `REJECT` on another member's behalf.

**Placement:** Migration 2120 (BCP committee workbook with paper ballots, ADR-048).

**Until it lands:** No BCP sheet imports a vote: 12_VOTES has no command and stages UNSUPPORTED (1960).

**Context:**
Q100 asks for full continuity through the workbook, but Q60 forbids the secretary recording a substantive vote for a member, so an offline vote cannot simply be typed in by the secretary.

**Option A — No offline voting**
Impact: Votes wait for restoration; meetings during an outage deliberate only.

**Option B — Signed paper ballots, confirmed by each member after restoration**
Impact: The secretary imports ballots as provisional; each member confirms their own vote online; the item closes only after confirmations.

**Option C — Secretary records votes from signed ballots**
Impact: Fastest; conflicts with Q60.

**Recommended:** Option B

**Why:** Keeps continuity and keeps Q60: every substantive vote is ultimately confirmed by the member.

**Temporary default (superseded on 2026-10-13):** No offline vote import (option A).

## DEC-AMB-009 — A subject who leaves employment during the case

Register rows: AMB-031. Status: decided on 2026-10-13, option A.

**Decision (Fady, verbatim):**

> DEC-AMB-009 → A — If a subject leaves employment during the case, continue the investigation through findings and recommendations. Applicable sanctions may be recorded but must not be shown as executable where the employment relationship no longer permits execution. Governance/corrective actions remain actionable.

**Placement:** Rebase PR-A, migration 2040.

**Until it lands:** Nothing marks a subject who has left employment; 2040 adds the decided rule.

**Context:**
Q&A and DEC-F11 do not say whether a case continues against a former employee.

**Option A — Continue to findings; sanctions recorded but not executed**
Impact: Governance learning and record are kept; sanction items marked not enforceable.

**Option B — Suspend the subject's path**
Impact: Path waits; may never resume.

**Option C — Close the subject's path**
Impact: Simplest; loses findings and any corrective actions tied to them.

**Recommended:** Option A

**Why:** Findings and corrective actions still matter for governance; marking sanctions not enforceable avoids acting outside the employment relationship.

**Temporary default (superseded on 2026-10-13):** Flag the subject LEFT_EMPLOYMENT, keep findings, block sanction execution.

## DEC-AMB-010 — Review of an upheld conflict decision

Register rows: AMB-055. Status: decided on 2026-10-13, option B.

**Decision (Fady, verbatim):**

> DEC-AMB-010 → B — An upheld conflict determination may be reversed by the next eligible decider in the DEC-F04 hierarchy, with documented reason and audit. Reversal applies prospectively to future meetings/actions only and does not retroactively validate participation in meetings from which the member was excluded.

**Placement:** Rebase PR-A, migration 2030.

**Until it lands:** No review: an upheld conflict keeps the member out of later meetings of the proceeding (built today).

**Context:**
An upheld conflict (ADR-038) excludes the member from the whole proceeding (PRIOR_CONFLICT_DECLARED) and DEC-F05 gives no hearing. A wrongly upheld conflict can change the committee's composition for the rest of the case.

**Option A — No review**
Impact: Decision final; simplest.

**Option B — Reversal by the next decider in the DEC-F04 order, with reason, for future meetings only**
Impact: Past meetings stand; the member can return for later meetings; audited.

**Option C — Appeal to the configured independent conflict authority**
Impact: Independent; slower.

**Recommended:** Option B

**Why:** Gives a remedy without reopening past meetings and reuses the DEC-F04 decider order.

**Temporary default (superseded on 2026-10-13):** No review (option A).

## DEC-AMB-011 — Whether a grievance outcome may make the sanction more severe

Register rows: AMB-149. Status: decided on 2026-10-13, option A.

**Decision (Fady, verbatim):**

> DEC-AMB-011 → A — A grievance outcome must never make the challenged disciplinary sanction more severe. It may uphold, reduce, modify in a non-more-severe manner, or cancel it. If genuinely new facts justify a potentially more severe sanction, that must proceed through the appropriate reinvestigation/new decision process with full due-process protections rather than through the grievance itself.

**Placement:** Rebase PR-A, migration 2040.

**Until it lands:** No severity check on a grievance outcome yet; 2040 adds the decided rule.

**Setting the decision needs:** `SANCTION_SEVERITY_RANK (per catalogue entry) = SOURCE_REQUIRED (default: unranked, so no change between types)`, listed in SOURCE_REQUIRED_REGISTER.md and CONFIGURATION_REQUIREMENTS.md.

**Context:**
Q95 allows MODIFY; it does not say whether modification may increase severity. If it may, employees may be deterred from filing.

**Option A — Never more severe**
Impact: A grievance can only uphold, reduce or cancel.

**Option B — More severe only with notice and a chance to respond**
Impact: Allowed after the grievant is warned and heard.

**Option C — Configurable per committee**
Impact: Flexible.

**Recommended:** Option A

**Why:** Protects the right to grieve; a more severe sanction can still come from a reinvestigation and a new decision.

**Temporary default (superseded on 2026-10-13):** Option A behaviour.

## DEC-AMB-012 — Lifting a case's restricted status

Register rows: AMB-234. Status: decided on 2026-10-13, option C.

**Decision (Fady, verbatim):**

> DEC-AMB-012 → C — Restricted status may be lifted only through two-person control: the case's Restricted Case Authority plus an independent second authorized approver. Require reason, audit, and a preview of the access population/permissions that would become available after declassification. No user may approve their own second approval.

**Placement:** Migration 2130 (two-person lift of restricted status, ADR-049).

**Until it lands:** Built today on main: reclassification can lift restriction (0700). CDF-206 (PR #61, migration 2015, AGENT-09) makes null keep the value and refuses restricted=true → false; that refusal stays until 2130 is implemented and security-cleared.

**Setting the decision needs:** `RESTRICTION_LIFT_SECOND_APPROVER = SOURCE_REQUIRED (DoA; default: none, so no lift)`, listed in SOURCE_REQUIRED_REGISTER.md and CONFIGURATION_REQUIREMENTS.md.

**Context:**
DEC-01 governs restriction at creation; nothing decides when a case may become unrestricted, which opens it to every CASE_VIEW_ALL holder. Built today: reclassification can lift restriction (api.change_case_classification, migration 0700: a CLASSIFICATION_CHANGE holder can pass false, and a null is treated as false).

**Option A — Never**
Impact: Restricted for life; access widened only by named approvals.

**Option B — Restricted Case Authority alone, with reason**
Impact: Simple; one person widens access to many.

**Option C — Restricted Case Authority plus a second approver (for example GRC Director)**
Impact: Two-person control; audited; previewed list of who gains access.

**Recommended:** Option C

**Why:** Widening access to a whole population is the most sensitive access change; two-person control matches disposition and hold release.

**Temporary default (superseded on 2026-10-13):** Restriction is not lifted (option A behaviour).
