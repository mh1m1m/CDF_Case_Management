// §23, threats T01–T05, T21: the anonymous portal can submit and follow up on its own report only,
// never learns whether another Report ID exists, and is rate-limited per Report ID.
import { describe, expect, it } from "vitest";
import { admin, newReportRef, newSecret, portal, portalScenario, secretHmac } from "../support/db";
import type { Tx } from "@cdf/infrastructure";

const DESCRIPTION = "SYNTHETIC: Employee Alpha allegedly shared tender prices with Vendor Omega.";

/** Synthetic identified-mode vault payload (Drive fields 4–12). */
export const IDENTIFIED = {
  given_name: "Reporter",
  father_name: "Sigma",
  grandfather_name: "Synthetic",
  family_name: "Example",
  gender: "MALE",
  birth_date: "1410-09-20",
  birth_date_calendar: "HIJRI",
  id_type: "IQAMA",
  id_number: "2000000002",
  city: "JEDDAH",
  nationality: "EG",
  phone: "+966 500000002",
  email: "reporter.sigma@example.test",
  preferred_contact: "PHONE",
};

type Mode = "ANONYMOUS" | "EMAIL_ONLY" | "IDENTIFIED";

/** Calls the portal command with the Drive field set; `over` replaces individual arguments. */
function submitSql(
  tx: Tx,
  o: {
    ref?: string;
    hmac?: string;
    mode?: Mode;
    relationship?: string | null;
    relationshipOther?: string | null;
    category?: string | null;
    categoryOther?: string | null;
    subject?: string | null;
    description?: string;
    date?: string | null;
    time?: string | null;
    location?: string | null;
    cooperate?: boolean | null;
    identity?: object | null;
  } = {},
) {
  const v = {
    ref: newReportRef(),
    hmac: secretHmac("x"),
    mode: "ANONYMOUS" as Mode,
    relationship: "EMPLOYEE",
    relationshipOther: null,
    category: "IRREGULAR_TRANSACTIONS",
    categoryOther: null,
    subject: "Employee Alpha (synthetic)",
    description: DESCRIPTION,
    date: "2026-09-01",
    time: "09:30",
    location: "Procurement department (synthetic)",
    cooperate: true,
    identity: null,
    ...o,
  };
  return tx<{ report_ref: string }[]>`
    select * from public_api.submit_report(${v.ref}, ${v.hmac}, ${v.mode}, ${v.relationship}, ${v.relationshipOther},
      ${v.category}, ${v.categoryOther}, ${v.subject}, ${v.description}, ${v.date}, ${v.time}, ${v.location},
      ${v.cooperate}, 'en', ${v.identity === null ? null : tx.json(v.identity as never)})`;
}

async function submit(tx: Tx, mode: Mode = "ANONYMOUS", identity: object | null = null) {
  const secret = newSecret();
  const [row] = await submitSql(tx, { hmac: secretHmac(secret), mode, identity });
  return { ref: row!.report_ref, secret };
}

describe("public portal", () => {
  it("the portal login can never become authenticated or read tables", async () => {
    await expect(portal.begin((tx) => tx`set local role authenticated`)).rejects.toThrow(/permission denied/);
    await expect(portal.begin((tx) => tx`set local role service_role`)).rejects.toThrow(/permission denied/);
    await expect(portal`select * from intake.report`).rejects.toThrow(/permission denied/);
    await expect(
      portal.begin(async (tx) => {
        await tx`set local role anon`;
        await tx`select * from intake.report`;
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      portal.begin(async (tx) => {
        await tx`set local role anon`;
        await tx`select api.open_case(gen_random_uuid())`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("submits an anonymous report and follows up with Report ID + secret", async () => {
    await portalScenario(async (tx) => {
      const { ref, secret } = await submit(tx);
      const [status] = await tx<{ s: { status: string; messages: unknown[]; can_reply: boolean } }[]>`
        select public_api.get_report_status(${ref}, ${secretHmac(secret)}) as s`;
      expect(status!.s).toMatchObject({ report_ref: ref, status: "RECEIVED", messages: [], can_reply: true });
      const [posted] = await tx<
        { ok: boolean }[]
      >`select public_api.post_reporter_message(${ref}, ${secretHmac(secret)}, 'Synthetic follow-up') as ok`;
      expect(posted!.ok).toBe(true);
    });
  });

  it("a wrong secret and an unknown Report ID are indistinguishable", async () => {
    await portalScenario(async (tx) => {
      const { ref } = await submit(tx);
      const [wrong] = await tx`select public_api.get_report_status(${ref}, ${secretHmac("wrong")}) as s`;
      const [unknown] =
        await tx`select public_api.get_report_status(${newReportRef()}, ${secretHmac("wrong")}) as s`;
      const [malformed] = await tx`select public_api.get_report_status('not-a-ref', 'zz') as s`;
      expect(wrong).toEqual({ s: null });
      expect(unknown).toEqual({ s: null });
      expect(malformed).toEqual({ s: null });
      const [post] =
        await tx`select public_api.post_reporter_message(${ref}, ${secretHmac("wrong")}, 'x') as ok`;
      expect(post).toEqual({ ok: false });
    });
  });

  it("locks a Report ID after 10 failed attempts, even for the right secret", async () => {
    await portalScenario(async (tx) => {
      const { ref, secret } = await submit(tx);
      for (let i = 0; i < 11; i++)
        await tx`select public_api.get_report_status(${ref}, ${secretHmac("guess" + i)})`;
      const [locked] = await tx`select public_api.get_report_status(${ref}, ${secretHmac(secret)}) as s`;
      expect(locked).toEqual({ s: null });
    });
  });

  it("stores identified reporters only in the vault and keeps identity out of the audit trail", async () => {
    // Committed on purpose: the vault and ledger are inspected with the owner connection.
    const committed = await portal.begin(async (tx) => {
      await tx`set local role anon`;
      return submit(tx, "IDENTIFIED", IDENTIFIED);
    });
    const ref = committed.ref;
    const [report] = await admin<{ reporter_mode: string; wb_id: string; row: string }[]>`
      select reporter_mode, wb_id, to_jsonb(r)::text as row from intake.report r where report_ref = ${ref}`;
    expect(report!.reporter_mode).toBe("IDENTIFIED");
    // No identity value reaches the report row.
    for (const value of Object.values(IDENTIFIED)) {
      if (["MALE", "HIJRI", "IQAMA", "JEDDAH", "EG", "PHONE"].includes(value)) continue;
      expect(report!.row).not.toContain(value);
    }
    const [vault] = await admin`
      select full_name, given_name, family_name, gender, birth_date, birth_date_calendar, id_type, id_number, city,
             nationality, phone, email, preferred_contact
      from protected_identity.reporter_identity where wb_id = ${report!.wb_id}`;
    expect(vault).toEqual({
      full_name: "Reporter Sigma Synthetic Example",
      given_name: "Reporter",
      family_name: "Example",
      gender: "MALE",
      birth_date: "1410-09-20",
      birth_date_calendar: "HIJRI",
      id_type: "IQAMA",
      id_number: "2000000002",
      city: "JEDDAH",
      nationality: "EG",
      phone: "+966 500000002",
      email: "reporter.sigma@example.test",
      preferred_contact: "PHONE",
    });
    const leaked = await admin`
      select seq from audit.audit_event
      where metadata::text ~* '(sigma|2000000002|1410-09-20)' or coalesce(reason, '') ~* '(sigma|2000000002)'`;
    expect(leaked).toEqual([]);
    const [event] = await admin<{ actor_type: string; actor_id: string | null }[]>`
      select actor_type, actor_id from audit.audit_event where action = 'REPORT_SUBMITTED' and metadata->>'report_ref' = ${ref}`;
    expect(event).toEqual({ actor_type: "ANONYMOUS_REPORTER", actor_id: null });
  });

  it("email-only mode keeps just the email, and only in the vault", async () => {
    const committed = await portal.begin(async (tx) => {
      await tx`set local role anon`;
      // Extra identity keys sent in email-only mode are ignored, never stored.
      return submit(tx, "EMAIL_ONLY", {
        email: "Reporter.Tau@Example.test",
        given_name: "Tau",
        id_number: "1000000099",
      });
    });
    const [report] = await admin<{ reporter_mode: string; wb_id: string; row: string }[]>`
      select reporter_mode, wb_id, to_jsonb(r)::text as row from intake.report r where report_ref = ${committed.ref}`;
    expect(report!.reporter_mode).toBe("EMAIL_ONLY");
    expect(report!.row).not.toMatch(/reporter\.tau/i);
    const [vault] = await admin`
      select email, preferred_contact, full_name, given_name, id_number, phone
      from protected_identity.reporter_identity where wb_id = ${report!.wb_id}`;
    expect(vault).toEqual({
      email: "reporter.tau@example.test",
      preferred_contact: "EMAIL",
      full_name: null,
      given_name: null,
      id_number: null,
      phone: null,
    });
    const leaked = await admin`select seq from audit.audit_event where metadata::text ~* 'reporter\.tau'`;
    expect(leaked).toEqual([]);
  });

  it("anonymous reports store nothing in the vault and refuse identity values", async () => {
    await portalScenario(async (tx) => {
      await expect(
        tx.savepoint((sp) => submitSql(sp, { identity: { email: "reporter.x@example.test" } })),
      ).rejects.toThrow("CDF_INVALID:identity");
    });
    const committed = await portal.begin(async (tx) => {
      await tx`set local role anon`;
      return submit(tx);
    });
    const vault = await admin`
      select 1 from protected_identity.reporter_identity i
      join intake.report r on r.wb_id = i.wb_id where r.report_ref = ${committed.ref}`;
    expect(vault).toEqual([]);
  });

  it("validates input in the database as well as in the portal", async () => {
    const cases: [Parameters<typeof submitSql>[1], string][] = [
      [{ category: "NOT_A_CATEGORY" }, "CDF_INVALID:category"],
      [{ category: "FRAUD" }, "CDF_INVALID:category"],
      [{ description: "too short" }, "CDF_INVALID:description"],
      [{ ref: "WB-0000000000O0" }, "CDF_INVALID:report_ref"],
      [{ mode: "PSEUDONYMOUS" as Mode }, "CDF_INVALID:reporter_mode"],
      [{ relationship: null }, "CDF_INVALID:relationship"],
      [{ subject: null }, "CDF_INVALID:subject_description"],
      [{ location: " " }, "CDF_INVALID:location"],
      [{ date: null }, "CDF_INVALID:incident_date"],
      [{ date: "2999-01-01" }, "CDF_INVALID:incident_date"],
      [{ time: null }, "CDF_INVALID:incident_time"],
      [{ cooperate: null }, "CDF_INVALID:willing_to_cooperate"],
      [{ mode: "EMAIL_ONLY", identity: {} }, "CDF_INVALID:email"],
      [{ mode: "EMAIL_ONLY", identity: { email: "not-an-email" } }, "CDF_INVALID:email"],
      [{ mode: "IDENTIFIED", identity: { ...IDENTIFIED, family_name: "" } }, "CDF_INVALID:full_name"],
      [{ mode: "IDENTIFIED", identity: { ...IDENTIFIED, gender: "X" } }, "CDF_INVALID:gender"],
      [
        { mode: "IDENTIFIED", identity: { ...IDENTIFIED, birth_date: "1470-01-01" } },
        "CDF_INVALID:birth_date",
      ],
      [
        {
          mode: "IDENTIFIED",
          identity: { ...IDENTIFIED, birth_date_calendar: "GREGORIAN", birth_date: "2001-02-30" },
        },
        "CDF_INVALID:birth_date",
      ],
      [{ mode: "IDENTIFIED", identity: { ...IDENTIFIED, id_number: "1000000002" } }, "CDF_INVALID:id_number"],
      [{ mode: "IDENTIFIED", identity: { ...IDENTIFIED, city: "riyadh;" } }, "CDF_INVALID:city"],
      [{ mode: "IDENTIFIED", identity: { ...IDENTIFIED, nationality: "SAU" } }, "CDF_INVALID:nationality"],
      [{ mode: "IDENTIFIED", identity: { ...IDENTIFIED, phone: "" } }, "CDF_INVALID:phone"],
      [{ mode: "IDENTIFIED", identity: { ...IDENTIFIED, email: "" } }, "CDF_INVALID:email"],
    ];
    await portalScenario(async (tx) => {
      for (const [over, message] of cases) {
        await expect(tx.savepoint((sp) => submitSql(sp, over))).rejects.toThrow(message);
      }
    });
  });

  it("keeps conditional 'other' texts only when Other is chosen", async () => {
    const refs = await portal.begin(async (tx) => {
      await tx`set local role anon`;
      const [a] = await submitSql(tx, {
        relationship: "OTHER",
        relationshipOther: "Volunteer (synthetic)",
        category: "OTHER",
        categoryOther: "Misuse of sponsorship (synthetic)",
      });
      const [b] = await submitSql(tx, {
        relationship: "SUPPLIER",
        relationshipOther: "should be dropped",
        categoryOther: "should be dropped",
      });
      return [a!.report_ref, b!.report_ref];
    });
    const rows = await admin`
      select report_ref, relationship_to_fund, relationship_other, category, category_other,
             to_char(incident_time, 'HH24:MI') as incident_time, willing_to_cooperate
      from intake.report where report_ref = any(${refs}) order by report_ref = ${refs[0]!} desc`;
    expect(rows).toEqual([
      {
        report_ref: refs[0],
        relationship_to_fund: "OTHER",
        relationship_other: "Volunteer (synthetic)",
        category: "OTHER",
        category_other: "Misuse of sponsorship (synthetic)",
        incident_time: "09:30",
        willing_to_cooperate: true,
      },
      {
        report_ref: refs[1],
        relationship_to_fund: "SUPPLIER",
        relationship_other: null,
        category: "IRREGULAR_TRANSACTIONS",
        category_other: null,
        incident_time: "09:30",
        willing_to_cooperate: true,
      },
    ]);
  });

  it("the reporter sees a coarse status, never internal workflow state", async () => {
    const { ref, secret } = await portal.begin(async (tx) => {
      await tx`set local role anon`;
      return submit(tx);
    });
    await portalScenario(async (tx) => {
      const [row] = await tx<
        { s: Record<string, unknown> }[]
      >`select public_api.get_report_status(${ref}, ${secretHmac(secret)}) as s`;
      expect(Object.keys(row!.s).sort()).toEqual([
        "can_reply",
        "messages",
        "received_at",
        "report_ref",
        "status",
        "status_changed_at",
      ]);
      expect(["RECEIVED", "IN_PROGRESS", "INFORMATION_REQUESTED", "CLOSED"]).toContain(row!.s.status);
    });
  });
});
