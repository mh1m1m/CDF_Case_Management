# Sentry plan (CDF-64, CDF-81)

Classification: SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Sentry is a prototype observability processor: `PRODUCTION_SUBSTITUTION_REQUIRED` (replaced by the approved SOC/observability platform, see [`architecture/PRODUCTION_MAPPING.md`](../../architecture/PRODUCTION_MAPPING.md)). Nothing in this document makes the platform production ready.

| Field         | Value                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Linear        | CDF-64 plan and scrubber; CDF-81 SDK wiring (parent EPIC 18, CDF-23)                                                               |
| Status        | Plan + scrubber: IN_REVIEW (CDF-64). Server-side SDK: IN_REVIEW (CDF-81). Sentry projects: created. DSNs in Vercel: NOT_STARTED    |
| Approval      | Fady, 2026-10-07 12:03 decision 8: Sentry for the synthetic reference implementation, after the first Vercel deployment (met)      |
| Scrubber      | [`packages/infrastructure/src/observability/scrub.ts`](../../packages/infrastructure/src/observability/scrub.ts)                   |
| Scrubber test | `packages/infrastructure/src/observability/scrub.test.ts` (`pnpm test`)                                                            |
| SDK options   | [`packages/infrastructure/src/observability/sentry-options.ts`](../../packages/infrastructure/src/observability/sentry-options.ts) |
| SDK entry     | `apps/*/src/instrumentation.ts` (the only files that import `@sentry/nextjs`)                                                      |

## 1. What Sentry is for

Runtime exceptions, regressions and coarse performance of the two prototype apps (CLAUDE.md §11). It is **not** an audit trail, a security event store or a log of user activity: those stay in the append-only audit ledger (ADR-005) and the `SecurityEventSink` port. A Sentry event carries technical metadata only: error type, scrubbed message, stack frames, route, release, environment and the correlation ID that users already see in generic error messages (§82).

## 2. Projects and environments

The two apps never share security context (ADR-002), so they never share a Sentry project or DSN either.

| Sentry project (org `cdf-xm`, region `de.sentry.io`) | App                       | Vercel project       | Runtimes instrumented                     |
| ---------------------------------------------------- | ------------------------- | -------------------- | ----------------------------------------- |
| `cdf-whistleblowing`                                 | `apps/whistleblowing-web` | `cdf-whistleblowing` | server and edge only (no browser SDK, §3) |
| `cdf-investigations`                                 | `apps/investigation-web`  | `cdf-investigations` | server and edge only (browser SDK: §8.3)  |

- **Environments:** `dev` (Vercel production deployments of `main`, backed by Supabase DEV), `preview` (Vercel preview deployments), `demo` (only once a DEMO environment exists; not before DEV is validated). Local development sends nothing: the SDK is disabled when no DSN is configured.
- **Release:** the git commit SHA (`VERCEL_GIT_COMMIT_SHA`), identical for both apps at the same commit.
- **Source maps:** not uploaded (CDF-81). Uploading needs `withSentryConfig` and an auth token; server stack traces already name the compiled file, function and line. If upload is wanted later it needs its own decision: a CI/Vercel-only build secret, never `NEXT_PUBLIC_*`, with `sourcemaps.deleteSourcemapsAfterUpload`.

## 3. The public portal is server-only

The whistleblowing portal handles anonymous reporters. Loading a third-party script in their browser would disclose to Sentry that a person visited the portal, from which IP, when. The portal therefore gets **no browser SDK, no Session Replay and no user feedback widget**. Server errors in Server Actions and route handlers are still captured, after scrubbing. The investigation app may later use the browser SDK with the same scrubber, without Session Replay (§8.3); CDF-81 wires both apps server-side only.

## 4. What is never sent

Enforced by the scrubber in `beforeSend`, `beforeSendTransaction` and `beforeBreadcrumb`, and backed by Sentry's server-side scrubbing (§6).

| Never sent                                                                                                   | How the scrubber removes it                                                                                                |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Whistleblower identity (name, email, phone, preferred contact)                                               | Denied keys (`identity`, `fullName`, `email`, `phone`, …); email and phone patterns in free text                           |
| Case and report narrative, Arabic or English                                                                 | Denied keys (`description`, `subjectDescription`, `summary`, `body`, `reason`, `justification`, …); Arabic-script runs     |
| Evidence content and file names                                                                              | Denied keys (`fileName`, `originalFileName`, `objectKey`); request bodies dropped                                          |
| Report ID (`WB-…`) and follow-up secret, compact or grouped; secret HMACs                                    | Report reference and Crockford secret patterns; hex digests ≥ 40 characters                                                |
| Credentials: passwords, tokens, JWTs, cookies, `Authorization`, keys                                         | Denied key fragments (`password`, `secret`, `token`, `cookie`, `session`, `pepper`, `servicerole`, …); Bearer/JWT patterns |
| Request bodies, cookies, query strings, `env`                                                                | Dropped from `request`; URLs keep scheme, host and path only                                                               |
| Request headers other than `Accept`, `Accept-Language`, `Content-Type`, `Content-Length`, `X-Correlation-Id` | Header allow-list                                                                                                          |
| IP addresses (IPv4/IPv6), the `user` object, geo                                                             | `user` removed; IP patterns; `sendDefaultPii: false`                                                                       |
| Saudi national ID / Iqama, phone numbers, other long digit runs                                              | `[12]` + 9 digits; `+`/`00` international and `05x` mobile; any 9+ digit run                                               |
| Stack-frame local variables, log format parameters                                                           | `frames[].vars` and `logentry.params` dropped                                                                              |

Free-form areas are allow-listed, because English names and narrative cannot be recognised by pattern: `contexts` keeps only the SDK's standard contexts (`os`, `runtime`, `browser`, `device`, `app`, `trace`, `culture`, `cloud_resource`, `response.status_code`) and their technical fields; `extra` keeps only the correlation ID, error kind and route template; `tags` keeps those plus the `app` name and the SDK's technical tags; allow-listed `extra`, `tags` and context fields keep scalar values only (an object under an allowed key is replaced); breadcrumb `data` keeps only method, status code and URL paths; breadcrumb `message` is kept (as a path) only for `navigation`, `http`, `fetch` and `xhr` breadcrumbs and replaced for every other category. Stack-frame code locations (file, module, function, line) are kept unchanged so grouping works. Unknown top-level keys, including `sdkProcessingMetadata`, are dropped. Report secrets and references are matched in every shape the portal's normalisers accept (any case, look-alike letters, any separator, including mixed and multi-character separators such as `ABCD - EFGH JKMN-…` and `WB 0123…`); PostgreSQL `Failing row contains (…)` and `Key (…)=(…)` echoes are redacted, and `detail`, `where` and `hint` keys are denied. Object keys that themselves contain personal data are dropped.

Values are replaced by `[REDACTED:<kind>]`, never hashed, so nothing derived from a secret leaves the process. The scrubber is pure, does not mutate its input and is idempotent.

Event structure is preserved: event ID, timestamps, level, release, environment, SDK metadata, exception types, frame file names, functions and line numbers, runtime contexts and non-sensitive tags stay as they are, so grouping and regressions still work.

## 5. SDK configuration (CDF-81)

`@sentry/nextjs` (pinned) is initialised in each app's `src/instrumentation.ts` for the Node.js and edge runtimes, with options from `buildSentryServerOptions(app)` in `@cdf/infrastructure/observability`. Uncaught request errors reach it through Next.js `onRequestError`. There is no `instrumentation-client` file, no `sentry.client.config`, no `withSentryConfig` and no wizard output, so no Sentry code or DSN is shipped to a browser.

| Option                                                         | Value                                                                                                                                                                                                        | Why                                                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dsn`                                                          | `SENTRY_DSN`, a server-scoped Vercel variable per app                                                                                                                                                        | Absent (local, CI unit tests) means Sentry stays off. A malformed value turns Sentry off with a names-only warning, so the SDK never logs the raw DSN. |
| `environment`                                                  | `preview` on Vercel previews, else `CDF_ENVIRONMENT` (`dev`, `demo`, …)                                                                                                                                      | §2                                                                                                                                                     |
| `release`                                                      | `VERCEL_GIT_COMMIT_SHA`                                                                                                                                                                                      | §2                                                                                                                                                     |
| `sendDefaultPii`, `includeLocalVariables`, `sendClientReports` | `false`                                                                                                                                                                                                      | No IPs, cookies, users or frame variables                                                                                                              |
| `tracesSampleRate`                                             | `0.1` on `dev`/`preview`, `0` elsewhere                                                                                                                                                                      | Errors are always sent                                                                                                                                 |
| `tracePropagationTargets`                                      | `[]`                                                                                                                                                                                                         | No `sentry-trace`/`baggage` headers on outgoing requests (Supabase, storage)                                                                           |
| `beforeSend`, `beforeSendTransaction`                          | `scrubOrDrop`: the §4 scrubber; event types other than errors and transactions, or an event the scrubber cannot process, are dropped (fail closed)                                                           | §4                                                                                                                                                     |
| `beforeBreadcrumb`                                             | console breadcrumbs dropped, the rest scrubbed                                                                                                                                                               | §4                                                                                                                                                     |
| `integrations`                                                 | defaults minus `Console`, `LocalVariables`, `LocalVariablesAsync`, `ContextLines`, plus an event processor that drops every event type outside the allow-list (also user feedback, which skips `beforeSend`) | No console capture, no runtime values, no source code sent                                                                                             |
| `initialScope.tags.app`                                        | `whistleblowing-web` / `investigation-web`                                                                                                                                                                   | One tag, from a fixed list                                                                                                                             |

The app refuses to start if any `NEXT_PUBLIC_` variable names Sentry or a DSN (`assertNoSecretsInPublicEnv`).

- No Session Replay, profiling, user feedback or `setUser` anywhere. `setTag` only with values from a fixed list (route template, locale, error kind, correlation ID).
- Console breadcrumbs are dropped entirely; HTTP breadcrumbs keep method, path and status.
- Server Actions keep their current contract: users see a generic message with the correlation ID (§82), and the correlation ID is the only link between a user's report of a problem and a Sentry event.
- The investigation app's pages stay uncached; adding the SDK must not add caching or change response headers beyond its own.
- Sampling: errors 100 % (volume is tiny), transactions 10 % on `dev`/`preview`. Sentry's spike protection stays on.
- Retention: the shortest period the Sentry plan allows; confirm the value when the projects are created.
- Import path: the instrumentation files import `@cdf/infrastructure/observability`, a subpath that loads no database drivers or identity adapters.
- Lint: `@sentry/*` may be imported only by `apps/*/src/instrumentation.ts` (and its envelope test), so no other code can call `Sentry.init`, `setUser`, `captureMessage` or `setTag`.

## 6. Sentry project settings

Defence in depth behind the scrubber, set per project:

- Data Scrubber **on**, Use Default Scrubbers **on**, Scrub IP Addresses **on**, "Prevent Storing of IP Addresses" **on**.
- Additional sensitive fields: `description`, `subjectDescription`, `summary`, `body`, `narrative`, `identity`, `fullName`, `email`, `phone`, `secret`, `reportRef`, `fileName`, `objectKey`, `justification`.
- Advanced Data Scrubbing rules: `[Mask] [Credit card numbers] from [$string]`, `[Remove] [Email addresses] from [$string]`, `[Remove] [IP addresses] from [$string]`, plus a regex rule for `WB-[0-9A-HJKMNP-TV-Z]{12}`.
- Source maps: never publicly accessible; "Allow JavaScript source fetching" **off**.
- Members: Fady and named engineers only; no public dashboards; alerts go to email, not to a public Slack channel (Slack holds no decisions or data, CLAUDE.md §11).

## 7. How this is tested

- **Now (CDF-64):** `scrub.test.ts` (including one negative case per CDF-62 review finding) (unit project, runs in CI `pnpm test`) asserts removal of Arabic and English narrative, report references and secrets (including generated ones), emails, phones, Saudi national ID / Iqama patterns, cookies, auth headers, request bodies, IPs and query strings; preserved event structure; no input mutation; idempotency; cycles and deep nesting.
- **CDF-81:**
  - `apps/whistleblowing-web/src/instrumentation.test.ts` captures an error carrying synthetic narrative (Arabic and English), a report reference, a secret, an email and a phone number, with a synthetic user, extra, context and tag, through the real SDK with a transport stub, and asserts the outgoing envelope contains none of them; a user-feedback event is not sent at all.
  - `sentry-options.test.ts`: options, DSN validation, `beforeSend` calls the scrubber, disallowed event types and scrubber failures are dropped, integrations removed.
  - `scripts/security/check-sentry-boundary.mjs` (CI step in the quality job, self-test in `tests/unit/sentry-boundary.test.ts`): no `NEXT_PUBLIC_` Sentry variable, no browser entry point, `withSentryConfig`, Replay or feedback, no SDK import outside the instrumentation files or in a `"use client"` module, no DSN literal anywhere in the repository.
  - `scripts/security/scan-client-bundles.mjs` (e2e job, after `pnpm build` with a synthetic `SENTRY_DSN`): the client bundles of both apps contain no DSN value, no DSN-shaped string and no trace of the Sentry browser SDK.
  - The ESLint import boundary above.
- **After each UAT cycle (CDF-51):** review new Sentry events for personal data or case content (UAT plan, exit criterion X5). Any hit is a HIGH security defect.

## 8. Open items needing a human decision

Recorded once; not re-asked.

1. **Sentry projects and DSNs.** Decided 2026-10-10: two projects, `cdf-investigations` and `cdf-whistleblowing`, created by Fady with the org-level scrubbing settings of §6. Each DSN goes into its own Vercel project as a server-scoped `SENTRY_DSN`, set by Fady (CDF-81). The §6 Advanced Data Scrubbing rules are set per project at the same time. No source-map upload token (§2).
2. **Data residency:** the org is in the EU region (`de.sentry.io`), not Saudi Arabia. Acceptable only because all data is synthetic; production uses the approved SOC platform.
3. Whether the investigation app gets the browser SDK at all (without replay) or stays server-only like the portal. CDF-81 keeps it server-only; adding a browser SDK later needs a CSP `connect-src` change, the same scrubber and an update to the boundary check.

## 9. Production substitution

| Prototype                               | Production                                        | Migration                                                                                   |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Sentry SaaS (EU), scrubbed `beforeSend` | Approved SOC/observability platform, KSA-resident | Keep the scrubber as the export filter (it has no Sentry dependency); re-point the exporter |
| Correlation ID in error messages        | Same, propagated to SLS/SIEM                      | Unchanged                                                                                   |
