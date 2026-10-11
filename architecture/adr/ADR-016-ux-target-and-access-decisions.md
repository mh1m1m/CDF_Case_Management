# ADR-016: UX Target Architecture and Approved Access Decisions

- **Status:** Accepted (2026-10-11). D1 is implemented in `20261007001810_restricted_case_authority.sql`; D2 to D6 are approved and not yet implemented (their phase is named in each decision).
- **Decision owner:** Fady, 2026-10-11 12:11 UTC, in the UI/UX audit thread: "IMPLEMENT THE UX REDESIGN", with the decision package recorded here.
- **Source:** CDF-UX-AUDIT v1.0, run 2026-10-10/11 on synthetic data (report `UIUX_AUDIT_2026-10-10.md` and its summary, held in the project files, not in this repository). Decision IDs `DEC-nn`, debt IDs `UX-nnn` and step IDs `S0`–`S6` are the audit's. Its decision register is O17 §17.7; its gates are O28 §28.10.
- **Extends:** ADR-014 (purpose-bound authorization). **Amends:** ADR-013 and ADR-014 on case-history audience (D5). **Unchanged:** ADR-003 (PostgreSQL/RLS, command-only writes), ADR-004 (identity vault), ADR-005 (append-only audit), ADR-006 and ADR-015 (evidence and reporter attachments).
- **Linear:** project "UX Re-Architecture" (epics CDF-88 to CDF-99 = UXR-01 to UXR-12); decision groups CDF-100 (S0) to CDF-108. D1 is CDF-176; the UX-002 verification is CDF-140.
- **Protocol:** §4 (authority), §10–§11 (two apps, BFF), §19–§23 (authorization, roles, identity, portal), §24–§29 (evidence, audit), §39–§42 (notifications, search, bilingual), §65 (definition of done), §82–§83 (errors, logging), §87–§88 (prohibitions, human decisions).

## Context

The audit rated overall UX at 31/100. It found three CRITICAL defects:

- UX-001: a refused command wipes the user's input.
- UX-002: portal forms submit as GET before hydration. CDF-87 fixed this on `main`, but the fix has not yet been verified on a running build.
- UX-003: a restricted case opened at triage is orphaned. Restricted cases are invisible to `CASE_VIEW_ALL`, and nobody with authority over restricted cases was named, so only the creator's 30-day TRIAGE grant could see the case.

It also found the following:

- The access model is inverted for review and committee work. `authz.has_active_grant` ignores grant scope, so 17 to 20 grants made for one purpose (TRIAGE, COMMITTEE, REVIEW) open whole cases.
- Case history is unlabelled and has no audience rule.
- Nobody owns the reporter conversation once a report becomes a case.
- Triage keeps reading evidence after hand-over.

The owner reviewed the audit, approved its target and baseline, and decided the access questions that gate steps S0 to S3.

## Decision

### D0. Target architecture (DEC-33 / HD-S1): work-led, case-homed, purpose-bound «يبدأ من العمل، ويستقر في القضية، ويتقيّد بالغرض»

- **Approved baseline.** The audit, the target synthesis, the debt register, the page inventory, the form-field dispositions and the roadmap. The architecture selection is not re-run. No redesign moves back toward the old page-centric model, and existing screens are not just reskinned.
- **Shell and landing.** There is one authenticated shell with no workspace selector. My Work «أعمالي» is the landing page.
- **Who uses which surface.**
  - The case team works in one case workspace.
  - Everyone else works through purpose routes keyed by the request object: packets, cards and record views.
  - Records, Oversight, Administration and Reporting are separate areas.
- **Navigation (editorial clarification 1).** "A sidebar of at most five items" means at most five visible primary destinations **per user**, not five product areas overall.
  - The possible areas are My Work, Intake, Cases, Committee, Records, Oversight, Administration and Reporting.
  - `api.my_areas()`, or its successor, derives each user's areas from permission and relationship. It never derives them from role name.
- **Delivery order.** S0 safety floor → S1 shell, My Work, read-only Oversight and Administration → S2 case workspace → S3 purpose-bound access → S4 durable work items and notifications → S5 decision half → S6 governance and reporting.
  - The portal track and the design-system foundation run in parallel.
  - Decisions for S3–S6 that this ADR does not record must not stall S0–S2. Each is raised when its gate is reached.
- **Design system.** EVOLVE the system, with a major refactor of page composition. Do not rebuild it. Proof screens PS-1 to PS-7 come first; PS-8 waits for S5.
- **Accessibility target (DEC-52).** WCAG 2.2 AA, checked in CI as part of the shared foundation.
- **Forms.** No prettier replicas of paper forms.
  - Rule: ask once → reuse → derive → auto-populate → confirm only where necessary.
  - Each field takes the audit's disposition: KEEP, AUTO-POPULATE, DERIVE, MERGE, REMOVE, CONVERT-TO-WORKFLOW or CONVERT-TO-COMPONENT.
  - No consequential answer is pre-selected.
  - `SOURCE_REQUIRED` values stay unconfigured until a source exists.
- **Invariants that do not change:**
  - PostgreSQL RLS
  - case ACL
  - purpose-bound authorization (ADR-014)
  - protected identity
  - append-only audit
  - evidence integrity
  - classification and clearance
  - indistinguishable not-found
  - secure search
  - separation of admin from content

  **The database remains the enforcement authority. The frontend explains authorization; it does not replace authorization.**

### D1. Restricted-case authority at creation (DEC-01 / HD-S5). Effective at S0. Implemented.

**Decision.** At case creation:

1. The user indicates restricted handling.
2. Only eligible restricted-case authorities are offered.
3. The user explicitly selects one.
4. The UI previews the access consequence.
5. One transaction does all of the following: creates the case, applies restricted status, assigns the authority as the initial accountable owner, creates the minimum scoped access, records the hand-over and audits.

If no eligible authority exists, creation fails safely and leaves no orphan. Classification options stop at the initiator's clearance.

**As built (`20261007001810`).**

- **New permission** `RESTRICTED_CASE_AUTHORITY`, held by `GRC_DIRECTOR`.
  - `authz.is_restricted_case_authority(user, classification)` decides eligibility.
  - An eligible user is ACTIVE, holds the permission, may own a case (`CASE_MANAGER` or `GRC_DIRECTOR`, the same rule as `case_mgmt.assert_assignee_eligible` for `CASE_OWNER`), and has clearance at or above the classification.
- **`api.list_restricted_case_authorities(report_id, classification)`** returns names only (id, English and Arabic display name).
  - It requires that the caller can see the report, holds `CASE_CREATE`, and asks at or below their own clearance.
  - A hidden report and a random id get the same `NOT_FOUND`.
- **`api.create_case_from_report` gains `p_restricted_authority_id`.** The old five-argument overload is dropped.
  - A restricted case without an authority fails as `INVALID:restricted_authority_id`, and nothing is written.
  - An unknown, inactive or ineligible authority gets the same answer.
  - An authority on a non-restricted case also gets the same answer.
- **On success:**
  - The case is created with `is_restricted = true` and `owner_id` set to the authority.
  - The authority receives one `CASE_OWNER` assignment.
  - No `case_access_grant` row is written for anyone.
  - Audit events `CASE_CREATED`, `CASE_ASSIGNED` and `CASE_HANDED_OVER` are written in the same transaction. The hand-over metadata records `from_user_id`, `to_user_id`, basis `RESTRICTED_AT_CREATION` and `initiator_access`.
- **"Minimum scoped grant", as interpreted here.** The authority's `CASE_OWNER` assignment is the least access an accountable owner needs to staff the case.
  - The initiator keeps nothing, under D3, because a legitimate receiving owner exists and responsibility moved in the same transaction. This is unless the initiator is the chosen authority.
  - Because the source report follows its case (`authz.can_view_report`), the initiator also stops seeing the report.
  - The UI says so before submission.
  - The authority staffs the case with the ordinary assignment and grant commands.

**Rationale.** A restricted case must always have an accountable person who can see it and decide who joins. Naming the authority at creation, in the same transaction, removes the orphan state rather than repairing it afterwards. Returning names only keeps the directory exposure to what the decision needs.

**Security impact.**

- \+ Restricted cases are never orphaned.
- \+ CASE_VIEW_ALL, PLATFORM_ADMIN and the other eligible authority still cannot see the case.
- \+ The initiator has no residual access.
- − Triage staff learn the names of the people eligible to hold restricted cases at a classification. This is accepted as the minimum the choice needs.

**Migration impact.** One non-destructive migration:

- a permission and a role mapping (reference data);
- one internal predicate;
- one read function;
- one replaced command.

No policy changes; existing cases are untouched.

**Required tests (present).** `tests/security/restricted-case-authority.spec.ts`:

- eligible list and names-only shape;
- refusals for a hidden report, no `CASE_CREATE`, and a classification above clearance;
- the single access basis and no grants;
- reachability: the authority can open and staff the case; 14 other roles including the initiator cannot;
- the same `INVALID` for missing, ineligible, revoked and unknown authorities, with nothing written;
- an under-cleared authority is refused;
- over-clearance classification is refused;
- an authority on a non-restricted case is refused;
- the vault is unreachable to the authority;
- the non-restricted path is unchanged.

Also: the IDOR probe and audit-coverage lists, and the policy snapshot.

### D2. Grant scope (DEC-02 / HD-S2), with interim path (e) = (a). Effective at S3.

**Decision.** Enforce grant scope.

- TRIAGE, REVIEW and COMMITTEE are not full-case grants.
- The target model is PURPOSE ROUTE + PURPOSE PACKET + `PACKET_VIEW` (S5).
- **Interim (S3 → S5): form-scoped access in the database authorization model.**
  - COMMITTEE_SECRETARY gets the specific committee form instances it is entitled to.
  - The chair or reviewer gets only the instances they review or approve.
  - REVIEW holders get only their entitled review-form instances, plus the minimum context those instances need.
- Broad grants are not preserved.
- Existing synthetic over-purpose grants are reconciled and migrated auditably, with migration and reconciliation evidence. **Access is never deleted silently.**

**Rationale.** Functional authority must not imply case discovery (ADR-014). The live count of over-purpose grants opening whole cases was 17–20 (audit DEC-02, 2026-10-11).

**Security impact.** Access narrows. In-flight committee and review forms stay completable by their entitled holders through the form-scoped path.

**Migration impact.**

- A scope-aware `authz.has_active_grant` (or a successor predicate).
- Form-instance-scoped access rows.
- A reconciliation migration that records each changed grant, with before and after evidence and an audit event.
- Possibly destructive to existing access, so the reconciliation evidence ships with it.

**Required tests.**

- A TRIAGE, COMMITTEE or REVIEW grant opens no case content outside its scope.
- The entitled holder can still complete an in-flight WB-FRM-13 or WB-FRM-14.
- Everyone else gets the uniform 404.
- The reconciliation report matches the rows changed.
- Audit events exist for every change.

### D3. TRIAGE ends at formal hand-over (DEC-03 / HD-S3). Effective at S3 for ordinary cases; at S0 for restricted creation (D1).

**Decision.** The TRIAGE grant terminates or narrows in the same transaction as formal hand-over. Formal hand-over means a legitimate receiving owner or team exists **and** responsibility has been transferred.

- There is no 30-day residual grant.
- After hand-over, the triage holder has no access to the workspace, evidence, interviews, investigation forms, findings or review material, unless they have another independent relationship to the case.
- Work returned to triage gets a new authorization that is TASK-SCOPED + PURPOSE-SCOPED + TIME-BOUND (a `case_mgmt.case_task`, ADR-014).

**Rationale.** Access must follow responsibility. A grant that outlives the stage is the audit's UX-066/UX-112.

**Security impact.** Access narrows. Returned work is explicit and expires.

**Migration impact.**

- The hand-over command ends the TRIAGE grant in the same transaction.
- Existing residual TRIAGE grants are reconciled under D2's evidence rule.

**Required tests.**

- After hand-over, the former triage holder gets 404 on the case, its evidence, interviews and forms.
- A returned task gives exactly its scope until it expires.

### D4. Reporter conversation (DEC-06 / HD-S17). Effective at S2.

**Decision.**

- **Ownership.** INTAKE/TRIAGE owns the conversation before a case exists. At case creation and hand-over, it transfers to the CASE_MANAGER.
- **Who may communicate afterwards:**
  - the CASE_MANAGER by default;
  - the LEAD_INVESTIGATOR while assigned;
  - an INVESTIGATOR only with an explicit `REPORTER_COMMUNICATE` delegation.

  It is never derived from generic case visibility.

- **Oversight.** GRC has authorised read oversight where required.
- **No automatic thread** for COMMITTEE_MEMBER, COMMITTEE_CHAIR, RECORDS_OFFICER, an unrelated LEGAL_REVIEWER, PLATFORM_ADMIN, DB_ADMIN, INTERNAL_AUDIT or SOC_ANALYST.
- **Identity.** Conversation access does not imply access to protected identity.
- **Interview invitations** to a reporter use the controlled channel and do not reveal identity.

**Rationale.** Today only a TRIAGE grant holder can reply, so the reporter is orphaned once a case exists (UX-026).

**Security impact.**

- Communication becomes a named, delegable capability rather than a side effect of visibility.
- The vault boundary (§22) is unchanged.

**Migration impact.**

- A conversation-ownership model on the report or case.
- The `REPORTER_COMMUNICATE` delegation.
- A replacement reply command checked against them.

**Required tests.**

- Each listed role can or cannot read and send, exactly as above.
- A delegated investigator can; an undelegated one cannot.
- No conversation path returns identity fields.
- An invitation sent through the channel carries no identity.

**Implementation (S2, migration 1840).** Two permissions: `REPORTER_CONVERSATION_HOLD` (Case Manager) and `REPORTER_CONVERSATION_OVERSEE` (GRC Director). `authz.is_reporter_correspondent(case)` is case visibility plus one of: the HOLD permission, an active CASE_OWNER or LEAD_INVESTIGATOR assignment, or an active INVESTIGATOR assignment with an active delegation in `case_mgmt.reporter_communication_delegation`. `authz.can_message_reporter(report)` and `authz.can_read_reporter_conversation(report)` apply it once the report has a case and keep the intake rule before it; the `report_message_read` policy, `api.reply_to_reporter`, the message events of `api.case_history` and My Work's "the reporter replied" all use them. The case owner is a correspondent as well as the lead: a restricted case's owner is its named authority (D1), whom the Case Manager cannot see, so without it a restricted case's reporter would have nobody to write to. `api.delegate_reporter_communication` and `api.end_reporter_communication` are for `authz.can_assign_case` holders and are audited; an investigator's delegation ends, audited, in the transaction that ends its assignment, so a later assignment never revives it. Delegations are never deleted and none is added after archiving. The case's Reporter tab is shown only to the conversation's readers, and the intake page tells everyone else that the conversation moved to the case team. Tests: `tests/security/reporter-conversation.spec.ts`; `tests/e2e/case-workspace.spec.ts`. Not yet built: interview invitations to the reporter through the channel, which arrive with the interview work in S3.

### D5. History audience, access roster and legal-hold indicator (DEC-08 + DEC-10 / HD-S6, HD-S16). Effective at S2.

**Decision.**

- **Access roster.** CASE_MANAGER, LEAD_INVESTIGATOR and GRC_DIRECTOR, when they themselves have authorised access, see the full operational roster: user, relationship, assignment or grant type, purpose, effective date, expiry and status.
  - Ordinary participants see their own access basis and expiry, plus the operational team.
  - They do not see break-glass, identity-reveal, security/oversight, exceptional admin or restricted grants.
  - Oversight roles get access information through the Oversight area.
- **Case history.** History is business-readable and filtered by ACTOR ACCESS + ACTION AUDIENCE + OBJECT ENTITLEMENT + CLASSIFICATION.
  - Page-view events leave case history. They remain available through Oversight/audit.
  - Form, evidence, records, reporter-communication and legal-hold events respect the audience of their object.
- **Legal hold.** "LEGAL HOLD ACTIVE" may be shown to authorised case-team users where it changes permitted handling.
  - Requester, rationale, strategy, deliberation and privileged notes are limited to LEGAL_REVIEWER, RECORDS_OFFICER, GRC_DIRECTOR or a specifically authorised purpose holder.

**Rationale.** History is the case team's working memory, but today it is unlabelled noise (UX-011) and ignores who may know what (UX-092).

**Security impact.** Narrows what history shows. The ledger is unchanged and append-only; this is a read-model audience, not a deletion.

**Migration impact.**

- An action-audience catalogue.
- A history read function or view that applies the four filters.
- A roster read function.
- No change to `audit.audit_event`.

**Required tests.**

- Per role, the roster shows exactly the fields and grant types above.
- History omits page views and every event whose object the viewer is not entitled to.
- The hold indicator shows without the hold's details.
- Oversight still reads the full ledger under its own permission.

**Implementation (S2, migration 1830).** `api.case_history(case, limit)` and `api.case_access_roster(case)`; the action-audience catalogue is an allowlist inside `api.case_history`, so an action not in it never reaches history. The full-roster audience is `authz.can_assign_case` (Case Manager and GRC Director with access to the case, or its assigned lead or owner). Purpose tasks are left out of the roster: a legal task would reveal a hold request to people outside the hold audience. Tests: `tests/security/case-history-roster.spec.ts`. Known gap: the `audit_event_read` table policy is unchanged, so direct SQL by the case team still reads every `BUSINESS` row of a case it can view; the application reads history only through `api.case_history`, and narrowing the policy is a follow-up decision.

### D6. Evidence need-to-know (DEC-09). Effective at S2.

**Decision.**

- Intake/Triage gets only the attachments and information it needs for completeness, screening, jurisdiction and initial triage. That access ends at hand-over.
- The investigation team's access is subject to relationship, classification and clearance, need-to-know, and evidence-specific restrictions.
- Legal, GRC, Committee and Decision users get only the evidence deliberately linked in their purpose packet.
- Records gets metadata only, for retention, hold, preservation and disposition. It gets no content and no download.
- Enforced in RLS/authz (`authz.can_view_evidence` and the download path), not by hiding UI.

**Rationale.** Triage reads the full evidence register today (UX-072).

**Security impact.** Access narrows; downloads are gated again at the server.

**Migration impact.**

- A need-to-know clause in the evidence predicates.
- An evidence-restriction attribute.
- A packet-link table at S5.

**Required tests.**

- Each role, before and after hand-over, sees exactly the evidence above.
- Records gets metadata but `NOT_FOUND` on content and download.
- An unlinked item is invisible from a packet.

### D7. CDF-87 / UX-002 stays open until verified (editorial clarification 2; DEC-59)

The POST fix is verified on a running build, covering:

- no-JS behaviour;
- no sensitive query string;
- report submission;
- follow-up credential handling;
- request and log behaviour.

UX-002 is re-rated only after that.

**Status 2026-10-11.** A local production build of `7d10259` passes all five points for confidentiality: every portal form sends POST with JavaScript off and before hydration, and no report text, Report ID or secret reaches a URL, Referer, redirect, history entry or log (`tests/e2e/portal-no-js.spec.ts`). Two things keep UX-002 open:

- the hosted check is not done (the deployment URL was unreachable from the build environment);
- without JavaScript a report or follow-up sign-in is dropped silently, with no message to the reporter.

## Delivery governance

- **Unit path.** Every unit of work follows Requirement → Decision → Linear → Branch → PR → Test → Hosted validation. Delivery goes through the redesign epics and coherent capabilities, not one ticket per debt item.
- **Checks after every major stage:**
  - the relevant automated suites;
  - Arabic and English;
  - desktop and mobile;
  - negative authorization tests;
  - an updated UX debt crosswalk;
  - re-scoring of only the dimensions materially affected;
  - before-and-after evidence.
- **Merging.** Merge to `main` needs an authorised human.

## Consequences

- S0 and the shared foundation start at once. S1 and S2 follow without waiting for S3–S6 decisions.
- D2–D6 each need their own migration, allocated one at a time above the highest number on `main`, plus a security review before merge.
- **Still OPEN.** These decisions are not made here. Each is raised when its gate is reached (audit O28 §28.10):
  - DEC-22 (My Work row fields, S1);
  - DEC-47, DEC-20, DEC-16, DEC-14, DEC-29 and DEC-32 (S1);
  - DEC-54, DEC-37, DEC-38, DEC-40, DEC-41 and DEC-25 (S2);
  - DEC-04, DEC-05, DEC-19, DEC-31, DEC-35, DEC-49 and DEC-50 (S3);
  - the S4–S6 and portal-track decisions;
  - DEC-59 and DEC-60 (verification).

## Production mapping

The decisions are platform-independent and move unchanged to RDS PostgreSQL and the CDF corporate IdP. Two items depend on the identity source:

- Eligibility for `RESTRICTED_CASE_AUTHORITY` and the `REPORTER_COMMUNICATE` delegation come from the CDF Delegation of Authority (SOURCE_REQUIRED).
- Their holders come from the CDF IdP's role claims (PRODUCTION_SUBSTITUTION_REQUIRED, CDF-35).

## Requirements

§19 (authorization enforced twice), §21 (admin roles never imply content), §22 (identity vault), §24–§27 (evidence), §29 (audit in the same transaction), §40 (authorise before results), §65 (definition of done) and §88 (human decisions: recorded here).
