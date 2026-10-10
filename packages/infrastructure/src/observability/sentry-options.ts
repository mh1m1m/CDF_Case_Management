/**
 * Server-side Sentry options for both apps (CDF-81). Pure: no Sentry dependency, so the apps'
 * `instrumentation.ts` files are the only places that import the SDK, and these options are
 * unit-testable without it.
 *
 * - Disabled unless a server-scoped `SENTRY_DSN` is set; local development sends nothing.
 * - Every error and transaction passes the CDF-64 scrubber; anything that fails to scrub, or any
 *   event type outside the allow-list (replays, feedback, profiles, …), is dropped (fail closed).
 * - No PII defaults, no local variables, no console breadcrumbs, no user object.
 *
 * PRODUCTION_SUBSTITUTION_REQUIRED: Sentry SaaS (EU region) is a prototype observability
 * processor. Production uses the approved SOC/observability platform
 * (architecture/PRODUCTION_MAPPING.md); the scrubber stays as the export filter.
 */
import { assertNoSecretsInPublicEnv } from "@cdf/config";
import { scrubBreadcrumb, scrubSentryEvent } from "./scrub";

export type SentryApp = "whistleblowing-web" | "investigation-web";

type Env = Record<string, string | undefined>;
type SentryEventLike = { type?: string };
type BreadcrumbLike = { category?: string };
type IntegrationLike = { name: string };

export interface CdfSentryOptions {
  dsn: string;
  environment: string;
  release: string | undefined;
  sendDefaultPii: false;
  attachStacktrace: true;
  includeLocalVariables: false;
  maxBreadcrumbs: number;
  tracesSampleRate: number;
  tracePropagationTargets: never[];
  sendClientReports: false;
  initialScope: { tags: { app: SentryApp } };
  beforeSend: <E extends SentryEventLike>(event: E) => E | null;
  beforeSendTransaction: <E extends SentryEventLike>(event: E) => E | null;
  beforeBreadcrumb: <B extends BreadcrumbLike>(breadcrumb: B) => B | null;
  integrations: <I extends IntegrationLike>(defaults: I[]) => (I | CdfEventFilterIntegration)[];
}

/**
 * Default integrations that are removed: console capture (console breadcrumbs, and console calls
 * that can echo user input), local-variable capture (runtime values in stack frames), release-health sessions and source
 * context lines (source code around each frame; file, function and line number are enough, and
 * no source code goes to the processor).
 */
const REMOVED_INTEGRATIONS: ReadonlySet<string> = new Set([
  "Console",
  "LocalVariables",
  "LocalVariablesAsync",
  "ContextLines",
  // Release-health sessions are separate envelopes that never pass beforeSend.
  "ProcessSession",
]);

export interface CdfEventFilterIntegration {
  name: "CdfEventFilter";
  processEvent: <E extends SentryEventLike>(event: E) => E | null;
}

/**
 * Event types that may leave the process. `undefined` is an error event; `transaction` a trace.
 * Everything else the SDK can produce (replay_event, feedback, profile, check_in, …) is dropped.
 */
const ALLOWED_EVENT_TYPES: ReadonlySet<string | undefined> = new Set([undefined, "transaction"]);

/** Scrubs one event, or drops it when its type is not allowed or the scrubber fails. */
export function scrubOrDrop<E extends SentryEventLike>(event: E): E | null {
  if (event === null || typeof event !== "object" || !ALLOWED_EVENT_TYPES.has(event.type)) return null;
  try {
    return scrubSentryEvent(event);
  } catch {
    // Fail closed: an event that cannot be scrubbed is not sent.
    return null;
  }
}

/**
 * Event processor that runs for every event the client handles, including types that never reach
 * `beforeSend` (user feedback): anything outside the event-type allow-list is dropped.
 */
export const cdfEventFilter: CdfEventFilterIntegration = {
  name: "CdfEventFilter",
  processEvent: (event) => (ALLOWED_EVENT_TYPES.has(event.type) ? event : null),
};

export function selectIntegrations<I extends IntegrationLike>(
  defaults: I[],
): (I | CdfEventFilterIntegration)[] {
  return [...defaults.filter((i) => !REMOVED_INTEGRATIONS.has(i.name)), cdfEventFilter];
}

/** Console breadcrumbs are dropped entirely; the rest are scrubbed (fail closed). */
export function breadcrumbOrDrop<B extends BreadcrumbLike>(breadcrumb: B): B | null {
  if (breadcrumb === null || typeof breadcrumb !== "object" || breadcrumb.category === "console") return null;
  try {
    return scrubBreadcrumb(breadcrumb);
  } catch {
    return null;
  }
}

/** A Sentry DSN: https, an alphanumeric public key as the user name, no password, a numeric project path. */
export function isValidSentryDsn(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      // Same shape the SDK's own parser accepts; anything else makes the SDK log the raw DSN.
      /^\w+$/.test(url.username) &&
      url.password === "" &&
      /^\/\d+$/.test(url.pathname) &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/** `preview` on Vercel preview deployments, otherwise the CDF environment (dev, demo, …). */
export function sentryEnvironment(env: Env): string {
  if (env.VERCEL_ENV === "preview") return "preview";
  return env.CDF_ENVIRONMENT ?? "local";
}

/**
 * Options for `Sentry.init` on the server and edge runtimes, or `null` when Sentry stays off.
 * Refuses to start if any browser-exposed variable names a Sentry DSN or token.
 */
export function buildSentryServerOptions(app: SentryApp, env: Env = process.env): CdfSentryOptions | null {
  assertNoSecretsInPublicEnv(env);
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  if (!isValidSentryDsn(dsn)) {
    // Names only; never echo the value.
    console.warn("Sentry disabled: SENTRY_DSN is not a valid DSN");
    return null;
  }
  const environment = sentryEnvironment(env);
  return {
    dsn,
    environment,
    release: env.VERCEL_GIT_COMMIT_SHA || undefined,
    sendDefaultPii: false,
    attachStacktrace: true,
    includeLocalVariables: false,
    maxBreadcrumbs: 30,
    // Errors are always sent; traces are sampled on dev and preview only (SENTRY_PLAN.md §5).
    tracesSampleRate: environment === "dev" || environment === "preview" ? 0.1 : 0,
    // No sentry-trace / baggage headers on outgoing requests (Supabase, storage): baggage carries
    // the DSN public key, release and route to another processor.
    tracePropagationTargets: [],
    sendClientReports: false,
    initialScope: { tags: { app } },
    beforeSend: scrubOrDrop,
    beforeSendTransaction: scrubOrDrop,
    beforeBreadcrumb: breadcrumbOrDrop,
    integrations: selectIntegrations,
  };
}
