# Implementation Plan

Phase 0 planning deliverables, protocol section 91 items 3, 7, 9, 10 and 11. Items 1, 2, 4, 5, 6 and 8 are in [`BASELINE_ANALYSIS.md`](../BASELINE_ANALYSIS.md).

---

## 3. Target repository map

```
cdf-case-platform/
├── apps/
│   ├── whistleblowing-web/        Public Next.js portal (untrusted internet boundary). No user sessions.
│   │                              DB login: cdf_portal → can only become `anon` → can only EXECUTE public_api.*
│   └── investigation-web/         Protected Next.js app (authenticated boundary).
│                                  DB login: cdf_bff → SET LOCAL ROLE authenticated + JWT claims per transaction
├── packages/
│   ├── config/                    Env schemas (server vs public split), shared tsconfig/eslint presets
│   ├── contracts/                 Shared enums and DTO types (roles, permissions, classification, statuses, audit actions)
│   ├── validation/                Zod schemas for every command input (used client-side for UX, server-side for enforcement)
│   ├── domain/                    Pure domain rules: identifiers, classification ordering, report reference format
│   ├── workflow/                  Workflow definition mirror + transition evaluation (pure)
│   ├── authorization/             Role→permission model + can_* predicates mirroring the SQL functions (pure)
│   ├── audit/                     Audit action catalogue, SecurityEventSink port, request-context helpers
│   ├── application/               Use cases + ports (repositories, IdentityProvider, EvidenceStorage, KeyManagementProvider, RateLimiter, MalwareScanner)
│   ├── infrastructure/            Adapters: postgres/ (portable SQL), supabase/ (Auth, Storage), prototype/ (keys, scanner, dev identity)
│   ├── i18n/                      ar/en message catalogs, direction helpers
│   └── ui/                        CDF design tokens, Tailwind preset, CDF* React components
├── infrastructure/
│   └── supabase/
│       ├── config.toml            Supabase CLI config (run with `supabase --workdir infrastructure`)
│       ├── migrations/            Authoritative schema, RLS, functions, reference data
│       ├── seed/                  Synthetic demo data only
│       ├── policies/              Generated RLS policy snapshot (drift-checked in CI)
│       ├── functions/             Edge functions (none planned; BFF is Next.js)
│       └── tests/
│           └── bootstrap/         Supabase-compatibility shim for plain PostgreSQL (roles, auth/storage stubs)
├── architecture/                  ADRs, diagrams, threat model, data model, security rules, workflow, production mapping
├── compliance/                    requirements.yaml (machine-readable traceability), mappings, CI evidence
├── tests/
│   ├── unit/                      Cross-package unit tests
│   ├── integration/               Use cases against a real database
│   ├── security/                  RLS / isolation / vault / audit immutability (DB-level, role-switching)
│   ├── e2e/                       Playwright role journeys across both apps
│   └── accessibility/             axe-core checks in RTL and LTR
├── scripts/                       db reset/apply, policy snapshot, SBOM
├── .github/                       workflows, CODEOWNERS, dependabot.yml, PR template
├── CLAUDE.md  BASELINE_ANALYSIS.md  README.md  SECURITY.md  CONTRIBUTING.md  PROJECT_STATUS.md
├── package.json  pnpm-workspace.yaml
```

Material changes from protocol section 8, each recorded in an ADR:

| Change                                            | Why                                                                                                                       | ADR     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------- |
| Added `packages/infrastructure`                   | Section 7 requires explicit adapters; they need a home outside the domain and application packages                        | ADR-009 |
| Supabase CLI runs with `--workdir infrastructure` | Keeps the protocol's `infrastructure/supabase/` layout while remaining CLI-compatible                                     | ADR-001 |
| Added `tests/bootstrap` shim for plain PostgreSQL | Lets the schema and RLS suites run on vanilla PostgreSQL, which is also evidence of portability to Alibaba RDS PostgreSQL | ADR-008 |

---

## 7. RLS / access model plan

### 7.1 Enforcement layers

```
Browser ──► Next.js server (BFF)
              1. Session → verified identity (IdentityProvider)
              2. Zod validation (packages/validation)
              3. Application authorization pre-check (packages/authorization)   ◄── fast, user-friendly denial
              4. DB transaction with security context:
                   SET LOCAL ROLE authenticated
                   set_config('request.jwt.claims', {sub, ...})
                   set_config('cdf.request_id', <uuid>)
            ──► PostgreSQL
              5. Reads: table SELECT through RLS policies that call authz.can_* functions
              6. Writes: only via api.* SECURITY DEFINER command functions that call authz.* again,
                 apply workflow guards, and write audit events in the same transaction
              7. audit.audit_event: INSERT only through audit.record_event(); UPDATE/DELETE/TRUNCATE rejected
```

Application roles have **no INSERT/UPDATE/DELETE privilege on any table**. Every state change is a named, audited command. This is the main structural defence against "authorization only in the UI" and against unaudited writes.

### 7.2 Database roles

| Role            | Login          | Can do                                                  | Used by                                                                                     |
| --------------- | -------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `anon`          | no             | EXECUTE `public_api.*` only                             | Public portal (via `cdf_portal`)                                                            |
| `authenticated` | no             | SELECT on RLS-protected tables; EXECUTE `api.*`         | Investigation app (via `cdf_bff`)                                                           |
| `cdf_portal`    | yes, NOINHERIT | `SET ROLE anon`                                         | whistleblowing-web server                                                                   |
| `cdf_bff`       | yes, NOINHERIT | `SET ROLE authenticated` (and `anon` for health checks) | investigation-web server                                                                    |
| `service_role`  | (Supabase)     | Bypasses RLS                                            | **Not used by application code.** Storage adapter only, server-side, after DB authorization |
| `postgres`      | yes            | Migrations                                              | CI / operators                                                                              |

Because the login roles are NOINHERIT, a code path that forgets to set the security context has no privileges at all. It fails closed.

### 7.3 Identity in the database

`authz.current_user_id()` reads `sub` from `request.jwt.claims` and returns it **only if** a matching `iam.user_profile` exists with `status = 'ACTIVE'`. Revoked or suspended users therefore lose all access immediately, even with a still-valid token. The function does not depend on Supabase's `auth` schema, so the same SQL works with a future CDF OIDC IdP.

### 7.4 Authorization factors (RBAC + ABAC + case ACL)

| Factor                      | Source                                                                             | Used in                                  |
| --------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| User active                 | `iam.user_profile.status`                                                          | every check                              |
| Permission present          | `iam.user_role_assignment` (effective-dated, not revoked) → `iam.role_permission`  | `authz.has_permission(code)`             |
| Clearance vs classification | `user_profile.clearance` ≥ `case_record.classification`                            | `authz.can_view_case`                    |
| Restricted-case flag        | `case_record.is_restricted`                                                        | global-view permission ignored when true |
| Case assignment             | `case_mgmt.case_assignment` (active)                                               | `authz.can_view_case`, `can_edit_case`   |
| Case access grant           | `case_mgmt.case_access_grant` (active, effective-dated, scoped)                    | `authz.can_view_case`                    |
| Conflict                    | `case_mgmt.conflict_check` with status `CONFLICT_DECLARED` or `CONFLICT_CONFIRMED` | overrides everything: deny               |
| Supervisor authority        | permission `CASE_ASSIGN` + view                                                    | `authz.can_assign_case`                  |
| Committee membership        | grant with scope `COMMITTEE`                                                       | later phase                              |
| Special permission          | `REPORTER_IDENTITY_REVEAL`, `EXPORT_APPROVE`, `LEGAL_HOLD_APPLY`                   | specific functions                       |

### 7.5 Central authorization functions

| SQL function (schema `authz`)                              | TypeScript mirror (`@cdf/authorization`) | Phase |
| ---------------------------------------------------------- | ---------------------------------------- | ----- |
| `current_user_id()`                                        | `Identity` from IdentityProvider         | 3     |
| `has_permission(code)`                                     | `hasPermission()`                        | 3     |
| `can_view_report(report_id)`                               | `canViewReport()`                        | 5     |
| `can_view_case(case_id)`                                   | `canViewCase()`                          | 4     |
| `can_edit_case(case_id)`                                   | `canEditCase()`                          | 4     |
| `can_assign_case(case_id)`                                 | `canAssignCase()`                        | 4     |
| `can_reveal_whistleblower_identity(case_id)`               | `canRevealWhistleblowerIdentity()`       | 5     |
| `can_view_evidence(evidence_id)` / `can_download_evidence` |                                          | 7     |
| `can_close_case(case_id)`                                  |                                          | 10    |
| `can_export_case(case_id)`                                 |                                          | 12    |
| `can_apply_legal_hold(case_id)`                            |                                          | 11    |

Both layers are tested against the same fixture matrix so they cannot drift silently.

### 7.6 Role → permission baseline (first slice)

| Role              | Key permissions                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| INTAKE_OFFICER    | INTAKE_VIEW, REPORT_MESSAGE_REPLY                                                                                |
| TRIAGE_OFFICER    | INTAKE_VIEW, REPORT_TRIAGE, CASE_CREATE, REPORT_MESSAGE_REPLY, WORKFLOW_SCREEN                                   |
| CASE_MANAGER      | CASE_VIEW_ALL, CASE_EDIT_ALL, CASE_CREATE, CASE_ASSIGN, WORKFLOW_ADVANCE, INVESTIGATION_APPROVE, CONFLICT_MANAGE |
| LEAD_INVESTIGATOR | CASE_ASSIGN (within assigned cases), WORKFLOW_ADVANCE                                                            |
| INVESTIGATOR      | (assigned cases only) CONFLICT_DECLARE                                                                           |
| GRC_DIRECTOR      | CASE_VIEW_ALL, INVESTIGATION_APPROVE, REPORTER_IDENTITY_REVEAL, RESTRICTED_CASE_GRANT                            |
| INTERNAL_AUDIT    | AUDIT_VIEW (metadata, no case content)                                                                           |
| SOC_ANALYST       | SECURITY_EVENT_VIEW                                                                                              |
| PLATFORM_ADMIN    | USER_ADMIN, ROLE_ADMIN — **no case permissions**                                                                 |
| DB_ADMIN          | none in the application; operates migrations only                                                                |

Full matrix: [`SECURITY_RULES.md`](SECURITY_RULES.md).

---

## 9. Phased development plan

Each phase is one or more PRs from a feature branch. No phase merges to `main` without human review (section 52).

| Phase | Scope                           | Key deliverables                                                                                                                                                             | Exit criteria                                                |
| ----- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 0     | Baseline analysis               | BASELINE_ANALYSIS.md, this plan, CLAUDE.md, ADR-001…010, PROJECT_STATUS.md                                                                                                   | Reviewed                                                     |
| 1     | Repository + governance         | pnpm monorepo, strict TS, lint, CI pipeline (§49), Dependabot, CODEOWNERS, PR template, SECURITY.md, CONTRIBUTING.md, README, .env.example, secret scan, CodeQL, SBOM script | CI green on an empty-feature PR                              |
| 2     | DB/domain foundation            | Schemas, enums, case master, people, sequences, audit ledger, Supabase shim, reset script                                                                                    | Reset from zero reproduces DB; audit immutability tests pass |
| 3     | Identity, roles, RLS            | `iam.*`, `authz.*`, DB roles, IdentityProvider adapters, sessions                                                                                                            | Role/RLS matrix tests pass                                   |
| 4     | Case master + assignments + ACL | case_record, assignment, access grants, conflict checks, case list/detail                                                                                                    | Case isolation suite passes                                  |
| 5     | Portal + identity vault         | Anonymous submission, Report_ID + secret, two-way messaging, rate limiting, protected_identity, reveal                                                                       | Vault suite passes; enumeration tests pass                   |
| 6     | Workflow engine                 | Definitions, instances, guarded transitions, SLA fields                                                                                                                      | Transition authorization tests                               |
| 7     | Evidence + custody              | Second vertical slice                                                                                                                                                        | Storage policy suite                                         |
| 8     | Forms, activities, interviews   | 19 WB-FRM definitions as data, instances with versions/hash                                                                                                                  |                                                              |
| 9     | Findings, reviews, committee    | Third vertical slice                                                                                                                                                         |                                                              |
| 10    | Corrective actions, closure     | Fourth slice part 1                                                                                                                                                          |                                                              |
| 11    | Records, retention, legal hold  | Fourth slice part 2                                                                                                                                                          | Legal hold blocks disposition                                |
| 12    | Documents + export              | Versioned documents, export approval, watermark                                                                                                                              | Export suite                                                 |
| 13    | Audit/security dashboards       | Read-only, permission-scoped                                                                                                                                                 |                                                              |
| 14    | Hardening                       | a11y, performance, security review                                                                                                                                           |                                                              |
| 15    | Traceability + release          | requirements.yaml complete, release evidence                                                                                                                                 | Section 93 criteria A–T                                      |

**This first execution covers Phases 0–1 fully and Phases 2–6 to the extent needed by the first vertical slice.** Later phases extend the same schemas.

---

## 10. Risk register

| ID  | Risk                                                                                            | Likelihood      | Impact   | Mitigation                                                                                                                                     | Owner         |
| --- | ----------------------------------------------------------------------------------------------- | --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| R1  | Prototype mistaken for an approved CDF production channel                                       | Medium          | Critical | Classification banner on every page of both apps; README and portal text state it is a synthetic demonstration; no real reporting instructions | Product owner |
| R2  | Real data entered into the prototype (e.g. during demos)                                        | Medium          | Critical | Banner + portal warning; seed-only data; data-safety rule in CLAUDE.md; DEMO environment reset policy                                          | Product owner |
| R3  | Supabase/Vercel coupling leaks into domain code                                                 | Medium          | High     | Ports in `@cdf/application`; lint rule forbidding `@supabase/*` imports outside `packages/infrastructure`                                      | Engineering   |
| R4  | Service-role key exposure                                                                       | Low             | Critical | Never `NEXT_PUBLIC_*`; env schema rejects it in public config; secret scanning in CI; service role used by the storage adapter only            | Engineering   |
| R5  | RLS gap on a new table                                                                          | Medium          | Critical | Migration test asserting every table in application schemas has RLS enabled; default no grants                                                 | Engineering   |
| R6  | Audit hash chain becomes a write bottleneck (serialised by advisory lock)                       | Low (prototype) | Medium   | Acceptable for prototype; production sink (SLS) documented in PRODUCTION_MAPPING                                                               | Architecture  |
| R7  | Free-tier limits (Supabase pausing, Vercel limits) disrupt demos                                | High            | Medium   | DB reproducible from migrations + seed; DEMO reset runbook                                                                                     | Operations    |
| R8  | Hosted Supabase connection pooling breaks `SET LOCAL` context                                   | Low             | High     | Transaction-mode pooler + all context set inside the same transaction; integration test asserts context is not leaked between requests         | Engineering   |
| R9  | Local identity substitute used outside local/test                                               | Low             | Critical | Adapter refuses to load when `VERCEL` is set or `CDF_ENVIRONMENT` ∉ {local, test}; covered by a unit test                                      | Engineering   |
| R10 | Governance values (quorum, disciplinary authority, retention period) invented to "make it work" | Medium          | High     | Kept SOURCE_REQUIRED in `config.setting`; features depending on them show "configuration required"                                             | Product owner |
| R11 | Anonymous reporter de-anonymised through metadata (IP, timing, rate-limit keys)                 | Medium          | High     | No IP stored with reports; rate-limit keys are HMACs with daily rotation and short expiry; uniform responses                                   | Engineering   |
| R12 | Vercel preview URLs publicly reachable with CDF branding                                        | Medium          | Medium   | Enable Vercel Deployment Protection on both projects; previews hold synthetic data only                                                        | Product owner |
| R13 | Arabic brand font not available                                                                 | High            | Low      | System font fallback; `BRAND_SOURCE_REQUIRED` tracked                                                                                          | Design        |
| R14 | Docker-dependent Supabase stack unavailable in some environments                                | Medium          | Medium   | Plain-PostgreSQL shim path for DB and security suites; CI also validates against the Supabase CLI stack                                        | Engineering   |

---

## 11. First vertical slice plan

**Goal (section 56):** Anonymous Report → Triage → Create Case → Assign Investigator → Open Investigation, with database, RLS, audit, workflow, UI and tests.

### 11.1 Journey

| Step | Actor (synthetic)               | App                | Command                                                                                          | Audit events                                                 |
| ---- | ------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 1    | Anonymous reporter              | whistleblowing-web | `public_api.submit_report` → returns Report ID + one-time secret                                 | `REPORT_SUBMITTED` (actor = ANONYMOUS_REPORTER)              |
| 2    | Reporter                        | whistleblowing-web | `public_api.get_report_status`, `public_api.post_reporter_message` (Report ID + secret)          | `REPORT_MESSAGE_RECEIVED`                                    |
| 3    | intake@example.test             | investigation-web  | View intake queue (RLS), reply to reporter                                                       | `REPORT_VIEWED`, `REPORT_MESSAGE_SENT`                       |
| 4    | triage@example.test             | investigation-web  | `api.triage_report` (outcome OPEN_CASE + reason)                                                 | `REPORT_TRIAGED`                                             |
| 5    | triage@example.test             | investigation-web  | `api.create_case_from_report` → case + workflow instance (REFERRAL → REGISTERED)                 | `CASE_CREATED`, `WORKFLOW_TRANSITION`                        |
| 6    | lead@example.test / casemanager | investigation-web  | Advance REGISTERED → SCREENING → CONFLICT_CHECK → TRIAGE → JURISDICTION → INVESTIGATION_APPROVAL | `WORKFLOW_TRANSITION` ×5                                     |
| 7    | casemanager                     | investigation-web  | `api.assign_case` (investigator.a, role INVESTIGATOR)                                            | `CASE_ASSIGNED`                                              |
| 8    | investigator.a                  | investigation-web  | `api.declare_conflict` (NO_CONFLICT)                                                             | `CONFLICT_DECLARED`                                          |
| 9    | grc.director / casemanager      | investigation-web  | `api.transition_case(APPROVE_INVESTIGATION)` (guard: active investigator with NO_CONFLICT)       | `WORKFLOW_TRANSITION`                                        |
| 10   | investigator.b                  | investigation-web  | Tries the case URL / search                                                                      | **Denied**; `ACCESS_DENIED` security event, no metadata leak |

### 11.2 Schema delivered in the slice

`iam` (role, permission, role_permission, user_profile, user_role_assignment), `intake` (report, report_message, report_triage), `protected_identity` (reporter_identity), `case_mgmt` (case_record, person, case_person, allegation, case_assignment, case_access_grant, conflict_check, case_number_counter), `workflow` (definition, state, transition_definition, instance, transition_event), `audit` (audit_event), `public_api` (rate_limit_bucket), `config` (setting).

### 11.3 Tests delivered in the slice

| Suite         | File                                      | Proves                                                                                                            |
| ------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| security      | `authorization.spec.ts`                   | Role → permission behaviour, admin has no case access, revoked user has nothing                                   |
| security      | `case-isolation.spec.ts`                  | Investigator A vs B: view, list, open by UUID, search, linked report, audit of denial                             |
| security      | `whistleblower-vault.spec.ts`             | No role can SELECT `protected_identity`; reveal needs permission + case access + justification; reveal is audited |
| security      | `audit-immutability.spec.ts`              | UPDATE/DELETE/TRUNCATE on `audit_event` rejected for every app role; chain verifies; tamper detected              |
| security      | `admin-separation.spec.ts`                | PLATFORM_ADMIN and DB-level `cdf_bff` without context see no case content                                         |
| security      | `public-portal.spec.ts`                   | `anon` cannot read any table; unknown Report ID and wrong secret are indistinguishable; rate limit                |
| security      | `rls-coverage.spec.ts`                    | Every table in app schemas has RLS enabled; no table grants for INSERT/UPDATE/DELETE to app roles                 |
| integration   | `first-slice.spec.ts`                     | Steps 1–10 through the application layer                                                                          |
| unit          | packages                                  | workflow evaluation, authorization predicates, identifiers, validation                                            |
| e2e           | `first-slice.e2e.ts`                      | Steps 1–10 through both UIs                                                                                       |
| accessibility | `portal.a11y.ts`, `investigation.a11y.ts` | axe checks, Arabic RTL and English LTR                                                                            |

Section 61 also names `evidence-access.spec.ts` and `storage-policy.spec.ts` (delivered in Phase 7) and `export.spec.ts` (Phase 12, tracked as NOT_STARTED in [`PROJECT_STATUS.md`](../PROJECT_STATUS.md), not stubbed with a passing placeholder).
