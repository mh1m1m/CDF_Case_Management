// Business architecture rebase, migration 1920 (ADR-025; owner Q&A Q29, Q41, Q90, Q98; AUTHORIZATION_IMPACT.md N18).
// Notifications commit with their domain event, carry a template code, ids and a deep link only, reach only their
// recipient, honour the rule layers (mandatory, committee default, event rule, user mute) and are delivered by email
// only through server-only functions the BFF login role holds.
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, caseId, ownerScenario, scenario, type Scenario } from "../support/db";
import { REASON, committeeIds, scheduleMeeting, seat } from "../support/committee";

let caseB: string, ic: string, gc: string;

beforeAll(async () => {
  caseB = await caseId("0002");
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
    await ownerScenario(async (s) => {
      await seat(s, ic, SEATS);
      await scheduleMeeting(s, ic, caseB);
      await s.asOwner();
      await s.tx.unsafe("set local role cdf_bff");
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
    await ownerScenario(async (s) => {
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
      await s.asOwner();
      await s.tx.unsafe("set local role cdf_bff");
      expect((await s.tx<{ n: number }[]>`select notify.emit_due_reminders() as n`)[0]!.n).toBe(1);
      expect((await s.tx<{ n: number }[]>`select notify.emit_due_reminders() as n`)[0]!.n).toBe(0);
      await s.as("employee");
      expect(await mine(s, "DEFENCE_DUE_REMINDER")).toHaveLength(1);
    });
  });
});
