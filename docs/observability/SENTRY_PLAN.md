# Sentry plan (CDF-64)

Classification: SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Sentry is a prototype observability processor: `PRODUCTION_SUBSTITUTION_REQUIRED` (replaced by the approved SOC/observability platform, see [`architecture/PRODUCTION_MAPPING.md`](../../architecture/PRODUCTION_MAPPING.md)). Nothing in this document makes the platform production ready.

| Field         | Value                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Linear        | CDF-64 (parent EPIC 18, CDF-23)                                                                                               |
| Status        | Plan + scrubber: IN_REVIEW. SDK, Sentry projects, DSNs, environment variables: NOT_STARTED (needs a human decision, see §8)   |
| Approval      | Fady, 2026-10-07 12:03 decision 8: Sentry for the synthetic reference implementation, after the first Vercel deployment (met) |
| Scrubber      | [`packages/infrastructure/src/observability/scrub.ts`](../../packages/infrastructure/src/observability/scrub.ts)              |
| Scrubber test | `packages/infrastructure/src/observability/scrub.test.ts` (`pnpm test`)                                                       |

## 1. What Sentry is for

Runtime exceptions, regressions and coarse performance of the two prototype apps (CLAUDE.md §11). It is **not** an audit trail, a security event store or a log of user activity: those stay in the append-only audit ledger (ADR-005) and the `SecurityEventSink` port. A Sentry event carries technical metadata only: error type, scrubbed message, stack frames, route, release, environment and the correlation ID that users already see in generic error messages (§82).

## 2. Projects and environments

The two apps never share security context (ADR-002), so they never share a Sentry project or DSN either.

| Sentry project (org `cdf-xm`, region `de.sentry.io`) | App                       | Vercel project       | Runtimes instrumented                     |
| ---------------------------------------------------- | ------------------------- | -------------------- | ----------------------------------------- |
| `cdf-whistleblowing`                                 | `apps/whistleblowing-web` | `cdf-whistleblowing` | server and edge only (no browser SDK, §3) |
| `cdf-investigations`                                 | `apps/investigation-web`  | `cdf-investigations` | server, edge and browser                  |

- **Environments:** `dev` (Vercel production deployments of `main`, backed by Supabase DEV), `preview` (Vercel preview deployments), `demo` (only once a DEMO environment exists; not before DEV is validated). Local development sends nothing: the SDK is disabled when no DSN is configured.
- **Release:** the git commit SHA (`VERCEL_GIT_COMMIT_SHA`), identical for both apps at the same commit.
- **Source maps:** uploaded at build time with a CI/Vercel-only auth token, then deleted from the build output so they are never served publicly (`sourcemaps.deleteSourcemapsAfterUpload`). The upload token is a server-side build secret, never `NEXT_PUBLIC_*`.

## 3. The public portal is server-only

The whistleblowing portal handles anonymous reporters. Loading a third-party script in their browser would disclose to Sentry that a person visited the portal, from which IP, when. The portal therefore gets **no browser SDK, no Session Replay and no user feedback widget**. Server errors in Server Actions and route handlers are still captured, after scrubbing. The investigation app may use the browser SDK with the same scrubber, without Session Replay.

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

Free-form areas are allow-listed, because English names and narrative cannot be recognised by pattern: `contexts` keeps only the SDK's standard contexts (`os`, `runtime`, `browser`, `device`, `app`, `trace`, `culture`, `cloud_resource`, `response.status_code`) and their technical fields; `extra` keeps only the correlation ID, error kind and route template; `tags` keeps those plus the SDK's technical tags; breadcrumb `data` keeps only method, status code and URL paths. Unknown top-level keys, including `sdkProcessingMetadata`, are dropped. Report secrets and references are matched in every shape the portal's normalisers accept (any case, look-alike letters, any separator); PostgreSQL `Failing row contains (…)` and `Key (…)=(…)` echoes are redacted, and `detail`, `where` and `hint` keys are denied. Object keys that themselves contain personal data are dropped.

Values are replaced by `[REDACTED:<kind>]`, never hashed, so nothing derived from a secret leaves the process. The scrubber is pure, does not mutate its input and is idempotent.

Event structure is preserved: event ID, timestamps, level, release, environment, SDK metadata, exception types, frame file names, functions and line numbers, runtime contexts and non-sensitive tags stay as they are, so grouping and regressions still work.

## 5. SDK configuration (later story, not in this PR)

When the SDK is wired, both apps use the same options, differing only in DSN and the portal's lack of a browser config:

```ts
// Sketch only. No SDK is installed by CDF-64.
import { scrubBreadcrumb, scrubSentryEvent } from "@cdf/infrastructure";

const options = {
  dsn: env.SENTRY_DSN, // server-only env var; absent locally => SDK disabled
  environment: env.SENTRY_ENVIRONMENT, // dev | preview | demo
  release: env.VERCEL_GIT_COMMIT_SHA,
  sendDefaultPii: false,
  attachStacktrace: true,
  includeLocalVariables: false,
  maxBreadcrumbs: 30,
  tracesSampleRate: 0.1, // dev/preview; 0 on demo until a need is shown
  beforeSend: (event) => scrubSentryEvent(event),
  beforeSendTransaction: (event) => scrubSentryEvent(event),
  beforeBreadcrumb: (crumb) => (crumb.category === "console" ? null : scrubBreadcrumb(crumb)),
};
```

- No Session Replay, profiling, user feedback or `setUser` anywhere. `setTag` only with values from a fixed list (route template, locale, error kind, correlation ID).
- Console breadcrumbs are dropped entirely; HTTP breadcrumbs keep method, path and status.
- Server Actions keep their current contract: users see a generic message with the correlation ID (§82), and the correlation ID is the only link between a user's report of a problem and a Sentry event.
- The investigation app's pages stay uncached; adding the SDK must not add caching or change response headers beyond its own.
- Sampling: errors 100 % (volume is tiny), transactions 10 % on `dev`/`preview`. Sentry's spike protection stays on.
- Retention: the shortest period the Sentry plan allows; confirm the value when the projects are created.
- Import path: the browser config must not pull in the server adapters re-exported by `@cdf/infrastructure`; the SDK story adds a `@cdf/infrastructure/observability` subpath export (a `package.json` change, out of scope here).

## 6. Sentry project settings (when created)

Defence in depth behind the scrubber, set per project:

- Data Scrubber **on**, Use Default Scrubbers **on**, Scrub IP Addresses **on**, "Prevent Storing of IP Addresses" **on**.
- Additional sensitive fields: `description`, `subjectDescription`, `summary`, `body`, `narrative`, `identity`, `fullName`, `email`, `phone`, `secret`, `reportRef`, `fileName`, `objectKey`, `justification`.
- Advanced Data Scrubbing rules: `[Mask] [Credit card numbers] from [$string]`, `[Remove] [Email addresses] from [$string]`, `[Remove] [IP addresses] from [$string]`, plus a regex rule for `WB-[0-9A-HJKMNP-TV-Z]{12}`.
- Source maps: never publicly accessible; "Allow JavaScript source fetching" **off**.
- Members: Fady and named engineers only; no public dashboards; alerts go to email, not to a public Slack channel (Slack holds no decisions or data, CLAUDE.md §11).

## 7. How this is tested

- **Now (CDF-64):** `scrub.test.ts` (including one negative case per CDF-62 review finding) (unit project, runs in CI `pnpm test`) asserts removal of Arabic and English narrative, report references and secrets (including generated ones), emails, phones, Saudi national ID / Iqama patterns, cookies, auth headers, request bodies, IPs and query strings; preserved event structure; no input mutation; idempotency; cycles and deep nesting.
- **SDK story:** an integration test that captures a thrown error carrying a synthetic narrative through the real SDK with a transport stub and asserts the outgoing envelope contains none of the synthetic values; a lint rule that forbids `Sentry.setUser` and `Sentry.init` outside the two instrumentation files.
- **After each UAT cycle (CDF-51):** review new Sentry events for personal data or case content (UAT plan, exit criterion X5). Any hit is a HIGH security defect.

## 8. Open items needing a human decision

Recorded once; not re-asked.

1. **Create the two Sentry projects and DSNs** (new third-party processor of runtime data, CLAUDE.md §11). Fady approved Sentry for the synthetic prototype on 2026-10-07; project creation, DSN storage as Vercel server-side env vars and the source-map upload token are a follow-up story and need his go-ahead to proceed.
2. **Data residency:** the org is in the EU region (`de.sentry.io`), not Saudi Arabia. Acceptable only because all data is synthetic; production uses the approved SOC platform.
3. Whether the investigation app gets the browser SDK at all (recommended: yes, without replay) or stays server-only like the portal.

## 9. Production substitution

| Prototype                               | Production                                        | Migration                                                                                   |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Sentry SaaS (EU), scrubbed `beforeSend` | Approved SOC/observability platform, KSA-resident | Keep the scrubber as the export filter (it has no Sentry dependency); re-point the exporter |
| Correlation ID in error messages        | Same, propagated to SLS/SIEM                      | Unchanged                                                                                   |
