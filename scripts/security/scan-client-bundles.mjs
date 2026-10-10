#!/usr/bin/env node
// CDF-62 · §46–§48, rule B-6: server-only secrets never reach a browser bundle.
// Scans everything Next.js serves to browsers (`.next/static` of both apps) for
//   0. (CDF-81) a Sentry DSN or any trace of the Sentry browser SDK, which neither app ships,
//   1. the VALUES of server-only environment variables present in this process (CI generates throwaway ones),
//   2. secret-shaped material: connection strings, private keys, Supabase service-role / secret keys,
//   3. the names of variables that must never be referenced from client code.
// Run after `pnpm build`:  node scripts/security/scan-client-bundles.mjs
// Exit code 1 lists every hit (file and rule, never the secret value itself).
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const APPS = ["apps/investigation-web", "apps/whistleblowing-web"];

/** Server-only variables. Any value set in the environment must not appear in client output. */
export const SERVER_ONLY_VARS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_DB_PASSWORD",
  "CDF_ADMIN_DATABASE_URL",
  "CDF_BFF_DATABASE_URL",
  "CDF_PORTAL_DATABASE_URL",
  "CDF_BFF_DB_PASSWORD",
  "CDF_PORTAL_DB_PASSWORD",
  "CDF_REPORT_SECRET_PEPPER",
  "CDF_RATE_LIMIT_SALT",
  "CDF_DEV_IDENTITY_SECRET",
  "CDF_DEV_PASSWORD",
  // CDF-81: Sentry is server-side only; its DSN and any upload token never reach a browser.
  "SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
];

const PATTERNS = [
  ["postgres connection string", /postgres(?:ql)?:\/\/[^\s"'`]+/i],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{10,}/],
  // A JWT whose payload declares the service_role (base64 of `"role":"service_role"` in any alignment).
  [
    "service-role JWT",
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*(?:InNlcnZpY2Vfcm9sZS|JzZXJ2aWNlX3JvbGUi|ic2VydmljZV9yb2xlI)[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/,
  ],
  ["service-role variable name", /SERVICE_ROLE_KEY/],
  // CDF-81: no Sentry DSN and no Sentry browser SDK in either app (SENTRY_PLAN.md §3).
  ["Sentry DSN", /https?:\/\/[A-Za-z0-9]+@[A-Za-z0-9.-]*ingest[A-Za-z0-9.-]*\/\d+/],
  ["Sentry browser SDK", /sentry\.javascript\.|__SENTRY__|sentry-trace|browserTracingIntegration/],
  [
    "server secret variable name",
    new RegExp(`\\b(?:${SERVER_ONLY_VARS.filter((v) => v !== "SUPABASE_SERVICE_ROLE_KEY").join("|")})\\b`),
  ],
];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

export function scan({ env = process.env, base = root, apps = APPS } = {}) {
  const values = SERVER_ONLY_VARS.map((name) => [name, env[name]])
    .filter(([, v]) => typeof v === "string" && v.length >= 12)
    .flatMap(([name, v]) => {
      // A connection string's password is checked on its own too.
      const out = [[name, v]];
      try {
        const u = new URL(v);
        if (u.password && u.password.length >= 12)
          out.push([`${name} password`, decodeURIComponent(u.password)]);
      } catch {
        /* not a URL */
      }
      return out;
    });

  const hits = [];
  let scanned = 0;
  for (const app of apps) {
    const dir = join(base, app, ".next", "static");
    if (!existsSync(dir)) throw new Error(`${relative(base, dir)} is missing: run pnpm build first`);
    for (const file of files(dir)) {
      if (!/\.(js|mjs|css|json|html|txt|map)$/.test(file)) continue;
      scanned++;
      const text = readFileSync(file, "utf8");
      const where = relative(base, file);
      for (const [name, value] of values) if (text.includes(value)) hits.push(`${where}: value of ${name}`);
      for (const [rule, re] of PATTERNS) if (re.test(text)) hits.push(`${where}: ${rule}`);
    }
  }
  return { scanned, checkedValues: values.length, hits };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { scanned, checkedValues, hits } = scan();
  console.log(
    `scanned ${scanned} client files for ${checkedValues} secret values and ${PATTERNS.length} patterns`,
  );
  if (hits.length) {
    for (const h of hits) console.error(`✗ ${h}`);
    process.exit(1);
  }
  console.log("✓ no server-only secret in client bundles");
}
