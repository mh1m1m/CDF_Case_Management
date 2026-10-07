# Demonstration Scenarios

Protocol §91 item 10 and §93. Each scenario runs against the synthetic seed (`pnpm db:reset`) with both apps started (`pnpm dev`: investigation workspace on http://localhost:3000, portal on http://localhost:3001). Sign in to the workspace with a seed email and the local development password from `apps/investigation-web/.env.local` (`CDF_DEV_PASSWORD`). Everything shown is synthetic; the banner on every page says so.

Switch language with the `ar`/`en` toggle in the header; every scenario works in both.

**What the workspace UI covers today:** the intake queue, triage, reply to reporter, create case, edit details, assign, declare your own conflict, workflow transitions and the case timeline. Other commands (deciding conflicts, access grants, identity reveal, role administration, security-event views, audit-chain verification) exist and are tested at the database API level but have no screens yet. Scenarios mark those steps **API** and point at the automated test that exercises them. They get UI in later phases.

## Seed users

| Email                       | Role(s)           | Clearance    | Notes                                |
| --------------------------- | ----------------- | ------------ | ------------------------------------ |
| intake@example.test         | INTAKE_OFFICER    | RESTRICTED   |                                      |
| triage@example.test         | TRIAGE_OFFICER    | CONFIDENTIAL |                                      |
| casemanager@example.test    | CASE_MANAGER      | CONFIDENTIAL |                                      |
| investigator.a@example.test | INVESTIGATOR      | CONFIDENTIAL | Conflict confirmed on case 0004      |
| investigator.b@example.test | INVESTIGATOR      | CONFIDENTIAL |                                      |
| lead@example.test           | LEAD_INVESTIGATOR | CONFIDENTIAL |                                      |
| committee@example.test      | COMMITTEE_MEMBER  | CONFIDENTIAL | No case access                       |
| grc.director@example.test   | GRC_DIRECTOR      | SECRET       | Owner of restricted case 0003        |
| grc.deputy@example.test     | GRC_DIRECTOR      | SECRET       | Second approver for identity reveals |
| records@example.test        | RECORDS_OFFICER   | CONFIDENTIAL | Retention class, disposition request |
| records.b@example.test      | RECORDS_OFFICER   | CONFIDENTIAL | Second records officer               |
| legal@example.test          | LEGAL_REVIEWER    | CONFIDENTIAL | Places and releases legal holds      |
| legal.b@example.test        | LEGAL_REVIEWER    | CONFIDENTIAL | Second hold release approver         |
| admin@example.test          | PLATFORM_ADMIN    | INTERNAL     | No case content                      |
| audit@example.test          | INTERNAL_AUDIT    | INTERNAL     | Audit metadata only                  |
| soc@example.test            | SOC_ANALYST       | INTERNAL     | Security events only                 |
| dpo@example.test            | PRIVACY_DPO       | CONFIDENTIAL |                                      |
| revoked@example.test        | (revoked)         | CONFIDENTIAL | Cannot sign in                       |

## Seed cases

| Case               | State         | Classification     | Team                                                   |
| ------------------ | ------------- | ------------------ | ------------------------------------------------------ |
| CDF-DEMO-2026-0001 | INVESTIGATION | RESTRICTED         | lead (lead investigator), investigator.a; GRC approved |
| CDF-DEMO-2026-0002 | SCREENING     | RESTRICTED         | investigator.b; identified reporter held in the vault  |
| CDF-DEMO-2026-0003 | REGISTERED    | SECRET, restricted | grc.director (case owner) only                         |
| CDF-DEMO-2026-0004 | REGISTERED    | CONFIDENTIAL       | investigator.b; investigator.a's conflict confirmed    |

Reports WB-SEED00000005 (RECEIVED) and WB-SEED00000006 (INFO_REQUESTED) are waiting in the intake queue. Seed report secrets are unusable by design; use scenario 1 to obtain a live one.

## Scenario 1: anonymous report becomes an open investigation (the first slice)

1. Portal → "Submit a report". Keep "anonymous", choose a category, write a description of at least 20 characters, submit.
2. Note the Report ID and the secret on the receipt. They are shown once.
3. Workspace as **triage**: Intake → the new report → Triage → outcome "Open case" with a reason → "Create case" with title, summary and classification RESTRICTED.
4. On the case page: "Start screening". The "Complete screening" button is disabled with the reason "no allegation recorded" until an allegation exists (seeded cases have one; the UI to add one is Phase 9, so continue with seed case 0002 if you want to walk the remaining steps in the UI). Then: declare no conflict → "Clear conflict check" → set priority in Details → "Complete triage" → "Confirm jurisdiction" with a reason.
5. As **casemanager**: assign **lead** as lead investigator and **investigator.b** as investigator. Each declares no conflict when they next open the case. "Approve investigation" stays disabled for anyone assigned as investigator (`SEPARATION_OF_DUTIES`) and until every assignee has declared.
6. As **grc.director**: "Approve investigation" with a reason. The tracker shows INVESTIGATION and the timeline shows the transition.
7. Back in the portal → "Follow up" with the Report ID and secret: status reads IN_PROGRESS. Nothing about the case is shown.

Automated equivalent: `tests/e2e/first-slice.spec.ts` "anonymous report becomes an open investigation"; `tests/integration/first-slice.spec.ts`.

## Scenario 2: the portal never reveals whether a report exists

1. Portal → Follow up. Enter a made-up Report ID with any secret.
2. Enter the real Report ID from scenario 1 with a wrong secret.
3. Both show the same generic message. Enter a wrong secret ten times: the next attempt with the **correct** secret is also refused (15-minute lockout).
4. **API:** the lockout and each failure are `SECURITY` audit events (`REPORT_ACCESS_FAILED`, `REPORT_ACCESS_LOCKED`) carrying only a hash of the reference, readable by **soc**. `tests/security/public-portal.spec.ts` "a wrong secret and an unknown Report ID are indistinguishable", "locks a Report ID after 10 failed attempts…".

## Scenario 3: investigators see only their cases

1. As **investigator.b**: Cases lists 0002 and 0004 only. Paste the URL of case 0001 (copy it while signed in as **lead**): the page says the case does not exist, exactly as for a random UUID.
2. **API:** that attempt is a `CASE_ACCESS_DENIED` security event. `tests/security/case-isolation.spec.ts` "records a SECURITY event when a user opens a case they cannot view".
3. As **casemanager**: all non-restricted cases are listed, but 0003 (SECRET, restricted) is not, even though the role has `CASE_VIEW_ALL`.

## Scenario 4: clearance and restricted cases

1. As **grc.director**: open 0003. Classification badge SECRET, restricted flag on.
2. Try to assign **investigator.a** (CONFIDENTIAL clearance) to 0003: refused, the form explains the clearance mismatch.
3. **API:** `api.grant_case_access()` applies the same checks: **lead** (CONFIDENTIAL) cannot be granted access to a SECRET case (`GRANTEE_CLEARANCE_INSUFFICIENT`); **grc.deputy** (SECRET) can, audited as `CASE_ACCESS_GRANTED`. Only `RESTRICTED_CASE_GRANT` holders may grant on a restricted case. `tests/security/case-isolation.spec.ts`.

## Scenario 5: conflict of interest

1. As **investigator.a**: 0004 is not listed; the confirmed conflict removed access.
2. As **casemanager**: try to assign **investigator.a** to 0004: refused ("declared conflict").
3. As **lead** on 0001: declare a conflict with a declaration text. The case disappears from your list immediately.
4. **API:** **casemanager** decides the conflict (`api.decide_conflict`); the declarer cannot decide their own. `tests/security/case-isolation.spec.ts` "a conflict cannot be decided by the person who declared it".

## Scenario 6: dual-controlled identity reveal (API)

1. As **investigator.b** on 0002: no identity is shown anywhere, only the opaque WB-ID.
2. **API:** **grc.director** requests a reveal with a 20+ character justification and cannot approve it; **grc.deputy** approves; **grc.director** resolves once. The audit trail records `REPORTER_IDENTITY_REVEALED` with ids only, as a `SECURITY` event the case team cannot read. `tests/security/whistleblower-vault.spec.ts` (all cases).

## Scenario 7: administrators see no cases

1. As **admin**: sign-in works, but the case list is empty and any case URL gives "not found".
2. **API:** granting **admin** the CASE_MANAGER role to themselves is refused; granting **committee** INVESTIGATOR with a justification is audited as `ROLE_GRANTED` (`ADMIN`) and takes effect at the next transaction; **audit** reads BUSINESS and ADMIN events as metadata without case titles or descriptions. `tests/security/admin-separation.spec.ts`.

Automated UI equivalent: `tests/e2e/first-slice.spec.ts` "revoked users cannot sign in and administrators see no cases".

## Scenario 8: revoked user and brute force

Sign in as **revoked**: a generic failure, the same message as for a wrong password. After 10 failed attempts for one account within 15 minutes (or 50 from one client), further attempts are refused with the same message.

## Scenario 9: audit chain integrity (API)

`api.verify_audit_chain()` as **audit** or **soc** returns no rows when the chain is intact. To see a break, as a superuser in `psql` inside a transaction: `alter table audit.audit_event disable trigger all; update audit.audit_event set reason = 'x' where seq = 5;` then `select * from audit.verify_chain();` and `rollback`. Automated: `tests/security/audit-immutability.spec.ts` "detects tampering…". Investigators cannot call the verifier at all.

## Scenario 10: Arabic first, accessible

1. Switch both apps to Arabic. Layout mirrors (logical CSS properties); the progress tracker, tables and forms read right-to-left.
2. Keyboard only: skip link, focus order, focusable scrollable regions, visible focus. `pnpm test:a11y` runs axe on the main pages in both languages.

## Scenario 11: evidence with chain of custody (the second slice)

1. As **investigator.a** (assigned to 0001): open the case → "Evidence" card → choose a PDF, give it a title, pick the type and a classification (never below the case's, never above your own clearance) → "Upload evidence". The success message carries the SHA-256; the table shows EV-001, the file, its size and "Available"; the versions panel shows the hash, the scanner and the chain of custody "Received → Stored in the vault".
2. "Download" streams the exact bytes through the app with `Content-Disposition: attachment`, `nosniff` and `no-store` headers. The custody list gains "Downloaded" and the audit timeline shows "Evidence downloaded". The browser never receives a storage URL.
3. Upload a `.txt` file containing the EICAR test string: "The scanner rejected this file as suspected malware." The item is listed as Rejected with the version's scan result, and the ledger records `MALWARE_DETECTED` as a `SECURITY` event.
4. Rename an executable to `.pdf` and upload it: "does not match its extension". Nothing is written to storage or the database.
5. "Add a new version" on EV-001 with a changed file: version 2 becomes current; version 1 stays downloadable. Uploading the identical file again is refused as a duplicate.
6. As **triage** (grant on 0001, no `EVIDENCE_DOWNLOAD`): the card lists the item but shows no upload form and no download links; pasting the download URL answers "not found" and records `EVIDENCE_ACCESS_DENIED`. As **investigator.b**: the case page and the download URL both answer "not found".

Automated equivalent: `tests/e2e/evidence.spec.ts`; `tests/integration/evidence.spec.ts`; `tests/security/evidence-access.spec.ts`, `tests/security/storage-policy.spec.ts`. The local filesystem adapter and the mock scanner are PRODUCTION_SUBSTITUTION_REQUIRED.

## What these scenarios do not show

Interviews, findings, committee, decisions, corrective actions, retention and reporting are not implemented (`NOT_STARTED`). Local sign-in, the HMAC key provider, the local filesystem evidence store and the mock malware scanner are prototype substitutions, not production controls.
