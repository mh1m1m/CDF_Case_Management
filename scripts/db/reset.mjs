#!/usr/bin/env node
// Rebuilds the LOCAL database from Git: shim (plain PostgreSQL only) → migrations → seed → login-role passwords.
// Protocol §12–§14: Git is authoritative; the live database is not.
//
// Modes
//   supabase  `supabase db reset` (Supabase CLI running locally). Selected with CDF_DB_MODE=supabase.
//   plain     PostgreSQL 16+ via psql, with the compatibility shim (ADR-008). Default.
//
// Refuses to touch anything that is not a loopback host in a local/test environment.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const supabaseDir = join(root, "infrastructure", "supabase");

loadEnvFile(join(root, ".env.local"));

const env = process.env.CDF_ENVIRONMENT ?? "local";
if (!["local", "test"].includes(env))
  fail(`db:reset only runs when CDF_ENVIRONMENT is local or test (got "${env}").`);
if (process.env.VERCEL) fail("db:reset never runs on Vercel.");

const adminUrl = new URL(
  process.env.CDF_ADMIN_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:54322/postgres",
);
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(adminUrl.hostname)) {
  fail(`db:reset only targets a loopback database host (got "${adminUrl.hostname}").`);
}

const mode = process.env.CDF_DB_MODE ?? "plain";
const dbName = decodeURIComponent(adminUrl.pathname.slice(1) || "postgres");

if (mode === "supabase") {
  run("supabase", ["db", "reset", "--workdir", join(root, "infrastructure")]);
} else if (mode === "plain") {
  const maintenance = new URL(adminUrl);
  maintenance.pathname = "/template1";
  psql(maintenance, { sql: `drop database if exists "${dbName}" with (force);` });
  psql(maintenance, { sql: `create database "${dbName}";` });
  psql(adminUrl, { file: join(supabaseDir, "tests", "bootstrap", "00_supabase_compat.sql") });
  for (const file of sqlFiles(join(supabaseDir, "migrations"))) psql(adminUrl, { file, single: true });
  for (const file of sqlFiles(join(supabaseDir, "seed"))) psql(adminUrl, { file, single: true });
} else {
  fail(`Unknown CDF_DB_MODE "${mode}" (expected plain or supabase).`);
}

// Login-role passwords come from the environment only (never from Git, §48).
for (const [role, variable] of [
  ["cdf_bff", "CDF_BFF_DB_PASSWORD"],
  ["cdf_portal", "CDF_PORTAL_DB_PASSWORD"],
]) {
  const password = process.env[variable];
  if (!password) {
    console.warn(
      `! ${variable} is not set; ${role} keeps its current password (local trust auth may still allow it).`,
    );
    continue;
  }
  if (password.length < 16) fail(`${variable} must be at least 16 characters.`);
  psql(adminUrl, { sql: `alter role ${role} password :'pw';`, vars: { pw: password } });
}

console.log(`✓ database "${dbName}" rebuilt (${mode} mode)`);

// ---------------------------------------------------------------------------
function sqlFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(dir, f));
}

function psql(url, { sql, file, single = false, vars = {} }) {
  const args = ["--no-psqlrc", "--quiet", "-v", "ON_ERROR_STOP=1", "-d", url.toString()];
  if (single) args.push("--single-transaction");
  for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
  if (file) {
    args.push("-f", file);
    console.log(`→ ${file.slice(root.length + 1)}`);
  }
  // Pass SQL on stdin so psql variable interpolation (:'pw') applies and values stay out of argv.
  run("psql", args, sql);
}

function run(cmd, args, input) {
  try {
    execFileSync(cmd, args, {
      stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
      input,
    });
  } catch {
    fail(`${cmd} failed`);
  }
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
