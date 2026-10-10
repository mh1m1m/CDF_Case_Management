import { defineConfig } from "vitest/config";

// CI runs the database suites against a PostgreSQL next to the runner. hosted-dev.yml runs the same suites
// against Supabase DEV in another region (CDF-32), where one multi-statement scenario can take minutes, so
// that workflow raises the limits with CDF_DB_TEST_TIMEOUT_MS. Everywhere else the limit stays 30 s.
const dbTimeout = Number(process.env.CDF_DB_TEST_TIMEOUT_MS) || 30_000;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.spec.ts"],
          environment: "node",
          fileParallelism: false,
          testTimeout: dbTimeout,
          hookTimeout: 2 * dbTimeout,
        },
      },
      {
        test: {
          name: "security",
          include: ["tests/security/**/*.spec.ts"],
          environment: "node",
          fileParallelism: false,
          testTimeout: dbTimeout,
          hookTimeout: 2 * dbTimeout,
        },
      },
    ],
  },
});
