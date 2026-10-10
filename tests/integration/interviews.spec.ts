// EPIC 09 (CDF-60, ADR-012): an interview from plan to approval through the real application service,
// Postgres gateway, database commands, RLS and audit ledger; the database hash equals the domain hash and
// the reporter's identity never appears in anything the interview reads return.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createInterviewService,
  createInvestigationService,
  type CommandResult,
  type InterviewService,
} from "@cdf/application";
import type { Actor } from "@cdf/contracts";
import { INTERVIEW_TRANSITIONS, statementSha256 } from "@cdf/domain";
import {
  PostgresInterviewGateway,
  PostgresInvestigationGateway,
  PostgresSecurityEventSink,
} from "@cdf/infrastructure";
import { USERS, admin, bff, caseId, type UserKey } from "../support/db";

let interviews: InterviewService;
let caseA: string, caseB: string;
const investigation = createInvestigationService({
  gateway: new PostgresInvestigationGateway(bff),
  securityEvents: new PostgresSecurityEventSink(bff),
});

beforeAll(async () => {
  interviews = createInterviewService({
    gateway: new PostgresInterviewGateway(bff),
    securityEvents: new PostgresSecurityEventSink(bff),
  });
  [caseA, caseB] = await Promise.all([caseId("0001"), caseId("0002")]);
});

const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });
async function actor(user: UserKey): Promise<Actor> {
  const a = await investigation.loadActor(ctxFor(user));
  if (!a) throw new Error(`no actor for ${user}`);
  return a;
}
function ok<T>(r: CommandResult<T>): T {
  if (!r.ok) throw new Error(JSON.stringify("error" in r ? r.error : r.fieldErrors.issues));
  return r.value;
}
/** datetime-local in Riyadh time, `hours` from now. */
function riyadhLocal(hours: number): string {
  const d = new Date(Date.now() + hours * 3_600_000 + 3 * 3_600_000);
  return d.toISOString().slice(0, 16);
}

describe("interview slice", () => {
  it("runs plan → schedule → notice → rights → conduct → statement → acknowledgement → approval", async () => {
    const stamp = randomUUID().slice(0, 8);
    const id = ok(
      await interviews.plan(ctxFor("investigatorA"), {
        caseId: caseA,
        title: `Witness interview ${stamp}`,
        intervieweeKind: "WITNESS",
        intervieweeLabel: "Witness Kappa (synthetic)",
        classification: "CONFIDENTIAL",
      }),
    );
    ok(
      await interviews.schedule(ctxFor("investigatorA"), {
        interviewId: id,
        scheduledStart: riyadhLocal(-2),
        durationMinutes: "60",
        mode: "IN_PERSON",
        location: "Meeting room 1 (synthetic)",
      }),
    );
    ok(
      await interviews.issueNotice(ctxFor("investigatorA"), {
        interviewId: id,
        noticeType: "INVITATION",
        channel: "INTERNAL_EMAIL",
      }),
    );
    ok(
      await interviews.recordRights(ctxFor("investigatorA"), {
        interviewId: id,
        method: "VERBAL_ON_RECORD",
        noticeVersion: "synthetic-rights-v1",
      }),
    );
    ok(
      await interviews.recordConducted(ctxFor("investigatorA"), {
        interviewId: id,
        startedAt: riyadhLocal(-2),
        endedAt: riyadhLocal(-1),
      }),
    );

    // The database computes the statement hash; it equals SHA-256 over the canonical UTF-8 text.
    const text = "إفادة تجريبية: الشاهد كابا يؤكد مراجعة الفواتير.\r\nSYNTHETIC second line.";
    const recorded = ok(
      await interviews.recordStatement(ctxFor("investigatorA"), {
        interviewId: id,
        content: text,
        language: "ar",
      }),
    );
    expect(recorded.versionNo).toBe(1);
    expect(recorded.sha256).toBe(await statementSha256(text.normalize("NFC").replace(/\r\n?/g, "\n")));

    // An acknowledgement must attest the exact hash.
    const wrong = await interviews.acknowledgeStatement(ctxFor("investigatorA"), {
      versionId: recorded.versionId,
      method: "SIGNED_PAPER",
      attestedSha256: "0".repeat(64),
    });
    expect(!wrong.ok && "error" in wrong && wrong.error.detail).toBe("STATEMENT_HASH_MISMATCH");
    ok(
      await interviews.acknowledgeStatement(ctxFor("investigatorA"), {
        versionId: recorded.versionId,
        method: "SIGNED_PAPER",
        attestedSha256: recorded.sha256,
      }),
    );

    const prepared = ok(
      await interviews.transition(ctxFor("investigatorA"), await actor("investigatorA"), {
        interviewId: id,
        action: "PREPARE",
      }),
    );
    expect(prepared).toBe("PREPARED");

    // The preparer cannot review their own work; the service refuses early when it knows the detail.
    const detail = await interviews.getInterview(ctxFor("investigatorA"), id);
    expect(detail?.preparedBy).toBe(USERS.investigatorA);
    const self = await interviews.transition(
      ctxFor("investigatorA"),
      await actor("investigatorA"),
      { interviewId: id, action: "REVIEW" },
      detail!,
    );
    expect(!self.ok && "error" in self && self.error.detail).toBe("SEPARATION_OF_DUTIES");
    ok(
      await interviews.transition(ctxFor("lead"), await actor("lead"), { interviewId: id, action: "REVIEW" }),
    );
    const leadApprove = await interviews.transition(ctxFor("lead"), await actor("lead"), {
      interviewId: id,
      action: "APPROVE",
    });
    expect(!leadApprove.ok && "error" in leadApprove && leadApprove.error.detail).toBe(
      "SEPARATION_OF_DUTIES",
    );
    expect(
      ok(
        await interviews.transition(ctxFor("caseManager"), await actor("caseManager"), {
          interviewId: id,
          action: "APPROVE",
        }),
      ),
    ).toBe("APPROVED");

    const final = await interviews.getInterview(ctxFor("lead"), id);
    expect(final).toMatchObject({
      status: "APPROVED",
      intervieweeKind: "WITNESS",
      intervieweeLabel: "Witness Kappa (synthetic)",
      rightsAckMethod: "VERBAL_ON_RECORD",
      rightsNoticeVersion: "SYNTHETIC-RIGHTS-V1",
      preparedBy: USERS.investigatorA,
      reviewedBy: USERS.lead,
      approvedBy: USERS.caseManager,
      currentStatementVersionId: recorded.versionId,
    });
    expect(final!.statements).toHaveLength(1);
    expect(final!.statements[0]).toMatchObject({
      versionNo: 1,
      contentSha256: recorded.sha256,
      acknowledgement: { method: "SIGNED_PAPER", attestedSha256: recorded.sha256 },
    });
    expect(final!.notices.map((n) => n.noticeType)).toEqual(["INVITATION"]);

    // Every step left one business audit event on the interview, in order; statement text never did.
    const events = await admin<{ action: string; metadata: unknown }[]>`
      select action, metadata from audit.audit_event
      where object_id in (${id}, ${recorded.versionId}) and category = 'BUSINESS' and action <> 'INTERVIEW_VIEWED'
      order by seq`;
    expect(events.map((e) => e.action)).toEqual([
      "INTERVIEW_PLANNED",
      "INTERVIEW_SCHEDULED",
      "INTERVIEW_NOTICE_ISSUED",
      "INTERVIEW_RIGHTS_ACKNOWLEDGED",
      "INTERVIEW_CONDUCTED",
      "INTERVIEW_STATEMENT_RECORDED",
      "INTERVIEW_STATEMENT_ACKNOWLEDGED",
      "INTERVIEW_PREPARED",
      "INTERVIEW_REVIEWED",
      "INTERVIEW_APPROVED",
    ]);
    expect(JSON.stringify(events)).not.toContain("كابا");
    const [viewed] = await admin<{ n: number }[]>`
      select count(*)::int as n from audit.audit_event where object_id = ${id} and action = 'INTERVIEW_VIEWED'`;
    expect(viewed!.n).toBe(2);

    // The list shows it to the case team and to nobody else.
    expect((await interviews.listInterviews(ctxFor("lead"), caseA)).map((i) => i.id)).toContain(id);
    expect(await interviews.listInterviews(ctxFor("investigatorB"), caseA)).toEqual([]);
    expect(await interviews.getInterview(ctxFor("investigatorB"), id)).toBeNull();
  });

  it("never returns the reporter's identity for a reporter interview", async () => {
    const list = await interviews.listInterviews(ctxFor("investigatorB"), caseB);
    const reporter = list.find((i) => i.intervieweeKind === "REPORTER");
    expect(reporter).toBeDefined();
    expect(reporter!.intervieweeLabel).toBeNull();
    const detail = await interviews.getInterview(ctxFor("investigatorB"), reporter!.id);
    expect(detail).toMatchObject({ intervieweeKind: "REPORTER", intervieweeLabel: null, casePersonId: null });
    const json = JSON.stringify({ list, detail });
    for (const secret of ["Reporter Gamma", "reporter.gamma@example.test"])
      expect(json).not.toContain(secret);
    expect(detail!.notices.map((n) => n.channel)).toEqual(["PORTAL_MESSAGE"]);
  });

  it("keeps the domain transition table in step with the database", async () => {
    const [fn] = await admin<{ src: string }[]>`
      select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api' and p.proname = 'transition_interview'`;
    const src = fn!.src;
    const segment = (action: string) => {
      const start =
        action === "CANCEL" ? src.indexOf("else -- CANCEL") : src.indexOf(`p_action = '${action}' then`);
      expect(start, action).toBeGreaterThan(0);
      const ends = ["\n  elsif", "\n  else -- CANCEL", "perform audit.record_event(v_action"]
        .map((m) => src.indexOf(m, start + 1))
        .filter((i) => i > 0);
      return src.slice(start, Math.min(...ends));
    };
    for (const [action, t] of Object.entries(INTERVIEW_TRANSITIONS)) {
      const body = segment(action);
      const allowed = body.match(/require_interview_status\(v_i, array\[([^\]]+)\]\)/)![1]!;
      expect(
        allowed
          .split(",")
          .map((s) => s.trim().replace(/'/g, ""))
          .sort(),
        action,
      ).toEqual([...t.from].sort());
      expect(body.match(/v_to := '([A-Z]+)'/)![1], action).toBe(t.to);
      expect(body.includes("_require_text(p_reason"), action).toBe(t.reasonRequired);
    }
  });
});
