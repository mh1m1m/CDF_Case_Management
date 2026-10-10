// CDF-81: self-test for the CI guard that keeps Sentry server-side only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without type declarations
import { check } from "../../scripts/security/check-sentry-boundary.mjs";

const runCheck = check as (o: { base: string; apps?: string[] }) => string[];
const APP = "apps/whistleblowing-web";
// Assembled from parts so secret scanners do not mistake the synthetic DSN for a credential.
const DSN = ["https://", "0123456789abcdef", "@", "o0.ingest.de.", "sentry.io", "/1"].join("");

let base: string;
function tree(files: Record<string, string>): string {
  base = mkdtempSync(join(tmpdir(), "cdf-sentry-boundary-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), text);
  }
  return base;
}
afterEach(() => rmSync(base, { recursive: true, force: true }));

const CLEAN = {
  [`${APP}/src/instrumentation.ts`]: 'import * as Sentry from "@sentry/nextjs";\n// no withSentryConfig\n',
  [`${APP}/src/app/page.tsx`]: '"use client";\nexport default function Page() { return null; }\n',
  [`${APP}/next.config.ts`]: "export default {};\n",
  ".env.example": "SENTRY_DSN=\n",
};

describe("check-sentry-boundary", () => {
  it("passes a server-only tree", () => {
    expect(runCheck({ base: tree(CLEAN), apps: [APP] })).toEqual([]);
  });

  it.each([
    ["a public Sentry variable", { ".env.example": "NEXT_PUBLIC_SENTRY_DSN=\n" }, "public Sentry variable"],
    [
      "a client Sentry config",
      { [`${APP}/src/instrumentation-client.ts`]: "export {};\n" },
      "browser Sentry entry point",
    ],
    [
      "sentry.client.config",
      { [`${APP}/sentry.client.config.ts`]: "export {};\n" },
      "browser Sentry entry point",
    ],
    [
      "withSentryConfig",
      {
        [`${APP}/next.config.ts`]:
          'import { withSentryConfig } from "x";\nexport default withSentryConfig({});\n',
      },
      "withSentryConfig",
    ],
    [
      "Session Replay",
      { [`${APP}/src/instrumentation.ts`]: 'import * as S from "@sentry/nextjs";\nS.replayIntegration();\n' },
      "browser-only Sentry API",
    ],
    [
      "a client module importing the SDK",
      { [`${APP}/src/app/page.tsx`]: '"use client";\nimport * as Sentry from "@sentry/nextjs";\n' },
      "client module",
    ],
    [
      "a server module importing the SDK",
      { [`${APP}/src/server/report.ts`]: 'import { captureMessage } from "@sentry/nextjs";\n' },
      "outside src/instrumentation.ts",
    ],
    ["a DSN literal in docs", { "docs/x.md": `dsn: ${DSN}\n` }, "Sentry DSN literal"],
  ])("fails on %s", (_name, files, expected) => {
    const violations = runCheck({ base: tree({ ...CLEAN, ...files }), apps: [APP] });
    expect(violations.some((v) => v.includes(expected))).toBe(true);
    // Violations name the file and rule, never the value.
    for (const v of violations) expect(v).not.toContain("0123456789abcdef");
  });
});
