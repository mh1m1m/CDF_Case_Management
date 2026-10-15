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
  // The seed's demo Investigation Committee (Phase 12 P12-2a meeting screens; see IC_DEMO)
  icChair: "a0000000-0000-4000-8000-000000000101",
  icDeputy: "a0000000-0000-4000-8000-000000000102",
  icSecretary: "a0000000-0000-4000-8000-000000000103",
  icMemberA: "a0000000-0000-4000-8000-000000000104",
  icMemberB: "a0000000-0000-4000-8000-000000000105",
  // Appointed to the demo committee after a referral, then ended (Phase 12 P12-2b; no other browser spec uses it)
  dpo: "a0000000-0000-4000-8000-000000000012",
  // Employee Chi, a corrective action's owner (Phase 12 P12-3b; no other browser spec uses it)
  financeEmployee: "a0000000-0000-4000-8000-000000000028",
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

/**
 * A disposed case and its certificate (DEC-51 dates, CDF-209): the records officer requests disposition, the GRC
 * Director approves it and the officer executes it, each through the real command in their own context. Returns the
 * certificate's stored issue time as ISO text, as read by the officer.
 */
export async function disposedCase(
  label: string,
): Promise<{ caseId: string; caseNumber: string; certificateId: string; issuedAt: string }> {
  const c = await eligibleCase(label);
  const requestId = await as("records", async (tx) => {
    const [r] = await tx<{ id: string }[]>`select api.request_disposition(${c.caseId}) as id`;
    return r!.id;
  });
  await as(
    "grcDirector",
    (tx) => tx`select api.decide_disposition(${requestId}, true, 'Synthetic decision reason.')`,
  );
  return as("records", async (tx) => {
    const [r] = await tx<{ id: string }[]>`select api.execute_disposition(${requestId}) as id`;
    const [cert] = await tx<{ issued_at: Date }[]>`
      select issued_at from records.disposition_certificate where id = ${r!.id}`;
    return { ...c, certificateId: r!.id, issuedAt: cert!.issued_at.toISOString() };
  });
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

// ---- Phase 12 purpose kinds in My Work (P12-0b; migration 2045, ADR-051) ----------------------------------

/** The comment the GRC Sector Head returns a recommendation with; My Work never shows it, only the reason codes. */
export const RETURN_COMMENT = "Synthetic: add the dates of the meetings.";

/**
 * A preliminary recommendation the GRC Director prepared, waiting for the GRC Sector Head's approval (no review
 * step, Q15), so it is in the sector head's My Work. Returns its id.
 */
export async function awaitingPreliminaryApproval(caseId: string): Promise<string> {
  const [r] = await as(
    "grcDirector",
    (tx) => tx<{ id: string }[]>`
      select api.prepare_preliminary_recommendation(${caseId}, 'REFERRED_TO_COMMITTEE',
        'Synthetic: serious enough for the Investigation Committee.') as id`,
  );
  return r!.id;
}

/** The GRC Sector Head returns it with two structured reasons and a comment (AMB-250). */
export async function returnPreliminary(recommendationId: string): Promise<void> {
  await as(
    "grcSectorHead",
    (tx) => tx`
      select api.approve_preliminary_recommendation(${recommendationId}, 'RETURN',
        array['MISSING_INFORMATION', 'UNCLEAR_ALLEGATION'], ${RETURN_COMMENT})`,
  );
}

/**
 * Ends the case's preliminary review approved, from whichever step a test left it in, so no row stays in anyone's
 * My Work: one awaiting approval is approved; one returned gets a next version, approved.
 */
export async function settlePreliminary(caseId: string): Promise<void> {
  const [last] = await as(
    "grcDirector",
    (tx) => tx<{ id: string; status: string }[]>`
      select id, status from case_mgmt.preliminary_recommendation where case_id = ${caseId}
       order by prepared_at desc, id desc limit 1`,
  );
  if (last?.status === "AWAITING_APPROVAL")
    await as(
      "grcSectorHead",
      (tx) => tx`select api.approve_preliminary_recommendation(${last.id}, 'APPROVE', null, null)`,
    );
  else if (last?.status === "RETURNED") await preliminaryReferral(caseId);
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

// ---- Meeting and minutes screens (Phase 12 P12-2a; migration 2065, ADR-054) ---------------------------------

/**
 * The seed's demo Investigation Committee (30_synthetic_committee_seats.sql). On a seeded database a referral to the
 * Investigation Committee goes to it, so the meeting screens' specs sign in as its members: the chair, the deputy
 * chair and the two members vote, and the secretary runs the meeting. The database tests never use them; they seat
 * the test users inside a transaction that rolls back.
 */
export const IC_DEMO = {
  icChair: "ic.chair@example.test",
  icDeputy: "ic.deputy@example.test",
  icSecretary: "ic.secretary@example.test",
  icMemberA: "ic.member.a@example.test",
  icMemberB: "ic.member.b@example.test",
} as const;
export type IcDemoUser = keyof typeof IC_DEMO;
export const IC_VOTERS: IcDemoUser[] = ["icChair", "icDeputy", "icMemberA", "icMemberB"];

const MEETING_REASON = "Synthetic: meeting screens e2e fixture.";

export interface MeetingFixture {
  caseId: string;
  caseNumber: string;
  meetingId: string;
  /** Each demo member's participant id in the meeting. */
  participant: Record<IcDemoUser, string>;
}

interface RawMeeting {
  logistics: { status: string };
  roster: { participant_id: string; user_id: string | null; attendance: string; coi_status: string }[] | null;
  deliberation: { vote_items: { vote_item_id: string; sequence_no: number; status: string }[] } | null;
  minutes: { minutes_id: string; version_no: number; status: string }[];
}

const meetingAs = async (user: keyof typeof USERS, meetingId: string): Promise<RawMeeting> => {
  const [row] = await as(user, (tx) => tx<{ v: RawMeeting }[]>`select api.meeting_view(${meetingId}) as v`);
  return row!.v;
};

const demoUser = (userId: string | null) =>
  (Object.keys(IC_DEMO) as IcDemoUser[]).find((u) => USERS[u] === userId);

/** The demo Investigation Committee's id. */
export async function demoCommitteeId(): Promise<string> {
  const [c] = await as(
    "platformAdmin",
    (tx) => tx<{ id: string }[]>`select id from committee.committee where code = 'IC'`,
  );
  return c!.id;
}

export interface ReferralFixture {
  caseId: string;
  caseNumber: string;
  /** The proceeding the referral opened in the demo Investigation Committee. */
  committeeProceedingId: string;
}

/** Fails unless the demo Investigation Committee holds its seats. */
async function requireSeatedDemoCommittee(): Promise<void> {
  const seated = await as(
    "platformAdmin",
    (tx) => tx<{ user_id: string }[]>`
      select m.user_id from committee.membership m join committee.committee c on c.id = m.committee_id
       where c.code = 'IC' and m.effective_from <= now() and (m.effective_to is null or m.effective_to > now())`,
  );
  const unseated = (Object.keys(IC_DEMO) as IcDemoUser[]).filter(
    (u) => !seated.some((m) => m.user_id === USERS[u]),
  );
  if (unseated.length > 0)
    throw new Error(
      `the demo Investigation Committee is not seated (${unseated.join(", ")}); run pnpm db:reset`,
    );
}

/**
 * A new case referred to the demo Investigation Committee after its preliminary review referred it (AMB-018). Fails
 * unless the demo committee holds its seats.
 */
export async function referredCase(label: string): Promise<ReferralFixture> {
  await requireSeatedDemoCommittee();
  const c = await screeningCase(label);
  await preliminaryReferral(c.caseId);
  const [referral] = await as(
    "caseManager",
    (tx) => tx<{ id: string }[]>`
      select api.refer_case_to_committee(${c.caseId}, (select id from committee.committee where code = 'IC'), null,
                                         ${MEETING_REASON}) as id`,
  );
  return { ...c, committeeProceedingId: referral!.id };
}

/**
 * A new case referred to the demo Investigation Committee (referredCase), with an in-person deliberation the
 * secretary scheduled for tomorrow.
 */
export async function scheduledMeeting(label: string): Promise<MeetingFixture> {
  const { committeeProceedingId, ...c } = await referredCase(label);
  return scheduledDeliberation(c, committeeProceedingId);
}

/** The secretary schedules an in-person deliberation of the proceeding for tomorrow. */
async function scheduledDeliberation(
  c: { caseId: string; caseNumber: string },
  committeeProceedingId: string,
): Promise<MeetingFixture> {
  const meetingId = await as("icSecretary", async (tx) => {
    const [m] = await tx<{ id: string }[]>`
      select api.schedule_meeting(${committeeProceedingId}, 'DELIBERATION', 'IN_PERSON', 'Meeting room 2 (synthetic)',
        null, now() + interval '1 day', now() + interval '1 day 2 hours', ${MEETING_REASON}) as id`;
    return m!.id;
  });
  const roster = (await meetingAs("icSecretary", meetingId)).roster ?? [];
  const participant = Object.fromEntries(
    (Object.keys(IC_DEMO) as IcDemoUser[]).map((u) => {
      const row = roster.find((r) => r.user_id === USERS[u]);
      if (!row) throw new Error(`scheduledDeliberation: ${u} is not in the meeting`);
      return [u, row.participant_id];
    }),
  ) as Record<IcDemoUser, string>;
  return { ...c, meetingId, participant };
}

/**
 * A person on the case without an account (a case subject the case manager adds), whom the secretary invites as a
 * witness: the invitation form comes with P12-2c, so the fixture calls the command. Returns their participant id.
 */
export async function invitedWitness(m: MeetingFixture): Promise<string> {
  const person = await as("caseManager", async (tx) => {
    const [subject] = await tx<{ id: string }[]>`
      select api.add_case_subject(${m.caseId}, 'Witness Omega (synthetic)', 'EMPLOYEE', null) as id`;
    const [row] = await tx<{ person_id: string }[]>`
      select person_id from case_mgmt.case_subject where id = ${subject!.id}`;
    return row!.person_id;
  });
  const [p] = await as(
    "icSecretary",
    (tx) => tx<{ id: string }[]>`
      select api.invite_to_meeting(${m.meetingId}, 'WITNESS', null, ${person}, true, ${MEETING_REASON}) as id`,
  );
  return p!.id;
}

/**
 * The deputy chair and both members declare no conflict, the secretary opens the meeting, records them present and
 * the chair absent: the deputy chair may then act as chair (DEC-F03).
 */
export async function openWithChairAbsent(m: MeetingFixture): Promise<void> {
  const present: IcDemoUser[] = ["icDeputy", "icMemberA", "icMemberB"];
  await declareNoConflict(m, present);
  await as("icSecretary", async (tx) => {
    await tx`select api.open_meeting(${m.meetingId}, ${MEETING_REASON})`;
    for (const u of present) await tx`select api.record_attendance(${m.participant[u]}, 'PRESENT')`;
    await tx`select api.record_attendance(${m.participant.icChair}, 'ABSENT')`;
  });
}

const LATE_MEMBER_REFERENCE = "E2E-DEMO-IC-MEMBER-AFTER-REFERRAL";

/** Ends the late member's seat on the demo committee, if they hold one, so no later referral copies them. */
export async function endLateMember(): Promise<void> {
  await as(
    "platformAdmin",
    (tx) => tx`
      select api.end_committee_membership(m.id, clock_timestamp(), ${MEETING_REASON})
      from committee.membership m join committee.committee c on c.id = m.committee_id
      where c.code = 'IC' and m.user_id = ${USERS.dpo} and m.ended_at is null
        and (m.effective_to is null or m.effective_to > clock_timestamp())`,
  );
}

/**
 * Appoints a member to the demo committee after a referral (AMB-038), whom the secretary may then add to that
 * proceeding. Call endLateMember afterwards: the seat would otherwise join every later referral.
 */
export async function appointLateMember(): Promise<void> {
  await endLateMember();
  await as(
    "platformAdmin",
    (tx) => tx`
      select api.appoint_committee_member((select id from committee.committee where code = 'IC'), ${USERS.dpo},
        'MEMBER', clock_timestamp(), null, ${`${LATE_MEMBER_REFERENCE}-${randomUUID().slice(0, 8)}`})`,
  );
}

/** The listed members declare no conflict, each as themself. */
export async function declareNoConflict(m: MeetingFixture, users: IcDemoUser[]): Promise<void> {
  for (const u of users)
    await as(u, (tx) => tx`select api.declare_meeting_conflict(${m.participant[u]}, 'NO_CONFLICT', null)`);
}

/** The voters declare no conflict, then the secretary opens the meeting and records them present. */
export async function openWithVoters(m: MeetingFixture, voters: IcDemoUser[] = IC_VOTERS): Promise<void> {
  await declareNoConflict(m, voters);
  await as("icSecretary", async (tx) => {
    await tx`select api.open_meeting(${m.meetingId}, ${MEETING_REASON})`;
    for (const u of voters) await tx`select api.record_attendance(${m.participant[u]}, 'PRESENT')`;
  });
}

/** The secretary opens a vote on other business; returns its id. */
export async function openVote(m: MeetingFixture, title = "Recommendation (synthetic)"): Promise<string> {
  const [v] = await as(
    "icSecretary",
    (tx) => tx<{ id: string }[]>`select api.open_vote_item(${m.meetingId}, 'OTHER', null, ${title}) as id`,
  );
  return v!.id;
}

/** The id of the meeting's vote with this number, as the secretary reads it. */
export async function voteItemId(m: MeetingFixture, sequenceNo: number): Promise<string> {
  const item = (await meetingAs("icSecretary", m.meetingId)).deliberation?.vote_items.find(
    (v) => v.sequence_no === sequenceNo,
  );
  if (!item) throw new Error(`voteItemId: no vote ${sequenceNo}`);
  return item.vote_item_id;
}

/** Each listed member casts their own vote. */
export async function castVotes(item: string, votes: [IcDemoUser, string][]): Promise<void> {
  for (const [u, choice] of votes) await as(u, (tx) => tx`select api.cast_vote(${item}, ${choice}, null)`);
}

/** The secretary closes the vote; returns its result. */
export async function closeVote(item: string): Promise<string> {
  const [r] = await as(
    "icSecretary",
    (tx) => tx<{ v: string }[]>`select api.close_vote_item(${item}, null) as v`,
  );
  return r!.v;
}

/** A vote everyone present approves, closed: the meeting may then close. */
export async function approvedVote(m: MeetingFixture, voters: IcDemoUser[] = IC_VOTERS): Promise<string> {
  const item = await openVote(m);
  await castVotes(
    item,
    voters.map((u) => [u, "APPROVE"]),
  );
  await closeVote(item);
  return item;
}

/** The secretary closes the meeting and writes its minutes; returns their id. */
export async function minutedMeeting(m: MeetingFixture): Promise<string> {
  return as("icSecretary", async (tx) => {
    await tx`select api.close_meeting(${m.meetingId}, ${MEETING_REASON})`;
    const [mi] = await tx<{ id: string }[]>`
      select api.generate_minutes(${m.meetingId}, 'Synthetic minutes for the meeting screens e2e.') as id`;
    return mi!.id;
  });
}

/** A member raises a conflict about another and the chair decides it; returns the concern's id. */
export async function decidedConcern(
  m: MeetingFixture,
  raiser: IcDemoUser,
  about: IcDemoUser,
  decision: "UPHELD" | "DISMISSED",
): Promise<string> {
  const [k] = await as(
    raiser,
    (tx) => tx<{ id: string }[]>`
      select api.raise_meeting_conflict(${m.participant[about]},
        'Synthetic: the member reviewed this matter before, for the e2e check.') as id`,
  );
  await as(
    "icChair",
    (tx) =>
      tx`select api.decide_meeting_conflict(${k!.id}, ${decision}, 'Synthetic: decided on the record.')`,
  );
  return k!.id;
}

/**
 * Leaves nothing waiting on the demo committee, whatever state a test left the meeting in. A scheduled meeting is
 * cancelled. On an open one, each counted member who has not voted approves, each open vote closes (the chair breaks
 * a tie) and the meeting closes. A closed meeting without minutes gets them, and every member who may still review
 * the latest minutes approves them.
 */
export async function settleMeeting(meetingId: string): Promise<void> {
  let view = await meetingAs("icSecretary", meetingId);
  if (view.logistics.status === "SCHEDULED") {
    await as("icSecretary", (tx) => tx`select api.cancel_meeting(${meetingId}, ${MEETING_REASON})`);
    return;
  }
  if (view.logistics.status === "OPEN") {
    const counted = (view.roster ?? []).filter(
      (r) => r.attendance === "PRESENT" && r.coi_status === "NO_CONFLICT",
    );
    for (const item of view.deliberation?.vote_items.filter((v) => v.status === "OPEN") ?? []) {
      const [status] = await as(
        "icSecretary",
        (tx) =>
          tx<
            { v: { voters: { participant_id: string; has_voted: boolean; replaced: boolean | null }[] } }[]
          >`select api.vote_item_status(${item.vote_item_id}) as v`,
      );
      for (const voter of status!.v.voters) {
        const row = counted.find((r) => r.participant_id === voter.participant_id);
        const user = demoUser(row?.user_id ?? null);
        if (!voter.has_voted && !voter.replaced && user)
          await castVotes(item.vote_item_id, [[user, "APPROVE"]]);
      }
      if ((await closeVote(item.vote_item_id)) === "AWAITING_CASTING_VOTE")
        await as("icChair", (tx) => tx`select api.cast_casting_vote(${item.vote_item_id}, 'APPROVE', null)`);
    }
    await as("icSecretary", (tx) => tx`select api.close_meeting(${meetingId}, ${MEETING_REASON})`);
    view = await meetingAs("icSecretary", meetingId);
  }
  if (view.logistics.status !== "CLOSED") return;
  let latest = [...view.minutes].sort((a, b) => b.version_no - a.version_no)[0];
  if (!latest) {
    await as(
      "icSecretary",
      (tx) => tx`select api.generate_minutes(${meetingId}, 'Synthetic minutes for the meeting screens e2e.')`,
    );
    latest = (await meetingAs("icSecretary", meetingId)).minutes[0];
  }
  if (latest?.status !== "IN_REVIEW") return;
  for (const u of IC_VOTERS) {
    // A member who did not sit (absent, for example) may not read the minutes in review: nothing to review.
    const row = await as(
      u,
      (tx) => tx<{ v: { capabilities: { may_review: boolean } | null } }[]>`
        select api.minutes_view(${latest.minutes_id}) as v`,
    ).then(
      ([r]) => r,
      (e: unknown) => {
        if (e instanceof Error && e.message.includes("CDF_NOT_FOUND")) return undefined;
        throw e;
      },
    );
    if (row?.v.capabilities?.may_review)
      await as(u, (tx) => tx`select api.review_minutes(${latest.minutes_id}, 'APPROVE', null)`);
  }
}

// ---- The proceeding before the committee (Phase 12 P12-2c; migration 2086, ADR-056) -------------------------------

export interface ProceedingFixture extends MeetingFixture {
  /** The proceeding the referral opened in the demo Investigation Committee. */
  committeeProceedingId: string;
  /** The case's one person concerned. Their name is never shown while labels are ordinal (DEC-02). */
  subjectId: string;
  /** The report's allegation, tied to them. */
  allegationId: string;
  /** The investigation's finding on it, which the committee may put to the vote (CDF-214). */
  findingId: string;
}

/** The fixture's person concerned: a page that shows this name has broken the ordinal labels (DEC-02). */
export const PROCEEDING_SUBJECT = "Employee Kappa (synthetic)";

/**
 * A case ready for a recommendation package and a vote on a finding: one person concerned, the report's allegation
 * tied to them, the investigation's substantiated finding on it, and the person's defence notice on that allegation (a
 * sanction is adopted only after one, AMB-026). The case is referred to the demo Investigation Committee from that
 * investigation, so its finding is one the committee may act on, and the secretary opens a deliberation with the four
 * voters present. Fails unless the demo committee holds its seats.
 */
export async function proceedingMeeting(label: string): Promise<ProceedingFixture> {
  await requireSeatedDemoCommittee();
  const c = await structureCase(label);
  await preliminaryReferral(c.caseId);
  const investigation = await openInvestigation(c.caseId);
  const { subjectId, allegationId } = await as("caseManager", async (tx) => {
    const [subject] = await tx<{ id: string }[]>`
      select api.add_case_subject(${c.caseId}, ${PROCEEDING_SUBJECT}, 'EMPLOYEE', null) as id`;
    const [a] = await tx<{ id: string }[]>`
      select id from case_mgmt.allegation where case_id = ${c.caseId} order by created_at, id limit 1`;
    await tx`select api.link_allegation_subject(${a!.id}, ${subject!.id}, 'Code of Conduct art. 7 (synthetic)', null)`;
    await tx`select api.issue_defence_notice(${subject!.id}, 'Synthetic: you are invited to respond.',
      ${[a!.id]}::uuid[], now() + interval '10 days')`;
    return { subjectId: subject!.id, allegationId: a!.id };
  });
  const [finding] = await as(
    "investigatorA",
    (tx) => tx<{ id: string }[]>`
      select api.record_finding(${allegationId}, null, ${investigation}, 'SUBSTANTIATED',
        'Synthetic: the records support the allegation.') as id`,
  );
  const [referral] = await as(
    "caseManager",
    (tx) => tx<{ id: string }[]>`
      select api.refer_case_to_committee(${c.caseId}, (select id from committee.committee where code = 'IC'),
                                         ${investigation}, ${MEETING_REASON}) as id`,
  );
  const m = await scheduledDeliberation(c, referral!.id);
  await openWithVoters(m);
  return { ...m, committeeProceedingId: referral!.id, subjectId, allegationId, findingId: finding!.id };
}

/**
 * The secretary creates a package voted as a whole or item by item, with one item: a written warning from the
 * catalogue for the person concerned, on their allegation. Returns the package's id.
 */
export async function draftPackage(
  f: ProceedingFixture,
  granularity: "PACKAGE" | "ITEM" = "PACKAGE",
): Promise<string> {
  return as("icSecretary", async (tx) => {
    const [p] = await tx<{ id: string }[]>`
      select api.create_recommendation_package(${f.committeeProceedingId}, ${granularity}) as id`;
    await tx`select api.add_recommendation_item(${p!.id}, 'DISCIPLINARY_SANCTION', 'WARNING', null,
      'Synthetic: a written warning for the person concerned.', ${[f.subjectId]}::uuid[], ${[f.allegationId]}::uuid[],
      false, '{}'::uuid[], null)`;
    return p!.id;
  });
}

/** The secretary puts the package to the committee and opens its vote in the meeting. */
export async function packageVoteOpened(f: ProceedingFixture, packageId: string): Promise<void> {
  await as("icSecretary", async (tx) => {
    await tx`select api.submit_package_for_vote(${packageId})`;
    await tx`select api.open_package_vote(${f.meetingId}, ${packageId})`;
  });
}

/** Each open vote of the meeting, approved by every voter present, closed; so a conflict may then be raised. */
export async function openVotesApproved(m: MeetingFixture): Promise<void> {
  const items = (await meetingAs("icSecretary", m.meetingId)).deliberation?.vote_items ?? [];
  for (const item of items.filter((v) => v.status === "OPEN")) {
    await castVotes(
      item.vote_item_id,
      IC_VOTERS.map((u) => [u, "APPROVE"]),
    );
    await closeVote(item.vote_item_id);
  }
}

/** The secretary records the committee's adoption of the package, once every vote of its round is closed. */
export async function adoptionRecorded(packageId: string): Promise<void> {
  await as("icSecretary", (tx) => tx`select api.record_package_adoption(${packageId})`);
}

/** The package put to the committee, its vote opened in the meeting and approved, and its adoption recorded. */
export async function adoptedPackage(f: ProceedingFixture, packageId: string): Promise<void> {
  await packageVoteOpened(f, packageId);
  await openVotesApproved(f);
  await adoptionRecorded(packageId);
}

/** The secretary opens a vote on the case's finding in the meeting; returns its id. */
export async function findingVoteOpened(f: ProceedingFixture): Promise<string> {
  const [v] = await as(
    "icSecretary",
    (tx) => tx<{ id: string }[]>`
      select api.open_vote_item(${f.meetingId}, 'FINDING', ${f.findingId},
        'Synthetic: is the allegation substantiated?') as id`,
  );
  return v!.id;
}

// ---- Legal review and the authority's decision (Phase 12 P12-3a; migration 2095, ADR-057) ----------------------------

/** The secretary's reason when a fixture asks for a legal review: the reviewer reads it, My Work never shows it. */
export const REVIEW_REASON = "Synthetic: please review the adopted package before it goes to the CEO.";

/** The package the demo committee adopted with its one item (a written warning), ready for a legal review. */
export async function packageForReview(label: string): Promise<ProceedingFixture & { packageId: string }> {
  const f = await proceedingMeeting(label);
  const packageId = await draftPackage(f);
  await adoptedPackage(f, packageId);
  return { ...f, packageId };
}

/** The secretary asks Legal Reviewer Pi to review the package with the case's finding; returns the request's id. */
export async function legalReviewAsked(f: ProceedingFixture, packageId: string): Promise<string> {
  const [r] = await as(
    "icSecretary",
    (tx) => tx<{ id: string }[]>`
      select api.request_legal_review(${packageId}, ${USERS.legalB}, ${REVIEW_REASON}, ${[f.findingId]}::uuid[],
        null) as id`,
  );
  return r!.id;
}

/** Legal Reviewer Pi concurs. */
export async function opinionGiven(requestId: string): Promise<void> {
  await as("legalB", (tx) => tx`select api.give_legal_opinion(${requestId}, 'CONCURS', null)`);
}

/** The package's latest legal review request and the packet sent with it, as the committee's page reads them (R2). */
export async function latestRequest(
  f: { committeeProceedingId: string },
  packageId: string,
): Promise<{ requestId: string; packetId: string }> {
  const [row] = await as(
    "icSecretary",
    (tx) =>
      tx<
        {
          v: {
            packages: {
              package_id: string;
              legal_review?: { requests: { request_id: string; packet_id: string }[] };
            }[];
          };
        }[]
      >`select api.committee_items_view(${f.committeeProceedingId}) as v`,
  );
  const last = row!.v.packages.find((p) => p.package_id === packageId)?.legal_review?.requests.at(-1);
  if (!last) throw new Error("latestRequest: the package has no request on the committee's page");
  return { requestId: last.request_id, packetId: last.packet_id };
}

/**
 * A restricted case (owned and restricted by the GRC Director, its Restricted Case Authority) referred to the demo
 * Investigation Committee with that authority's approval (DEC-F20), and a package of one case-wide corrective action
 * the committee adopted: a legal review of it waits for the authority's approval. Investigator Alpha is on the case's
 * team; the GRC Director takes them off it again (endInvestigatorAssignment with "grcDirector").
 */
export async function restrictedPackageForReview(
  label: string,
): Promise<MeetingFixture & { committeeProceedingId: string; packageId: string }> {
  await requireSeatedDemoCommittee();
  const c = await restrictedStructureCase(label);
  await preliminaryReferral(c.caseId);
  const committeeProceedingId = await as("grcDirector", async (tx) => {
    const [ic] = await tx<{ id: string }[]>`select id from committee.committee where code = 'IC'`;
    await tx`select api.approve_restricted_committee_referral(${c.caseId}, ${ic!.id}, ${MEETING_REASON})`;
    const [r] = await tx<{ id: string }[]>`
      select api.refer_case_to_committee(${c.caseId}, ${ic!.id}, null, ${MEETING_REASON}) as id`;
    return r!.id;
  });
  const m = await scheduledDeliberation(c, committeeProceedingId);
  await openWithVoters(m);
  const packageId = await as("icSecretary", async (tx) => {
    const [p] = await tx<{ id: string }[]>`
      select api.create_recommendation_package(${committeeProceedingId}, 'PACKAGE') as id`;
    await tx`select api.add_recommendation_item(${p!.id}, 'CORRECTIVE_ACTION', null, null,
      'Synthetic: tighten the approval controls.', null, null, false, '{}'::uuid[], null)`;
    await tx`select api.submit_package_for_vote(${p!.id})`;
    await tx`select api.open_package_vote(${m.meetingId}, ${p!.id})`;
    return p!.id;
  });
  await openVotesApproved(m);
  await adoptionRecorded(packageId);
  return { ...m, committeeProceedingId, packageId };
}

/** The secretary submits the package, with its opinion, to the authority its rules name (the CEO, for a sanction). */
export async function submittedToAuthority(packageId: string): Promise<void> {
  await as("icSecretary", (tx) => tx`select api.submit_to_authority(${packageId})`);
}

/** The restricted case's authority approves a legal review of the package by Legal Reviewer Pi, with nothing besides. */
export async function legalReviewApproved(packageId: string): Promise<void> {
  await as(
    "grcDirector",
    (tx) => tx`
      select api.approve_restricted_legal_review(${packageId}, ${USERS.legalB}, '{}'::uuid[], '{}'::uuid[],
        'Synthetic: a legal review is needed on this restricted case.')`,
  );
}

// ---- Corrective actions under a superseded decision (Phase 12 P12-3b; migration 2096, ADR-058) ----------------------

/** The action the case manager opens under the first decision: the wording its owner reads on its card. */
export const FROZEN_ACTION = {
  title: "Synthetic: strengthen the approval controls",
  description: "Synthetic: add a second approver to payments above the threshold.",
} as const;

/** The action's owner: Employee Chi, an implementation owner (see correctiveActionPrerequisites). */
export const ACTION_OWNER = { id: USERS.financeEmployee, email: "employee.chi@example.test" } as const;

/** The replacement decision's source documents, its primary document first: a disposition cites one of them. */
export const REPLACEMENT_SOURCES = ["MEMO-DEMO-2096-E2E-02", "MEMO-DEMO-2096-E2E-03"] as const;

const DECISION_REASON = "Synthetic: the CEO's decision on the package, for the e2e check.";

export interface FrozenActionFixture extends ProceedingFixture {
  packageId: string;
  /** The package's one item, a case-wide corrective action. */
  itemId: string;
  /** The action opened under the first decision, owned by Employee Chi: frozen once that decision is superseded. */
  actionId: string;
}

/**
 * A corrective action needs an authority to decide it and an implementation owner to answer for it, and the seed has
 * neither: only the disciplinary rule is seeded (DEC-F13; a submission fails closed without a rule, AMB-135) and nobody
 * holds IMPLEMENTATION_OWNER. The platform administrator sets a synthetic SOURCE_REQUIRED rule sending corrective actions
 * to the authority the disciplinary rule names (as tests/support/decision.ts does for the security suite) and grants
 * Employee Chi IMPLEMENTATION_OWNER, each once per database. TEST FIXTURE steps, not CDF values: they exist only in the
 * throwaway CI or local database.
 */
async function correctiveActionPrerequisites(): Promise<void> {
  await as("platformAdmin", async (tx) => {
    const [r] = await tx<{ sanction: string; present: boolean }[]>`
      select (select authority_type from decision.action_authority_rule
              where item_type = 'DISCIPLINARY_SANCTION' and effective_from <= now()
                and (effective_to is null or effective_to > now())
              order by effective_from desc limit 1) as sanction,
             exists (select 1 from decision.action_authority_rule
                     where item_type = 'CORRECTIVE_ACTION' and effective_from <= now()
                       and (effective_to is null or effective_to > now())) as present`;
    if (!r!.present)
      await tx`select api.set_action_authority_rule('CORRECTIVE_ACTION', ${r!.sanction}::text, now(),
        'SOURCE_REQUIRED', 'Synthetic: test fixture rule.')`;
  });
  await as(
    "platformAdmin",
    (tx) => tx`select api.grant_role(${USERS.financeEmployee}, 'IMPLEMENTATION_OWNER',
      'Synthetic: implementation owner for the e2e check.')`,
  ).catch((e: unknown) => {
    if (!(e instanceof Error && e.message.includes("ROLE_ALREADY_ACTIVE"))) throw e;
  });
}

/** The meeting's open vote, as the secretary reads it; returns its id. */
async function openVoteId(m: MeetingFixture): Promise<string> {
  const open = (await meetingAs("icSecretary", m.meetingId)).deliberation?.vote_items.filter(
    (v) => v.status === "OPEN",
  );
  if (open?.length !== 1) throw new Error(`openVoteId: ${open?.length ?? 0} open votes`);
  return open[0]!.vote_item_id;
}

/** Legal Reviewer Pi reviews the adopted package and the secretary submits it to the authority its rules name. */
async function reviewedAndSubmitted(f: ProceedingFixture, packageId: string): Promise<void> {
  await opinionGiven(await legalReviewAsked(f, packageId));
  await submittedToAuthority(packageId);
}

/** The secretary records the CEO's approval of the package, from these source documents (the first is primary). */
async function ceoApproves(packageId: string, sources: readonly string[]): Promise<void> {
  await as(
    "icSecretary",
    (tx) => tx`
      select api.record_authority_decision(${packageId}, 'CEO', 'APPROVE_AS_RECOMMENDED', now(), 'Authority (synthetic)',
        ${sources[0]!}, null::jsonb, ${DECISION_REASON}, null::text, null::text, null::text,
        ${sources.length > 1 ? [...sources.slice(1)] : null}::text[], null::jsonb)`,
  );
}

/**
 * A corrective action frozen by a superseded decision (DEC-AMB-014), and the replacement decision that must say what
 * becomes of it. The demo committee adopts a package of one case-wide corrective action, Member B's vote deciding it
 * (without that vote it ties); after a legal review the CEO approves it and the case manager opens the action for
 * Employee Chi. Member A's concern about Member B is then upheld, the committee votes again without Member B and adopts
 * the package again, and after a second review the CEO approves it again from REPLACEMENT_SOURCES: the first decision is
 * superseded and the action frozen until a corrective-action manager of the case records its disposition. Fails unless
 * the demo committee holds its seats.
 */
export async function frozenAction(label: string): Promise<FrozenActionFixture> {
  await correctiveActionPrerequisites();
  const f = await proceedingMeeting(label);
  const { packageId, itemId } = await as("icSecretary", async (tx) => {
    const [p] = await tx<{ id: string }[]>`
      select api.create_recommendation_package(${f.committeeProceedingId}, 'PACKAGE') as id`;
    const [i] = await tx<{ id: string }[]>`
      select api.add_recommendation_item(${p!.id}, 'CORRECTIVE_ACTION', null, null,
        'Synthetic: strengthen the approval controls.', null, null, false, '{}'::uuid[], null) as id`;
    return { packageId: p!.id, itemId: i!.id };
  });
  await packageVoteOpened(f, packageId);
  const first = await openVoteId(f);
  await castVotes(first, [
    ["icChair", "APPROVE"],
    ["icDeputy", "ABSTAIN"],
    ["icMemberA", "REJECT"],
    ["icMemberB", "APPROVE"],
  ]);
  await closeVote(first);
  await adoptionRecorded(packageId);
  await reviewedAndSubmitted(f, packageId);
  await ceoApproves(packageId, ["MEMO-DEMO-2096-E2E-01"]);
  const [action] = await as(
    "caseManager",
    (tx) => tx<{ id: string }[]>`
      select api.open_corrective_action(${itemId}, ${FROZEN_ACTION.title}, ${FROZEN_ACTION.description},
        ${USERS.financeEmployee}, (now() at time zone 'Asia/Riyadh')::date + 30) as id`,
  );
  // Member B's vote decided the package: their upheld conflict sends it back to the committee without them.
  await decidedConcern(f, "icMemberA", "icMemberB", "UPHELD");
  await as("icSecretary", async (tx) => {
    await tx`select api.resolve_conflict_taint(${itemId}, 'RE_VOTE',
      'Synthetic: the committee votes again without the conflicted member.')`;
    await tx`select api.open_package_vote(${f.meetingId}, ${packageId})`;
  });
  const again = await openVoteId(f);
  await castVotes(again, [
    ["icChair", "APPROVE"],
    ["icDeputy", "APPROVE"],
    ["icMemberA", "APPROVE"],
  ]);
  await closeVote(again);
  await adoptionRecorded(packageId);
  await reviewedAndSubmitted(f, packageId);
  await ceoApproves(packageId, REPLACEMENT_SOURCES);
  return { ...f, packageId, itemId, actionId: action!.id };
}

/** The wording a modification gives the action. */
export const MODIFIED_ACTION = {
  title: "Synthetic: add a second approver above the threshold",
  description: "Synthetic: payments above the threshold need a second approver from Finance.",
} as const;

/**
 * A corrective-action manager of the case records the replacement decision's disposition of the frozen action (the
 * case manager, or the GRC Director as another manager), citing its primary document: a waiver, or a modification to
 * MODIFIED_ACTION. The reason is the manager's; no page shows it back (R3).
 */
export async function disposedAs(
  user: "caseManager" | "grcDirector",
  actionId: string,
  disposition: "WAIVE" | "MODIFY",
  reason: string,
): Promise<void> {
  const reword = disposition === "MODIFY";
  await as(
    user,
    (tx) => tx`
      select api.dispose_superseded_corrective_action(${actionId}, ${disposition}, ${REPLACEMENT_SOURCES[0]}, ${reason},
        ${reword ? MODIFIED_ACTION.title : null}::text, ${reword ? MODIFIED_ACTION.description : null}::text,
        null::uuid, null::date)`,
  );
}
