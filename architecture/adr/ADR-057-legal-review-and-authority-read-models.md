# ADR-057: Legal review and the authority's decision: read models

- **Status:** Proposed (2026-10-15). Linear CDF-229. Migration
  `20261007002095_legal_review_and_authority_read_models.sql`, number and ADR allocated by the project coordinator
  (2026-10-15, 06:50) with the rulings below. UX redesign Phase 12, step P12-3 (slice P12-3a). It merges after 2086
  (ADR-056) and its pages, and after 2092 (ADR-059), which changes the adoption's answer that R2 carries through
  `decision.package_capabilities`; and before 2096 (ADR-058, P12-3b).
- **Protocol:** §19 (authorization twice), §20 (security tests for an authorization change), §21 (administration
  never implies case content), §40 (authorise before results); ADR-016 D0 and D2; ADR-022 and ADR-023 (legal review
  and the authority); ADR-031 (packets, N14); ADR-042; ADR-056; DEC-02; DEC-19; DEC-62 and DEC-F20 (the restricted
  case's authority approves each legal review); DEC-F12; DEC-F13; DEC-F19; DEC-AMB-003; DEC-AMB-013; UX-116.

## Context

P12-3 is the package's life after the committee adopts it: legal review, the authority's decision and (in P12-3b) the
corrective actions that execute it. The commands exist since 1900 and 2030: asking for a review, cancelling it, the
reviewer's opinion and a superseding one, the restricted case's approval, the submission to the authority and the
recording of its decision. Before this migration:

1. No read model was keyed by a legal-review request. The reviewer's page could not know whether a superseding opinion
   was still possible (the package's status is hidden from the reviewer by design) or why an opinion was refused.
2. Nobody could list the eligible reviewers, because role assignments are unreadable, and on a restricted case the
   secretary could not read the approval their request must match.
3. None of the secretary's acts after the adoption had a capability. `decision.legal_review_required` was internal,
   `api.authority_rule_coverage` answers only `COMMITTEE_ADMIN`, and nothing said before recording that a decision
   would supersede the earlier round's (DEC-AMB-013).
4. The case's history dropped every legal-review and authority event.

The coordinator's rulings of 2026-10-15 (06:50), all within existing decisions:

1. **Reviewer candidates** are on the seat basis, not filtered by the case gate, as 2085's `amendment_candidates`
   (DEC-F19): every active holder of `LEGAL_OPINION_GIVE` but the caller. The command answers INVALID at submit for a
   reviewer not cleared for the case, and no list says who is cleared.
2. **On a restricted case** the secretary reads the approval's reviewer and scope as the choices only, never its reason.
3. **What recording a decision would supersede** is given to the secretary as counts only.
4. **The packet** is `api.open_packet`'s audited read of stored content, so it shows subject names as snapshotted in
   every mode. DEC-02 governs labels in lists and rosters, not packet content; the open label card is not re-raised.
5. **The Restricted Case Authority's My Work row** stays as it is for a review the secretary elects (a known
   limitation below, carried in the coordinator's backlog).
6. **Read models only**, under the capability-flag pattern (the command's helpers in the command's order, no lock, no
   audit sequence consumed, flags false and never null); the choices audited with counts only; SOURCE_REQUIRED stays
   marked; nothing widened before 2160.

## Decision

The database decides and the screen explains (ADR-016 D0). Two read models are added, one is replaced, the case
history is extended and eleven internal helpers are added. No table, policy, table grant or command changes. The read
models are `SECURITY DEFINER` with `search_path = ''` and granted to `authenticated` only: L1 is `stable` and writes
nothing; L2 and R2 are volatile because they audit. The helpers are `stable` and no application role may execute them.

### 1. `api.legal_review_view(request)` (L1): the reviewer's request

- **Who:** the assigned reviewer, while the request's packet is theirs to read (`authz.can_view_packet`, as the
  request's own policy reads it for its assignee). Anyone else gets NOT_FOUND, the same answer as for an id that names
  nothing, and so does a reviewer who reads the packet only as its reviewer, once the request is cancelled or the
  authority has decided (AMB-115, AMB-119). A reviewer who also sits on the committee reads the packet as the
  committee does, so L1 still answers them, with why each opinion command now refuses them; it shows them nothing R2
  does not.
- **What:** the request's status, round, basis, the secretary's reason and when it was asked, who asked (a name from
  the user directory), the opinion with its text and time, its revisions, and the packet's id for `api.open_packet`.
  Nothing about the package, the case or other requests.
- **Capabilities:** `may_give_opinion` (`api.give_legal_opinion`) and `may_give_superseding_opinion`
  (`api.give_superseding_legal_opinion`), each up to the opinion and text chosen, with the code each would refuse
  with (`opinion_block`, `superseding_opinion_block`): REQUEST_CANCELLED, OPINION_ALREADY_GIVEN or TAINTED_BY_CONFLICT
  for the first opinion; OPINION_NOT_GIVEN, PACKAGE_NOT_ADOPTED (the submission, or a new round, closes this path) or
  TAINTED_BY_CONFLICT for a superseding one; FORBIDDEN for both to a reviewer on the committee who no longer holds
  `LEGAL_OPINION_GIVE`.
- **Not audited.** The page reads the packet with `api.open_packet`, which records `PACKET_VIEWED`.

### 2. `api.legal_review_choices(package, act)` (L2): asking for or approving a review

- **REQUEST**, for the committee's secretary. Checks in `api.request_legal_review`'s order without its lock:
  `decision.lock_managed_package` (NOT_FOUND, FORBIDDEN, CONFLICT:CASE_NOT_ACTIVE), the package ADOPTED
  (PACKAGE_NOT_ADOPTED), no review of its round open (LEGAL_REVIEW_OPEN), no taint (TAINTED_BY_CONFLICT), and on a
  restricted case an unused approval of the round (AUTHORITY_APPROVAL_REQUIRED).
- **APPROVE**, for the case's owner as its Restricted Case Authority. Checks in
  `api.approve_restricted_legal_review`'s order: NOT_FOUND, CASE_NOT_RESTRICTED, FORBIDDEN, CASE_NOT_ACTIVE,
  PACKAGE_NOT_ADOPTED, then APPROVAL_ALREADY_PENDING, which refuses every choice.
- **The choices:**
  - `reviewers`: every active holder of `LEGAL_OPINION_GIVE` but the caller (ruling 1), with their names. On a
    restricted request, exactly the approval's reviewer.
  - `findings`: the committee's scope, as `api.committee_scope_choices` lists them (the current version of each
    finding of the committee's proceeding or the one it was referred from, on an allegation not withdrawn; since 2090
    that includes a finding a subject correction leaves on the allegation it supersedes, one naming another person),
    by allegation number and category, result, version and role, with the subject by position (a label only in
    DISPLAY_NAME mode). The command accepts any finding of the case, but the secretary sees only R1's. On a restricted
    request, exactly the approval's findings.
    - **Amended by migration 2099 (CDF-247, 2026-10-16).** `api.request_legal_review`, `api.approve_restricted_legal_review` and `api.open_vote_item` refuse a finding of a withdrawn allegation (`ALLEGATION_WITHDRAWN`), and a subject correction is refused while an open allegation about the wrong subject carries any finding, so no superseded allegation carries one. On a restricted request L2 lists the approval's findings less a withdrawn allegation's; every finding it lists is still accepted, and the request may send the rest of the approval.
  - `minutes`: the proceeding's approved or deemed-approved minutes, by meeting and version. On a restricted request,
    exactly the approval's.
  - `items`: the adopted items the packet will carry.
- **Never** the approval's reason, a finding's rationale, the case id or number.
- **Audit:** `LEGAL_REVIEW_CHOICES_VIEWED` (BUSINESS, on the case, the package as object), with counts only: the act,
  whether the case is restricted, and the reviewers, findings and minutes listed. None on a refusal. Like 2086's invite
  list, a read model's event is not shown in the case's history.

### 3. R2 replaced: the legal review and the authority half

Same signature, grant, owner and audit (`COMMITTEE_ITEMS_VIEWED`, counts only). Every key 2086 returned is returned to
the same callers with the same values; the tests run 2086's definition beside the new one. Each package gains:

| Key                                                          | What it shows                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `adopted_at`, `decided_at`                                   | When the committee adopted the package and when the authority decided it                                |
| `legal_review.required`                                      | Whether the rules require a review now (DEC-F12, `decision.legal_review_required`)                      |
| `legal_review.requests`                                      | Each request in every round: status, basis, reason, reviewer, opinion, revisions, packet, cancellation  |
| `legal_review.requests[].capabilities`                       | `may_cancel`: `api.cancel_legal_review_request`, up to the reason typed                                 |
| `authority.rules`                                            | The rule in force for each adopted item type, as a submission would snapshot it now (DEC-F13)           |
| `authority.submissions`                                      | Each submission with its packet (the package as submitted, DEC-19) and its requirements                 |
| `authority.decisions`                                        | Each decision with its sources, scope, conditions and, once replaced, its supersession (DEC-AMB-013)    |
| `authority.to_decide`                                        | The authorities still to decide in the current round, their items, and whether each completes it        |
| `capabilities.may_request_legal_review`                      | `api.request_legal_review`, up to the reviewer, findings, minutes and reason chosen                     |
| `capabilities.may_submit_to_authority`                       | `api.submit_to_authority`                                                                               |
| `capabilities.may_record_authority_decision`                 | `api.record_authority_decision`, up to the authority and the decision chosen                            |
| `request_legal_review_block`, `submit_block`, `record_block` | The code each act would refuse with, once the package is where the act is done                          |
| `record_outcomes`                                            | The outcomes the record command accepts now: only RETURN_TO_COMMITTEE while a taint waits (DEC-AMB-003) |
| `record_supersedes`                                          | What recording the round's last decision would supersede: decisions and corrective actions, as counts   |

- **Nothing new to read.** Every row shown is one its table's own policy already lets R2's callers read: each is
  keyed on `authz.can_view_recommendation_package`, which for a package of the proceeding is R2's own gate. Authority
  rules and the `FINAL_DISCIPLINARY_AUTHORITY` setting are readable by every signed-in user, and reviewer names come
  from the user directory.
- **Only for whoever runs the package commands.** The committee's secretary or alternate secretary, passing the case
  gate with no conflict in the proceeding, on an active case, gets a true flag, a non-empty list or a code. The case
  team, the members, a legal reviewer and an administrator read every flag false, `record_outcomes` empty,
  `record_supersedes` and every code null. `to_decide` is the same for every reader.
- **The rules** are given in `api.authority_rule_coverage`'s shape: the authorities, the source status (OWNER_DEFAULT,
  SOURCE_REQUIRED and so on, as configured), NO_RULE where none is in force (the submission is refused), and whether
  the `FINAL_DISCIPLINARY_AUTHORITY` setting disagrees with the sanction rule. SOURCE_REQUIRED stays marked.
- **Codes:** `request_legal_review_block` and `submit_block` only on an ADOPTED package (LEGAL_REVIEW_OPEN,
  TAINTED_BY_CONFLICT, AUTHORITY_APPROVAL_REQUIRED; LEGAL_REVIEW_REQUIRED, TAINTED_BY_CONFLICT,
  AUTHORITY_RULE_MISSING; CASE_NOT_ACTIVE for either), `record_block` only on a package with the authority. A code
  never says NOT_FOUND or FORBIDDEN.
- **`record_supersedes`** is set only while a conflict remediation is open (DEC-AMB-013): the decisions of the decided
  round and the corrective actions executing them, which freeze. It happens only when the decision recorded makes the
  package DECIDED: it completes the round (`completes_round`), is not RETURN_TO_COMMITTEE and no two authorities
  disagree on an item. The page says so beside the counts.

### 4. The case's history

The package's events reach the History tab as codes and times only, with no actor, reason, reviewer, authority,
outcome or detail:

- LEGAL_REVIEW_REQUESTED, LEGAL_REVIEW_CANCELLED, LEGAL_OPINION_GIVEN, LEGAL_OPINION_SUPERSEDED,
  RECOMMENDATION_PACKAGE_SUBMITTED_TO_AUTHORITY, AUTHORITY_DECISION_RECORDED and AUTHORITY_DECISION_SUPERSEDED, to
  whoever may see the package (`authz.can_view_recommendation_package`, as the request, submission and decision
  policies read it), which is the whole case team;
- RESTRICTED_LEGAL_REVIEW_APPROVED, to the case's owner as its Restricted Case Authority and whoever recorded it, as
  for the restricted referral.

The History tab names these events in Arabic and English (`packages/i18n`).

### 5. How each answer is computed

As ADR-054 §3, ADR-055 §5 and ADR-056 §4: each capability calls its command's helpers in the command's order,
including the triggers that refuse the command's writes (`decision.block_tainted_progress`,
`decision.enforce_restricted_packet_scope`, `decision.protect_records`). It takes no lock, writes nothing and consumes
no audit sequence number; the one event a read writes is R2's own `COMMITTEE_ITEMS_VIEWED`, unchanged, and L2's
`LEGAL_REVIEW_CHOICES_VIEWED`. Input checks stay the command's to answer: the reviewer, findings, minutes and reason
chosen; the opinion and its text; the authority, outcome, dates, sources, item outcomes, conditions and reason of a
decision. Where a command needs a choice the form makes, the capability answers up to that choice.

Each package helper runs once per package: R2's lateral subqueries are fenced with `offset 0`, since a flattened
subquery repeats a stable function at every reference to its column. Measured locally on one package with one review
and one submission, R2 answers in about 30 ms, against about 20 ms for 2086's and about 50 ms unfenced.

### 6. What a capability tells

Nothing its command would not answer, and only to whoever may act (for AGENT-09 to clear). The reviewer learns whether
their opinion waits for a conflict to be settled and whether the package has moved on from the adoption their opinion
is about, which the two opinion commands answer (TAINTED_BY_CONFLICT, PACKAGE_NOT_ADOPTED). The secretary reads
nothing the package's policies do not already show them, but the reviewers (ruling 1), the restricted approval's
reviewer and scope (ruling 2) and the counts a re-decision would supersede (ruling 3).

### 7. Not in this change

- **The pages** come in the next change, with no migration (the P12-3a amendment below): `/legal-reviews/{requestId}`
  goes live for the reviewer (purpose banner, the packet as stored, the opinion forms); the approval card on the case's
  Proceedings tab and its page; on the proceeding's page, the request and cancel forms, the submit and record forms,
  the as-submitted packet, the decisions with SUPERSEDED, and the consequence preview.
- **P12-3b** (2096, ADR-058, CDF-230): the case's corrective actions and their disposition.
- **CDF-227** (a disposition's reason reaching an action's owner) was fixed by Rebase in 2090 (#87); **CDF-228** (two
  authorities in a replacement round) goes to Rebase with CDF-215 in 2170.

## P12-3a amendment: the reviewer's page, the approval and the authority's forms (2026-10-15)

The legal review and authority screens come on these read models, with no migration. They are purpose routes
(ADR-016 D2; CDF-73 option D) and pages of the case's own; none reads a case table. Each action is a server action
that runs the `api.*` command in the caller's security context, so the database checks again on submit.

- **The reviewer's page.** `/legal-reviews/{requestId}` reads L1 and nothing else. It opens only for the request's
  assignee while its packet is theirs to read. Anyone else, a cancelled request, a request the authority has decided
  (with `PURPOSE_ACCESS_GRACE_DAYS` at its default of 0) and an id that names nothing get the same 404, and the refusal
  is recorded as `ACCESS_DENIED` with the read's name only. The request is the reviewer's own work: the page belongs
  to My Work, and the LEGAL_REVIEW_ASSIGNED row (2045) and the request's notice now open it (`/legal-reviews` joins the
  live purpose roots). The row names neither the case's people nor the secretary's reason. The page shows the request
  (its round, why a review, who asked and when, its status and the secretary's reason), the opinion and every later
  opinion with their times, and a purpose banner that says what it does not show: the case, its narrative and
  evidence, and anything the packet does not carry. The opinion form shows where `may_give_opinion` is true and the
  later-opinion form where `may_give_superseding_opinion` is; otherwise the page says why in words (a conflict to
  settle, the package moved on, the permission or clearance lost). An opinion other than "concurs" needs its text, as
  the command does, and the form says before it is sent that "does not concur" returns the package.
- **The packet.** `/legal-reviews/{requestId}/packet` reads L1, then the packet it names through `api.open_packet`,
  which records `PACKET_VIEWED`, so only opening the packet is a read of it. The packet is what was stored when the
  request was made and never changes: the adopted items with their sanction and its rule, the findings sent with their
  reasons, the approved minutes with their votes, and earlier opinions, with the persons concerned named as stored
  (ruling 4). The same view serves the committee's packet page and the case's.
- **On the proceeding's page.** Each package gains two sections for whoever reads it through R2:
  - _Legal review:_ whether the rules require one; each request in every round with its reviewer, status, opinion and
    later opinions, or its cancellation and reason; and the packet sent, which opens on the proceeding's packet page
    (`/committee-proceedings/{id}/packets/{packetId}`, only a packet R2 names to the caller). The secretary's link to
    ask shows where `may_request_legal_review` is true. Where the package is adopted but the command would refuse (a
    review open, a taint, the restricted case's approval still needed, the case past closure), the section says so in
    words. Cancelling is a form on the request where `may_cancel` is true.
  - _The authority's decision:_ who decides each adopted item type under the rule in force, with its source (owner
    default, approved, or provisional while it awaits the CDF source, never hidden), no rule where none is in force,
    and the `FINAL_DISCIPLINARY_AUTHORITY` setting's disagreement; the submit form where `may_submit_to_authority` is
    true, else why; each submission with its requirements and the package as submitted; the authorities still to
    decide, each with a link to record its decision where `may_record_authority_decision` is true and whether its
    decision completes the round; and each decision as recorded, read-only: the outcome, when and by whom, the source
    documents, the signature or the secretary's attestation, the delegation, the items one by one, the conditions and
    the reason, marked SUPERSEDED with its date once a later decision replaced it (DEC-AMB-013).
- **Asking for a legal review.** `/committee-proceedings/{id}/packages/{packageId}/legal-review` opens only where R2
  says the caller may ask now; otherwise it is the same 404 as a package that does not exist. Only this page reads L2,
  so the proceeding's page records no read of the choices. It lists the reviewers (every holder of the opinion
  permission but the caller; the hint says that someone not cleared for the case is refused when the request is sent),
  the findings by result, allegation number and category, and person by position (a name only in DISPLAY_NAME mode),
  never their reasons, and the approved minutes by meeting and version. The packet carries the adopted items besides.
  On a restricted case the page offers exactly the approval's reviewer, findings and minutes and says so, never the
  approval's reason.
- **Recording the authority's decision.** `/committee-proceedings/{id}/packages/{packageId}/decision/{authorityType}`
  opens only where R2 lists that authority still to decide and the caller may record now; otherwise it is the same 404. It reads R2 only. The outcomes offered are `record_outcomes` (only a return to the committee while a taint
  waits); the items this authority decides are listed, decided one by one for "approve partially" and "modify"; up to
  ten further sources, one per line; conditions only with an approving outcome; and the time in Riyadh, never in the
  future and never before the day of the adoption. Where a conflict remediation is open the page says, as counts only,
  what completing the round would supersede and freeze (ruling 3). The schema checks the command's pairings field by
  field before the database is asked.
- **From the case.** The Proceedings tab shows, under each Investigation Committee proceeding, the committee's
  packages as the case team reads R2, every capability false and so no form, with the legal review and the authority's
  decision. The packets R2 names open on the case's own packet page (`/cases/{id}/proceedings/packets/{packetId}`). On
  a restricted, active case the case's owner, its Restricted Case Authority, gets a link on each adopted package with
  no review open in its round to `/cases/{id}/proceedings/legal-review-approval/{packageId}`, and the RESTRICTED_APPROVAL
  row on a package in My Work (2045) opens the same page. The page finds the package through the case, so an id from
  another case is the same 404, then reads L2 for the approval: NOT_FOUND or FORBIDDEN is the 404, and any other
  refusal is said in words (the case not restricted, an approval already waiting, the case past closure).
- **Confirmation and refusals.** Seven new server actions run seven commands, and each asks first with what changes,
  whether it can be undone, who is affected and who is told. A refused command is recorded as `COMMAND_DENIED` with
  the command and the outcome only, never a reason, opinion, source reference or condition typed.
- **Not in this change.** The corrective actions a superseded decision freezes and their dispositions (P12-3b, 2096,
  ADR-058); the secretary's sanction extract (P12-5); names in DISPLAY_NAME mode outside packets, until the owner
  answers the DEC-02 card.
- **Tests.** Unit: 61 new (schemas, the service, the gateway's mapping, the labels with every refusal code in both
  languages, and the routes). `tests/integration/legal-reviews.spec.ts` (4): the secretary asks from L2's choices, and
  the reviewer opens the request, reads the packet and gives an opinion and then a later one; the secretary submits
  and records the CEO's decision with its sources and a condition, the case team reads it with every capability false,
  and the reviewer loses the request once the authority decided; anyone else gets the uniform not-found, with
  `ACCESS_DENIED` or `COMMAND_DENIED` recorded; on a restricted case the request waits for the owner's approval and then
  takes exactly its reviewer, without its reason. `tests/e2e/legal-reviews.spec.ts` (6; Arabic and English, the
  reviewer and the case team on a 390 px phone): asking from the package's card; the reviewer from My Work through
  the packet to the opinion; the submission and the CEO's decision, read from the case; the restricted case's approval
  from the case; and the 404s for the case team, a member, the reviewer outside their request, another holder of the
  opinion permission, a platform administrator and forged ids. `tests/accessibility/legal-reviews.spec.ts` (6): axe at
  1280 and 390 px and no sideways scroll at 1280, 390 and 320 px, with every disclosure open, on each page and each
  confirmation, in both languages.

## Known limitations

- **A review the secretary elects on a restricted case** (ruling 5). The Restricted Case Authority's My Work row
  (2045, RESTRICTED_APPROVAL on a package) appears only where the rules require the review. A review the secretary
  elects needs the approval too, so until the row changes the authority reaches the approval card from the case's
  Proceedings tab only. The coordinator carries it in the backlog.
- **A proceeding that is no longer open.** R2 is NOT_FOUND to the committee side there (2060), while
  `api.request_legal_review`, `api.cancel_legal_review_request`, `api.submit_to_authority` and
  `api.record_authority_decision` do not check the proceeding's status. The page offers less than the commands accept,
  never more: a test pins that the secretary may still record a decision the page no longer shows. CDF-226 (2120)
  narrows the committee's own package commands; whether the authority's half should stay open on a closed proceeding
  is for the coordinator. Until then the pages follow R2: once the proceeding is closed, the proceeding's page shows
  the secretary, who is not on the case team, no package, and the ask and record pages are the 404, so an authority's
  decision that arrives after the proceeding closed cannot be recorded from the product.
- **An approval waiting to be used.** No read model gives the case an unused approval, so the case owner's link stays
  on the package while one waits; the approval page then says that an approved review of the round is already waiting
  to be sent. The committee's ask page is where it is used.
- **The reviewer's page ends with the decision.** With `PURPOSE_ACCESS_GRACE_DAYS` at its default of 0, a reviewer
  who does not sit on the committee loses the request and its packet as soon as the authority decides (AMB-119). The
  request stays on the committee's and the case's pages.
- **Reads from the case.** The Proceedings tab reads R2 once for each of the case's Investigation Committee
  proceedings, so each opening by the case team records `COMMITTEE_ITEMS_VIEWED` with counts only, as the committee's
  page does.
- **Two authorities in a replacement round** (CDF-228): the read model mirrors the record command as it stands.
- **Answers are for now.** A flag can turn false between reading and submitting (a conflict upheld, an approval
  used, another authority's decision); the command checks again and the page shows its refusal.

## Consequences

- The reviewer's page, the approval card and the package's legal and authority forms can each offer an act to exactly
  whoever its command would accept now, and nobody else, without restating a rule.
- The secretary chooses a reviewer, findings and minutes from lists no wider than the command, and on a restricted
  case from exactly what the authority approved.
- The case team follows the package to its decision in the History tab without reading what the decision says.
- A capability and its command can drift apart only if one of them changes without the other. The tests run the real
  command for every caller and every state they build, and fail when an answer differs.

## Where access is enforced, audit and tests

- **Enforced:** in the database. L1 answers only the assignee who may still read the packet; L2 refuses as its
  command does; R2 shows its packages to the callers 2060 admits; each command checks again when it runs.
- **Audit:** R2's `COMMITTEE_ITEMS_VIEWED` as before; L2's `LEGAL_REVIEW_CHOICES_VIEWED`, one event per answer with
  counts only, none on a refusal; L1 none (the packet's opening is audited).
- **Tests:** `tests/security/legal-review-and-authority-read-models.spec.ts` (9 tests) runs three sweeps in every
  state it builds:
  - `acts()`, for the secretary, the chair, two members (one of them a legal reviewer), the legal reviewer without a
    seat, the case team, the case manager, a platform administrator and the GRC director (the restricted case's
    authority): each of `may_request_legal_review`, `may_cancel`,
    `may_submit_to_authority` and `may_record_authority_decision` equals what its command answers, run and rolled
    back (a review asked of each holder, a decision recorded for each active authority); `to_decide` is exactly the
    authorities the record command accepts; each code is the command's, where the act is done; every package,
    request, submission and decision is shown; and R2 without 2095's keys equals 2086's, run side by side.
  - `opinions()`: L1 is NOT_FOUND to everyone but the assignee who may still read the packet; for them each flag and
    code equals the opinion commands' answer; where L1 is NOT_FOUND neither command accepts; L1 writes nothing.
  - `choices()`: L2 refuses exactly as its command does; otherwise every reviewer the command accepts is listed and a
    listed one is accepted unless the command answers INVALID for them; every finding and minutes listed is accepted,
    and they are R1's scope and the approved minutes (on a restricted request, the approval's); one event with counts
    only per answer, none on a refusal.

  The states: a review the rules require, asked, cancelled, asked again, answered and superseded, submitted and
  decided by two authorities (the board for corrective actions, the CEO for the sanction), with a sanction rule set
  after the submission; a listed reviewer cleared below the case; minutes in review, then approved; an act L2 does not
  know; a review the secretary elects, asked of a committee member who also reviews (cancelled, then refused once they
  lose the reviewer role) and superseded by an opinion that returns the package; a package that waits for an
  authority rule, then goes straight to the authority, which returns it; a taint while a review is open, while an
  answered review waits and while the package is with the authority, and the committee's confirmation; a re-decision
  after a re-vote, with two authorities to the round, that supersedes the earlier round's decisions and freezes their
  corrective action, then a second re-vote after the re-decision; a restricted case before and after its authority's
  approval, with a second approval refused, the approval spent by its request and not carried into the next round,
  approved minutes the approval does not name, and a case owner who loses the Restricted Case Authority; a package
  voted item by item with one item rejected; an allegation withdrawn after its finding was recorded; a proceeding
  closed while the package is with the authority; and the history of each, for the case team, the committee side, a
  reviewer and an administrator.

  Mutation check: 100 mutants of the new SQL, each with one check removed, widened or narrowed, ran against the spec
  on a copy of the database. 82 fail a test. The other 18 cannot change an answer, and stay as defence in depth:

  - Eleven checks that another check already implies:
    - L1 answers only the request's assignee, and only while they may read its packet, so the opinion helpers'
      visibility, assignee, case-gate and packet checks never decide an answer L1 gives (five);
    - an open request keeps its package IN_LEGAL_REVIEW, so a package that passes the adoption check has no review
      open (two);
    - the cancellation's own manage check and the managed-package check refuse the same callers, a request is open
      only on an active case, and R2 gives the cancellation as a boolean (two);
    - the record helper's status check: the authorities still to decide are listed only while the package is with
      the authority, and every answer about recording needs one (one);
    - whoever may read a case's history may see each of its packages (one).
  - Six checks against states no command builds:
    - a case out of ACTIVE with a package between the committee's vote and the authority's decision (the closure
      guard refuses with DECISION_NOT_FINAL, two);
    - an inactive authority type (no command writes `decision.authority_type.is_active`, two);
    - a round with the authority and no submission (since 2030 `api.submit_to_authority` always writes one);
    - the FINAL_DISCIPLINARY_AUTHORITY setting marked SOURCE_REQUIRED with the rule's own authority as its value (no
      command writes `config.setting`, and the seed's value is null).
  - One against rows no command writes: a package event of the history recorded with a reason (the seven package
    events are recorded without one).

  The first run left 40 survivors. 21 of them could change an answer, and the tests now build the states they need:
  a restricted approval spent by its request and not carried into the next round, approved minutes it does not name,
  an approval asked for on a package that is no longer adopted, and an owner who loses the Restricted Case Authority;
  a superseding opinion on an earlier round's request; a member-reviewer whose review is cancelled and who then loses
  the reviewer role, and the caller among the holders of the opinion permission; a package that waits for an authority
  rule; a taint while an answered review waits; a sanction rule set after the submission, minutes still in review and
  an act L2 does not know; two authorities in a re-decision round and a second re-vote after the re-decision; and a
  package voted item by item with an item rejected. Since 2090, `api.withdraw_allegation` withdraws an allegation and
  keeps its findings, so a test now builds one withdrawn after its finding, and the mutant without L2's withdrawn
  check fails it.

  Guards: `api-idor.spec.ts` (L1 and L2 are NOT_FOUND to whoever cannot see the request or package, as for a random
  id), `audit-bypass.spec.ts` (L2 writes its event; L1 is a read), `case-history-roster.spec.ts` (the eight events
  join the history's catalogue), `package-builder-and-invite-choices.spec.ts` (2086's spec compares its own keys only)
  and the policy snapshot.

## Production mapping

Platform-independent SQL; it moves unchanged to RDS PostgreSQL. The holders of `LEGAL_OPINION_GIVE` and the case's
owner come from the CDF corporate IdP and the case's assignments in production (PRODUCTION_SUBSTITUTION_REQUIRED,
CDF-35).

## Requirements

Phase 12 plan §2 (rules 1, 5 and 6) and §4 (P12-3); DEC-02; DEC-19; DEC-62; DEC-F12; DEC-F13; DEC-F19; DEC-F20;
DEC-AMB-003; DEC-AMB-013; AMB-115; AMB-117; AMB-119; ADR-016 D0 and D2; ADR-022; ADR-023; ADR-031; ADR-042; ADR-056;
UX-116; the coordinator's rulings of 2026-10-15 (06:50).
