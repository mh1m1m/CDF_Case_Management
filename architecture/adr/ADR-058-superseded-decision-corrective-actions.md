# ADR-058: Corrective actions under a superseded decision: read models

- **Status:** Proposed (2026-10-15). Linear CDF-230. Migration
  `20261007002096_superseded_decision_corrective_actions.sql`, number and ADR allocated by the project coordinator
  (2026-10-15, 06:50) with the rulings below. UX redesign Phase 12, step P12-3 (slice P12-3b). It merges after 2095
  (ADR-057) and its pages, and after 2090 (ADR-045), whose `api.corrective_action_view` it replaces.
- **Protocol:** §19 (authorization twice), §20 (security tests for an authorization change), §21 (administration
  never implies case content), §40 (authorise before results); ADR-016 D0 and D2; ADR-033 (corrective actions; their
  owner reads the card only); ADR-043 (DEC-F41); ADR-045 (CDF-227); ADR-057; DEC-AMB-013; DEC-AMB-014; DEC-F19;
  DEC-F28; UX-116.

## Context

P12-3b is what happens to the corrective actions when a decision is replaced. A re-decision after a conflict
remediation supersedes the earlier round's decisions (DEC-AMB-013), and each corrective action that executed a
superseded decision freezes (`FROZEN_BY_SUPERSEDED_DECISION`) until the replacement decision disposes of it: it is
re-adopted, modified, waived or replaced with a new action (DEC-AMB-014). The case cannot close while any action is
frozen. The disposition command, `api.dispose_superseded_corrective_action`, exists since 2030 and was amended in 2090.
Before this migration:

1. No read listed a case's corrective actions. The case team could tell which actions froze, or which held the case's
   closure, only by opening each one, and the case's page had no list to show.
2. On a frozen action the view gave the superseded decision, but not the replacement decision whose source documents
   a disposition must cite (the command refuses any other document as INVALID).
3. The view offered REPLACE_WITH_NEW_ACTION to a manager who may not name an owner on a restricted case; the command
   then refused with RESTRICTED_CASE_AUTHORITY_REQUIRED.
4. Nobody could list the owners a replacement may name (role assignments are unreadable), nor tell whether a
   replacement without a due date would take the policy's default or be refused.
5. The case's history dropped the freezing and the disposition.

The coordinator's rulings of 2026-10-15 (06:50), all within existing decisions:

1. **Owner candidates** are on the seat basis, not filtered by the case gate, as 2085's `amendment_candidates`
   (DEC-F19). The command answers INVALID at submit for an owner who may not hold the action on this case, and no list
   says who is cleared.
2. **CDF-227** (a disposition's reason reaching the action's owner) is fixed by the Rebase thread in 2090. This
   migration replaces the view as 2090 left it and keeps its exclusion, which the tests pin.
3. **CDF-228** (two authorities in a replacement round) goes to the Rebase thread's 2170, with CDF-215.
4. **Read models only**, under the capability-flag pattern (the command's helpers in the command's order, no lock, no
   audit sequence consumed, flags false and never null); SOURCE_REQUIRED stays marked; nothing widened before 2160.

## Decision

The database decides and the screen explains (ADR-016 D0). One read model is added, one is replaced and the case
history is extended. No table, policy, table grant or command changes. Both read models are `SECURITY DEFINER` with
`search_path = ''`, `stable`, granted to `authenticated` only, and write nothing.

### 1. `api.case_corrective_actions(case)` (A1): the case's corrective actions

- **Who:** whoever may see the case (`authz.can_view_case`). Anyone else, an id that names no case and a missing id get
  NOT_FOUND.
- **What:** each corrective action of the case, in the order it was opened, with its number, type, title, status, due
  date, progress and wording version; its owner (the kind, the user's name from the directory, a sector, a pool by code
  and name, or an external party's label); where it comes from (a package item and its decision, or a preliminary
  proposal, DEC-F41); the decision it executes now (the replacement decision once the action is re-adopted or
  modified); why it may not move (`decision.action_block`: TAINTED_BY_CONFLICT, CONFLICT_REMEDIATION_OPEN,
  FROZEN_BY_SUPERSEDED_DECISION, WAIVED_BY_SUPERSEDING_DECISION or REPLACED_BY_NEW_ACTION); when the decision it
  executes was superseded; and the action that replaced it, or that it replaces.
- **`may_dispose`:** the view's answer for `api.dispose_superseded_corrective_action`, up to the disposition chosen:
  `CORRECTIVE_ACTION_MANAGE` with the case (`decision.require_manager`), the case ACTIVE, and the action frozen (a
  replacement decision exists and has not disposed of it yet).
- **Nothing new to read.** Each row is one the case team reads already: the action (`corrective_action_read`: the
  case), its dispositions (`corrective_action_disposition_read`: the case) and the supersession (its package's
  readers, the whole case team); the owner's name is the directory's.
- **Not audited**, as `api.sanction_executability` (2040) and the view.

### 2. `api.corrective_action_view(action)` (A2) replaced

Same signature, grant and owner, on 2090's body. Every key 2090 returned is returned to the same callers with the same
values, CDF-227's exclusion included; the tests run 2090's definition beside the new one. The case team's origin gains
`replacement`, null unless the action is frozen. While it is:

| Key                | What it shows                                                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decision_id`      | The replacement decision: the decision in force that superseded the one the action executes (`decision.superseding_decision`, the command's own lookup)                                                     |
| `sources`          | Its source documents by position, the primary one marked. A disposition cites one of them                                                                                                                   |
| `may_name_owner`   | Whether the caller, a manager who may dispose, may also name an owner (`decision.require_owner_naming`: an active case and, on a restricted one, its owner as its Restricted Case Authority)                |
| `owner_candidates` | The owners a replacement may name: every active holder of `CORRECTIVE_ACTION_OWN`, with their names from the directory, in the order of their names. Only to whoever may dispose, name an owner and replace |
| `default_due_date` | The due date a replacement takes when none is given: today in Riyadh plus the policy's default. Null when the policy has none (the seed's is SOURCE_REQUIRED), and a replacement must then name its date    |

- **The seat basis** (ruling 1). The candidates are not filtered by the case gate. A listed owner who may not hold the
  action on this case (below its classification, conflicted, outside a restriction) is refused at submit as
  INVALID:owner_id, which the page shows as the command's answer. The caller is listed like anyone else when they hold
  the permission, as the command accepts them.
- **Replacing.** `disposition_options` (2090) stays what the replacement decision allows. REPLACE_WITH_NEW_ACTION is
  possible only where `may_name_owner` holds too; the candidates are empty otherwise, and when the replacement decision
  does not approve the item (only WAIVE is offered).
- **Only to the case team.** The origin is the case team's: an owner's card has none (ADR-033), and the investigator
  and other readers who may not dispose read `may_name_owner` false and no candidates.

### 3. The case's history

`CORRECTIVE_ACTION_FROZEN` and `CORRECTIVE_ACTION_DISPOSED` reach the History tab as codes and times only, with no
actor, reason, disposition, document or detail, to whoever may see the action (`authz.can_view_corrective_action`, as
the action's own policy reads it), which is the whole case team. The disposition's reason stays in the disposition and
the ledger (CDF-227). The History tab names the two events in Arabic and English (`packages/i18n`) with the pages.

### 4. How each answer is computed

As ADR-054 §3 and ADR-057 §5: each answer calls the command's helpers in the command's order. It takes no lock (the
command's `decision.lock_action` is read as the action's visibility, `authz.can_view_corrective_action`), writes nothing
and consumes no audit sequence number. Input checks stay the command's to answer: the disposition, the document cited,
the reason, the wording, the owner and the due date chosen.

### 5. What a capability tells

Nothing its command would not answer, and only to whoever may act (for AGENT-09 to clear). The case team reads the
replacement decision and its sources through the decision's own policies already; the policy in force is readable by
every signed-in user. The owner candidates are active holders of a permission, never who is cleared for the case, and
only a manager who may dispose of the action and name its owner reads them.

### 6. Not in this change

- **The pages** come in the next change, with no migration: see the P12-3b amendment below.
- **The command and the tables** are unchanged.
- **CDF-228** (two authorities in a replacement round) goes to the Rebase thread's 2170.

## P12-3b amendment: the case's actions, the action's page and the disposition forms (2026-10-15)

The corrective-action screens come on these read models, with no migration. The action's page is a purpose route
(ADR-016 D2; CDF-73 option D); none of the pages reads a case table. The disposition is a server action that runs
`api.dispose_superseded_corrective_action` in the caller's security context, so the database checks again on submit.

- **The case's actions.** The Proceedings tab lists A1 to whoever may see the case: each action's title, status,
  owner (their kind and the accountable person's name), due date, progress and source, why it may not move (the
  decision not yet in force, awaiting final approval, frozen, waived or replaced), and, for a frozen one, the day its
  decision was superseded. Each title opens the action's page. A link to record the disposition
  (`/actions/{id}#dispose`) shows only where `may_dispose` is true; a replaced action and its replacement link to each
  other. No disposition's reason is shown (R3).
- **The action's page.** `/actions/{actionId}` reads A2. Whoever may see the action reads its card: the wording it
  carries now and every earlier one, its status, owner and due date, and nothing of the case; the owner sees their own
  name. The case team also reads where it comes from: the decision it carries out now (the one it was opened under, the
  replacement decision once that re-adopted or modified it, or none), while it is frozen the replacement decision with
  its source documents, why it may not move, and each disposition recorded (its code, the document cited, the wording
  it set and the action that replaced it), never its reason. Their breadcrumbs lead back to the case's Proceedings
  tab, the owner's to My Work. Anyone else, and an id that names nothing, get the same 404, and the refusal is recorded
  as `ACCESS_DENIED` with the read's name only. A purpose banner says what the page does not show: to the case team,
  the case's narrative and evidence and each disposition's reason; to anyone else, the case, where the action comes
  from and why it may not move.
- **The disposition forms.** Where `may_dispose` is true, one form for each disposition in `disposition_options`:
  re-adopt, modify (new wording and, optionally, a new due date), waive, and replace with a new action (new wording,
  an owner chosen from `owner_candidates` and a due date, optional only where `default_due_date` is set). Replacing
  shows only where `may_name_owner` is true; otherwise the page says why (the restricted case's authority must own the
  case, or no one can be named its owner). Each form cites one of the replacement decision's own source documents, the
  primary one first. Where the replacement decision rejected the item, the page says that only a waiver is open. A
  member of the case team who may not dispose of the action reads that it is not theirs to dispose of, and no form.
  Each disposition asks first with what changes, whether it can be undone, who is affected and who is told (four new
  confirmations). A refused command is recorded as `COMMAND_DENIED` with the command and the outcome only, never the
  reason, wording or document typed. The schema checks each disposition's fields before the database is asked.
- **Where closure is refused.** On the case's overview, a step out of ACTIVE refused because an action is frozen
  (`FROZEN_BY_SUPERSEDED_DECISION`, 2070) lists the frozen actions from A1, each linked to its page.
- **My Work.** The ACTION_TO_DISPOSE row (2045) opens the action's disposition (`/actions/{id}#dispose`). The owner's
  and the verifier's rows (ACTION_ASSIGNED, ACTION_RETURNED, ACTION_TO_VERIFY) open nothing until P12-6 brings their
  controls, when `/actions` joins the live purpose roots.
- **Not in this change.** The owner's progress and completion and the verifier's controls (P12-6); the History tab
  already names the two events (§3).
- **Tests.** Unit: 30 new (the labels with every code and refusal in both languages and the schema's messages, the
  service, the gateway's mapping and the route), and the confirmation and status tests cover the new acts and
  statuses. `tests/integration/corrective-actions.spec.ts` (2): after a conflict upheld against a voter and a re-vote,
  the manager reads the frozen action in A1 and A2 with the replacement decision's sources and owners, is refused the
  superseded decision's own document, modifies the action, and is then refused a second disposition; the owner reads
  the card alone; anyone else, and an id that names nothing, get the uniform not-found, with `ACCESS_DENIED` or
  `COMMAND_DENIED` recorded and nothing changed. `tests/e2e/corrective-actions.spec.ts` (6; Arabic and English, the
  owner on a 390 px phone): the manager from the Proceedings tab, the overview's refused step and My Work to the form,
  then a modification (English) and a replacement with a new owner (Arabic) read back on the action, the case and the
  overview; the owner's card; a form left open while another manager records a disposition; the case's investigator
  reading why with no form; and the 404s for others and forged ids. `tests/accessibility/corrective-actions.spec.ts`
  (4): axe at 1280 and 390 px and no sideways scroll at 1280, 390 and 320 px, with every disclosure open, on the
  Proceedings tab, the overview, the action's page with its forms and with a recorded disposition, the owner's card and
  a confirmation, in both languages. The browser fixture sets a `SOURCE_REQUIRED` corrective-action rule and grants
  `IMPLEMENTATION_OWNER` to a synthetic user, in test databases only.

## Known limitations

- **Two authorities in a replacement round** (CDF-228). The replacement decision is the one
  `decision.superseding_decision` names, as the command reads it; both change together in 2170.
- **A listed owner may be refused** (ruling 1). The list is the seat basis; the command decides at submit.
- **Events written before 2090** (CDF-227) stay in the ledger and the action's history. The action's owner reads them
  without the reason and the document (2090); the case team reads them whole.
- **Answers are for now.** A flag can turn false between reading and submitting (another manager disposes of the
  action first, a role ends, the policy changes); the command checks again and the page shows its refusal.
- **A form whose action moved on** (P12-3b). When another manager records a disposition while a form is open, the
  command refuses the second one and nothing is recorded; the page then shows the disposition recorded first, without
  the form, so the refusal's own words are not shown. The same holds for every form whose subject changes under it.

## Consequences

- The case's page can list every corrective action with why it may not move, and offer a disposition to exactly
  whoever its command would accept now, without restating a rule.
- A manager disposes of a frozen action citing one of the replacement decision's own documents, chooses an owner from a
  list no wider than the command, and knows before sending whether the replacement takes the policy's due date.
- The case team follows each action's freezing and disposition in the History tab without reading why.
- A capability and its command can drift apart only if one of them changes without the other. The tests run the real
  command for every caller and every state they build, and fail when an answer differs.

## Where access is enforced, audit and tests

- **Enforced:** in the database. A1 answers only whoever may see the case; A2 answers only whoever may see the action,
  and its origin only the case team; the command checks again when it runs.
- **Audit:** none for the reads (codes and ids, as `api.sanction_executability` and the view); the disposition command
  records `CORRECTIVE_ACTION_DISPOSED` as before.
- **Tests:** `tests/security/superseded-decision-corrective-actions.spec.ts` (4 tests) sweeps, in every state it builds
  and for the case's managers, its investigator, the lead investigator, the action's owner, a second implementation
  owner, the committee's secretary and chair, a legal reviewer, a platform administrator, an internal auditor and a
  revoked user:
  - **Reads.** A1 is NOT_FOUND exactly where the caller cannot read the case; otherwise it lists exactly the actions
    the caller reads, in order, each with the values the caller's view and tables give. The view is NOT_FOUND exactly
    where 2090's is and, without `replacement`, equals 2090's, run side by side; the case's history without the two
    events equals 2095's. `replacement` is there exactly while the action is frozen, and only in the case team's
    origin.
  - **Answers.** Each disposition is accepted by the command, run and rolled back, exactly when the caller may
    dispose, `disposition_options` offers it and, for REPLACE_WITH_NEW_ACTION, `may_name_owner` holds. Where the caller
    may dispose, every source listed is accepted and the superseded decision's own document is refused;
    `may_name_owner` is false exactly where the command answers RESTRICTED_CASE_AUTHORITY_REQUIRED; every owner the
    command accepts is listed, a listed owner is refused only as INVALID:owner_id, and the list is every active holder
    of `CORRECTIVE_ACTION_OWN` with the directory's names; a replacement without a due date is accepted exactly when
    `default_due_date` is set, which is the policy's default counted from today in Riyadh.
  - **Nothing is written.** The ledger holds the same rows after the sweep as before it.

  The states: a decision in force with four actions, one awaiting verification; the decision superseded (all four
  frozen); a listed owner lowered below the case's classification; three dispositions (re-adopted from a document other
  than the primary one, modified out of verification, waived); a policy with a default and a replacement without a due
  date; every action disposed of; and the events a disposition wrote before 2090, which reach the owner without the
  reason and the document. A replacement decision that rejects the item (WAIVE only, no candidates). A restricted case
  before and after its authority owns it: the manager who restricted it may dispose of the action but not replace it;
  once the case's authority owns the case, they may, and they are listed as an owner. Refusals, and the read's
  properties.

  Mutation check: 36 mutants of the new SQL, each with one check removed, widened or narrowed, ran against the spec
  on a copy of the database. 33 fail a test; the first run left a fourth, A1 listing every case's actions, standing,
  and the refusals test now pins that a case lists only its own. The other three cannot change an answer, and stay as
  defence in depth:

  - two are a frozen action on a case that is not active: the closure guard refuses to close a case while an action is
    frozen (2070), so no command builds that state; A1's `may_dispose` and the owner candidates keep the case's state
    check;
  - one is the history's gate for the two events: they are written on the case and read through `api.case_history`,
    which only the case team reads, and the action's own policy reads every action of the case for the case team, so
    the gate never decides a row.

  Guards: `api-idor.spec.ts` (A1 is NOT_FOUND to whoever cannot see the case, as for a random id),
  `audit-bypass.spec.ts` (A1 is a read), `case-history-roster.spec.ts` (the two events join the history's catalogue),
  `purpose-read-models-2040.spec.ts` (the origin's new key) and the policy snapshot.

## Production mapping

Platform-independent SQL; it moves unchanged to RDS PostgreSQL. The holders of `CORRECTIVE_ACTION_OWN` and the case's
owner come from the CDF corporate IdP and the case's assignments in production (PRODUCTION_SUBSTITUTION_REQUIRED,
CDF-35).

## Requirements

Phase 12 plan §2 (rules 1, 5 and 6) and §4 (P12-3); DEC-AMB-013; DEC-AMB-014; DEC-F19; DEC-F28; DEC-F41; ADR-016 D0
and D2; ADR-033; ADR-043; ADR-045; ADR-057; UX-116; CDF-227; CDF-228; the coordinator's rulings of 2026-10-15 (06:50).
