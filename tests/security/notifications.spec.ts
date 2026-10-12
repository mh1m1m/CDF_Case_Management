// Business architecture rebase, migration 1920 (ADR-025; owner Q&A Q29, Q41, Q90, Q98; AUTHORIZATION_IMPACT.md N18).
// Notifications commit with their domain event, carry a template code, ids and a deep link only, reach only their
// recipient, honour the rule layers (mandatory, committee default, event rule, user mute) and are delivered by email
// only through server-only functions the BFF login role holds.
import { beforeAll, describe, expect, it } from "vitest";
import {
  USERS,
  caseId,
  ownerScenario,
  scenario,
  type OwnerScenario,
  type Scenario,
  type UserKey,
} from "../support/db";
import { IC_SEATS, REASON, committeeIds, openWithPresent, scheduleMeeting, seat } from "../support/committee";

let caseB: string, caseR: string, ic: string, gc: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  caseR = await caseId("0003");
  ({ ic, gc } = await committeeIds());
});

const SEATS: [Parameters<typeof seat>[2][number][0], string][] = [
  ["committeeChair", "CHAIR"],
  ["committeeSecretary", "SECRETARY"],
  ["legal", "MEMBER"],
];

async function mine(s: Scenario, template?: string) {
  return s.tx<
    { template_code: string; channel: string; object_id: string; deep_link: string; status: string }[]
  >`
    select template_code, channel, object_id, deep_link, status from notify.outbox
    where ${template ?? null}::text is null or template_code = ${template ?? null} order by created_at`;
}

describe("notification content (N18)", () => {
  it("an outbox row holds a template code, ids and a deep link, nothing else", async () => {
    await ownerScenario(async (s) => {
      const columns = await s.tx<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_schema = 'notify' and table_name = 'outbox'
        order by ordinal_position`;
      expect(columns.map((c) => c.column_name)).toEqual([
        "id",
        "recipient_id",
        "template_code",
        "channel",
        "object_type",
        "object_id",
        "deep_link",
        "dedupe_key",
        "status",
        "attempts",
        "created_at",
        "delivered_at",
        "read_at",
      ]);
      const templates = await s.tx<{ code: string }[]>`select code from notify.template`;
      for (const t of templates) expect(t.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    });
  });

  it("free text cannot be smuggled into a deep link, and the facts of a row never change", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, SEATS);
      await s.asOwner();
      const [row] = await s.tx<{ id: string }[]>`
        select id from notify.outbox where recipient_id = ${USERS.legal} and channel = 'IN_APP' limit 1`;
      await s.expectError(
        "new row for relation",
        (tx) =>
          tx`insert into notify.outbox (recipient_id, template_code, channel, object_type, object_id, deep_link, dedupe_key,
             status, delivered_at)
           values (${USERS.legal}, 'MEETING_INVITATION', 'IN_APP', 'MEETING', gen_random_uuid(),
             '/meetings/x?name=Employee Sigma', 'probe', 'SENT', now())`,
      );
      await s.expectError(
        "notify.outbox facts are immutable",
        (tx) => tx`update notify.outbox set deep_link = '/meetings/other' where id = ${row!.id}`,
      );
      await s.expectError(
        "notify.outbox rows cannot be deleted",
        (tx) => tx`delete from notify.outbox where id = ${row!.id}`,
      );
    });
  });
});

describe("delivery to the recipient only", () => {
  it("a scheduled meeting notifies each participating user; nobody else sees it (Q41)", async () => {
    await scenario(async (s) => {
      await seat(s, ic, SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      for (const user of ["committeeChair", "legal"] as const) {
        await s.as(user);
        const rows = await mine(s, "MEETING_INVITATION");
        expect(rows).toEqual([
          {
            template_code: "MEETING_INVITATION",
            channel: "IN_APP",
            object_id: f.meeting,
            deep_link: `/meetings/${f.meeting}`,
            status: "SENT",
          },
        ]);
        expect(await mine(s, "COMMITTEE_SEAT_ASSIGNED")).toHaveLength(1);
      }
      // Email rows are invisible to everyone, including their recipient; outsiders see nothing at all.
      await s.as("legal");
      expect(await s.tx`select id from notify.outbox where channel = 'EMAIL'`).toEqual([]);
      for (const user of ["investigatorA", "platformAdmin", "dpo", "internalAudit"] as const) {
        await s.as(user);
        expect(await mine(s), user).toEqual([]);
      }
    });
  });

  it("a recipient marks their own notification read; another user's answers NOT_FOUND", async () => {
    await scenario(async (s) => {
      await seat(s, ic, SEATS);
      await s.as("legal");
      const [n] = await s.tx<{ id: string }[]>`select id from notify.outbox limit 1`;
      await s.as("committeeChair");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.mark_notification_read(${n!.id})`);
      await s.as("legal");
      await s.tx`select api.mark_notification_read(${n!.id})`;
      const [r] = await s.tx<
        { read: boolean }[]
      >`select read_at is not null as read from notify.outbox where id = ${n!.id}`;
      expect(r!.read).toBe(true);
    });
  });

  it("a defence notice reaches only its own subject's linked account (Q90)", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      const subjects: Record<string, string> = {};
      for (const [key, label, user] of [
        ["sigma", "Employee Sigma (synthetic)", USERS.employee],
        ["tau", "Employee Tau (synthetic)", USERS.employeeB],
      ] as const) {
        const [subj] = await s.tx<{ id: string }[]>`
          select api.add_case_subject(${caseB}, ${label}, 'EMPLOYEE', null) as id`;
        const [a] = await s.tx<{ id: string }[]>`
          select api.add_allegation(${caseB}, 'FRAUD', ${"Synthetic: allegation against " + label + "."}, ${subj!.id}, null, null) as id`;
        await s.tx`select api.link_subject_portal_account(${subj!.id}, ${user}, ${REASON})`;
        subjects[key] = subj!.id;
        subjects[key + "A"] = a!.id;
      }
      const [n] = await s.tx<{ id: string }[]>`
        select api.issue_defence_notice(${subjects.sigma!}, 'Synthetic: you are invited to respond.',
          ${[subjects.sigmaA!]}::uuid[], now() + interval '1 day') as id`;
      await s.as("employee");
      expect(await mine(s, "DEFENCE_NOTICE_ISSUED")).toEqual([
        {
          template_code: "DEFENCE_NOTICE_ISSUED",
          channel: "IN_APP",
          object_id: n!.id,
          deep_link: `/my-defence/${n!.id}`,
          status: "SENT",
        },
      ]);
      await s.as("employeeB");
      expect(await mine(s)).toEqual([]);
    });
  });
});

describe("rule layers (ADR-025)", () => {
  it("a user mutes an optional notification but never a mandatory one", async () => {
    await scenario(async (s) => {
      await s.as("legal");
      await s.tx`select api.set_notification_preference('COMMITTEE_SEAT_ASSIGNED', 'IN_APP', true)`;
      await s.expectError(
        "CDF_CONFLICT:MANDATORY_NOTIFICATION",
        (tx) => tx`select api.set_notification_preference('MEETING_INVITATION', 'IN_APP', true)`,
      );
      await s.expectError(
        "CDF_INVALID:template_code",
        (tx) => tx`select api.set_notification_preference('NO_SUCH_TEMPLATE', 'IN_APP', true)`,
      );
      await seat(s, ic, SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await s.as("legal");
      expect(await mine(s, "COMMITTEE_SEAT_ASSIGNED")).toEqual([]);
      expect((await mine(s, "MEETING_INVITATION")).map((r) => r.object_id)).toEqual([f.meeting]);
      await s.as("committeeChair");
      expect(await mine(s, "COMMITTEE_SEAT_ASSIGNED")).toHaveLength(1);
      expect(await s.tx`select user_id from notify.preference`).toEqual([]);
    });
  });

  it("only NOTIFICATION_ADMIN sets rules; a committee default overrides the event rule for that committee only", async () => {
    await scenario(async (s) => {
      const rule = (layer: string, committee: string | null) =>
        s.tx`select api.set_notification_rule(${layer}, 'COMMITTEE_SEAT_ASSIGNED', ${committee}, 'IN_APP', false, now(),
          ${REASON}) as id`;
      for (const user of ["committeeSecretary", "grcDirector", "caseManager"] as const) {
        await s.as(user);
        await s.expectError("CDF_FORBIDDEN", () => rule("COMMITTEE_DEFAULT", gc));
      }
      await s.as("platformAdmin");
      await s.expectError("CDF_INVALID:layer", () => rule("SYSTEM_MANDATORY", null));
      await s.expectError("CDF_INVALID:committee_id", () => rule("COMMITTEE_DEFAULT", null));
      await s.expectError("CDF_INVALID:committee_id", () => rule("EVENT_RULE", gc));
      await rule("COMMITTEE_DEFAULT", gc);
      await seat(s, gc, [["investigatorA", "MEMBER"]]);
      await seat(s, ic, [["lead", "MEMBER"]]);
      await s.as("investigatorA");
      expect(await mine(s, "COMMITTEE_SEAT_ASSIGNED")).toEqual([]);
      await s.as("lead");
      expect(await mine(s, "COMMITTEE_SEAT_ASSIGNED")).toEqual([
        {
          template_code: "COMMITTEE_SEAT_ASSIGNED",
          channel: "IN_APP",
          object_id: ic,
          deep_link: `/committees/${ic}`,
          status: "SENT",
        },
      ]);
    });
  });
});

/**
 * Back to the BFF login role itself, which the delivery job connects as: on the BFF connection, `reset role` leaves
 * `authenticated`. (The owner cannot assume cdf_bff on a Supabase stack, where it is not a superuser.)
 */
async function asBffLogin(s: Scenario) {
  await s.tx`reset role`;
  await s.tx`select set_config('request.jwt.claims', '', true)`;
}

describe("server-only email delivery and reminders", () => {
  it("authenticated and anon cannot claim, settle or schedule; the BFF login role can", async () => {
    await scenario(async (s) => {
      for (const user of ["platformAdmin", null] as const) {
        await s.as(user);
        await s.expectError("permission denied", (tx) => tx`select * from notify.claim_email_batch(10)`);
        await s.expectError(
          "permission denied",
          (tx) => tx`select notify.record_email_delivery(gen_random_uuid(), true)`,
        );
        await s.expectError("permission denied", (tx) => tx`select notify.emit_due_reminders()`);
      }
    });
  });

  it("the sender sees recipient, template and link only; delivery settles, failures give up after five attempts", async () => {
    await scenario(async (s) => {
      await seat(s, ic, SEATS);
      await scheduleMeeting(s, ic, caseB);
      await asBffLogin(s);
      const batch = await s.tx<
        { id: string; recipient_id: string; template_code: string; deep_link: string }[]
      >`
        select * from notify.claim_email_batch(100)`;
      expect(batch.length).toBeGreaterThan(0);
      expect(Object.keys(batch[0]!).sort()).toEqual([
        "attempts",
        "deep_link",
        "id",
        "recipient_id",
        "template_code",
      ]);
      // Only mandatory templates email by default.
      expect(new Set(batch.map((b) => b.template_code))).toEqual(new Set(["MEETING_INVITATION"]));
      const [first, second] = batch;
      expect(
        (await s.tx<{ s: string }[]>`select notify.record_email_delivery(${first!.id}, true) as s`)[0]!.s,
      ).toBe("SENT");
      await s.expectError(
        "unknown or settled notification",
        (tx) => tx`select notify.record_email_delivery(${first!.id}, true)`,
      );
      let status = "";
      for (let i = 0; i < 5; i++) {
        if (i > 0) await s.tx`select * from notify.claim_email_batch(100)`;
        status = (
          await s.tx<{ s: string }[]>`select notify.record_email_delivery(${second!.id}, false) as s`
        )[0]!.s;
      }
      expect(status).toBe("FAILED");
    });
  });

  it("a defence response due within two days is reminded once", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      const [subj] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseB}, 'Employee Sigma (synthetic)', 'EMPLOYEE', null) as id`;
      const [a] = await s.tx<{ id: string }[]>`
        select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: allegation.', ${subj!.id}, null, null) as id`;
      await s.tx`select api.link_subject_portal_account(${subj!.id}, ${USERS.employee}, ${REASON})`;
      await s.tx`select api.issue_defence_notice(${subj!.id}, 'Synthetic: you are invited to respond.',
        ${[a!.id]}::uuid[], now() + interval '1 day')`;
      await s.tx`select api.issue_defence_notice(${subj!.id}, 'Synthetic: a later notice.',
        ${[a!.id]}::uuid[], now() + interval '10 days')`;
      await asBffLogin(s);
      expect((await s.tx<{ n: number }[]>`select notify.emit_due_reminders() as n`)[0]!.n).toBe(1);
      expect((await s.tx<{ n: number }[]>`select notify.emit_due_reminders() as n`)[0]!.n).toBe(0);
      await s.as("employee");
      expect(await mine(s, "DEFENCE_DUE_REMINDER")).toHaveLength(1);
    });
  });
});

// AGENT-09 review of 1920 (adopted from its probe): every notification row goes to someone who can open its object.
const BY_ID = Object.fromEntries(Object.entries(USERS).map(([k, v]) => [v, k])) as Record<string, UserKey>;
const VISIBLE: Record<string, string> = {
  COMMITTEE: "select count(*)::int as n from committee.committee where id = $1",
  MEETING: "select count(*)::int as n from committee.meeting where id = $1",
  MINUTES: "select count(*)::int as n from committee.minutes where id = $1",
  LEGAL_REVIEW: "select count(*)::int as n from decision.legal_review_request where id = $1",
  DEFENCE_NOTICE: "select count(*)::int as n from grievance.defence_notice where id = $1",
  GRIEVANCE: "select count(*)::int as n from grievance.grievance where id = $1",
  EXPORT: "select count(*)::int as n from exchange.export_request where id = $1",
  CORRECTIVE_ACTION: "select count(*)::int as n from decision.corrective_action where id = $1",
  BCP_IMPORT: "select count(*)::int as n from exchange.bcp_import_batch where id = $1",
};

async function outbox(s: OwnerScenario) {
  await s.asOwner();
  return s.tx<{ recipient_id: string; template_code: string; object_type: string; object_id: string }[]>`
    select recipient_id, template_code, object_type, object_id from notify.outbox order by created_at`;
}

async function expectRecipientsSeeObjects(s: OwnerScenario) {
  for (const r of await outbox(s)) {
    await s.as(BY_ID[r.recipient_id]!);
    const [v] = await s.tx.unsafe<{ n: number }[]>(VISIBLE[r.object_type]!, [r.object_id]);
    expect(v!.n, `${BY_ID[r.recipient_id]} ${r.template_code}`).toBe(1);
  }
  await s.asOwner();
}

async function received(s: OwnerScenario, template: string): Promise<string[]> {
  const rows = (await outbox(s)).filter((r) => r.template_code === template);
  return [...new Set(rows.map((r) => `${r.object_id}:${BY_ID[r.recipient_id]!}`))].map(
    (k) => k.split(":")[1]!,
  );
}

async function declareCaseConflict(s: OwnerScenario, caseIdValue: string, user: UserKey) {
  await s.asOwner();
  await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
             values (${caseIdValue}, ${USERS[user]}, 'CONFLICT_DECLARED', 'Synthetic declared conflict')`;
}

describe("AGENT-09 review of 1920", () => {
  it("restricted referral: excluded seats and uncleared invitees are never notified", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, [
        ["grcSectorHead", "CHAIR"],
        ["grcDeputy", "SECRETARY"],
        ["committee", "MEMBER"],
        ["legal", "MEMBER"],
        ["committeeSecretary", "ALTERNATE_SECRETARY"],
      ]);
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_committee_referral(${caseR}, ${ic}, ${REASON})`;
      const [cp] = await s.tx<{ id: string }[]>`
        select api.refer_case_to_committee(${caseR}, ${ic}, null, ${REASON}) as id`;
      await s.as("grcDeputy");
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp!.id}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 2 hours', ${REASON}) as id`;
      await s.tx`savepoint invite`;
      await s.tx`select api.invite_to_meeting(${m!.id}, 'EXPERT', ${USERS.investigatorA}, null, true, ${REASON})`.catch(
        async () => s.tx`rollback to savepoint invite`,
      );
      await s.tx`select api.cancel_meeting(${m!.id}, ${REASON})`;
      expect(await received(s, "MEETING_CANCELLED")).not.toContain("investigatorA");
      await expectRecipientsSeeObjects(s);
    });
  });

  it("N1: a conflicted or uncleared Grievance Committee secretary is not told of a grievance", async () => {
    await ownerScenario(async (s) => {
      await declareCaseConflict(s, caseB, "committeeSecretary");
      await seat(s, gc, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["grcDeputy", "ALTERNATE_SECRETARY"],
        ["investigatorA", "MEMBER"],
      ]);
      await s.as("caseManager");
      const [subj] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseB}, 'Employee Sigma (synthetic)', 'EMPLOYEE', null) as id`;
      const [l] = await s.tx<{ id: string }[]>`
        select api.link_subject_portal_account(${subj!.id}, ${USERS.employee}, ${REASON}) as id`;
      await s.as("employee");
      await s.tx`select api.file_grievance(${l!.id}, now() - interval '5 days', 'Synthetic: grievance grounds.')`;
      expect(await received(s, "GRIEVANCE_RECEIVED")).toEqual(["grcDeputy"]);
      // The CONFIDENTIAL-cleared secretary is not told of a grievance recorded on the SECRET restricted case.
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_grievance_recording(${caseR}, ${USERS.grcDeputy}, ${REASON})`;
      await s.as("grcDeputy");
      await s.tx`select api.record_grievance('LINKED', 'CDF-DEMO-2026-0003', 'Grievant Phi (synthetic)', null, null, null,
        'EMAIL', now(), now() - interval '3 days', 'Synthetic: grievance grounds text.', 'EMAIL-DEMO-0009')`;
      // The approved recorder records it themselves; nobody else on the committee is told of the restricted case.
      expect(await received(s, "GRIEVANCE_RECEIVED")).toEqual(["grcDeputy"]);
      await expectRecipientsSeeObjects(s);
    });
  });

  it("N2: a cancelled meeting is not announced to a meeting-conflicted or case-conflicted participant", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await s.as("legal");
      await s.tx`select api.declare_meeting_conflict(${f.participant.legal!}, 'CONFLICT_DECLARED', 'Synthetic: conflict.')`;
      await declareCaseConflict(s, caseB, "legalB");
      await s.as("committeeSecretary");
      await s.tx`select api.cancel_meeting(${f.meeting}, ${REASON})`;
      const cancelled = await received(s, "MEETING_CANCELLED");
      expect(cancelled).toContain("committeeChair");
      expect(cancelled).not.toContain("legal");
      expect(cancelled).not.toContain("legalB");
      // legalB's earlier invitation stays in their list; it carries no content and its meeting now answers NOT_FOUND.
    });
  });

  it("a member conflicted after referral and before scheduling is not invited", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      await declareCaseConflict(s, caseB, "legalB");
      await scheduleMeeting(s, ic, caseB);
      expect(await received(s, "MEETING_INVITATION")).not.toContain("legalB");
      await expectRecipientsSeeObjects(s);
    });
  });

  it("a suspended user receives nothing", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      await s.asOwner();
      await s.tx`update iam.user_profile set status = 'SUSPENDED' where id = ${USERS.legalB}`;
      await s.as("caseManager");
      const [subj] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseB}, 'Employee Sigma (synthetic)', 'EMPLOYEE', null) as id`;
      const [a] = await s.tx<{ id: string }[]>`
        select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: allegation.', ${subj!.id}, null, null) as id`;
      await s.tx`select api.link_subject_portal_account(${subj!.id}, ${USERS.employee}, ${REASON})`;
      await s.asOwner();
      await s.tx`update iam.user_profile set status = 'SUSPENDED' where id = ${USERS.employee}`;
      await s.as("caseManager");
      await s.tx`select api.issue_defence_notice(${subj!.id}, 'Synthetic: you are invited to respond.',
        ${[a!.id]}::uuid[], now() + interval '1 day')`;
      expect(await received(s, "DEFENCE_NOTICE_ISSUED")).toEqual([]);
    });
  });

  it("minutes review requests go only to members recorded present, never to an absent member or the secretary", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await openWithPresent(s, f, ["committeeChair", "legal", "lead"]);
      await s.tx`select api.record_attendance(${f.participant.legalB!}, 'ABSENT')`;
      await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
      await s.tx`select api.generate_minutes(${f.meeting}, 'Synthetic minutes narrative.')`;
      expect((await received(s, "MINUTES_REVIEW_REQUESTED")).sort()).toEqual([
        "committeeChair",
        "lead",
        "legal",
      ]);
    });
  });

  it("a defence notice is not sent to a revoked portal link", async () => {
    await ownerScenario(async (s) => {
      await s.as("caseManager");
      const [subj] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseB}, 'Employee Sigma (synthetic)', 'EMPLOYEE', null) as id`;
      const [a] = await s.tx<{ id: string }[]>`
        select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: allegation.', ${subj!.id}, null, null) as id`;
      const [l] = await s.tx<{ id: string }[]>`
        select api.link_subject_portal_account(${subj!.id}, ${USERS.employee}, ${REASON}) as id`;
      await s.tx`select api.revoke_subject_portal_link(${l!.id}, ${REASON})`;
      await s.tx`select api.issue_defence_notice(${subj!.id}, 'Synthetic: you are invited to respond.',
        ${[a!.id]}::uuid[], now() + interval '1 day')`;
      expect(await received(s, "DEFENCE_NOTICE_ISSUED")).toEqual([]);
    });
  });
});
