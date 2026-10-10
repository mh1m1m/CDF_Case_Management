#!/usr/bin/env node
// Turns a Vitest JSON report into GitHub annotations: one notice with the totals and one with the failed
// tests. hosted-dev.yml runs the database suites against Supabase DEV, and its job logs cannot be read
// from every client, while check-run annotations can (CDF-32). Test names only; no data values.
// Usage: node scripts/db/vitest-annotations.mjs <report.json> <title>
import { existsSync, readFileSync } from "node:fs";

const [file, title = "Vitest"] = process.argv.slice(2);
if (!file || !existsSync(file)) {
  console.log(`::warning title=${property(title)}::no Vitest JSON report at ${data(String(file))}`);
  process.exit(0);
}

const report = JSON.parse(readFileSync(file, "utf8"));
const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
console.log(
  `::notice title=${property(title)}::${report.numPassedTests} passed, ${report.numFailedTests} failed, ` +
    `${skipped} skipped of ${report.numTotalTests} tests in ${(report.testResults ?? []).length} files`,
);

const failed = [];
for (const suite of report.testResults ?? []) {
  const path = suite.name.includes("/tests/") ? `tests/${suite.name.split("/tests/").pop()}` : suite.name;
  const tests = (suite.assertionResults ?? []).filter((t) => t.status === "failed");
  // A file that fails before any test runs (an import or hook error) has no failed assertions.
  if (suite.status === "failed" && tests.length === 0)
    failed.push(`${path} (file failed: ${firstLine(suite.message)})`);
  for (const t of tests) failed.push(`${path} › ${t.fullName}: ${firstLine(t.failureMessages?.[0])}`);
}
if (failed.length > 0) {
  console.log(
    `::notice title=${property(`${title}: failed tests`)}::${data(failed.join("\n").slice(0, 4000))}`,
  );
}

function firstLine(text) {
  return String(text ?? "")
    .split("\n")[0]
    .slice(0, 160);
}

// Workflow-command escaping: a message escapes %, CR and LF; a property also escapes : and ,.
function data(text) {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function property(text) {
  return data(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}
