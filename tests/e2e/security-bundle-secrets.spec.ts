// CDF-62 · §46–§48, rule B-6: no server-only secret reaches a browser. Runs in the e2e job, after `pnpm build`
// and with that run's throwaway secrets in the environment: the built client bundles and the HTML both apps
// serve are scanned for the secret values themselves and for secret-shaped material.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
// @ts-expect-error -- plain ESM script without type declarations
import { SERVER_ONLY_VARS, scan } from "../../scripts/security/scan-client-bundles.mjs";
import { APP, PORTAL, signIn } from "./support";

type ScanResult = { scanned: number; checkedValues: number; hits: string[] };
const runScan = scan as (o?: {
  env?: Record<string, string | undefined>;
  base?: string;
  apps?: string[];
}) => ScanResult;

test("built client bundles hold no server-only secret", () => {
  const result = runScan();
  expect(result.scanned).toBeGreaterThan(5);
  // CI and local runs set at least the database and portal secrets; the check must not be vacuous.
  expect(result.checkedValues).toBeGreaterThanOrEqual(4);
  expect(result.hits).toEqual([]);
});

test("the scanner detects a planted secret (self-test)", () => {
  const base = mkdtempSync(join(tmpdir(), "cdf-bundle-scan-"));
  try {
    const dir = join(base, "apps", "fake", ".next", "static", "chunks");
    mkdirSync(dir, { recursive: true });
    const secret = "planted-secret-value-0123456789";
    writeFileSync(join(dir, "a.js"), `const x = "${secret}"; const y = "postgresql://u:p@h/db";`);
    const { hits } = runScan({ env: { CDF_REPORT_SECRET_PEPPER: secret }, base, apps: ["apps/fake"] });
    expect(hits.some((h) => h.includes("value of CDF_REPORT_SECRET_PEPPER"))).toBe(true);
    expect(hits.some((h) => h.includes("postgres connection string"))).toBe(true);

    // CDF-81: a planted DSN (as a value and as a literal) and the Sentry browser SDK are caught.
    const dsn = ["https://", "plantedpublickey", "@", "o0.ingest.example.test", "/1"].join("");
    writeFileSync(join(dir, "b.js"), `init({dsn:"${dsn}"}); window.__SENTRY__ = {};`);
    const sentry = runScan({ env: { SENTRY_DSN: dsn }, base, apps: ["apps/fake"] }).hits;
    expect(sentry.some((h) => h.includes("value of SENTRY_DSN"))).toBe(true);
    expect(sentry.some((h) => h.includes("Sentry DSN"))).toBe(true);
    expect(sentry.some((h) => h.includes("Sentry browser SDK"))).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("served HTML and inline scripts hold no server-only secret", async ({ browser, request }) => {
  const secrets = (SERVER_ONLY_VARS as string[])
    .map((n) => process.env[n])
    .filter((v): v is string => !!v && v.length >= 12);
  expect(secrets.length).toBeGreaterThanOrEqual(4);
  const pages: string[] = [];
  for (const url of [`${PORTAL}/`, `${PORTAL}/report`, `${PORTAL}/follow-up`, `${APP}/login`])
    pages.push(await (await request.get(url)).text());
  const staff = await signIn(browser, "casemanager@example.test");
  for (const path of ["/", "/cases", "/intake"]) {
    await staff.goto(path);
    pages.push(await staff.content());
  }
  await staff.context().close();
  for (const html of pages) {
    for (const s of secrets) expect(html.includes(s)).toBe(false);
    expect(html).not.toMatch(/postgres(?:ql)?:\/\/|SERVICE_ROLE|-----BEGIN [A-Z ]*PRIVATE KEY/);
  }
});
