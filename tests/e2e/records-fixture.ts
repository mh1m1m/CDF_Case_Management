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
  investigatorA: "a0000000-0000-4000-8000-000000000004",
  grcDirector: "a0000000-0000-4000-8000-000000000008",
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

/**
 * A new case in SCREENING with Investigator Alpha on its team and one message from the reporter through the
 * portal (DEC-06: the conversation belongs to the case). The message is sent with the report's own credentials.
 */
export async function reporterCase(
  label: string,
): Promise<{ caseId: string; caseNumber: string; reportId: string; message: string }> {
  const ref = "WB-" + Array.from(randomBytes(12), (b) => CROCKFORD[b % 32]).join("");
  const hmac = randomBytes(32).toString("hex");
  const message = `SYNTHETIC: a detail from the reporter (${label}).`;
  await withAnonContext(
    db().portal,
    randomUUID(),
    (tx) => tx`
      select * from public_api.submit_report(${ref}, ${hmac}, 'ANONYMOUS', 'EMPLOYEE', null,
        'IRREGULAR_TRANSACTIONS', null, 'Employee Alpha (synthetic)',
        ${`Synthetic report for the reporter conversation e2e (${label}).`}, '2026-09-01', '09:30',
        'Procurement department (synthetic)', true, 'en', null)`,
  );
  const [report] = await as(
    "triage",
    (tx) => tx<{ id: string }[]>`select id from intake.report where report_ref = ${ref}`,
  );
  const reportId = report!.id;
  const caseId = await as("triage", async (tx) => {
    await tx`select api.triage_report(${reportId}, 'OPEN_CASE', 'Synthetic: within mandate for the e2e fixtures.', null, null)`;
    const [c] = await tx<{ id: string }[]>`
      select api.create_case_from_report(${reportId}, ${`Reporter e2e case ${label} (synthetic)`},
        'Synthetic case for the reporter conversation.', 'CONFIDENTIAL'::core.classification_level, false) as id`;
    await tx`select api.transition_case(${c!.id}, 'START_SCREENING', null)`;
    return c!.id;
  });
  await withAnonContext(
    db().portal,
    randomUUID(),
    (tx) => tx`select public_api.post_reporter_message(${ref}, ${hmac}, ${message})`,
  );
  const caseNumber = await as("caseManager", async (tx) => {
    await tx`select api.assign_case(${caseId}, ${USERS.investigatorA}, 'INVESTIGATOR', 'Synthetic: reporter e2e investigator.')`;
    const [row] = await tx<
      { case_number: string }[]
    >`select case_number from case_mgmt.case_record where id = ${caseId}`;
    return row!.case_number;
  });
  return { caseId, caseNumber, reportId, message };
}

/** Ends Investigator Alpha's assignment on a fixture case, so the seed's "my cases" stay as they were. */
export async function endInvestigatorAssignment(caseId: string): Promise<void> {
  await as("caseManager", async (tx) => {
    const rows = await tx<{ id: string }[]>`
      select id from case_mgmt.case_assignment
       where case_id = ${caseId} and user_id = ${USERS.investigatorA} and status = 'ACTIVE'`;
    for (const r of rows) await tx`select api.end_assignment(${r.id}, 'Synthetic: e2e fixture clean-up.')`;
  });
}

/** A new case in SCREENING under a legal hold placed by the GRC Director (DEC-10 history audience). */
export async function heldCase(label: string): Promise<{ caseId: string; caseNumber: string }> {
  const c = await screeningCase(label);
  await as("grcDirector", async (tx) => {
    await tx`select api.place_legal_hold(${c.caseId}, 'CASE', null, 'LITIGATION',
      'Synthetic: preservation for the case-history e2e.', null)`;
  });
  return c;
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
