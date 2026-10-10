# UAT Scenarios

How to read a script: **Actor** is the seed account (see [SYNTHETIC_DATA.md](SYNTHETIC_DATA.md)); **Pre** is the state needed before step 1; each step has an expected result the tester ticks or fails. A step marked **API** has no screen yet and is run as described in [UAT_PLAN.md §5](UAT_PLAN.md#steps-with-no-screen-yet). **Lang** says whether the scenario runs in Arabic, English or both. **Trace** names the requirement ids in `compliance/requirements/requirements.yaml`, the workflow transition, the baseline WB-FRM form or the Drive source, and the automated test that already covers the same ground.

Portal URL below means the DEMO `cdf-whistleblowing` deployment; Workspace URL means the DEMO `cdf-investigations` deployment.

Every page in both apps must show the synthetic-data banner. If it is missing on any step, fail the step.

## Wave 1 index

| Id            | Title                                                        | Actor(s)                            | Lang | Security check |
| ------------- | ------------------------------------------------------------ | ----------------------------------- | ---- | -------------- |
| UAT-ENV-01    | No service-role secret reaches the browser                   | test lead                           | —    | yes            |
| UAT-ENV-02    | Pages are not publicly cached; security headers present      | test lead                           | —    | yes            |
| UAT-ENV-03    | Portal and workspace are separate deployments                | test lead                           | —    | yes            |
| UAT-ENV-04    | Hosted sign-in works and the synthetic banner shows          | triage                              | both | —              |
| UAT-PORTAL-01 | Anonymous report submitted, receipt shown once               | anonymous reporter                  | both | —              |
| UAT-PORTAL-02 | Report form validation and acknowledgement                   | anonymous reporter                  | both | —              |
| UAT-PORTAL-03 | Follow-up with two-way messages                              | reporter, intake, triage            | both | —              |
| UAT-PORTAL-04 | The portal never reveals whether a report exists             | anonymous reporter, soc             | en   | yes            |
| UAT-PORTAL-05 | Submission throttling                                        | anonymous reporter                  | en   | yes            |
| UAT-VAULT-01  | Identified report: identity never shown to the case team     | identified reporter, triage, inv. b | both | yes            |
| UAT-VAULT-02  | Dual-controlled identity reveal                              | grc.director, grc.deputy            | en   | yes            |
| UAT-INTAKE-01 | Intake queue and request for information                     | intake, triage, reporter            | both | —              |
| UAT-INTAKE-02 | Triage outcomes that close a report                          | triage, reporter                    | en   | —              |
| UAT-WF-01     | Anonymous report becomes an open investigation               | triage, casemanager, lead, grc.dir. | both | —              |
| UAT-WF-02     | Blocked transitions explain themselves                       | triage, lead, casemanager           | en   | yes            |
| UAT-WF-03     | Closing and rejecting paths                                  | triage, casemanager, grc.director   | en   | —              |
| UAT-COI-01    | Declaring a conflict removes access; decided by someone else | lead, casemanager                   | en   | yes            |
| UAT-COI-02    | Conflicted or under-cleared people cannot be assigned        | casemanager, grc.director           | en   | yes            |
| UAT-AUTHZ-01  | Investigators see only their cases (UI, URL)                 | investigator.b, lead                | en   | yes            |
| UAT-AUTHZ-02  | Restricted and higher-classified cases stay hidden           | casemanager, grc.director, lead     | en   | yes            |
| UAT-EVID-01   | Evidence upload, hash, custody and audited download          | investigator.a                      | both | yes            |
| UAT-EVID-02   | Malware and disguised files are rejected                     | investigator.a, soc                 | en   | yes            |
| UAT-EVID-03   | New versions keep history; duplicates refused                | investigator.a                      | en   | —              |
| UAT-EVID-04   | Evidence download denied without permission or access        | triage, investigator.b              | en   | yes            |
| UAT-ADMIN-01  | Administrators see no case content                           | admin, committee, dpo               | en   | yes            |
| UAT-ADMIN-02  | Audit and security events: metadata only, chain intact       | audit, soc                          | en   | yes            |
| UAT-ADMIN-03  | Revoked users and brute-force throttling                     | revoked, any                        | en   | yes            |
| UAT-UX-01     | Arabic first, English parity                                 | reporter, triage                    | both | —              |
| UAT-UX-02     | Keyboard-only and phone-width use                            | reporter, investigator.a            | both | —              |

## Hosted environment (UAT-ENV)

These run first. A failure stops the cycle (UAT plan §6 step 2).

### UAT-ENV-01 No service-role secret reaches the browser

**Actor** test lead · **Pre** DEMO deployments live · **Trace** CDF-SEC (service-role rule, CLAUDE.md §4), Fady's decision 7, CDF-33

1. Open the portal home and the workspace sign-in page with browser developer tools. In Sources, search all loaded JavaScript for `service_role`, `SUPABASE_SERVICE_ROLE`, and for the first characters of the DEMO service-role key (the test lead reads them from Vercel, never pastes the key anywhere). → No match.
2. Inspect the environment variables of both Vercel projects (names only). → No variable whose name starts with `NEXT_PUBLIC_` holds a key or secret; the service-role variable exists only in `cdf-investigations`, scoped server-side.
3. In the Network tab, browse the portal and the workspace. → No request goes from the browser to `*.supabase.co` (PostgREST, Auth or Storage). All traffic goes to the app's own origin.

### UAT-ENV-02 Pages are not publicly cached; security headers present

**Actor** test lead · **Trace** Fady's decision 7, `tests/e2e/first-slice.spec.ts` "security headers are present on both apps"

1. Request the portal `/` and the workspace `/login` and, signed in, a case page. → Each response has `Cache-Control` containing `no-store`, a `Content-Security-Policy` with `default-src 'self'` and `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, no `X-Powered-By`.
2. Request the same case page twice. → Vercel does not report a cache `HIT` for any workspace page.
3. Sign out, then press Back. → The case page is not shown from cache; the sign-in page appears.

### UAT-ENV-03 Portal and workspace are separate deployments

**Actor** test lead · **Trace** CDF-ARCH-001, ADR-002

1. Compare the two Vercel projects. → Different project, different domain, different environment variables; the portal holds no service-role key and no workspace session secret.
2. In the portal, try workspace paths (`/login`, `/cases`, `/intake`). → Not found; no workspace page is served from the portal domain.
3. Sign in to the workspace, then open the portal in the same browser. → The portal knows nothing of the workspace session (no name, no cookie for the portal domain).

### UAT-ENV-04 Hosted sign-in works and the synthetic banner shows

**Actor** triage · **Lang** both · **Trace** ADR-010, Fady's decision 5 (Auth adapter)

1. Workspace → sign in as triage with the issued password. → The home page shows the signed-in name and role; the synthetic banner is visible.
2. Switch language with the header toggle. → Text and layout switch; the session stays signed in.
3. Leave the session idle longer than the configured idle timeout (default 30 minutes, `CDF_SESSION_IDLE_SECONDS`), then click a link. → The session has expired and the sign-in page appears.

## Public whistleblowing portal (UAT-PORTAL)

The portal implements two reporting modes (anonymous, identified). The Drive requirements report specifies three modes and 21 fields; the differences are tracked in CDF-63. Until CDF-63 is decided, these scenarios accept the portal **as built** and do not accept it against the Drive report.

### UAT-PORTAL-01 Anonymous report submitted, receipt shown once

**Actor** anonymous reporter · **Lang** both · **Trace** CDF-INTAKE-001, CDF-SEC (portal), Drive report fields 3, 13, 15, 21; `tests/e2e/first-slice.spec.ts`

1. Portal → "Submit a report". → The form loads; "anonymous" is the default mode; no identity fields are required.
2. Choose a category, enter description text R-01 from [SYNTHETIC_DATA.md §3](SYNTHETIC_DATA.md#3-report-texts) (at least 20 characters), optionally a past incident date and a location; tick the acknowledgement; submit. → A receipt shows a Report ID (`WB-…`) and a secret, with a warning that they are shown only once.
3. Record the Report ID in the execution record. Record the secret only in the tester's private notes for the follow-up scenarios, never in Linear or the shared folder. → —
4. Reload the receipt page. → The secret is not shown again.
5. Workspace as **intake** → Intake queue. → The new report is listed as Received, with category and date, and no reporter identity.

### UAT-PORTAL-02 Report form validation and acknowledgement

**Actor** anonymous reporter · **Lang** both · **Trace** CDF-INTAKE-001, `packages/validation` `submitReportSchema`

1. Submit an empty form. → Field errors on category, description and acknowledgement, in the page language; nothing is submitted.
2. Enter a description of fewer than 20 characters. → Error on the description.
3. Enter an incident date in the future. → Error "future date" on the date.
4. Switch to "identified", leave all identity fields empty, submit. → Error asking for at least a name, email or phone.
5. Switch back to "anonymous" with identity text still typed in, and submit a valid report. → Submitted; on the intake page the report shows no identity (the typed identity was discarded).

### UAT-PORTAL-03 Follow-up with two-way messages

**Actor** reporter (credentials from UAT-PORTAL-01), intake · **Lang** both · **Trace** CDF-INTAKE-001, public status mapping (`public_api._public_status`), Drive report "ticket lifecycle"

1. Portal → "Follow up", enter the Report ID and secret. → Status "Received", received date, no messages yet.
2. Write a reply as the reporter (text R-02) and send. → "Reply sent"; the message appears as "From you".
3. Workspace as **intake** → the report → messages. → The reporter's message is listed. Reply with text M-01. → Reply recorded.
4. Portal → follow up again. → The CDF reply appears as "From CDF". Nothing about internal state, assignees or case numbers is shown.
5. Click "sign out of this report". → Credentials are cleared; the follow-up form is empty; the browser holds no Report ID or secret in the address bar, cookies or local storage (check developer tools).

### UAT-PORTAL-04 The portal never reveals whether a report exists

**Actor** anonymous reporter, soc · **Trace** CDF-SEC (portal non-disclosure, lockout); `tests/security/public-portal.spec.ts`; `architecture/DEMONSTRATION_SCENARIOS.md` scenario 2

1. Follow up with a made-up Report ID and any secret. → Generic "invalid" message.
2. Follow up with the real Report ID from UAT-PORTAL-01 and a wrong secret. → Exactly the same message, same layout and no measurable difference in response.
3. Repeat the wrong secret until ten failures; then enter the correct secret. → Still refused with the same message (lockout of 15 minutes).
4. **API** as soc: read security events. → `REPORT_ACCESS_FAILED` and `REPORT_ACCESS_LOCKED` events exist with a hash of the reference only, never the Report ID or secret.
5. After the lockout expires, follow up with the correct secret. → Access works again.

### UAT-PORTAL-05 Submission throttling

**Actor** anonymous reporter · **Trace** CDF-SEC (rate limiting at the boundary), `PORTAL_LIMITS` in `packages/application/src/portal.ts` (5 submissions per hour per client in the prototype)

1. From one browser, submit six valid reports within an hour using text R-03. → The sixth is refused with a generic "too many requests" message and a correlation reference; no stack trace or internal detail.
2. Record that this limit is a demo setting, not a production control (gateway rate limiting is `PRODUCTION_SUBSTITUTION_REQUIRED`). → —

## Identity vault (UAT-VAULT)

### UAT-VAULT-01 Identified report: identity never shown to the case team

**Actor** identified reporter, triage, investigator.b · **Lang** both · **Trace** CDF-SEC (identity vault, §22), ADR-004; `tests/security/whistleblower-vault.spec.ts`

1. Portal → submit in "identified" mode with persona IP-01 from [SYNTHETIC_DATA.md §4](SYNTHETIC_DATA.md#4-reporter-personas) (synthetic name, `@example.test` email). → Receipt with Report ID and secret.
2. Workspace as **triage** → the report. → The report shows that the reporter is identified, but no name, email or phone anywhere on the page.
3. Open seed case CDF-DEMO-2026-0002 as **investigator.b**. → Only the opaque WB-ID; no identity field, no reveal button.
4. View page source and network responses for the case page. → The persona's name and email do not appear.

### UAT-VAULT-02 Dual-controlled identity reveal

**Actor** grc.director, grc.deputy · **Trace** ADR-004, CDF-SEC (vault); `tests/security/whistleblower-vault.spec.ts`; `architecture/DEMONSTRATION_SCENARIOS.md` scenario 6

1. **API** as grc.director on case 0002: request a reveal with a justification under 20 characters. → Refused (justification too short).
2. **API** as grc.director: request with justification J-01 (20+ characters). → Request recorded, pending.
3. **API** as grc.director: approve own request. → Refused (requester cannot approve).
4. **API** as grc.deputy: approve. → Approved.
5. **API** as grc.director: resolve the identity. → Returns the seeded synthetic identity (persona IP-00 in [SYNTHETIC_DATA.md §4](SYNTHETIC_DATA.md#4-reporter-personas)). Resolving again → refused with `APPROVED_REVEAL_REQUEST_REQUIRED` (single use).
6. **API** as soc: audit trail. → `REPORTER_IDENTITY_REVEALED` with ids only (no identity values), category SECURITY. As **lead** (case team): the event is not readable.

## Intake and triage (UAT-INTAKE)

### UAT-INTAKE-01 Intake queue and request for information

**Actor** intake, triage, reporter · **Lang** both · **Trace** CDF-INTAKE-001, triage outcome `REQUEST_INFORMATION`; baseline WB-FRM-03 (completeness check)

1. Workspace as **intake** → Intake queue. → Seed reports WB-SEED00000005 (Received) and WB-SEED00000006 (Information requested) and the UAT reports are listed. Intake has no triage form (no `REPORT_TRIAGE` permission).
2. As **triage** → a UAT report → Triage → outcome "Request information" with reason T-01 → submit. → Report status becomes Information requested; the timeline shows the triage event.
3. As **triage**, reply to the reporter asking for the missing detail (M-02). → Recorded.
4. Portal → follow up with that report's credentials. → Status "Information requested" and the CDF message; reply box available.

### UAT-INTAKE-02 Triage outcomes that close a report

**Actor** triage, reporter · **Trace** triage outcomes `REFER_OUT`, `CLOSE_NO_ACTION`, `DUPLICATE`; public status mapping; baseline WB-FRM-04, WB-FRM-06

Use three UAT reports submitted with text R-03.

1. Triage report A → "Refer out" without a referral target. → Error: target required. Add target "Synthetic Department Delta" and reason T-02. → Status Referred out.
2. Triage report B → "Close, no action" with reason T-03. → Status Closed no action.
3. Triage report C → "Duplicate" without choosing the original. → Error. Choose report A as the original. → Status Duplicate.
4. Portal → follow up on A, B and C. → Each shows public status "Closed" and the reply box is replaced by the closed notice. None shows the internal outcome or reason.

## Case workflow (UAT-WF)

States and transitions follow `architecture/WORKFLOW.md`. Only transitions marked enabled there are tested in Wave 1.

### UAT-WF-01 Anonymous report becomes an open investigation

**Actor** triage, casemanager, lead, investigator.b, grc.director, reporter · **Lang** both · **Trace** CDF-WF-001, CDF-CASE-001, transitions `REGISTER` → `APPROVE_INVESTIGATION`; baseline WB-FRM-05, -07, -09, -10; `tests/e2e/first-slice.spec.ts`, `tests/integration/first-slice.spec.ts`; `architecture/DEMONSTRATION_SCENARIOS.md` scenario 1

1. As **triage** on a UAT report → outcome "Open case" with reason → "Create case" with title C-01, summary C-02, classification CONFIDENTIAL. → Case `CDF-DEMO-2026-NNNN` created at Registered and opened in the browser; report status Case opened. The report's text is carried over as the case's first allegation (`api.create_case_from_report`).
2. "Start screening", then "Complete screening". → State Conflict check. The portal already shows "In progress" for the report.
3. As **casemanager** → the case → "Update details" → priority High. → Saved.
4. Declare no conflict with text D-02. → "No conflict declared". "Clear conflict check" → State Triage. "Complete triage" → State Jurisdiction. "Confirm jurisdiction" with reason W-01 → State Investigation approval.
5. "Approve investigation" is disabled with "Assign an investigator first." Assign **lead** as lead investigator and **investigator.b** as investigator, each with an assignment reason. → Team list shows both; "Approve investigation" stays disabled until both have declared.
6. As **investigator.b** → Cases → the new case is listed; open it, declare no conflict. → No assign form is shown. Do the same as **lead**.
7. As **investigator.a** (not assigned) → the case is not listed and its URL answers "not found".
8. As **grc.director**: "Approve investigation" with reason W-02. → State Investigation; the tracker shows it; the timeline shows "Case created", "Person assigned" and each transition.
9. Portal → follow up on the report. → "In progress"; nothing about the case.

### UAT-WF-02 Blocked transitions explain themselves

**Actor** triage, lead, casemanager · **Trace** `architecture/WORKFLOW.md` §3–§5; `tests/security/case-isolation.spec.ts` "an assigned investigator cannot approve…"

1. On a case in Triage without priority: "Complete triage" is disabled. → Reason "priority not set" in the page language.
2. On a case in Conflict check where the actor has not declared: "Clear conflict check" disabled. → Reason "your conflict declaration is missing".
3. As **lead** assigned to a case in Investigation approval: → "Approve investigation" disabled with reason "separation of duties".
4. Later-phase transitions (e.g. Submit findings) appear disabled with "not yet available". → Nothing in the UI lets the user force them.
5. Inspect the button state with developer tools and submit the form anyway. → The server refuses with a generic error and a correlation reference; state unchanged.

### UAT-WF-03 Closing and rejecting paths

**Actor** triage or casemanager, grc.director · **Trace** transitions `SCREEN_OUT`, `OUT_OF_JURISDICTION`, `REJECT_INVESTIGATION`; baseline WB-FRM-04, WB-FRM-06

1. On a new UAT case in Screening: "Screen out" without a reason. → Refused (reason 10–2000 characters required). With reason W-03. → State Closure; records state Closed; timeline shows `CASE_CLOSED`. Portal for its report → "Closed".
2. On a case in Jurisdiction: "Out of jurisdiction" with reason W-04. → State Closure.
3. On a case in Investigation approval, as **grc.director**: "Reject investigation" with reason W-05. → State returns to Jurisdiction.
4. Archive and reopen are not enabled. → Both show "not yet available".

## Conflict of interest (UAT-COI)

### UAT-COI-01 Declaring a conflict removes access; decided by someone else

**Actor** lead, casemanager · **Trace** CDF-CASE-001 (conflicts), `tests/security/case-isolation.spec.ts` "a conflict cannot be decided by the person who declared it"; scenario 5; baseline WB-FRM-10 independence, WB-FRM-13 declarations

1. As **lead** on case 0001: declare a conflict with declaration text D-01. → The case disappears from lead's case list at once; its URL now answers "not found".
2. **API** as lead: decide own conflict. → Refused.
3. **API** as casemanager: decide the conflict (uphold). → Recorded; lead's access stays removed. (Alternatively clear it → lead's access returns.)
4. Timeline (as casemanager) → conflict declared and decided events, without the declaration text being shown to other investigators.

### UAT-COI-02 Conflicted or under-cleared people cannot be assigned

**Actor** casemanager, grc.director · **Trace** `api.assign_case` checks; scenarios 4 and 5

1. As **casemanager** on case 0004: assign **investigator.a** (confirmed conflict). → Refused, "declared conflict".
2. As **grc.director** on case 0003 (SECRET, restricted): assign **investigator.a** (CONFIDENTIAL clearance). → Refused, clearance mismatch explained.
3. **API** as grc.director: grant **lead** access to 0003. → `GRANTEE_CLEARANCE_INSUFFICIENT`. Grant **grc.deputy**. → Granted, audited `CASE_ACCESS_GRANTED`.

## Authorization isolation (UAT-AUTHZ)

### UAT-AUTHZ-01 Investigators see only their cases (UI, URL)

**Actor** investigator.b, lead · **Trace** CDF-SEC-001/002 (RLS), `tests/security/case-isolation.spec.ts`; scenario 3

1. As **lead**, copy the URL of case 0001 and of one of its evidence downloads.
2. As **investigator.b** → Cases. → Only 0002 and 0004.
3. Paste the 0001 case URL. → "Case not found", identical to a random UUID.
4. Paste the 0001 evidence download URL. → "Not found"; no file bytes.
5. **API** as soc → a `CASE_ACCESS_DENIED` security event for investigator.b.

### UAT-AUTHZ-02 Restricted and higher-classified cases stay hidden

**Actor** casemanager, grc.director, lead · **Trace** CDF-SEC (ABAC clearance, restricted cases); scenarios 3 and 4

1. As **casemanager** (`CASE_VIEW_ALL`) → Cases. → All non-restricted cases, but not 0003.
2. As **grc.director** → 0003. → Opens; badge SECRET, restricted on.
3. As **lead** → paste 0003 URL. → "Not found".

## Evidence and chain of custody (UAT-EVID)

Evidence files are listed in [SYNTHETIC_DATA.md §5](SYNTHETIC_DATA.md#5-evidence-files). On DEMO the store is Supabase Storage through `SupabaseEvidenceStorage`; scanning is the EICAR-only mock.

### UAT-EVID-01 Evidence upload, hash, custody and audited download

**Actor** investigator.a · **Lang** both · **Trace** CDF-EVID-001, ADR-006; baseline WB-FRM-11 (evidence register); `tests/e2e/evidence.spec.ts`; scenario 11

1. As **investigator.a** → case 0001 → Evidence → choose file EV-PDF-1, title E-01, type Document, classification RESTRICTED → Upload. → Success message carries a SHA-256; the table shows EV-001, file name, size, "Available".
2. Compare the shown SHA-256 with the one in [SYNTHETIC_DATA.md §5](SYNTHETIC_DATA.md#5-evidence-files). → Equal.
3. Open the versions panel. → Version 1 with hash, scanner name, scan result Clean; custody "Received → Stored in the vault".
4. Choose a classification below the case's, then one above investigator.a's clearance. → Both refused.
5. "Download". → File saved; its SHA-256 equals step 2. Response headers include `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`. No storage URL or signed URL appears in the browser (network tab).
6. Reload. → Custody gains "Downloaded"; the case timeline shows "Evidence downloaded".
7. **API** as test lead: confirm the evidence bucket is private and anonymous access to the object path is refused. → Refused.

### UAT-EVID-02 Malware and disguised files are rejected

**Actor** investigator.a, soc · **Trace** CDF-EVID-001, `tests/security/evidence-access.spec.ts`; scenario 11 steps 3–4

1. Upload EV-EICAR (text file with the EICAR test string). → "The scanner rejected this file as suspected malware." Item listed as Rejected with the version's scan result; no download link.
2. **API** as soc → `MALWARE_DETECTED` security event.
3. Upload EV-FAKE-PDF (non-PDF bytes named `.pdf`). → "does not match its extension"; nothing listed, nothing written.
4. Upload a file over 25 MiB (EV-BIG). → Refused with the size limit message.

### UAT-EVID-03 New versions keep history; duplicates refused

**Actor** investigator.a · **Trace** CDF-EVID-001 (immutable versions, never overwrite)

1. On EV-001 → "Add a new version" with EV-PDF-2. → Version 2 current; version 1 still listed and downloadable.
2. Add EV-PDF-2 again. → Refused as duplicate.
3. Look for any delete or replace control. → None exists for evidence or versions.

### UAT-EVID-04 Evidence download denied without permission or access

**Actor** triage, investigator.b · **Trace** CDF-EVID-001, `tests/security/evidence-access.spec.ts`, `tests/security/storage-policy.spec.ts`

1. As **triage** (has a grant on 0001, no `EVIDENCE_DOWNLOAD`) → 0001 → Evidence. → Items listed; no upload form; no download links.
2. Paste the download URL copied in UAT-AUTHZ-01. → "Not found"; **API** as soc → `EVIDENCE_ACCESS_DENIED`.
3. As **investigator.b** → the same URL. → "Not found".

## Administration and audit separation (UAT-ADMIN)

### UAT-ADMIN-01 Administrators see no case content

**Actor** admin, committee, dpo · **Trace** CDF-SEC (admin separation, §21), `tests/security/admin-separation.spec.ts`; scenario 7

1. As **admin**: sign in. → Works; case list empty; any case URL "not found"; no intake queue.
2. As **committee** and as **dpo**: same checks. → No case and no report content.
3. **API** as admin: grant self CASE_MANAGER. → Refused. Grant committee INVESTIGATOR with justification (`api.grant_role`). → Audited `ROLE_GRANTED` (ADMIN category). Revoke it with a reason (`api.revoke_role`) to restore the seed. → Audited.

### UAT-ADMIN-02 Audit and security events: metadata only, chain intact

**Actor** audit, soc · **Trace** CDF-SEC (append-only audit, §29), ADR-005, `tests/security/audit-immutability.spec.ts`; scenario 9

1. **API** as audit: read BUSINESS and ADMIN events from this cycle. → Actions, ids, timestamps; no case titles, descriptions, messages or identities.
2. **API** as soc: read SECURITY events. → The denials and lockouts produced in earlier scenarios are present.
3. **API** as audit: `api.verify_audit_chain()`. → No rows (chain intact).
4. **API** as lead: call the verifier. → Refused.

The tamper demonstration in scenario 9 needs superuser access and is **not** run on DEMO; it stays covered by the automated test.

### UAT-ADMIN-03 Revoked users and brute-force throttling

**Actor** revoked, any · **Trace** ADR-010, `tests/e2e/first-slice.spec.ts` "revoked users cannot sign in…"; scenario 8

1. Sign in as **revoked** with its issued password. → Generic failure, the same text as a wrong password.
2. Enter a wrong password for one seed account repeatedly. → After 10 failures within 15 minutes further attempts are refused with the same generic message, including with the right password.
3. Record the throttling behaviour seen on hosted Auth; if it differs from local development (Supabase Auth's own limits), raise a MEDIUM defect describing the difference rather than passing silently.

## Language and accessibility (UAT-UX)

### UAT-UX-01 Arabic first, English parity

**Actor** reporter, triage · **Trace** CDF-UX-001; scenario 10; CDF-52, CDF-56 (known findings)

1. Open the portal fresh. → Arabic by default, right-to-left; the toggle switches to English, left-to-right.
2. Walk UAT-PORTAL-01 and UAT-INTAKE-01 in Arabic. → Every label, button, error, status and date is Arabic; no English fallback strings; tracker, tables and forms read right-to-left.
3. Repeat in English. → No Arabic leftovers except proper names.
4. Note any known accessibility finding (CDF-52..58) observed; do not raise duplicates for them.

### UAT-UX-02 Keyboard-only and phone-width use

**Actor** reporter, investigator.a · **Trace** CDF-UX-002; `tests/accessibility/a11y.spec.ts`; CDF-53, CDF-54

1. Submit a report and follow up using only the keyboard. → Skip link works; focus order logical; focus always visible; the result after submit is announced or focused.
2. On a 390 px wide phone viewport, open a case page as investigator.a. → No horizontal page scroll; evidence table usable. (CDF-53 is a known finding: record it against CDF-53, not as a new defect.)

## Wave 2 and 3: designed, not yet executable

These scenarios are written against the sources that exist today so the flows are agreed before the features land. Each enters UAT only after its feature merges with tests green and its transitions are enabled. Field-level steps come from `baseline/extracted/baseline-domain.json` (forms catalogue) and will be refined against the forms engine (CDF-50) when it ships. Where a business rule is `SOURCE_REQUIRED`, the scenario cannot be accepted until a CDF source is confirmed.

| Id        | Flow                                        | Actors                                          | Depends on                                                                    | Source of expected results                                                                                                                                                 | Key acceptance points                                                                                                                                                                                             |
| --------- | ------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UAT-W2-01 | Intake and assessment forms                 | intake, triage, casemanager                     | CDF-50                                                                        | WB-FRM-01..09 (registration, confidentiality, completeness, cancellation, jurisdiction, service complaint, initial assessment, date of knowledge, classification decision) | Each form saves as a versioned instance tied to the case; required fields enforced on server; review/approval flags respected; forms never move workflow state by themselves (`BASELINE_ANALYSIS.md` §5.2 item 7) |
| UAT-W2-02 | Investigation assignment form               | casemanager, lead                               | CDF-50                                                                        | WB-FRM-10                                                                                                                                                                  | Investigator chosen from users (not free text); scope and duration recorded; independence declaration required before approval                                                                                    |
| UAT-W2-03 | Evidence register form                      | investigator                                    | CDF-50, Phase 7                                                               | WB-FRM-11                                                                                                                                                                  | Register is derived from evidence records and custody, not retyped; hash and custody shown match the evidence module                                                                                              |
| UAT-W2-04 | Interviews and investigation activities     | lead, investigator                              | EPIC 09 (CDF-14)                                                              | EPIC 09 scope (Linear)                                                                                                                                                     | Interview recorded against case persons; witness identities pseudonymous; notes access-controlled like evidence                                                                                                   |
| UAT-W2-05 | Initial investigation report and findings   | investigator, lead                              | Phase 9; transition `SUBMIT_FINDINGS`                                         | WB-FRM-12; `architecture/WORKFLOW.md`                                                                                                                                      | Further allegations can be added and withdrawn; findings per allegation; case moves to Findings                                                                                                                   |
| UAT-W2-06 | GRC / legal review                          | grc.director, legal reviewer                    | Phase 9; `SUBMIT_FOR_REVIEW`, `RETURN_TO_INVESTIGATION`, `REFER_TO_COMMITTEE` | `architecture/WORKFLOW.md`                                                                                                                                                 | Approval-required transitions respect separation of duties; return needs a reason                                                                                                                                 |
| UAT-W3-01 | Committee formation and independence        | committee secretary, chair, members             | Phase 9–10                                                                    | WB-FRM-13; baseline committee and COI capability                                                                                                                           | Members are users; each declares independence; a recused member cannot vote; secretary has no vote                                                                                                                |
| UAT-W3-02 | Committee sessions and minutes              | secretary, chair, members                       | Phase 9–10; `CONCLUDE_COMMITTEE`                                              | WB-FRM-14                                                                                                                                                                  | Attendance and quorum evaluated: quorum rule is **SOURCE_REQUIRED** (`COMMITTEE_QUORUM`)                                                                                                                          |
| UAT-W3-03 | Notice of violation and right of defence    | secretary, subject employee (contextual)        | Phase 10                                                                      | WB-FRM-15                                                                                                                                                                  | Subject sees a reduced view only; defence response recorded and time-stamped; no reporter identity exposed                                                                                                        |
| UAT-W3-04 | Decision draft, approval and notice         | secretary, decision authority                   | Phase 10; `REQUIRE_CORRECTIVE_ACTION`, `CLOSE_AFTER_DECISION`                 | WB-FRM-16, WB-FRM-17                                                                                                                                                       | Decision approved by the decision authority: authority is **SOURCE_REQUIRED** (`FINAL_DISCIPLINARY_AUTHORITY`)                                                                                                    |
| UAT-W3-05 | Grievance                                   | subject employee, grievance committee           | later phase                                                                   | WB-FRM-18                                                                                                                                                                  | Grievance only against a final decision; grievance committee access scoped to that case                                                                                                                           |
| UAT-W3-06 | Corrective action, closure, archive, reopen | implementation owner, casemanager, grc.director | Phases 10–11; `COMPLETE_CORRECTIVE_ACTIONS`, `ARCHIVE_CASE`, `REOPEN_CASE`    | WB-FRM-19; baseline closure blockers                                                                                                                                       | Closure blocked while forms, actions or grievances are open; reopen needs reason and approval; archive is terminal                                                                                                |
| UAT-W3-07 | Retention, legal hold and disposition       | records officer, dpo                            | Phase 11–12                                                                   | Records requirements (CDF-REC-001)                                                                                                                                         | Legal hold blocks disposition; disposition audited; retention period is **SOURCE_REQUIRED** (`RETENTION_PERIOD`)                                                                                                  |

Wave 2 also adds, once CDF-63 is decided, a revised UAT-PORTAL set covering the email-only mode and the full Drive field list.
