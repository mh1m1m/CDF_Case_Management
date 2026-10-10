# UAT Evidence Templates

Copy a template into the cycle folder (`uat/<cycle-id>/` in the project shared folder) and fill it in. Cycle ids are `UAT-<YYYY-MM-DD>-<n>`. Records hold synthetic data, ids and technical metadata only: never a password, Report secret, session cookie, service key or real personal data. Screenshots are cropped to the relevant area and checked for credentials before saving.

Results: `PASS` (every expected result seen), `FAIL` (at least one expected result not seen; defect raised), `BLOCKED` (could not run because of an earlier failure or missing precondition; reason given), `NOT_RUN` (deliberately skipped; reason given).

## 1. Execution record

One per scenario per run.

```markdown
# Execution record: <scenario id> <scenario title>

| Field               | Value                                               |
| ------------------- | --------------------------------------------------- |
| Cycle               | UAT-YYYY-MM-DD-n                                    |
| Scenario            | UAT-XXX-NN                                          |
| Tester / automation | <name or "Playwright: <spec>">                      |
| Actor account(s)    | <seed emails used>                                  |
| Environment         | DEMO                                                |
| Commit SHA          | <40-char SHA deployed on both apps>                 |
| Vercel deployments  | cdf-whistleblowing: <id> · cdf-investigations: <id> |
| CI run(s) for SHA   | <workflow run ids>                                  |
| Language            | ar / en / both                                      |
| Browser / device    | <e.g. Chromium 1xx desktop; iPhone Safari>          |
| Started / finished  | <UTC timestamps>                                    |
| Result              | PASS / FAIL / BLOCKED / NOT_RUN                     |
| Defects             | <Linear ids or "none">                              |

## Steps

| Step | Expected result (from SCENARIOS.md) | Actual | Result | Evidence |
| ---- | ----------------------------------- | ------ | ------ | -------- |
| 1    |                                     |        |        |          |
| 2    |                                     |        |        |          |

## Notes

<observations, known findings seen (e.g. CDF-53), API step query output references>
```

## 2. Defect record (Linear issue body)

Title: `UAT: <short behaviour>`. Team CDF, project QA, related to CDF-51 and the feature's story.

```markdown
**Found in:** <scenario id> step <n> · cycle <cycle id> · DEMO · SHA `<sha>`
**Actor:** <seed email>
**Language / device:** <ar|en> · <browser>

**Expected** (SCENARIOS.md): <text>
**Actual:** <text; include the correlation reference shown in any error message>

**Steps to reproduce**

1. …

**Evidence:** <link to screenshot or record in uat/<cycle-id>/ (synthetic only)>

**Security severity:** CRITICAL / HIGH / MEDIUM / LOW / NONE (UAT_PLAN.md §8)
**Priority:** Urgent / High / Medium / Low
**Regression set to rerun after fix:** <area from E2E_CANDIDATES.md §3>
```

## 3. Retest record

```markdown
# Retest: <defect id> (<scenario id>)

| Field                 | Value                                |
| --------------------- | ------------------------------------ |
| Defect                | CDF-NN                               |
| Fix PR / merge SHA    | #NN / <sha>                          |
| Deployed SHA retested | <sha>                                |
| Retester              | <name> (not the person who fixed it) |
| Date (UTC)            |                                      |
| Original scenario     | UAT-XXX-NN: PASS / FAIL              |
| Regression set        | <area>: PASS / FAIL (list scenarios) |
| CI for SHA            | <run ids>                            |
| Outcome               | Defect closed / reopened             |
```

## 4. API step evidence

For steps marked **API** (no screen yet), record:

```markdown
| Step | Security context (seed user) | Statement (no secrets)                         | Rows / error returned            | Matches automated test |
| ---- | ---------------------------- | ---------------------------------------------- | -------------------------------- | ---------------------- |
| 4    | soc@example.test             | select action, category from audit.audit_event | REPORT_ACCESS_FAILED, SECURITY … | public-portal.spec.ts  |
```

## 5. Cycle summary

```markdown
# UAT cycle summary: UAT-YYYY-MM-DD-n

**Build:** SHA `<sha>` · Vercel <ids> · CI <run ids> · Supabase DEMO migration head `<version>`
**Test lead:** <name> · **Testers:** <names>
**Window:** <UTC start – end>

## Entry criteria

| #   | Met? | Evidence |
| --- | ---- | -------- |
| E1  |      | CDF-32 … |
| E2  |      | CDF-33 … |
| E3  |      |          |
| E4  |      |          |
| E5  |      |          |
| E6  |      |          |
| E7  |      |          |
| E8  |      |          |

## Results

| Group      | Scenarios | PASS | FAIL | BLOCKED | NOT_RUN |
| ---------- | --------- | ---- | ---- | ------- | ------- |
| UAT-ENV    | 4         |      |      |         |         |
| UAT-PORTAL | 6         |      |      |         |         |
| UAT-VAULT  | 2         |      |      |         |         |
| UAT-INTAKE | 2         |      |      |         |         |
| UAT-WF     | 3         |      |      |         |         |
| UAT-COI    | 2         |      |      |         |         |
| UAT-AUTHZ  | 2         |      |      |         |         |
| UAT-EVID   | 4         |      |      |         |         |
| UAT-ADMIN  | 3         |      |      |         |         |
| UAT-UX     | 2         |      |      |         |         |
| **Total**  | **30**    |      |      |         |         |

## Defects

| Linear | Severity | Priority | Scenario | Status | Deferral (owner decision) |
| ------ | -------- | -------- | -------- | ------ | ------------------------- |

## Exit criteria

| #   | Met? | Note |
| --- | ---- | ---- |
| X1  |      |      |
| X2  |      |      |
| X3  |      |      |
| X4  |      |      |
| X5  |      |      |
| X6  |      |      |

## Known limitations observed

<e.g. API-only steps, production substitutions, portal attachments pending CDF-72>

## Recommendation

Accept / Accept with deferrals / Reject, with reasons.
```

## 6. Acceptance sign-off

```markdown
# UAT acceptance: UAT-YYYY-MM-DD-n

Classification: SYNTHETIC-DATA REFERENCE IMPLEMENTATION. This acceptance covers the listed scenarios on the
listed build in the DEMO environment only. It is not a production acceptance and not a statement that the
platform is production ready.

| Field            | Value                                            |
| ---------------- | ------------------------------------------------ |
| Build accepted   | SHA `<sha>`                                      |
| Scope            | Wave 1 scenarios UAT-ENV … UAT-UX (30)           |
| Decision         | ACCEPTED / ACCEPTED WITH DEFERRALS / REJECTED    |
| Deferred defects | <Linear ids with owner's reason>                 |
| Conditions       | <e.g. portal attachments not yet built (CDF-72)> |
| Business owner   | <name>, <date UTC>                               |
| Test lead        | <name>, <date UTC>                               |
| Linked from      | CDF-51                                           |
```
