# ADR-016: UX Target Architecture and Approved Access Decisions

- **Status:** Accepted (2026-10-11). D1 is implemented in `20261007001810_restricted_case_authority.sql`. D4, D5 and D6 are implemented on the S2 branch (migrations 1840, 1830 and 1850), D6 up to the S5 packets. D2 and D3 are implemented on the S3 branch (`20261007002020_purpose_bound_grant_scope.sql`, CDF-179), as described under each decision and in the S3 amendment below. D8 (DEC-37, decided 2026-10-12) is implemented on the S2 branch (migration 1860), with routing for cases the shared queue cannot take, up to the S4 work item.
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

**As built (S3, `20261007002020`).**

- **Scope decides.** `authz.has_active_grant` counts CASE and AUDIT grants, and a TRIAGE grant only while the case is before hand-over (`authz.case_before_handover`: a state before `JURISDICTION`; a workflow without that state has no triage stage, so the grant opens nothing). COMMITTEE and REVIEW grants open no case. Every predicate built on it narrows with it, including case view, the records catalogue and the classification change.
- **No new over-purpose grants.** `api.grant_case_access` accepts CASE and AUDIT only. A table trigger refuses a COMMITTEE or REVIEW insert by any path (`CDF_INVALID:scope`). The column check keeps the codes, so reconciled rows keep their original scope. Committee and legal-review work needs no grant: it runs through the referral, meeting, packet and legal-review commands (1870–1920), under DEC-61/DEC-62 for restricted cases.
- **Interim path (a), for legacy instances only.** `case_mgmt.form_instance_access` keeps, for the holder of a reconciled COMMITTEE or REVIEW grant, each in-flight form instance of that case that their roles may view and their clearance covers. It opens that instance only (`authz.has_form_instance_access`, `authz.can_view_form_instance`, `authz.can_prepare_form_instance`); review and approval follow the existing form entitlements. It never opens the case: `api.open_case` answers false, and the case, its parties, team, evidence, interviews, findings and proceedings stay hidden. The row stops counting when the instance is final or withdrawn, or the case leaves `ACTIVE`. The case gate (`authz.user_case_gate`: active user, clearance, no conflict, not a linked subject or grievant) applies throughout, so an upheld conflict closes a kept form without deleting its row (DEC-F38).
- **Findings.** `finding_read` also needs a case-file basis (`authz.has_case_file_basis`), so a TRIAGE grant before hand-over shows no findings.
- **Reconciliation.** `case_mgmt.reconcile_grant_scope()` runs once inside the migration. It is owner-only; no application role may execute it. It ends every over-purpose grant in effect or scheduled (TRIAGE past hand-over, every COMMITTEE and REVIEW grant). Ending a grant never deletes it:
  - status `REVOKED`, with its time and reason;
  - one `CASE_ACCESS_REVOKED` event per grant, actor type `SYSTEM`, metadata basis `GRANT_SCOPE_RECONCILIATION` with the outcome and the kept instance ids;
  - one row per grant in `case_mgmt.grant_scope_reconciliation` (before and after status and end date, outcome `ENDED` or `NARROWED_TO_FORM_INSTANCES`, forms kept, the audit event id). The table is append-only, RLS-enabled and read by no application role.

  The migration then checks its own result and fails if any over-purpose grant is still in effect, or if the report and the audit events disagree. A second run finds nothing. Locally the migration runs before the seed, and the seed no longer creates committee grants, so it changes nothing there. On a hosted database it reconciles the live rows, and the report is the evidence.

- **Where a kept form opens (UX).** A kept form is reached from My Work on its own purpose route, `/my-work/forms/[instanceId]`. This deviates from RC-24's case-route wording, because a case route would name the case. The page says "You are seeing one form, not the case file" «تعرض نموذجًا واحدًا، لا ملف القضية»; its breadcrumbs lead to My Work, and it shows no case number. A viewer who may see the case is redirected to the case route. My access lists the form as "One form (not the case)" «نموذج واحد (لا القضية)», with no case number unless the viewer may see the case metadata, and links each row to its form (`api.my_access` gains a last column, `target_id`), because forms with the same number on different cases would otherwise read alike. The case roster shows each kept form to the full-roster audience (DEC-08/10). Both read models encode the form as `<form code>:<instance no>` (`parseFormAccessCode` in `@cdf/domain`).
- **Tests.**
  - `tests/security/grant-scope.spec.ts` covers: no access before reconciliation; command and table refusals; findings; hand-over (including close at screening and the restricted receiving owner); the reconciliation report, events and idempotency; each holder's exact part on a kept form; a conflict closing kept forms; immutability; the read models; reassignment (T-AMB-005).
  - Existing specs were updated for the narrower model.
  - `tests/e2e/purpose-bound.spec.ts` and `tests/accessibility/purpose-bound.spec.ts` cover the purpose route in Arabic and English and at 320 px.

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

**As built (S3, `20261007002020`).**

- **The hand-over transitions** are the two that leave the triage stages: `COMPLETE_TRIAGE` (TRIAGE → JURISDICTION) and `SCREEN_OUT` (SCREENING → CLOSURE). `case_mgmt.hand_over_from_triage` runs inside the transition itself (`workflow.apply_transition`), in the same transaction. It ends every TRIAGE grant on the case, with one `CASE_ACCESS_REVOKED` event per grant (actor: the person who moved the case; metadata basis `HANDOVER`).
- **Receiving owner.** For an ordinary case, the receiving team is the case-management function, which always exists (`CASE_VIEW_ALL`), and the transition itself is the transfer of responsibility. A restricted case is hidden from that function, so it is handed over only when an owner or investigator assignment, or a CASE grant, is held by someone the case gate admits. Otherwise the transition is refused with `CONFLICT:HANDOVER_NO_RECEIVING_OWNER`.
- **Residual grants.** TRIAGE grants already past hand-over are reconciled under D2's evidence rule.
- **Reassignment (AMB-013).** `api.reassign_case` already ends the outgoing assignment in its own transaction, audited `CASE_REASSIGNED` with `from_user_id` and `to_user_id`. That is the built equivalent of the register's `CASE_HANDED_OVER` wording. With the triage residue closed, the former assignee keeps nothing unless an independent relationship (for example a CASE grant) exists. Drafts stay with the case, and the new assignee continues them. Test T-AMB-005 is in `tests/security/grant-scope.spec.ts`; the register named a new `authz-purpose-bound.spec.ts`.
- **Returned work.** No workflow transition returns a case to a triage state, and the case-task types are LEGAL and RECORDS only. So nothing is built for returned triage work. When a return path is designed, it is a `case_mgmt.case_task` (ADR-014), and its capabilities are decided then.
- **In the UI.** Each hand-over step says before it is taken: "This step hands the case over from triage: triage access to it ends now, and the case team carries it on." «تُسلِّم هذه الخطوة القضية من الفرز: ينتهي وصول الفرز إليها فورًا، ويتابعها فريق القضية.» The close-at-screening confirmation names it too.

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

**Implementation (S2, migration 1850).** `evidence.evidence.restriction` is `TEAM` (the default) or `LEADS`. `authz.is_evidence_team(case)` is case visibility plus one of: `CASE_EDIT_ALL` (Case Manager), an active CASE_OWNER, LEAD_INVESTIGATOR or INVESTIGATOR assignment, an active CASE-scope grant, or an active break-glass. `authz.is_evidence_lead(case)` is case visibility plus `CASE_EDIT_ALL` or an active CASE_OWNER or LEAD_INVESTIGATOR assignment; break-glass never reaches a `LEADS` item. `authz.can_view_evidence(item)` keeps the clearance check and adds the item's restriction, so every evidence policy, `api.open_evidence_version` and the evidence events of `api.case_history` follow it, and `api.register_evidence_version` now refuses a new version of an item the caller cannot see. Seeing the case is not enough: TRIAGE, COMMITTEE, REVIEW and AUDIT grants, a REVIEWER assignment and `CASE_VIEW_ALL` alone give no evidence. `api.set_evidence_restriction(item, restriction, reason)` is for the leads, needs a reason, is audited (`EVIDENCE_RESTRICTION_CHANGED`) and refuses to open an item on an archived case. Reporter attachments follow `authz.can_view_report_files(report)`: the intake rule before a case, then the team or an active TRIAGE grant holder (listing only, since download needs `EVIDENCE_DOWNLOAD` once a case exists); D3 ends the TRIAGE grant at hand-over in S3, which ends that last triage path. Records keeps its metadata (disposition manifests, evidence-scoped holds) through the records functions and gets nothing from the evidence tables. The case's Evidence tab shows the register only to the team, reporter files to their readers, and is hidden from everyone else. Tests: `tests/security/evidence-need-to-know.spec.ts`, `tests/security/evidence-access.spec.ts`, `tests/security/reporter-attachments.spec.ts`; `tests/e2e/evidence.spec.ts`. Not yet built: packet links for review, committee and decision users (S5), which today get no evidence at all.

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

**Update 2026-10-11, `main` at `0034f47` (after #51).** On a local production build of `main`, a report and a follow-up sign-in without JavaScript now answer in the POST response with the receipt and the status page, in Arabic and English. All five points pass again (the repository's no-JS and portal specs, 15 of 15, and a request and log scan). Two items remain:

- UX-002 stays open for the hosted check, which still could not be reached from the build environment;
- reloading the receipt page re-submits the report, which is CDF-146.

### D8. Archive triggers retention review in a shared Records queue (DEC-37, in part). Effective at S2; durable work item at S4.

**Decision owner.** Fady, 2026-10-12 03:54 UTC, in the UI/UX audit thread, answering the DEC-37 card ("Other: queue now, durable shared-pool task at S4").

**Decision.** Archive triggers retention review; routing is to the Records shared pool, not a fixed individual. Retention periods remain source-required. DEC-37 is separated into five parts:

| Part                                                                    | Status                                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1. Trigger: archiving creates a retention-review obligation             | APPROVED                                                                                |
| 2. Routing: the shared Records queue (pool)                             | APPROVED                                                                                |
| 3. Named assignee: only by claim or assignment after the item is queued | APPROVED                                                                                |
| 4. Retention classes and periods                                        | SOURCE_REQUIRED until the governing CDF policy is confirmed (ADR-013 D2)                |
| 5. Who may archive                                                      | OPEN. Today: `WORKFLOW_ADVANCE` on the case (Case Manager or Lead), a prototype default |

- **Now (S2).** When a case enters `ARCHIVED`, it appears in Records work as "Retention classification required" «بانتظار تصنيف مدة الحفظ». The item is derived from the case's state. It creates no individual assignment, no routing rule and no implied owner, and any authorised records officer may pick it up.
- **S4.** A durable `RETENTION_REVIEW` work item in the pool `RECORDS_RETENTION_POOL` replaces the derived entry: archive, item created, an authorised officer claims it or is assigned it, classification, item completed. No hard-coded rule chooses an officer. Individual ownership comes only from a claim or from an approved workload rule.
- **Legal hold.** A hold overrides destruction and disposition, not classification. A held case may be classified, but no disposition eligibility may mature into execution while the hold is active.
- **What Records sees.** Case number, classification, archived date, retention class status, the legal-hold indicator where the viewer may see it, the age in the queue, and one action: "Review retention classification". The item grants only the records purpose needed to classify: never `CASE_VIEW_FULL`, evidence, interviews or findings.

**Implementation (S2, migration 1860).**

- **The obligation.** `records_state = 'ARCHIVED'`. The case is archived and its class is not yet confirmed; the shipped default class is `UNASSIGNED`, which stands for "no class". Confirming a class (`api.assign_retention_class`) moves the case to `RETENTION`, which ends the obligation. A legal hold never stops that command.
- **The pool.** `api.retention_review_queue()` returns the case to anyone who may classify it from the records catalogue: the catalogue scope (closed, not restricted, within clearance, no conflict) together with `ARCHIVE_RECORD_ADMINISTER` and `RETENTION_CLASS_ASSIGN`. That is the shared branch of `authz.can_manage_retention`. The rows carry lifecycle metadata only.
- **My Work.** `api.my_work_items()` adds one `RETENTION_CLASSIFICATION` item per queued case in the Records area. The item links to the record's retention form, which re-checks the purpose.
- **An existing task.** A `RETENTION_REVIEW` case task (ADR-014) is an individual assignment, so its holder sees the task instead of the queue item.
- **Cases the pool cannot take.** A restricted case never enters the shared queue (ADR-014 §9), and a case above every records officer's clearance, or one every officer is conflicted on, has nobody in the pool. So that no archived case waits unseen (the security review's follow-up to D8), such a case goes to the person who may create records tasks on it (`case_mgmt.may_manage_tasks`; for a restricted case, its DEC-01 Restricted Case Authority):
  - `authz.can_route_retention_review(case)`: the case is `ARCHIVED`, the caller may create records tasks on it, `records.retention_pool_can_take(case)` is false, and nobody holds a `RETENTION_REVIEW` task on it that they can still use;
  - `api.my_work_items()` gives that person one `RETENTION_TO_ROUTE` item in the Cases area, linked to the record's routing form;
  - `api.list_retention_reviewers(case)` lists the officers `api.create_case_task` would accept (eligible role, active, cleared, no conflict, no open task of this type on the case), names only; an empty list says that no officer can take the case yet, and the item stays until one can;
  - the person chooses one officer, and `api.create_case_task(case, 'RETENTION_REVIEW', officer, purpose)` gives the task (audited `CASE_TASK_ASSIGNED`). A person routes; no rule chooses the officer, as part 3 requires;
  - a cancelled or lapsed task brings the item back.
- **Completing the review.** Classifying is the outcome of a retention review, so `api.assign_retention_class` also completes the caller's own open `RETENTION_REVIEW` task on the case (audited `CASE_TASK_COMPLETED`). The task leaves their work and its access ends with it; the record page then returns them to Records with a notice.
- **Tests.** `tests/security/retention-review-queue.spec.ts` (RRQ-01 to RRQ-15) covers:
  - archiving creates exactly one item, the same for every officer;
  - archiving twice creates no second item;
  - nobody else gets it, and clearance, restricted cases and another officer's task are respected;
  - lifecycle metadata only, no case content;
  - a hold keeps the item and classification still works;
  - disposition stays blocked under the hold;
  - classifying records the class and closes the item for everyone, audited;
  - a restricted case goes to its authority, who routes it to one eligible officer; the task stands for the item, opens no content, and completes with the class, audited;
  - a case the pool can take is never routed;
  - above every officer's clearance, the authorities are told no officer is eligible, and the task command refuses one;
  - the reviewer list refuses everyone else, and a cancelled or lapsed task brings the item back;
  - classifying completes only the classifier's own task; another officer's task on the case stays open;
  - a task whose holder has lost the role or the clearance no longer stands for the obligation, so the item comes back.

## S3 amendment: statuses under the business architecture rebase (2026-10-13)

The rebase (owner Q&A of 2026-10-12, ADR-017 to ADR-039) changed what several UX-plan items and audit decisions mean. The statuses below are a **coordinator ruling from the owner-confirmed Q&A, 2026-10-12** (gap map `UX_S3_PLUS_GAP_MAP.md` §2 and §4, in the project files). They are not owner decisions; where the owner has decided, the row says so. The audit's own register (O17 §17.7) is unchanged.

| Item                                                             | Status                                                                                                                                                                                                                   | Basis                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| RC-24: grant scope, TRIAGE ends at hand-over, form purpose check | KEEP, REBASED. Built here (D2, D3).                                                                                                                                                                                      | Coordinator ruling                                                                     |
| RC-24 interim path (a)                                           | KEEP, for legacy in-flight WB-FRM instances only. Built here.                                                                                                                                                            | Coordinator ruling; DEC-02 (e)                                                         |
| RC-24 `finding_read`                                             | Narrowed here, not in the rebase stream.                                                                                                                                                                                 | Coordinator ruling                                                                     |
| RC-25: form framework and catalogue conversion                   | SUPERSEDED for the catalogue (ADR-028, ADR-029); KEEP for the framework (the 2 remaining user-entered forms).                                                                                                            | Coordinator ruling                                                                     |
| New WB-FRM-13 to 19 instances refused from S3                    | SUPERSEDED: the committee work is in the rebase commands (1870–1920). Form definitions are untouched; no WB-FRM artifact is retired until DEC-F34's conditions hold.                                                     | Coordinator ruling; DEC-F34 (owner, 2026-10-13)                                        |
| DEC-05 independence                                              | Split. Committee part ANSWERED (Q45–Q46, N9, ADR-024). Four parts OPEN for S3: approver differs from preparer; universal declarations; transitions blocking on an undecided conflict; the named-access conflict decider. | Coordinator ruling                                                                     |
| DEC-30 committee process                                         | ANSWERED (Q21–Q57, ADR-018 to ADR-020). The recusal decider is rule-set configuration, SOURCE_REQUIRED.                                                                                                                  | Coordinator ruling                                                                     |
| DEC-34 / HD-S9 phases 9–10                                       | SUPERSEDED by the proceeding model and the multi-dimensional status (ADR-017, ADR-029). The Delegation of Authority stays SOURCE_REQUIRED.                                                                               | Coordinator ruling                                                                     |
| Audit DEC-62 / HD-S15 (new entities)                             | ANSWERED by ADR-017 to ADR-023. Not the project's DEC-62 (ADR-022).                                                                                                                                                      | Coordinator ruling                                                                     |
| DEC-68 referral before a meeting                                 | DISSOLVED: referral is `api.refer_case_to_committee`.                                                                                                                                                                    | Coordinator ruling                                                                     |
| DEC-31 catalogue conversion                                      | NARROWED to the 2 remaining user-entered forms (portal report, grievance submission).                                                                                                                                    | Coordinator ruling, accepted provisionally                                             |
| DEC-35 option codes                                              | Placeholders stay SOURCE_REQUIRED; no code is inferred.                                                                                                                                                                  | DEC-F35 (owner, 2026-10-13)                                                            |
| DEC-50 rule values                                               | Configurable, values SOURCE_REQUIRED.                                                                                                                                                                                    | Coordinator ruling; consistent with DEC-F02, F08, F14, F18 and F25 (owner, 2026-10-13) |
| DEC-37 retention review                                          | Partly decided by the owner (D8); parts 4 and 5 open as D8 records.                                                                                                                                                      | Owner, 2026-10-12 (D8)                                                                 |

**Consistency with the owner's finalization set (DEC-F01 to F41, 2026-10-13).**

- DEC-F19 and DEC-F20: a COMMITTEE or REVIEW grant can no longer be created and opens nothing. So no grant can bypass the Restricted Case Authority approval that referral and legal review of a restricted case need.
- DEC-F07: S3 adds no witness or meeting entitlement. A kept form opens one form, nothing of the meeting.
- DEC-F38: a conflict suspends the affected purpose access, never the user. Kept forms close through the case gate and their rows stay.
- DEC-F34: no form is retired. Path (a) keeps in-flight legacy instances completable.

**Still open for the owner at the S3 gate.** DEC-04 (who prepares, reviews, approves and withdraws each form), the four open parts of DEC-05, DEC-19 (snapshot module content or reference it) and DEC-49 (which forms gate which transitions). S3 decides none of them; today's form entitlements and transition rules are unchanged.

## S4 amendment: notifications in the shell (Phase 12 P12-0a, 2026-10-13)

The shell gains the notifications the rebase queues (ADR-025, migration 1920). No migration: the screens read and
write only what 1920 already grants.

- **Bell.** The header carries a link to the caller's notifications with their own unread count (RC-06). It is never
  a case count, and its accessible name carries the count.
- **List.** Each notice shows its template wording, its kind and when it arrived, newest first, in two views (all,
  unread). A notice links to its page only once that page has shipped (`LIVE_PURPOSE_ROOTS`, empty until the
  Phase 12 purpose routes land, and shared with My Work since migration 2045), so nobody lands on a missing page; the
  page re-checks access. Marking read calls
  `api.mark_notification_read`; another user's id answers the uniform NOT_FOUND and is recorded as a refusal.
- **Settings.** Mandatory notices are listed as always sent and have no control. Each optional notice has a box per
  channel where the platform-wide rule sends it (or where the caller muted it earlier). All changes save in one
  transaction through `api.set_notification_preference`, so a refused change leaves every setting as it was. Email
  is the ADR-025 stub (PRODUCTION_SUBSTITUTION_REQUIRED).
- **Where access is enforced.** Reads are RLS selects on `notify.*`: own in-app rows and own mutes only; the template
  catalogue and the rules hold no content. Commands are `api.*` and audit `NOTIFICATION_READ` and
  `NOTIFICATION_PREFERENCE_SET` in the same transaction.
- **Known limitation.** A committee's own default (`COMMITTEE_DEFAULT`) that turns a notice on for one committee is
  not shown per committee. Where the platform-wide rule sends nothing the page offers no box, so a caller cannot mute
  such a notice in advance; they can once it is on.

Shared pieces the Phase 12 screens build on (no migration, no new command):

- **Consequence preview.** The confirmation dialog (ADR-030) can also say who is told and list facts the command
  will record. The page passes only what the caller may already read; the database still decides.
- **Workflow guide.** A step path, what happens now, who acts next and whether the caller can act. The action form
  renders only when the server says the caller can act; the command re-checks.
- **Purpose banner.** Says why a purpose-bound view shows what it shows and what it leaves out (D2). It explains
  access; it does not grant it.
- **Configured value.** Shows a rule value with its source; a SOURCE_REQUIRED or unset value is marked as such, never
  presented as decided.
- **Unsaved changes (AMB-243).** A long form (draft case form, interview statement) asks before the user leaves by a
  link or closes the page with changes not saved. An untouched or saved form never asks.

## P12-1 amendment: case structure on the case (Phase 12, 2026-10-13)

The case gains the structure the rebase built in migration 1870 (ADR-017 to ADR-019), on two tabs. No migration and no
new command: the screens call the 1870 `api.*` commands, which check access again and audit in the same transaction.

- **Allegations tab.** Who the case is about, what is alleged about each of them, and what each proceeding found. A
  case editor names a person (synthetic labels only), adds an allegation and ties one to a person with optional policy
  and law references. A finding is recorded for one allegation and one person (or the allegation as a whole when it is
  tied to no one) in one open proceeding; recording again adds a version, and earlier versions stay on record.
- **Governing finding (AMB-029).** The committee proceeding's current finding is the one the decision uses. The tab
  marks it, keeps the investigation's findings on record, and says so while there is none.
- **One path per person (AMB-105).** Each person shows their own progress: allegation recorded, finding recorded,
  committee finding. A step is done only when every allegation about them has reached it. Decision, notice and
  grievance join that path in later Phase 12 screens.
- **Proceedings tab.** Open a proceeding, change its state (waiting and suspension reasons), close it after a
  confirmation. A type that already has an open proceeding is not offered unless it may run in parallel; reason codes
  are the active database codes this version knows; outcomes leave out the codes DEC-F10 does not offer.
- **Referral (ADR-018).** Only the Investigation Committee is offered here; a grievance committee proceeding comes
  from a grievance (ADR-024). The parent defaults to the latest investigation (ASK ONCE, DERIVE). A workflow guide
  says what the referral waits for, who acts next and whether the caller can act.
- **Restricted case (DEC-61).** The referral waits for the case owner's approval as Restricted Case Authority. Only the
  owner sees the approval form; the database ties the approval to the owner's eligibility and lets one approval serve
  one referral. Others see who acts next. Anyone off the restricted team gets the same 404 as a missing case.
- **Preliminary review first (AMB-018, migration 2030).** A case that did not arrive as a direct referral or grievance
  reaches the Investigation Committee only once its latest approved preliminary recommendation refers it there; the
  database refuses any other referral (PRELIMINARY_REFERRAL_REQUIRED). The guide shows that step first and reads it as
  the database does, over the rows RLS returns to the case team. The approval and referral forms appear only after it;
  an approval already given still shows as given. The preliminary review's own screens are P12-4.
- **Committee at referral (DEC-F19).** The copy taken at referral is shown as counts per seat, voting members, members
  without a vote under the firewall and members not cleared for the case, with the rules in force then and their
  source. It never names a member, and later changes to the committee do not reach it.
- **Where access is enforced.** The tabs are case-homed: they read case-team data inside the case as RLS selects in the
  caller's own context (`case_mgmt.*`, the committee proceeding as `authz.can_view_committee_proceeding` allows, and
  seat counts with no member ids). Findings show only with a case-file basis (S3 `finding_read`). They are not purpose
  views, so the coordinator ruling that purpose views read DB read models behind the shared gate (P12-0b, migration
  2045, ADR-051) does not apply to them. Forms show only where the command would be accepted; every command checks
  again.
- **Known gaps, closed by migration 2045 (ADR-051).** (1) What a referral would copy now: the referral step and the
  restricted referral approval show the members in office as holders per seat and four totals (voting, cleared, not
  cleared, firewall restricted), behind the referral command's own checks, and the confirmation repeats the totals;
  never an id, a name or a flag per seat (coordinator ruling, 2026-10-14). (2) The case history lists the 1870 events
  as codes and times, each to whoever may read what it is about, and the restricted referral approval only to the
  case owner as Restricted Case Authority and whoever recorded it. The stage on the overview does not move with these
  tabs yet; its pending actions point to them.

## Phase 12 owner decisions (2026-10-13)

The owner decided the whole Phase 12 owner pack on 2026-10-13 at 14:43 UTC, and DEC-AMB-013 at 14:40 UTC. His
messages are the record. They are quoted in full in the Phase 12 plan (project files,
`uiux/impl/phase12/PHASE12_PLAN.md`, appendices A and B), and the owner-decision register and the rebase ADRs record
them through the rebase thread. This amendment says only what each decision means for the UX target; where it and his
text differ, his text governs. None of these rows is open any more.

| Decision                            | For the UX target                                                                                                                                                                                                                                                                                            | Built in                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| DEC-04 Form RACI and withdrawal     | Capability-based RACI stays. A draft is withdrawn under normal draft handling. After formal submission, a withdrawal request records who asked, when, why, the workflow state and the accepting authority where one is required. Nothing is erased, and a proceeding that has materially begun is not ended  | Migration 2150 (ADR-052)                       |
| DEC-05, four open parts             | Today's rules stay. Only a specific contradiction with a later confirmed decision, a security invariant or a purpose-bound rule is raised                                                                                                                                                                    | No change                                      |
| DEC-19 Snapshot or reference        | Decision-relevant data is snapshotted at material events; live reference stays only for non-material metadata where safe. A snapshot never widens who may read a module's content                                                                                                                            | Each screen that shows a completed decision    |
| DEC-49 Form gating and ownership    | Today's gates stay. Work belongs to the case, proceeding, task or action owner, never to a form; the 274-form catalogue is a control catalogue                                                                                                                                                               | No gate change                                 |
| DEC-22 My Work row fields           | Approved as built (S1, S3): action label, object id, a non-sensitive code or type, status, dates and priority where authorized or configured; the case number only with case-metadata visibility; never a subject name, allegation text, reporter identity, sensitive title or a restricted case's existence | Migration 2045 adds the form code to form rows |
| DEC-18 Server-side drafts           | Controlled server drafts for authenticated internal users, purpose-bound, under the owner's requirement list. Never for anonymous or unauthenticated flows, evidence binaries, or where an approved security rule forbids them. Restricted-case gates apply                                                  | Migration 2150 (ADR-052)                       |
| DEC-48 Finding vocabularies         | Governed, effective-dated vocabularies; SOURCE_REQUIRED where no authoritative source exists; an authorized OTHER finding only with a mandatory rationale; additive, so recorded findings keep their codes                                                                                                   | Migration 2150 (ADR-052)                       |
| DEC-51 Hijri dates                  | Gregorian first and Hijri second on formal generated records only; storage stays canonical; the platform's Umm al-Qura calendar, never a hand-written conversion                                                                                                                                             | Application only: P12-9 (a), CDF-209           |
| DEC-11 Oversight free text          | The general free-text field stays hidden; a controlled `OVERSIGHT_NOTE` where narrative is genuinely needed                                                                                                                                                                                                  | Migration 2160 (ADR-053)                       |
| DEC-12 Dual control on grants       | Dual control on grants that materially expand access; the requester never approves; no self-approval; revocation is never delayed                                                                                                                                                                            | Migration 2160 (ADR-053)                       |
| DEC-13 Clearance command, owner     | A dedicated `CLEARANCE_ADMIN`: elevation approved, lowering immediate, history kept. Its organisational owner is SOURCE_REQUIRED, so it stays fail closed until a holder is configured. `ROLE_ADMIN`, technical and committee administration never change clearance                                          | Migration 2160 (ADR-053)                       |
| DEC-36 Reporting role and KPIs      | Explicit reporting permissions and aggregate read models, never a role that opens cases. Reporting shows inside Oversight; a standalone area only for principally-reporting users within five areas                                                                                                          | Migration 2160 (ADR-053)                       |
| DEC-AMB-013 conflict after decision | Option A: re-vote without the conflicted member, the authority decides again, and the earlier decision is kept and marked SUPERSEDED. The committee and authority screens show it                                                                                                                            | Migration 2030 (rebase)                        |

Every piece keeps D0's rule: the database decides, and the screen explains.

**DEC-51, built (P12-9 (a), CDF-209).** `formatRecordDate` and `formatRecordDateToParts` in `@cdf/i18n` give the
Gregorian date first and the Hijri date second for the same day in Riyadh, from the platform's Umm al-Qura calendar
(ICU), with the words and brackets from the message catalogues: "13 October 2026 (2 Jumada I 1448H)" and
«13 أكتوبر 2026 (2 جمادى الأولى 1448هـ)». A runtime without that calendar shows the Gregorian date alone rather than a
wrong Hijri one. `CDFRecordDate` keeps the stored timestamp as the machine value and keeps each date on one line. The
disposition certificate is the first formal record to use it; notices, minutes and export documents adopt it in their
own slices (P12-5, P12-2, P12-6). Operational screens keep `CDFDateTime`. No migration and no access change.

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
  - DEC-47, DEC-20, DEC-16, DEC-14, DEC-29 and DEC-32 (S1);
  - DEC-54, DEC-38, DEC-40, DEC-41 and DEC-25 (S2), and the open parts of DEC-37 (D8);
  - DEC-31, DEC-35 and DEC-50, as the S3 amendment records them;
  - the portal-track decisions;
  - DEC-59 and DEC-60 (verification).
- **Decided since.** DEC-22, DEC-04, the four open parts of DEC-05, DEC-19, DEC-49 and the S4–S6 decisions of the
  Phase 12 owner pack (DEC-18, DEC-48, DEC-51, DEC-11, DEC-12, DEC-13, DEC-36), on 2026-10-13: see the Phase 12 owner
  decisions amendment.

## Production mapping

The decisions are platform-independent and move unchanged to RDS PostgreSQL and the CDF corporate IdP. Two items depend on the identity source:

- Eligibility for `RESTRICTED_CASE_AUTHORITY` and the `REPORTER_COMMUNICATE` delegation come from the CDF Delegation of Authority (SOURCE_REQUIRED).
- Their holders come from the CDF IdP's role claims (PRODUCTION_SUBSTITUTION_REQUIRED, CDF-35).

## Requirements

§19 (authorization enforced twice), §21 (admin roles never imply content), §22 (identity vault), §24–§27 (evidence), §29 (audit in the same transaction), §40 (authorise before results), §65 (definition of done) and §88 (human decisions: recorded here).
