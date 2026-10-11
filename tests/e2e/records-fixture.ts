// Fixtures for the records screens e2e and accessibility specs (CDF-71), also used by the command-form and
// confirmation specs (UX-001, UX-019, UX-031). The seed has no case past closure, so each call files a fresh
// synthetic report and moves a new case through the real database commands, acting as the synthetic users in
// their own security context (no RLS bypass).
//
// The one owner-level step adds TEST_ETE_RETENTION, a CONFIGURED class with a one-microsecond period, so a case
// can reach disposition in a test. It is a TEST FIXTURE, not a CDF value: shipped classes stay SOURCE_REQUIRED
// and the class exists only in the throwaway CI or local database.
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { createPool, withAnonContext, withUserContext, type Sql, type Tx } from "@cdf/infrastructure";

const host = process.env.CDF_TEST_DB_HOST ?? "127.0.0.1";
const port = process.env.CDF_TEST_DB_PORT ?? "54322";
const url = (user: string, pwVar: string) => {
  const pw = process.env[pwVar];
  return `postgresql://${user}${pw ? `:${encodeURIComponent(pw)}` : ""}@${host}:${port}/postgres`;
};

const USERS = {
  triage: "a0000000-0000-4000-8000-000000000002",
  caseManager: "a0000000-0000-4000-8000-000000000003",
  records: "a0000000-0000-4000-8000-000000000019",
} as const;

export const TEST_CLASS = "TEST_ETE_RETENTION";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let pools: { bff: Sql; portal: Sql } | undefined;
function db() {
  pools ??= {
    bff: createPool(process.env.CDF_BFF_DATABASE_URL ?? url("cdf_bff", "CDF_BFF_DB_PASSWORD"), {
      applicationName: "cdf-e2e-records-fixture",
      max: 2,
    }),
    portal: createPool(process.env.CDF_PORTAL_DATABASE_URL ?? url("cdf_portal", "CDF_PORTAL_DB_PASSWORD"), {
      applicationName: "cdf-e2e-records-fixture",
      max: 1,
    }),
  };
  return pools;
}

export async function closeFixtureConnections(): Promise<void> {
  if (!pools) return;
  await Promise.all([pools.bff.end(), pools.portal.end()]);
  pools = undefined;
}

const as = <T>(user: keyof typeof USERS, fn: (tx: Tx) => Promise<T>) =>
  withUserContext(db().bff, { userId: USERS[user], requestId: randomUUID() }, fn);

/** A new anonymous synthetic report, RECEIVED and waiting for triage. */
export async function receivedReport(label: string): Promise<{ reportId: string; reportRef: string }> {
  const ref = "WB-" + Array.from(randomBytes(12), (b) => CROCKFORD[b % 32]).join("");
  const [report] = await withAnonContext(
    db().portal,
    randomUUID(),
    (tx) =>
      tx<{ report_ref: string }[]>`
      select * from public_api.submit_report(${ref}, ${randomBytes(32).toString("hex")}, 'ANONYMOUS', 'EMPLOYEE', null,
        'IRREGULAR_TRANSACTIONS', null, 'Employee Alpha (synthetic)',
        ${`Synthetic report for the e2e fixtures (${label}).`}, '2026-09-01', '09:30',
        'Procurement department (synthetic)', true, 'en', null)`,
  );
  const [row] = await as(
    "triage",
    (tx) => tx<{ id: string }[]>`select id from intake.report where report_ref = ${report!.report_ref}`,
  );
  return { reportId: row!.id, reportRef: report!.report_ref };
}

/** The report's internal status, read as the triage officer (no RLS bypass). */
export async function reportStatus(reportId: string): Promise<string | undefined> {
  const [row] = await as(
    "triage",
    (tx) => tx<{ status: string }[]>`select status from intake.report where id = ${reportId}`,
  );
  return row?.status;
}

/** A new case in SCREENING, filed and opened by the triage officer; the case manager can close it. */
export async function screeningCase(label: string): Promise<{ caseId: string; caseNumber: string }> {
  const { reportId } = await receivedReport(label);
  await as("triage", async (tx) => {
    await tx`select api.triage_report(${reportId}, 'OPEN_CASE', 'Synthetic: within mandate for the e2e fixtures.', null, null)`;
  });
  const caseId = await as("triage", async (tx) => {
    const [c] = await tx<{ id: string }[]>`
      select api.create_case_from_report(${reportId}, ${`Records e2e case ${label} (synthetic)`},
        'Synthetic case for the records screens.', 'CONFIDENTIAL'::core.classification_level, false) as id`;
    await tx`select api.transition_case(${c!.id}, 'START_SCREENING', null)`;
    return c!.id;
  });
  const [row] = await as(
    "caseManager",
    (tx) => tx<{ case_number: string }[]>`
    select case_number from case_mgmt.case_record where id = ${caseId}`,
  );
  return { caseId, caseNumber: row!.case_number };
}

/** A new case closed at screening (CLOSURE), so the case manager can archive it. */
export async function closedCase(label: string): Promise<{ caseId: string; caseNumber: string }> {
  const c = await screeningCase(label);
  await as("caseManager", async (tx) => {
    await tx`select api.transition_case(${c.caseId}, 'SCREEN_OUT', 'Synthetic: screened out for the records e2e.')`;
  });
  return c;
}

/** A new case, screened out and archived, so it is in the records catalogue. */
export async function archivedCase(label: string): Promise<{ caseId: string; caseNumber: string }> {
  const { caseId } = await closedCase(label);
  await as("caseManager", async (tx) => {
    await tx`select api.transition_case(${caseId}, 'ARCHIVE_CASE', null)`;
  });
  const [row] = await as(
    "records",
    (tx) => tx<{ case_number: string }[]>`
    select case_number from api.list_records(null, ${caseId})`,
  );
  return { caseId, caseNumber: row!.case_number };
}

/** An archived case under the test class, marked eligible for disposition by the records officer. */
export async function eligibleCase(label: string): Promise<{ caseId: string; caseNumber: string }> {
  const admin = postgres(process.env.CDF_ADMIN_DATABASE_URL ?? url("postgres", "CDF_ADMIN_DB_PASSWORD"), {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await admin`insert into records.retention_class (code, name_en, name_ar, record_type, category, retention_period,
                  trigger_event, disposition_action, source_reference, status, description)
                values (${TEST_CLASS}, 'E2E test retention', 'اختبار شامل', 'CASE', 'TEMPORARY', interval '1 microsecond',
                  'CASE_CLOSED', 'DESTROY', 'TEST FIXTURE: not a CDF value', 'CONFIGURED',
                  'End-to-end test fixture only. Not a CDF retention value.')
                on conflict (code) do nothing`;
  } finally {
    await admin.end();
  }
  const c = await archivedCase(label);
  await as("records", async (tx) => {
    await tx`select api.assign_retention_class(${c.caseId}, ${TEST_CLASS})`;
    await tx`select api.refresh_disposition_eligibility()`;
  });
  return c;
}
