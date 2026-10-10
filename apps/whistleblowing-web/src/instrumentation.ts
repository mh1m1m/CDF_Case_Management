// Server-side Sentry (CDF-81). The only file in this app that may import the Sentry SDK (lint-enforced).
// No browser SDK, Session Replay or user feedback: there is no instrumentation-client file, no
// withSentryConfig wrapping and no NEXT_PUBLIC_ Sentry variable (scripts/security/check-sentry-boundary.mjs).
// SENTRY_DSN is a server-scoped Vercel variable; without it nothing is initialised or sent.
// PRODUCTION_SUBSTITUTION_REQUIRED: see docs/observability/SENTRY_PLAN.md §9.
import * as Sentry from "@sentry/nextjs";
import { buildSentryServerOptions } from "@cdf/infrastructure/observability";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" && process.env.NEXT_RUNTIME !== "edge") return;
  const options = buildSentryServerOptions("whistleblowing-web");
  if (options) Sentry.init(options);
}

// Uncaught errors from Server Components, Server Actions, route handlers and the proxy. Their
// events pass through the same scrubber in beforeSend.
export const onRequestError = Sentry.captureRequestError;
