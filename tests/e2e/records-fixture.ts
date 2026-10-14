// Fixtures for the records screens e2e and accessibility specs (CDF-71), also used by the command-form and
// confirmation specs (UX-001, UX-019, UX-031) and the notification specs (UX redesign S4). The seed has no case
// past closure, so each call files a fresh synthetic report and moves a new case through the real database
// commands, acting as the synthetic users in their own security context (no RLS bypass).
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
  committeeChair: "a0000000-0000-4000-8000-000000000016",
  records: "a0000000-0000-4000-8000-000000000019",
  // Notifications (UX redesign S4)
  committee: "a0000000-0000-4000-8000-000000000007",
  platformAdmin: "a0000000-0000-4000-8000-000000000009",
  legalB: "a0000000-0000-4000-8000-000000000022",
  // Case structure and committee referral (Phase 12 P12-1)
  committeeSecretary: "a0000000-0000-4000-8000-000000000015",
  legal: "a0000000-0000-4000-8000-000000000021",
  grcSectorHead: "a0000000-0000-4000-8000-000000000027",
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

/**
 * Ends Investigator Alpha's assignment on a fixture case, so the seed's "my cases" stay as they were. A restricted
 * case is cleaned up by its owner, the GRC Director: the case manager no longer sees it.
 */
export async function endInvestigatorAssignment(
  caseId: string,
  by: "caseManager" | "grcDirector" = "caseManager",
): Promise<void> {
  await as(by, async (tx) => {
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

/**
 * A new case owned by the case manager and restricted by the GRC Director (as the seed's executive case is), then
 * screened out and archived by the case manager. The shared Records queue never takes a restricted case, so the
 * people who may create records tasks on it route its retention review (ADR-016 D8).
 */
export async function restrictedArchivedCase(label: string): Promise<{ caseId: string; caseNumber: string }> {
  const c = await screeningCase(label);
  await as("caseManager", async (tx) => {
    await tx`select api.assign_case(${c.caseId}, ${USERS.caseManager}, 'CASE_OWNER', 'Synthetic: owner for the records e2e.')`;
  });
  await as("grcDirector", async (tx) => {
    await tx`select api.change_case_classification(${c.caseId}, 'CONFIDENTIAL', true,
      'Synthetic: restricted for the records e2e.')`;
  });
  await as("caseManager", async (tx) => {
    await tx`select api.transition_case(${c.caseId}, 'SCREEN_OUT', 'Synthetic: screened out for the records e2e.')`;
    await tx`select api.transition_case(${c.caseId}, 'ARCHIVE_CASE', null)`;
  });
  return c;
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

/** A new SCREENING case with a Committee Formation form the case manager started and left as an empty draft. */
export async function draftFormCase(
  label: string,
): Promise<{ caseId: string; caseNumber: string; instanceId: string }> {
  const c = await screeningCase(label);
  const instanceId = await as("caseManager", async (tx) => {
    const [f] = await tx<{ id: string }[]>`
      select api.start_form(${c.caseId}, 'WB-FRM-13', 'CONFIDENTIAL'::core.classification_level) as id`;
    return f!.id;
  });
  return { ...c, instanceId };
}

/**
 * One form kept open for the committee chair after their case grant was narrowed (S3, ADR-016 D2, path (a)): a
 * new SCREENING case with a Committee Formation form the case manager prepared, a COMMITTEE grant for the chair
 * as one made before S3, and the migration's own reconciliation, which ends the grant and keeps the chair on
 * that form only. The owner-level steps stand in for the history: no application path can create a COMMITTEE
 * grant any more. A TEST FIXTURE in the throwaway CI or local database.
 */
export async function formOnlyCase(
  label: string,
): Promise<{ caseId: string; caseNumber: string; instanceId: string }> {
  const c = await screeningCase(label);
  const instanceId = await as("caseManager", async (tx) => {
    const [f] = await tx<{ id: string }[]>`
      select api.start_form(${c.caseId}, 'WB-FRM-13', 'CONFIDENTIAL'::core.classification_level) as id`;
    await tx`select * from api.save_form_draft(${f!.id}, ${tx.json({
      formation_reference: `CDF-DEMO-COMMITTEE-${label}`.slice(0, 60),
      formation_date: "2026-09-15",
      chair: "Committee Chair Xi",
      members: "Committee Member Epsilon",
      secretary: "Committee Secretary Nu",
      scope: "Synthetic committee scope for the purpose-bound access e2e.",
      independence_confirmed: "true",
    })})`;
    await tx`select api.prepare_form(${f!.id})`;
    return f!.id;
  });
  const admin = postgres(process.env.CDF_ADMIN_DATABASE_URL ?? url("postgres", "CDF_ADMIN_DB_PASSWORD"), {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await admin.begin(async (tx) => {
      const [g] = await tx<{ id: string }[]>`
        insert into case_mgmt.case_access_grant (case_id, user_id, scope, reason, granted_by)
        values (${c.caseId}, ${USERS.committeeChair}, 'CASE', 'Synthetic: committee grant made before S3',
                ${USERS.grcDirector})
        returning id`;
      await tx`update case_mgmt.case_access_grant set scope = 'COMMITTEE' where id = ${g!.id}`;
      await tx`select case_mgmt.reconcile_grant_scope()`;
    });
  } finally {
    await admin.end();
  }
  return { ...c, instanceId };
}

// ---- Notifications (UX redesign S4, ADR-025) ------------------------------------------------------------------

/**
 * A committee-seat notice for the user. The platform administrator appoints them through
 * api.appoint_committee_member to a seat that lies wholly in the past (a unique one-millisecond range five years
 * ago), so it notifies without seating anyone today. Returns the in-app notification id, read as the recipient.
 */
export async function seatNotice(user: "committee" | "legalB"): Promise<string> {
  const [seat] = await as(
    "platformAdmin",
    (tx) => tx<{ id: string }[]>`
      select api.appoint_committee_member((select id from committee.committee where code = 'IC'), ${USERS[user]},
        'MEMBER', clock_timestamp() - interval '5 years', clock_timestamp() - interval '5 years' + interval '1 millisecond',
        'DEMO-E2E-NOTICE') as id`,
  );
  const [notice] = await as(
    user,
    (tx) => tx<{ id: string }[]>`
      select id from notify.outbox where dedupe_key like ${`seat-assigned:${seat!.id}:%`} and channel = 'IN_APP'`,
  );
  return notice!.id;
}

/** Whether the user's own notification is read, read as the user (no RLS bypass). */
export async function noticeRead(user: "committee" | "legalB", id: string): Promise<boolean> {
  const [row] = await as(
    user,
    (tx) => tx<{ read: boolean }[]>`select read_at is not null as read from notify.outbox where id = ${id}`,
  );
  return row!.read;
}

/** Sets the user's own choice for a template on a channel, through the command (tests restore the seed). */
export async function setNoticePreference(
  user: "committee" | "legalB",
  template: string,
  channel: "IN_APP" | "EMAIL",
  muted: boolean,
): Promise<void> {
  await as(user, (tx) => tx`select api.set_notification_preference(${template}, ${channel}, ${muted})`);
}

// ---- Case structure and committee referral (Phase 12 P12-1; ADR-017 to ADR-019) -----------------------------

const STRUCTURE_REASON = "Synthetic: case structure e2e fixture.";

/** A new SCREENING case with Investigator Alpha on its team: the case manager edits it, the investigator finds. */
export async function structureCase(label: string): Promise<{ caseId: string; caseNumber: string }> {
  const c = await screeningCase(label);
  await as(
    "caseManager",
    (tx) =>
      tx`select api.assign_case(${c.caseId}, ${USERS.investigatorA}, 'INVESTIGATOR', ${STRUCTURE_REASON})`,
  );
  return c;
}

/**
 * AMB-018 (migration 2030): the case's preliminary review refers it to the Investigation Committee, as
 * tests/support/committee.ts does it. The GRC Director prepares the recommendation (no review step, Q15) and the GRC
 * Sector Head approves it. On a restricted case the approver sees nothing without an explicit grant (fail safe), so
 * the owner grants case access for the approval and revokes it afterwards.
 */
export async function preliminaryReferral(caseId: string): Promise<void> {
  const { recommendation, grant } = await as("grcDirector", async (tx) => {
    const [c] = await tx<{ restricted: boolean }[]>`
      select is_restricted as restricted from case_mgmt.case_record where id = ${caseId}`;
    if (!c) throw new Error("preliminaryReferral: the GRC Director cannot see the case");
    const [r] = await tx<{ id: string }[]>`
      select api.prepare_preliminary_recommendation(${caseId}, 'REFERRED_TO_COMMITTEE',
        'Synthetic: serious enough for the Investigation Committee.') as id`;
    const [g] = c.restricted
      ? await tx<{ id: string }[]>`
          select api.grant_case_access(${caseId}, ${USERS.grcSectorHead}, 'CASE', ${STRUCTURE_REASON}, null) as id`
      : [];
    return { recommendation: r!.id, grant: g?.id };
  });
  await as(
    "grcSectorHead",
    (tx) => tx`select api.approve_preliminary_recommendation(${recommendation}, 'APPROVE', null, null)`,
  );
  if (grant)
    await as("grcDirector", (tx) => tx`select api.revoke_case_access(${grant}, ${STRUCTURE_REASON})`);
}

/** An investigation proceeding on the case, opened by the case manager. */
export async function openInvestigation(caseId: string): Promise<string> {
  const [p] = await as(
    "caseManager",
    (tx) => tx<{ id: string }[]>`
      select api.open_proceeding(${caseId}, 'INVESTIGATION', null, ${STRUCTURE_REASON}) as id`,
  );
  return p!.id;
}

/**
 * Runs `fn` while the Investigation Committee can take a referral (a chair, a secretary and a voting member in
 * office, all cleared to CONFIDENTIAL), then ends the seats it added. Seats already in office are kept as they are:
 * on a seeded database the demo committee (30_synthetic_committee_seats.sql) holds all three, so nothing is added.
 * The platform administrator appoints and ends seats through the api.* commands. A seat starts when it is appointed
 * and ends when `fn` returns, so the next call's seats never overlap it (MEMBERSHIP_OVERLAP).
 */
export async function withSeatedInvestigationCommittee<T>(fn: () => Promise<T>): Promise<T> {
  const wanted: [keyof typeof USERS, "CHAIR" | "SECRETARY" | "MEMBER"][] = [
    ["committeeChair", "CHAIR"],
    ["committeeSecretary", "SECRETARY"],
    ["legal", "MEMBER"],
  ];
  const added = await as("platformAdmin", async (tx) => {
    const current = await tx<{ seat: string }[]>`
      select m.seat from committee.membership m join committee.committee c on c.id = m.committee_id
       where c.code = 'IC' and m.effective_from <= now() and (m.effective_to is null or m.effective_to > now())`;
    const ids: string[] = [];
    for (const [user, seat] of wanted) {
      if (current.some((m) => m.seat === seat)) continue;
      const [m] = await tx<{ id: string }[]>`
        select api.appoint_committee_member((select id from committee.committee where code = 'IC'), ${USERS[user]},
          ${seat}, clock_timestamp(), null, 'DEMO-E2E-REFERRAL') as id`;
      ids.push(m!.id);
    }
    return ids;
  });
  try {
    return await fn();
  } finally {
    await as("platformAdmin", async (tx) => {
      for (const id of added)
        await tx`select api.end_committee_membership(${id}, clock_timestamp(), ${STRUCTURE_REASON})`;
    });
  }
}

/**
 * A case with its structure built through the commands: a preliminary review that referred it (proceeding 1), one
 * person, the report's allegation tied to them, an investigation with two versions of a finding (proceeding 2), and
 * a referral to the Investigation Committee with the committee's own finding (proceeding 3). Used where a test needs
 * every part of the two tabs on screen.
 */
export async function builtStructureCase(label: string): Promise<{ caseId: string; caseNumber: string }> {
  const c = await structureCase(label);
  await preliminaryReferral(c.caseId);
  const investigation = await openInvestigation(c.caseId);
  const allegation = await as("caseManager", async (tx) => {
    const [subject] = await tx<{ id: string }[]>`
      select api.add_case_subject(${c.caseId}, 'Employee Kappa (synthetic)', 'EMPLOYEE', null) as id`;
    const [a] = await tx<{ id: string }[]>`
      select id from case_mgmt.allegation where case_id = ${c.caseId} order by created_at, id limit 1`;
    await tx`select api.link_allegation_subject(${a!.id}, ${subject!.id}, 'Code of Conduct art. 7 (synthetic)', null)`;
    return a!.id;
  });
  await as("investigatorA", async (tx) => {
    await tx`select api.record_finding(${allegation}, null, ${investigation}, 'SUBSTANTIATED',
      'Synthetic: the first reading of the records.')`;
    await tx`select api.record_finding(${allegation}, null, ${investigation}, 'PARTIALLY_SUBSTANTIATED',
      'Synthetic: after the second interview, only part is supported.')`;
  });
  const committeeProceeding = await withSeatedInvestigationCommittee(() =>
    as("caseManager", async (tx) => {
      const [referral] = await tx<{ id: string }[]>`
        select api.refer_case_to_committee(${c.caseId}, (select id from committee.committee where code = 'IC'),
                                           ${investigation}, ${STRUCTURE_REASON}) as id`;
      const [cp] = await tx<{ proceeding_id: string }[]>`
        select proceeding_id from committee.committee_proceeding where id = ${referral!.id}`;
      return cp!.proceeding_id;
    }),
  );
  await as(
    "investigatorA",
    (tx) => tx`select api.record_finding(${allegation}, null, ${committeeProceeding}, 'SUBSTANTIATED',
      'Synthetic: the committee finds the allegation substantiated.')`,
  );
  return c;
}

/**
 * A new SCREENING case owned by the GRC Director (an eligible Restricted Case Authority) and restricted by them, with
 * Investigator Alpha on its team (DEC-01, DEC-61). The case manager is not on its team.
 */
export async function restrictedStructureCase(
  label: string,
): Promise<{ caseId: string; caseNumber: string }> {
  const c = await structureCase(label);
  await as("caseManager", async (tx) => {
    await tx`select api.assign_case(${c.caseId}, ${USERS.grcDirector}, 'CASE_OWNER', ${STRUCTURE_REASON})`;
  });
  await as("grcDirector", async (tx) => {
    await tx`select api.change_case_classification(${c.caseId}, 'CONFIDENTIAL', true, ${STRUCTURE_REASON})`;
  });
  return c;
}
