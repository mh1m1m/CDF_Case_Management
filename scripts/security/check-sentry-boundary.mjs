#!/usr/bin/env node
// CDF-81 · SENTRY_PLAN.md §3, §5: Sentry runs server-side only, from one file per app.
// Fails (exit 1) when the source tree breaks any of these rules:
//   1. no NEXT_PUBLIC_ Sentry or DSN variable in app, package, workflow or env files;
//   2. no browser SDK entry point in either app: instrumentation-client.*, sentry.client.config.*,
//      withSentryConfig (which injects client code), Session Replay or user feedback;
//   3. the Sentry SDK is imported only by apps/<app>/src/instrumentation.ts (and its test), never
//      by a "use client" module;
//   4. no Sentry DSN literal anywhere in the repository (DSNs live in server-scoped Vercel env).
// Run: node scripts/security/check-sentry-boundary.mjs   (prints each violation, never a value)
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const APPS = ["apps/investigation-web", "apps/whistleblowing-web"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "coverage", "playwright-report", "test-results"]);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const PUBLIC_SENTRY_VAR = /NEXT_PUBLIC_[A-Z0-9_]*(?:SENTRY|DSN)/;
// https://<public key>@<org>.ingest[.<region>].sentry.io/<project>
const DSN_LITERAL = /https?:\/\/[A-Za-z0-9]+@[A-Za-z0-9.-]*ingest[A-Za-z0-9.-]*\.sentry\.io\/\d+/;
const SENTRY_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']@sentry\//;
const CLIENT_ONLY_API =
  /\b(?:replayIntegration|replayCanvasIntegration|feedbackIntegration|browserTracingIntegration|withSentryConfig)\b/;
const USE_CLIENT = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/;

// Comments may name what is prohibited; only code counts for the API and import checks.
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const isInstrumentationFile = (rel) =>
  /^apps\/[^/]+\/src\/instrumentation(?:\.test)?\.ts$/.test(rel.split(sep).join("/"));

export function check({ base = root, apps = APPS } = {}) {
  const violations = [];
  const rel = (f) => relative(base, f).split(sep).join("/");

  // 1. Public Sentry variables in code, config, workflows and env templates (tests may name them
  //    to prove they are rejected).
  const configFiles = [
    ...walk(join(base, "apps")),
    ...walk(join(base, "packages")),
    ...walk(join(base, ".github")),
    ...readdirSync(base)
      .filter((n) => n.startsWith(".env") || n === "vercel.json" || n === "turbo.json")
      .map((n) => join(base, n)),
  ].filter(
    (f) => !TEST.test(f) && (SOURCE.test(f) || /\.(?:ya?ml|json)$/.test(f) || basename(f).startsWith(".env")),
  );
  for (const file of configFiles) {
    if (PUBLIC_SENTRY_VAR.test(readFileSync(file, "utf8")))
      violations.push(`${rel(file)}: public Sentry variable`);
  }

  // 2 and 3. Browser SDK entry points and SDK imports in the apps.
  for (const app of apps) {
    for (const file of walk(join(base, app))) {
      const r = rel(file);
      const name = basename(file);
      if (/^instrumentation-client\.|^sentry\.client\.config\./.test(name)) {
        violations.push(`${r}: browser Sentry entry point`);
        continue;
      }
      if (!SOURCE.test(file)) continue;
      const raw = readFileSync(file, "utf8");
      const text = stripComments(raw);
      if (CLIENT_ONLY_API.test(text)) violations.push(`${r}: browser-only Sentry API or withSentryConfig`);
      if (!SENTRY_IMPORT.test(text)) continue;
      if (USE_CLIENT.test(raw)) violations.push(`${r}: Sentry SDK imported by a client module`);
      else if (!isInstrumentationFile(r))
        violations.push(`${r}: Sentry SDK imported outside src/instrumentation.ts`);
    }
  }

  // 4. DSN literals anywhere in the tree (docs included).
  for (const file of walk(base)) {
    if (!/\.(?:[cm]?[jt]sx?|json|ya?ml|md|env|example|txt|toml)$|^\.env/.test(basename(file))) continue;
    if (DSN_LITERAL.test(readFileSync(file, "utf8"))) violations.push(`${rel(file)}: Sentry DSN literal`);
  }

  return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const violations = check();
  if (violations.length) {
    for (const v of violations) console.error(`✗ ${v}`);
    console.error("Sentry must stay server-side only (docs/observability/SENTRY_PLAN.md §3, §5).");
    process.exit(1);
  }
  console.log("✓ Sentry boundary: server-side only, no public Sentry variables, no DSN in the repository");
}
