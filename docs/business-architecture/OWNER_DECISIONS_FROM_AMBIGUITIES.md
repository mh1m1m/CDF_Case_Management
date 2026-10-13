# Owner Decisions from the Ambiguity Register

> SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Not CDF production, not regulatory certification, and not final HR or legal conformance. Written 2026-10-13 for the owner appendix "CDF 200-Ambiguities Resolution Engine v1.0". Linear [CDF-204](https://linear.app/cdfcasemanagement/issue/CDF-204). Generated from one data set with its companion files, so counts agree across them.

Only R5 items: 12 decisions covering 12 register rows (4.8% of 250). Everything else is resolved from evidence, configuration or a source request. Each decision has a fail-safe default that applies until it is answered. 6 of those defaults are how the platform behaves now; the other 6 need a guard first: DEC-AMB-001, 003, 004 and 011 in the rebase thread's 2030/2040; DEC-AMB-009 in a migration the coordinator still has to number; DEC-AMB-012 in the security fix CDF-206 (migration 2015). DEC-AMB-012 is the urgent one: reclassification can lift restricted status today. No build or merge waits on the answers themselves.

Not included, because they are already decided (DEC-F01–F41, DEC-01…DEC-68 approved items, Q1–Q100) or already open in the UX audit register and not re-asked: DEC-05, DEC-12, DEC-13, DEC-16, DEC-18, DEC-23, DEC-24, DEC-25, DEC-26, DEC-36, DEC-40, DEC-41, DEC-44, DEC-45, DEC-54, DEC-63, DEC-67.

| Decision                                                                                   | Register rows | Recommended | Default if unanswered                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | ------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEC-AMB-001 A second grievance against a final grievance outcome                           | AMB-145       | Option B    | No second grievance (option A behaviour), with the data model able to add B later. Built today: only an open grievance blocks another on the same decision, so this default needs the guard listed in the register row.             |
| DEC-AMB-002 Reopening a closed case                                                        | AMB-218       | Option B    | Reopening stays disabled; new information opens a new linked case.                                                                                                                                                                  |
| DEC-AMB-003 A conflict of interest discovered after a vote or after the authority decision | AMB-051       | Option B    | Flag the item TAINTED_BY_CONFLICT and block further downstream steps until the committee acts (fail safe).                                                                                                                          |
| DEC-AMB-004 Whether a grievance suspends execution of a sanction                           | AMB-110       | Option C    | Sanctions marked irreversible in the catalogue do not show as executable while a grievance window or grievance is open; others proceed.                                                                                             |
| DEC-AMB-005 Visibility of a subject's history in other cases                               | AMB-034       | Option B    | No cross-case visibility (option A).                                                                                                                                                                                                |
| DEC-AMB-006 Evidence disclosure to the subject for the defence                             | AMB-159       | Option C    | Allegations only (option A).                                                                                                                                                                                                        |
| DEC-AMB-007 Recording committee meetings                                                   | AMB-068       | Option A    | No recording function.                                                                                                                                                                                                              |
| DEC-AMB-008 Committee votes during an outage                                               | AMB-200       | Option B    | No offline vote import (option A).                                                                                                                                                                                                  |
| DEC-AMB-009 A subject who leaves employment during the case                                | AMB-031       | Option A    | Flag the subject LEFT_EMPLOYMENT, keep findings, block sanction execution.                                                                                                                                                          |
| DEC-AMB-010 Review of an upheld conflict decision                                          | AMB-055       | Option B    | No review (option A).                                                                                                                                                                                                               |
| DEC-AMB-011 Whether a grievance outcome may make the sanction more severe                  | AMB-149       | Option A    | Option A behaviour.                                                                                                                                                                                                                 |
| DEC-AMB-012 Lifting a case's restricted status                                             | AMB-234       | Option C    | Restriction is not lifted (option A behaviour). Built today: reclassification can lift restriction; fail-safe fix CDF-206 (migration 2015, AGENT-09) makes null keep the value and refuses true→false until DEC-AMB-012 is decided. |

## DEC-AMB-001 — A second grievance against a final grievance outcome

Register rows: AMB-145.

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

**Default if unanswered:** No second grievance (option A behaviour), with the data model able to add B later. Built today: only an open grievance blocks another on the same decision, so this default needs the guard listed in the register row.

**Default in force today:** Not yet: the guard comes with the rebase thread's 2030/2040.

## DEC-AMB-002 — Reopening a closed case

Register rows: AMB-218.

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

**Default if unanswered:** Reopening stays disabled; new information opens a new linked case.

**Default in force today:** Yes: this is how the platform behaves now.

## DEC-AMB-003 — A conflict of interest discovered after a vote or after the authority decision

Register rows: AMB-051.

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

**Default if unanswered:** Flag the item TAINTED_BY_CONFLICT and block further downstream steps until the committee acts (fail safe).

**Default in force today:** Not yet: the guard comes with the rebase thread's 2030/2040.

## DEC-AMB-004 — Whether a grievance suspends execution of a sanction

Register rows: AMB-110.

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

**Default if unanswered:** Sanctions marked irreversible in the catalogue do not show as executable while a grievance window or grievance is open; others proceed.

**Default in force today:** Not yet: the guard comes with the rebase thread's 2030/2040.

## DEC-AMB-005 — Visibility of a subject's history in other cases

Register rows: AMB-034.

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

**Default if unanswered:** No cross-case visibility (option A).

**Default in force today:** Yes: this is how the platform behaves now.

## DEC-AMB-006 — Evidence disclosure to the subject for the defence

Register rows: AMB-159.

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

**Default if unanswered:** Allegations only (option A).

**Default in force today:** Yes: this is how the platform behaves now.

## DEC-AMB-007 — Recording committee meetings

Register rows: AMB-068.

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

**Default if unanswered:** No recording function.

**Default in force today:** Yes: this is how the platform behaves now.

## DEC-AMB-008 — Committee votes during an outage

Register rows: AMB-200.

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

**Default if unanswered:** No offline vote import (option A).

**Default in force today:** Yes: this is how the platform behaves now.

## DEC-AMB-009 — A subject who leaves employment during the case

Register rows: AMB-031.

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

**Default if unanswered:** Flag the subject LEFT_EMPLOYMENT, keep findings, block sanction execution.

**Default in force today:** Not yet: the guard comes with a migration the coordinator still has to number.

## DEC-AMB-010 — Review of an upheld conflict decision

Register rows: AMB-055.

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

**Default if unanswered:** No review (option A).

**Default in force today:** Yes: this is how the platform behaves now.

## DEC-AMB-011 — Whether a grievance outcome may make the sanction more severe

Register rows: AMB-149.

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

**Default if unanswered:** Option A behaviour.

**Default in force today:** Not yet: the guard comes with the rebase thread's 2030/2040.

## DEC-AMB-012 — Lifting a case's restricted status

Register rows: AMB-234.

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

**Default if unanswered:** Restriction is not lifted (option A behaviour). Built today: reclassification can lift restriction; fail-safe fix CDF-206 (migration 2015, AGENT-09) makes null keep the value and refuses true→false until DEC-AMB-012 is decided.

**Default in force today:** Not yet: the guard comes with the security fix CDF-206 (migration 2015).
