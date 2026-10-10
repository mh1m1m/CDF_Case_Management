import { defineConfig, devices } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

// Local runs read the synthetic dev password from the investigation app's git-ignored .env.local.
for (const file of ["apps/investigation-web/.env.local"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^(CDF_DEV_PASSWORD)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
  }
}

const executablePath = process.env.CDF_E2E_CHROMIUM || undefined;

export default defineConfig({
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // "github" writes failures as check-run annotations, which are readable without downloading logs.
  reporter: process.env.CI ? [["list"], ["github"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: "e2e", testDir: "tests/e2e" },
    { name: "accessibility", testDir: "tests/accessibility" },
  ],
  webServer: [
    {
      command: "pnpm --filter @cdf/investigation-web start",
      url: "http://127.0.0.1:3000/login",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @cdf/whistleblowing-web start",
      url: "http://127.0.0.1:3001/",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
