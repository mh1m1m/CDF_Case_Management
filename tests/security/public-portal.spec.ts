// §23, threats T01–T05, T21: the anonymous portal can submit and follow up on its own report only,
// never learns whether another Report ID exists, and is rate-limited per Report ID.
import { describe, expect, it } from "vitest";
import { admin, newReportRef, newSecret, portal, portalScenario, secretHmac } from "../support/db";
import type { Tx } from "@cdf/infrastructure";

const DESCRIPTION = "SYNTHETIC: Employee Alpha allegedly shared tender prices with Vendor Omega.";

async function submit(tx: Tx, identity: object | null = null) {
  const ref = newReportRef();
  const secret = newSecret();
  const [row] = await tx<{ report_ref: string }[]>`
    select * from public_api.submit_report(${ref}, ${secretHmac(secret)}, 'PROCUREMENT', null, ${DESCRIPTION},
      null, null, 'en', ${identity === null ? null : tx.json(identity as never)})`;
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
      return submit(tx, { full_name: "Reporter Sigma (synthetic)", email: "reporter.sigma@example.test" });
    });
    const ref = committed.ref;
    const [report] = await admin<
      { reporter_mode: string; wb_id: string }[]
    >`select reporter_mode, wb_id from intake.report where report_ref = ${ref}`;
    expect(report!.reporter_mode).toBe("IDENTIFIED");
    const [vault] =
      await admin`select full_name from protected_identity.reporter_identity where wb_id = ${report!.wb_id}`;
    expect(vault).toEqual({ full_name: "Reporter Sigma (synthetic)" });
    const leaked =
      await admin`select seq from audit.audit_event where metadata::text ~* 'sigma' or coalesce(reason, '') ~* 'sigma'`;
    expect(leaked).toEqual([]);
    const [event] = await admin<{ actor_type: string; actor_id: string | null }[]>`
      select actor_type, actor_id from audit.audit_event where action = 'REPORT_SUBMITTED' and metadata->>'report_ref' = ${ref}`;
    expect(event).toEqual({ actor_type: "ANONYMOUS_REPORTER", actor_id: null });
  });

  it("validates input in the database as well as in the portal", async () => {
    await portalScenario(async (tx) => {
      await expect(
        tx.savepoint(
          (sp) =>
            sp`select * from public_api.submit_report(${newReportRef()}, ${secretHmac("x")}, 'NOT_A_CATEGORY', null, ${DESCRIPTION}, null, null, 'en', null)`,
        ),
      ).rejects.toThrow("CDF_INVALID:category");
      await expect(
        tx.savepoint(
          (sp) =>
            sp`select * from public_api.submit_report(${newReportRef()}, ${secretHmac("x")}, 'FRAUD', null, 'too short', null, null, 'en', null)`,
        ),
      ).rejects.toThrow("CDF_INVALID:description");
      await expect(
        tx.savepoint(
          (sp) =>
            sp`select * from public_api.submit_report('WB-0000000000O0', ${secretHmac("x")}, 'FRAUD', null, ${DESCRIPTION}, null, null, 'en', null)`,
        ),
      ).rejects.toThrow("CDF_INVALID:report_ref");
    });
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
