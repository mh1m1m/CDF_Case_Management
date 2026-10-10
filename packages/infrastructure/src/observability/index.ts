// Observability entry point (CDF-81), importable from the apps' instrumentation files without
// loading database drivers or identity adapters.
export { REDACTED, isDeniedKey, scrubBreadcrumb, scrubData, scrubSentryEvent, scrubString } from "./scrub";
export {
  breadcrumbOrDrop,
  buildSentryServerOptions,
  cdfEventFilter,
  isValidSentryDsn,
  scrubOrDrop,
  selectIntegrations,
  sentryEnvironment,
} from "./sentry-options";
export type { CdfEventFilterIntegration, CdfSentryOptions, SentryApp } from "./sentry-options";
