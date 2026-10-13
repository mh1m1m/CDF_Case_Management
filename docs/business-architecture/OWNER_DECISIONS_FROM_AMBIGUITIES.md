# Owner Decisions from the Ambiguity Register

> SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Not CDF production, not regulatory certification, and not final HR or legal conformance. Written 2026-10-13 for the owner appendix "CDF 200-Ambiguities Resolution Engine v1.0". Linear [CDF-204](https://linear.app/cdfcasemanagement/issue/CDF-204); the follow-on decisions DEC-AMB-013…015 and row AMB-251 were added the same day ([CDF-210](https://linear.app/cdfcasemanagement/issue/CDF-210)). Generated from one data set with its companion files, so counts agree across them.

Only R5 items: 15 decisions covering 12 register rows (4.8% of 251). Three of them, DEC-AMB-013, DEC-AMB-014 and DEC-AMB-015, are follow-ons on rows that already had a decision (AMB-051, and AMB-218 for DEC-AMB-015). Everything else is resolved from evidence, configuration or a source request.

**All 15 were decided on 2026-10-13.** Fady took the recommended option every time and added his own tightening to DEC-AMB-003, 006, 008, 011, 012, 013, 014 and 015. His decision text is reproduced below unedited. The decisions supersede the temporary fail-safe defaults; a fail-safe that is built today stays until the replacement rule and its negative tests are in place.

## Decision record

### 10:01 UTC: DEC-AMB-001…012

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

### 14:40 UTC: DEC-AMB-013

**Decision owner:** Fady, 2026-10-13 14:40 UTC, in the project chat (message cmsg_01CvgBgRZnhwQfVHsucbRcQyJ9QzEZDTfyFZiZVeqgXFYx), relayed by the coordinator. The rebase thread raised the question and the coordinator asked it in its Phase 12 owner pack at 11:08 UTC.

His English text is the decision. It is in the DEC-AMB-013 section below, unedited, with his Arabic framing; his message also carries "Pasted text" labels and a paragraph on PR #60's merge status, which are not part of the decision.

### 15:48 UTC: DEC-AMB-014 and DEC-AMB-015, the defaults Fady kept, his negative tests and his Arabic

**Decision owner:** Fady, 2026-10-13 15:48 UTC, in the project chat (message cmsg_01CvgBgRZnhwQfVHsucbRcQySeKSrtjGHytV63vS4JUjts), one message with both decisions, relayed by the coordinator at 15:49 UTC with the ids DEC-AMB-014 and DEC-AMB-015, which it shares with the rebase thread.

**Neighbouring consequences (Fady, verbatim):**

> Neighbouring consequences
>
> Keep the coordinator defaults for now:
>
> 1. Sanction already executed under the superseded decision
>    - retain the execution record;
>    - do not automatically execute it again;
>    - mark it as originating from a `SUPERSEDED` decision;
>    - the replacement authority decision determines any remedial consequence separately.
> 2. Grievance already filed against the superseded decision
>    - do not delete, cancel or silently migrate it;
>    - retain it with an explicit `SUPERSEDED_DECISION` relationship/status;
>    - preserve all submissions and audit history;
>    - any further procedural treatment should be derived from the replacement decision/grievance rules rather than automatic mutation.

**Recorded as:** Fady keeps the two neighbouring consequences as coordinator defaults "for now". At the coordinator's direction (15:49 UTC) they are recorded as owner-confirmed coordinator defaults, not new decisions.

**Placement:** Rebase PR-A (2030 and 2040), as built; no separate placement was given.

**Where it stands:** As built on the rebase branch (00c55ec, AGENT-09 pack 6): a sanction executed under a decision that is later superseded keeps its execution record and is not executed again (one execution per sanction item and subject, append-only), and `api.sanction_executability` marks it `execution_origin: SUPERSEDED_DECISION`; a grievance already filed on it is not deleted, cancelled or migrated, and `api.grievance_view` marks it `contested_decision_relationship: SUPERSEDED_DECISION`. They reach main with Rebase PR-A.

**Instruction and negative tests (Fady, verbatim):**

> Please record these as final owner decisions, update the ambiguity/decision registers, relevant ADRs, migration tests, and Phase 12 handling.
>
> Negative tests should confirm that:
>
> - frozen corrective actions cannot resume without replacement-decision disposition;
> - a closed case cannot enter DEC-AMB-013 directly;
> - reopening for post-decision conflict requires closure-authority approval;
> - the original authority decision is immutable;
> - superseded sanctions are not automatically re-executed;
> - existing grievances are preserved rather than rewritten.

**In Arabic (verbatim), with an English rendering:**

> اعتمد القرارين التاليين:

(I approve the following two decisions:)

> الخيار A في الحالتين هو الأنظف حوكميًا: الأولى تجعل القرار البديل هو الذي يتصرف صراحةً في الآثار التابعة للقرار الملغى بدل الترحيل أو الإعفاء التلقائي، والثانية تعيد استخدام بوابة reopening المضبوطة بدل خلق مسار خفي موازٍ للحالات المغلقة.

(Option A in both cases is the cleanest in governance terms: the first makes the replacement decision the one that explicitly disposes of the consequences that follow from the cancelled decision, instead of carrying them over or waiving them automatically, and the second reuses the controlled reopening gate instead of creating a hidden parallel path for closed cases.)

His two decisions are in the DEC-AMB-014 and DEC-AMB-015 sections below.

### 17:27 UTC: DEC-AMB-014 and DEC-AMB-015 closed on the owner side

**Decision owner:** Fady, 2026-10-13 17:27 UTC, in the project chat (message cmsg_01CvgBgRZnhwQfVHsucbRcQyLfDvKG6RrNCdY5jL8SM3aR), after reviewing the rebase thread's pack 6. No new owner decision: he closed DEC-AMB-014 and DEC-AMB-015 on the owner side.

**His message (verbatim), with an English rendering:**

> ممتاز. Pack 6 واضح ومتماسك، وقرارا DEC-AMB-014 وDEC-AMB-015 الآن مترجمان فعليًا إلى قواعد قابلة للتنفيذ وليس فقط نصوص قرار.

(Excellent. Pack 6 is clear and coherent, and the decisions DEC-AMB-014 and DEC-AMB-015 are now actually translated into enforceable rules, not only decision texts.)

> الأهم عندي أن التنفيذ الحالي حافظ على أربعة مبادئ صحيحة: تجميد الإجراء التصحيحي تحت القرار `SUPERSEDED` بدل ترحيله أو إعفائه تلقائيًا؛ عدم السماح للحالة المغلقة بالدخول مباشرة إلى مسار DEC-AMB-013؛ بقاء الجزاءات المنفذة مسجلة دون إعادة تنفيذ؛ وبقاء التظلمات المرتبطة بالقرار السابق محفوظة دون إعادة كتابة تاريخها. كما أن حزمة الاختبارات الستة التي طلبناها أصبحت جزءًا صريحًا من المراجعة الأمنية.

(What matters most to me is that the current implementation kept four sound principles: freezing the corrective action under the `SUPERSEDED` decision instead of carrying it over or waiving it automatically; not letting a closed case enter the DEC-AMB-013 path directly; executed sanctions staying recorded without being executed again; and grievances linked to the earlier decision staying preserved without their history being rewritten. And the set of six tests we asked for is now an explicit part of the security review.)

> لا أرى قرار مالك جديد مطلوبًا هنا. استمروا على ما هو مسجل، مع إبقاء النقطتين التاليتين كما هما حتى اكتمال مراحلهما:
>
> - مسار `DECISIVE_POST_DECISION_CONFLICT` للحالات المغلقة يعتمد على 2060 وعلى `CASE_CLOSURE_APPROVAL_RULE`.
> - ملاحظة AGENT-09 بخصوص إمكانية كون disposer هو نفسه مالك corrective action تُعالج في 2160، ولا ينبغي توسيع الصلاحية قبل تطبيق الفصل المناسب في طبقة الحوكمة.

(I do not see a new owner decision needed here. Carry on with what is recorded, keeping the following two points as they are until their stages are complete: the `DECISIVE_POST_DECISION_CONFLICT` path for closed cases depends on 2060 and on `CASE_CLOSURE_APPROVAL_RULE`; AGENT-09's note on the possibility that the disposer is the corrective action's own owner is handled in 2160, and the permission should not be widened before the appropriate separation is applied in the governance layer.)

> وبالنسبة لـPhase 12، توجيه الواجهة صحيح: المستخدم العادي صاحب الإجراء يرى النسخ والحالة التشغيلية فقط، بينما `origin`, governing decisions, dispositions و`may_dispose` تبقى محصورة على case team حسب الصلاحية؛ والحالة `FROZEN_BY_SUPERSEDED_DECISION` يجب أن تظهر كمانع صريح لأي progress/verification/waiver إلى أن يتصرف القرار البديل فيها.

(For Phase 12, the interface direction is right: the ordinary user who owns the action sees the versions and the operational state only, while `origin`, governing decisions, dispositions and `may_dispose` stay limited to the case team according to permission; and the `FROZEN_BY_SUPERSEDED_DECISION` state must show as an explicit block on any progress/verification/waiver until the replacement decision disposes of it.)

> يمكن اعتبار DEC-AMB-014 وDEC-AMB-015 مغلقين بالكامل من جانب المالك، ولا حاجة لإعادتهما في owner pack لاحق إلا إذا ظهر تعارض جديد في 2060 أو 2160.

(DEC-AMB-014 and DEC-AMB-015 can be considered fully closed on the owner side, and there is no need to bring them back in a later owner pack unless a new conflict appears in 2060 or 2160.)

Not included, because they are already decided (DEC-F01–F41, DEC-01…DEC-68 approved items, Q1–Q100) or already open in the UX audit register and not re-asked: DEC-05, DEC-12, DEC-13, DEC-16, DEC-18, DEC-23, DEC-24, DEC-25, DEC-26, DEC-36, DEC-40, DEC-41, DEC-44, DEC-45, DEC-54, DEC-63, DEC-67.

| Decision                                                                                                          | Register rows                                                  | Decided                | Placement                                                                                       | Until it lands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEC-AMB-001 A second grievance against a final grievance outcome                                                  | AMB-145                                                        | Option B (recommended) | Rebase PR-A, migration 2040                                                                     | Built today: only an open grievance blocks another (1990), and the Secretary can record one at any time (1910). 2040 adds the decided limit (CDF-207).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| DEC-AMB-002 Reopening a closed case                                                                               | AMB-218                                                        | Option B (recommended) | Rebase PR-B, 2060 (P11-G2 case closure)                                                         | Reopening stays disabled (REOPEN_CASE, 0600).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| DEC-AMB-003 A conflict of interest discovered after a vote or after the authority decision                        | AMB-051                                                        | Option B (recommended) | Rebase PR-A, migration 2030                                                                     | Nothing flags a vote or decision when a conflict comes to light later; 2030 adds the decided rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| DEC-AMB-004 Whether a grievance suspends execution of a sanction                                                  | AMB-110                                                        | Option C (recommended) | Rebase PR-A, migration 2040                                                                     | No sanction is held back for a grievance yet; 2040 adds the per-type rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| DEC-AMB-005 Visibility of a subject's history in other cases                                                      | AMB-034                                                        | Option B (recommended) | Rebase PR-B, 2050 (P11-G4 evidence half)                                                        | No cross-case view (built today).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| DEC-AMB-006 Evidence disclosure to the subject for the defence                                                    | AMB-159                                                        | Option C (recommended) | Rebase PR-B, 2050 (P11-G4 evidence half)                                                        | Defence notices carry allegations only (built today, ADR-024).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| DEC-AMB-007 Recording committee meetings                                                                          | AMB-068                                                        | Option A (recommended) | Rebase PR-A, migration 2030                                                                     | No recording function exists, so the decision is how the platform already behaves; 2030 records it without code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| DEC-AMB-008 Committee votes during an outage                                                                      | AMB-200                                                        | Option B (recommended) | Migration 2120 (BCP committee workbook with paper ballots, ADR-048)                             | No BCP sheet imports a vote: 12_VOTES has no command and stages UNSUPPORTED (1960).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| DEC-AMB-009 A subject who leaves employment during the case                                                       | AMB-031                                                        | Option A (recommended) | Rebase PR-A, migration 2040                                                                     | Nothing marks a subject who has left employment; 2040 adds the decided rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| DEC-AMB-010 Review of an upheld conflict decision                                                                 | AMB-055                                                        | Option B (recommended) | Rebase PR-A, migration 2030                                                                     | No review: an upheld conflict keeps the member out of later meetings of the proceeding (built today).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| DEC-AMB-011 Whether a grievance outcome may make the sanction more severe                                         | AMB-149                                                        | Option A (recommended) | Rebase PR-A, migration 2040                                                                     | No severity check on a grievance outcome yet; 2040 adds the decided rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| DEC-AMB-012 Lifting a case's restricted status                                                                    | AMB-234                                                        | Option C (recommended) | Migration 2130 (two-person lift of restricted status, ADR-049)                                  | Built today on main: reclassification can lift restriction (0700). CDF-206 (PR #61, migration 2015, AGENT-09) makes null keep the value and refuses restricted=true → false; that refusal stays until 2130 is implemented and security-cleared.                                                                                                                                                                                                                                                                                                                                                                                             |
| DEC-AMB-013 A conflict found after the authority decided, where the conflicted vote could have changed the result | AMB-051 (follow-on to DEC-AMB-003)                             | Option A (recommended) | Rebase PR-A, migration 2030                                                                     | Nothing on main flags a conflict found after a decision. The re-vote path is built in 2030 on the rebase branch (956bc91, hardened at b7e5e43) with a negative test for each one Fady named, and AGENT-09 accepted it as pack 5. It reaches main with Rebase PR-A.                                                                                                                                                                                                                                                                                                                                                                          |
| DEC-AMB-014 A corrective action opened under an authority decision that is later superseded                       | AMB-051 (follow-on to DEC-AMB-013)                             | Option A (recommended) | Rebase PR-A, migration 2030                                                                     | Nothing on main supersedes a decision. On the rebase branch (00c55ec, AGENT-09 pack 6) an action opened under a decision that is later superseded is `FROZEN_BY_SUPERSEDED_DECISION` until a corrective-action manager of the case records the replacement decision's disposition (`RE_ADOPT`, `MODIFY`, `WAIVE` or `REPLACE_WITH_NEW_ACTION`) with `api.dispose_superseded_corrective_action`; meanwhile its progress, an ordinary waiver, a second action on the same item and the case's closure are refused. A disposer who owns the action is not refused yet; that check is left to 2160 (ADR-053). It reaches main with Rebase PR-A. |
| DEC-AMB-015 A decisive conflict found only after the case has closed                                              | AMB-051 and AMB-218 (follow-on to DEC-AMB-013 and DEC-AMB-002) | Option A (recommended) | Rebase PR-A, migration 2030 (closed-case guard); Rebase PR-B, migration 2060 (reopening reason) | A decisive conflict found after closure has no entry, so nothing is remediated and nothing reopens (fail closed). On the rebase branch (00c55ec, AGENT-09 pack 6) the closed-case guard of 2030 refuses a conflict remediation unless the case is ACTIVE (CASE_NOT_ACTIVE). Reopening stays disabled (REOPEN_CASE, 0600) until 2060 adds the reopening reason; a reopening for it then fails closed while the closure authority is not configured, as Fady requires (`CASE_CLOSURE_APPROVAL_RULE` is SOURCE_REQUIRED, AMB-212).                                                                                                             |

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

**Follow-on (decided 2026-10-13, below):** DEC-AMB-015 reuses this reopening for a decisive conflict found after the case closed, with `DECISIVE_POST_DECISION_CONFLICT` as "a distinct governed reopening reason".

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

**Follow-ons (decided 2026-10-13, below):** DEC-AMB-013, for a conflict found after the competent authority decided, and from it DEC-AMB-014 (corrective actions of a decision that is later superseded) and DEC-AMB-015 (a decisive conflict found after the case closed).

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

## DEC-AMB-013 — A conflict found after the authority decided, where the conflicted vote could have changed the result

Register rows: AMB-051 (follow-on to DEC-AMB-003). Status: decided on 2026-10-13, option A.

**Decision owner:** Fady, 2026-10-13 14:40 UTC, in the project chat (message cmsg_01CvgBgRZnhwQfVHsucbRcQyJ9QzEZDTfyFZiZVeqgXFYx), relayed by the coordinator. The rebase thread raised the question and the coordinator asked it in its Phase 12 owner pack at 11:08 UTC.

**Decision (Fady, verbatim):**

> DEC-AMB-013 → Option A
>
> If a conflict of interest is discovered after the competent authority has already decided, and the conflicted member's participation could have changed the substantive voting result:
>
> 1. Mark the affected vote/recommendation package `TAINTED_BY_CONFLICT`.
> 2. Immediately block any further downstream action based on that decision.
> 3. Reopen the affected committee decision round for a new vote excluding the conflicted member.
> 4. Recalculate quorum and eligibility for the new round.
> 5. Preserve the original vote, recommendation and authority decision as immutable historical records.
> 6. After the committee completes the valid re-vote, submit the resulting recommendation/package to the competent authority for a new decision.
> 7. The earlier authority decision is never edited or deleted; it is marked `SUPERSEDED`.
> 8. Record the reason, conflict event, affected member, original result, new result, authority re-decision and complete audit lineage.
> 9. No corrective action, sanction execution, decision notice or closure may proceed from the tainted decision while this remediation path is open.
> 10. If the conflicted vote could not have changed the result, retain the existing DEC-AMB-003 confirmation path instead; do not force a re-vote unnecessarily.
>
> Do not route this through the ordinary closed-case reopening mechanism under DEC-AMB-002. This is remediation of a procedurally tainted decision chain, not a new-evidence reopening.
>
> Implement under migration 2030 with negative tests ensuring:
>
> - a decisive tainted vote cannot be confirmed;
> - a decided package can enter this controlled re-vote path only because of the validated conflict event;
> - the conflicted member cannot participate;
> - the prior authority decision remains immutable and is marked superseded only after the replacement decision;
> - downstream execution remains blocked until the new authority decision is recorded.

**In Arabic (verbatim), with an English rendering:**

> أختار DEC-AMB-013 → Option A.
>
> إذا اكتُشف تعارض مصالح بعد صدور قرار صاحب الصلاحية، وكان صوت العضو المتعارض يمكن أن يغيّر النتيجة، فلا يكفي الإبقاء على القرار أو استخدام مسار إعادة فتح عام. المسار الصحيح هو إعادة القرار إلى مصدره الحوكمي نفسه: إعادة التصويت من اللجنة دون العضو المتعارض، ثم إعادة العرض على صاحب الصلاحية لاتخاذ قرار جديد. القرار السابق يبقى محفوظًا كسجل تاريخي ويُوسم `SUPERSEDED` ولا يُعدل أو يُحذف. هذا يكمل DEC-AMB-003 منطقيًا ويحافظ على سلسلة القرار دون خلطها بمسار إعادة فتح القضايا المغلقة.

(I choose DEC-AMB-013 → Option A. If a conflict of interest is discovered after the competent authority has issued its decision, and the conflicted member's vote could change the result, keeping the decision or using a general reopening path is not enough. The right path is to return the decision to its own governance source: a re-vote by the committee without the conflicted member, then resubmission to the competent authority for a new decision. The earlier decision is preserved as a historical record, marked `SUPERSEDED`, and never edited or deleted. This completes DEC-AMB-003 logically and keeps the decision chain intact without mixing it with the path for reopening closed cases.)

> وبهذا يصبح لدينا فعليًا DEC-AMB-001 إلى DEC-AMB-013 كلها محسومة؛ القيم الثلاث التي ما زالت `SOURCE_REQUIRED` تظل كما هي لأنها تحتاج مصادر حاكمة فعلية وليست قرارات تصميم: أنواع الجزاءات التي تُعلّق أثناء التظلم، ترتيب شدة الجزاءات، وهوية الـsecond approver لفك تقييد الحالة.

(With this, DEC-AMB-001 to DEC-AMB-013 are now all decided. The three values that are still `SOURCE_REQUIRED` stay as they are, because they need actual governing sources and are not design decisions: the sanction types suspended during a grievance, the ranking of sanction severity, and the identity of the second approver for lifting a case's restriction.)

**Placement:** Rebase PR-A, migration 2030, with the taint (DEC-AMB-003). Built on the rebase branch at 956bc91 and accepted by AGENT-09 as pack 5, then hardened at b7e5e43; it reaches main with Rebase PR-A.

**Until it lands:** Nothing on main flags a conflict found after a decision. The re-vote path is built in 2030 on the rebase branch (956bc91, hardened at b7e5e43) with a negative test for each one Fady named, and AGENT-09 accepted it as pack 5. It reaches main with Rebase PR-A.

**Context:**
DEC-AMB-003 lets the committee re-vote or confirm. After the competent authority has decided, a re-vote would change the basis of a decision that is already recorded, and nothing says who reopens it.

**Option A — The committee re-votes and the authority re-decides**
Impact: RE_VOTE returns the decided package to the committee for a new round. The authority decides again on that round, with reason and audit. The earlier decision is kept, marked superseded, never edited.

**Option B — Reopen through the closure authority**
Impact: Treated as a reopening under DEC-AMB-002 (closure authority, new evidence, reason, approval, audit), then re-vote and re-decision.

**Option C — Keep it blocked**
Impact: Blocked until a source document (work regulations or DoA) sets the path. The case cannot move past the decision.

**Recommended:** Option A

**Temporary default (superseded on 2026-10-13):** Fail closed. The item stays TAINTED_BY_CONFLICT. CONFIRM is refused (RESULT_MAY_CHANGE) and RE_VOTE is refused once the package is DECIDED, so no corrective action or decision notice follows. A taint whose recount gives the same result is still confirmed as under DEC-AMB-003.

## DEC-AMB-014 — A corrective action opened under an authority decision that is later superseded

Register rows: AMB-051 (follow-on to DEC-AMB-013). Status: decided on 2026-10-13, option A.

**Decision owner:** Fady, 2026-10-13 15:48 UTC, in the project chat (message cmsg_01CvgBgRZnhwQfVHsucbRcQySeKSrtjGHytV63vS4JUjts), one message with both decisions, relayed by the coordinator at 15:49 UTC with the ids DEC-AMB-014 and DEC-AMB-015, which it shares with the rebase thread. The coordinator asked it at 15:26 UTC as a decision card in the project chat (message cmsg_01CvgBgRZnhwQfVHsucbRcQyQ8mjvm3ABBqDAxAfufTz2b).

**Decision (Fady, verbatim):**

> Decision 1 — Corrective action opened under a superseded authority decision
>
> Choose Option A — New decision disposes.
>
> The replacement authority decision must explicitly determine the disposition of every corrective action that originated from the superseded decision.
>
> For each affected action, the replacement decision must choose one of:
>
> - `RE_ADOPT`
> - `MODIFY`
> - `WAIVE`
> - `REPLACE_WITH_NEW_ACTION`
>
> Until that disposition is recorded, the action remains:
>
> `FROZEN_BY_SUPERSEDED_DECISION`
>
> and must not progress, be verified complete, or support case closure.
>
> Do not automatically carry the action forward.
>
> Do not automatically waive it.
>
> Do not depend on `CORRECTIVE_ACTION_WAIVE` merely to resolve this supersession scenario.
>
> This is a disposition by the replacement authority decision itself, not an ordinary standalone waiver.
>
> Audit must preserve:
>
> - original corrective action;
> - original authority decision;
> - superseding decision;
> - disposition selected;
> - reason;
> - actor;
> - timestamps;
> - any replacement action linkage.
>
> If re-adopted, the action resumes under the new authority decision without losing its historical execution evidence.
>
> If modified, preserve the prior version and create an auditable revised action version.
>
> If waived, retain it permanently as `WAIVED_BY_SUPERSEDING_DECISION`.
>
> Case closure remains blocked until every frozen action has a final disposition.

**In the same message:** the neighbouring consequences Fady keeps as coordinator defaults, his instruction with six negative tests and his Arabic framing, in the decision record (15:48 UTC).

**Closed on the owner side (Fady, 17:27 UTC, verbatim), with an English rendering:**

> لا أرى قرار مالك جديد مطلوبًا هنا. استمروا على ما هو مسجل، مع إبقاء النقطتين التاليتين كما هما حتى اكتمال مراحلهما:
>
> - مسار `DECISIVE_POST_DECISION_CONFLICT` للحالات المغلقة يعتمد على 2060 وعلى `CASE_CLOSURE_APPROVAL_RULE`.
> - ملاحظة AGENT-09 بخصوص إمكانية كون disposer هو نفسه مالك corrective action تُعالج في 2160، ولا ينبغي توسيع الصلاحية قبل تطبيق الفصل المناسب في طبقة الحوكمة.

(I do not see a new owner decision needed here. Carry on with what is recorded, keeping the following two points as they are until their stages are complete: the `DECISIVE_POST_DECISION_CONFLICT` path for closed cases depends on 2060 and on `CASE_CLOSURE_APPROVAL_RULE`; AGENT-09's note on the possibility that the disposer is the corrective action's own owner is handled in 2160, and the permission should not be widened before the appropriate separation is applied in the governance layer.)

> وبالنسبة لـPhase 12، توجيه الواجهة صحيح: المستخدم العادي صاحب الإجراء يرى النسخ والحالة التشغيلية فقط، بينما `origin`, governing decisions, dispositions و`may_dispose` تبقى محصورة على case team حسب الصلاحية؛ والحالة `FROZEN_BY_SUPERSEDED_DECISION` يجب أن تظهر كمانع صريح لأي progress/verification/waiver إلى أن يتصرف القرار البديل فيها.

(For Phase 12, the interface direction is right: the ordinary user who owns the action sees the versions and the operational state only, while `origin`, governing decisions, dispositions and `may_dispose` stay limited to the case team according to permission; and the `FROZEN_BY_SUPERSEDED_DECISION` state must show as an explicit block on any progress/verification/waiver until the replacement decision disposes of it.)

> يمكن اعتبار DEC-AMB-014 وDEC-AMB-015 مغلقين بالكامل من جانب المالك، ولا حاجة لإعادتهما في owner pack لاحق إلا إذا ظهر تعارض جديد في 2060 أو 2160.

(DEC-AMB-014 and DEC-AMB-015 can be considered fully closed on the owner side, and there is no need to bring them back in a later owner pack unless a new conflict appears in 2060 or 2160.)

**Placement:** Rebase PR-A, migration 2030, with the DEC-AMB-013 supersession; the markers on sanctions and grievances are in 2040. Built on the rebase branch at 00c55ec and accepted by AGENT-09 as pack 6; it reaches main with Rebase PR-A.

**Until it lands:** Nothing on main supersedes a decision. On the rebase branch (00c55ec, AGENT-09 pack 6) an action opened under a decision that is later superseded is `FROZEN_BY_SUPERSEDED_DECISION` until a corrective-action manager of the case records the replacement decision's disposition (`RE_ADOPT`, `MODIFY`, `WAIVE` or `REPLACE_WITH_NEW_ACTION`) with `api.dispose_superseded_corrective_action`; meanwhile its progress, an ordinary waiver, a second action on the same item and the case's closure are refused. A disposer who owns the action is not refused yet; that check is left to 2160 (ADR-053). It reaches main with Rebase PR-A.

**Context:**
DEC-AMB-013 (option A) is built: after a decisive post-decision conflict, the committee re-votes and the authority decides again, and the earlier decision is marked SUPERSEDED. A corrective action already opened under the superseded decision now stays frozen, fail closed, and the case cannot close until that action is waived, but no role holds CORRECTIVE_ACTION_WAIVE yet. Two neighbouring cases keep coordinator defaults unless you say otherwise: a sanction already executed under the superseded decision stays recorded and is not re-executed; a grievance already filed on it is left as it is, both shown with the superseded status.

**Option A — New decision disposes**
Impact: The replacement authority decision must explicitly re-adopt or waive each frozen action before the case can close.

**Option B — Carry over**
Impact: Frozen actions attach automatically to the replacement decision and resume unchanged.

**Option C — Waive by rule**
Impact: Frozen actions are waived automatically when the earlier decision is superseded, with an audit record.

**Option D — Stay frozen**
Impact: Nothing changes until a role holding CORRECTIVE_ACTION_WAIVE is configured (SOURCE_REQUIRED).

**Recommended:** Option A

**Why:** Keeps the competent authority in control of every action and avoids both automatic outcomes.

**Temporary default (superseded on 2026-10-13):** Stay frozen, fail closed: the action cannot progress and the case cannot close until the action is waived, and no role holds CORRECTIVE_ACTION_WAIVE yet (SOURCE_REQUIRED).

## DEC-AMB-015 — A decisive conflict found only after the case has closed

Register rows: AMB-051 and AMB-218 (follow-on to DEC-AMB-013 and DEC-AMB-002). Status: decided on 2026-10-13, option A.

**Decision owner:** Fady, 2026-10-13 15:48 UTC, in the project chat (message cmsg_01CvgBgRZnhwQfVHsucbRcQySeKSrtjGHytV63vS4JUjts), one message with both decisions, relayed by the coordinator at 15:49 UTC with the ids DEC-AMB-014 and DEC-AMB-015, which it shares with the rebase thread. The coordinator asked it at 15:30 UTC as a decision card in the project chat (message cmsg_01CvgBgRZnhwQfVHsucbRcQyAQdXqDQpB9K7sNpXX1BGc7).

**Decision (Fady, verbatim):**

> Decision 2 — Decisive conflict discovered only after the case has already closed
>
> Choose Option A — Reopen then remediate, with one important clarification:
>
> Use the controlled reopening machinery of DEC-AMB-002, but treat the validated post-decision conflict event as an authorized reopening trigger alongside new evidence.
>
> The workflow is:
>
> `CLOSED CASE`
>
> → validated decisive conflict event
>
> → closure authority reviews reopening request
>
> → reopening approved with reason and audit
>
> → case reopens
>
> → affected decision chain marked `TAINTED_BY_CONFLICT`
>
> → committee reconvenes
>
> → quorum and eligibility recalculated
>
> → re-vote without conflicted member
>
> → competent authority re-decides
>
> → former authority decision remains immutable and becomes `SUPERSEDED`
>
> → downstream consequences reconciled
>
> → case may proceed toward closure again.
>
> This does not mean the conflict itself is treated as “new evidence.”
>
> Instead:
>
> `DEC-AMB-002 reopening infrastructure` is reused as the controlled reopening gate, while the reopening reason type is:
>
> `DECISIVE_POST_DECISION_CONFLICT`
>
> Add this as a distinct governed reopening reason.
>
> The closure authority must not re-decide the conflict merits; it authorizes reopening once the conflict event has already been validated through the applicable conflict process.
>
> Fail closed if the required closure authority is not configured.

**In the same message:** the neighbouring consequences Fady keeps as coordinator defaults, his instruction with six negative tests and his Arabic framing, in the decision record (15:48 UTC).

**Closed on the owner side (Fady, 17:27 UTC, verbatim), with an English rendering:**

> لا أرى قرار مالك جديد مطلوبًا هنا. استمروا على ما هو مسجل، مع إبقاء النقطتين التاليتين كما هما حتى اكتمال مراحلهما:
>
> - مسار `DECISIVE_POST_DECISION_CONFLICT` للحالات المغلقة يعتمد على 2060 وعلى `CASE_CLOSURE_APPROVAL_RULE`.
> - ملاحظة AGENT-09 بخصوص إمكانية كون disposer هو نفسه مالك corrective action تُعالج في 2160، ولا ينبغي توسيع الصلاحية قبل تطبيق الفصل المناسب في طبقة الحوكمة.

(I do not see a new owner decision needed here. Carry on with what is recorded, keeping the following two points as they are until their stages are complete: the `DECISIVE_POST_DECISION_CONFLICT` path for closed cases depends on 2060 and on `CASE_CLOSURE_APPROVAL_RULE`; AGENT-09's note on the possibility that the disposer is the corrective action's own owner is handled in 2160, and the permission should not be widened before the appropriate separation is applied in the governance layer.)

> يمكن اعتبار DEC-AMB-014 وDEC-AMB-015 مغلقين بالكامل من جانب المالك، ولا حاجة لإعادتهما في owner pack لاحق إلا إذا ظهر تعارض جديد في 2060 أو 2160.

(DEC-AMB-014 and DEC-AMB-015 can be considered fully closed on the owner side, and there is no need to bring them back in a later owner pack unless a new conflict appears in 2060 or 2160.)

**Placement:** Split, as the coordinator placed it: the closed-case guard in Rebase PR-A, migration 2030 (built on the rebase branch at 00c55ec, AGENT-09 pack 6); the reopening reason `DECISIVE_POST_DECISION_CONFLICT` in Rebase PR-B, migration 2060, with the DEC-AMB-002 reopening (ADR-042). The rebase thread builds both.

**Until it lands:** A decisive conflict found after closure has no entry, so nothing is remediated and nothing reopens (fail closed). On the rebase branch (00c55ec, AGENT-09 pack 6) the closed-case guard of 2030 refuses a conflict remediation unless the case is ACTIVE (CASE_NOT_ACTIVE). Reopening stays disabled (REOPEN_CASE, 0600) until 2060 adds the reopening reason; a reopening for it then fails closed while the closure authority is not configured, as Fady requires (`CASE_CLOSURE_APPROVAL_RULE` is SOURCE_REQUIRED, AMB-212).

**Context:**
DEC-AMB-013 (option A) is built and security-cleared for cases still active: re-vote without the conflicted member, authority re-decides, earlier decision marked SUPERSEDED. The path needs an open meeting on an active case. Your decision excluded routing it through ordinary DEC-AMB-002 reopening, so a decisive conflict discovered only after closure has no entry today: no remediation and no reopening, fail closed. This is only about conflicts found after closure; active cases are unaffected.

**Option A — Reopen then remediate**
Impact: Closure authority reopens under DEC-AMB-002 citing the conflict event, then the DEC-AMB-013 re-vote path runs on the reopened case.

**Option B — Record only**
Impact: The conflict is recorded against the closed case with audit, but the decision stands and nothing is re-voted.

**Option C — Dedicated path**
Impact: A separate conflict-reopening command for closed cases is designed later; stays fail closed until then (SOURCE_REQUIRED).

**Recommended:** Option A

**Why:** Reuses the closure authority's existing reopening with full audit and then applies the rule you already set.

**Temporary default (superseded on 2026-10-13):** Fail closed: a decisive conflict discovered only after closure has no entry, so there is no remediation and no reopening.
