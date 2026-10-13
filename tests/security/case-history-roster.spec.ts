// UX redesign S2 (CDF-127; migration 1830; ADR-016 D5; DEC-08, DEC-10) · §19, §21, §22, §29, §40: case history and
// the access roster are read models with an audience. Both answer nothing without the caller's own case access,
// the same as for a case that does not exist. History has no page views, no security events, no identity-reveal
// detail and no legal-hold rationale outside the hold audience, and an object's events follow that object's own
// rule. The full roster is only for those who manage the team; nobody sees oversight grants or break-glass.
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import { USERS, admin, caseId, ownerScenario, scenario, type Scenario, type UserKey } from "../support/db";

const REASON = "Synthetic: case history and roster test.";
let caseA: string, caseB: string, caseSecret: string, caseConflict: string;
beforeAll(async () => {
  [caseA, caseB, caseSecret, caseConflict] = await Promise.all([
    caseId("0001"),
    caseId("0002"),
    caseId("0003"),
    caseId("0004"),
  ]);
});

interface HistoryRow {
  seq: string;
  action: string;
  actor_id: string | null;
  actor_name: string | null;
  subject_name: string | null;
  reason: string | null;
  detail: Record<string, unknown> | null;
}
interface RosterRow {
  user_id: string;
  relationship: string;
  code: string;
  status: string;
  is_self: boolean;
}

// The catalogue in migration 1830. Anything else in the ledger must never reach history.
const CATALOGUE = new Set([
  ...[
    "CASE_CREATED",
    "CASE_UPDATED",
    "CASE_CLOSED",
    "CASE_REOPENED",
    "CLASSIFICATION_CHANGED",
    "WORKFLOW_TRANSITION",
  ],
  ...["CASE_ASSIGNED", "CASE_UNASSIGNED", "CASE_REASSIGNED", "CASE_HANDED_OVER"],
  ...["CASE_ACCESS_GRANTED", "CASE_ACCESS_REVOKED", "CONFLICT_DECLARED", "CONFLICT_DECIDED"],
  ...["EVIDENCE_RECEIVED", "EVIDENCE_STORED", "EVIDENCE_REJECTED", "EVIDENCE_RESTRICTION_CHANGED"],
  ...[
    "FORM_STARTED",
    "FORM_SAVED",
    "FORM_PREPARED",
    "FORM_REVIEWED",
    "FORM_RETURNED",
    "FORM_APPROVED",
    "FORM_WITHDRAWN",
  ],
  ...["INTERVIEW_PLANNED", "INTERVIEW_PARTICIPANT_ADDED", "INTERVIEW_SCHEDULED", "INTERVIEW_RESCHEDULED"],
  ...[
    "INTERVIEW_NOTICE_ISSUED",
    "INTERVIEW_RIGHTS_ACKNOWLEDGED",
    "INTERVIEW_CONDUCTED",
    "INTERVIEW_STATEMENT_RECORDED",
  ],
  ...[
    "INTERVIEW_STATEMENT_ACKNOWLEDGED",
    "INTERVIEW_RECORDING_LINKED",
    "INTERVIEW_PREPARED",
    "INTERVIEW_REVIEWED",
  ],
  ...["INTERVIEW_APPROVED", "INTERVIEW_RETURNED", "INTERVIEW_CANCELLED"],
  ...[
    "REPORT_MESSAGE_SENT",
    "REPORTER_MESSAGE_RECEIVED",
    "REPORT_ATTACHMENT_RECEIVED",
    "REPORT_ATTACHMENT_STORED",
  ],
  ...["REPORT_ATTACHMENT_REJECTED", "LEGAL_HOLD_PLACED", "LEGAL_HOLD_RELEASED", "LEGAL_HOLD_REQUESTED"],
  ...[
    "LEGAL_HOLD_REVIEWED",
    "LEGAL_HOLD_RELEASE_REQUESTED",
    "LEGAL_HOLD_RELEASE_REJECTED",
    "CASE_TASK_ASSIGNED",
  ],
  ...["RETENTION_CLASS_ASSIGNED", "RETENTION_SCHEDULE_COMPUTED", "RETENTION_SCHEDULE_SUPERSEDED"],
  ...[
    "RETENTION_REVIEW_STARTED",
    "DISPOSITION_ELIGIBLE_MARKED",
    "DISPOSITION_REVIEW_STARTED",
    "DISPOSITION_REQUESTED",
  ],
  ...["DISPOSITION_APPROVED", "DISPOSITION_REJECTED", "DISPOSITION_BLOCKED_BY_HOLD", "DISPOSITION_EXECUTED"],
  "DISPOSITION_CERTIFICATE_ISSUED",
]);

const history = (tx: Tx, id: string) => tx<HistoryRow[]>`select * from api.case_history(${id}, 500)`;
const roster = (tx: Tx, id: string) => tx<RosterRow[]>`select * from api.case_access_roster(${id})`;
async function historyOf(s: Scenario, user: UserKey, id: string) {
  await s.as(user);
  return history(s.tx, id);
}
async function rosterOf(s: Scenario, user: UserKey, id: string) {
  await s.as(user);
  return roster(s.tx, id);
}
const nameOf = (id: string) => Object.entries(USERS).find(([, v]) => v === id)?.[0];
const rosterKey = (r: RosterRow) => `${nameOf(r.user_id)}:${r.relationship}:${r.code}`;

const OUTSIDERS: UserKey[] = [
  "investigatorB", // no relationship with case A
  "committee", // CONFLICT_DECLARE and FORM_VIEW alone
  "intake",
  "legal", // CASE_DISCOVER and LEGAL_HOLD_APPLY confer no case content
  "records",
  "platformAdmin", // §21: administrators never read case content
  "internalAudit", // Oversight reads the ledger under AUDIT_VIEW, not through case history
  "soc",
  "dpo",
  "revoked",
];

describe("no access, no answer, and the same answer as a case that does not exist", () => {
  it("outsiders, administrators and oversight roles get no history and no roster", async () => {
    await scenario(async (s) => {
      for (const user of OUTSIDERS) {
        expect(await historyOf(s, user, caseA), user).toEqual([]);
        expect(await roster(s.tx, caseA), user).toEqual([]);
      }
      await s.as(null);
      await s.expectError("permission denied", (tx) => history(tx, caseA));
      await s.expectError("permission denied", (tx) => roster(tx, caseA));
    });
  });

  it("an unknown case id and a hidden case answer identically", async () => {
    await scenario(async (s) => {
      for (const user of ["investigatorB", "caseManager", "grcDeputy"] as UserKey[]) {
        const missing = await historyOf(s, user, randomUUID());
        expect(missing, user).toEqual([]);
        expect(await roster(s.tx, randomUUID()), user).toEqual([]);
      }
      // The restricted case: the GRC Director who is not its named authority holds CASE_VIEW_ALL and SECRET
      // clearance, and still gets nothing (DEC-01, ADR-016 D5: "when they themselves have authorised access").
      expect(await historyOf(s, "grcDeputy", caseSecret)).toEqual([]);
      expect(await rosterOf(s, "grcDeputy", caseSecret)).toEqual([]);
      // CONFIDENTIAL clearance below the SECRET case: nothing, as for a missing case.
      expect(await historyOf(s, "caseManager", caseSecret)).toEqual([]);
      // The named authority does see it.
      expect((await historyOf(s, "grcDirector", caseSecret)).length).toBeGreaterThan(0);
    });
  });

  it("DB_ADMIN gets nothing either (§21)", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      await s.tx`insert into iam.user_role_assignment (user_id, role_code, justification)
                 values (${USERS.platformAdmin}, 'DB_ADMIN', ${REASON})`;
      expect(await historyOf(s, "platformAdmin", caseA)).toEqual([]);
      expect(await rosterOf(s, "platformAdmin", caseA)).toEqual([]);
    });
  });
});

describe("history shows business events from the catalogue only", () => {
  it("never a page view, a download, a discovery or a security event, for any user", async () => {
    await scenario(async (s) => {
      // Views and a download happen first, so the ledger holds them.
      await s.as("lead");
      await s.tx`select api.open_case(${caseA})`;
      await s.as("investigatorB");
      await s.tx`select api.open_case(${caseB})`;
      for (const user of Object.keys(USERS) as UserKey[]) {
        for (const id of [caseA, caseB, caseSecret, caseConflict]) {
          const actions = (await historyOf(s, user, id)).map((r) => r.action);
          const outside = actions.filter((a) => !CATALOGUE.has(a));
          expect(outside, `${user} on ${id}`).toEqual([]);
          expect(
            actions.filter((a) => a.endsWith("_VIEWED")),
            `${user} on ${id}`,
          ).toEqual([]);
        }
      }
      // Oversight still reads the full ledger, page views included, under its own permission.
      await s.as("dpo");
      const [views] = await s.tx<{ n: number }[]>`
        select count(*)::int as n from audit.audit_event where case_id = ${caseA} and action = 'CASE_VIEWED'`;
      expect(views!.n).toBeGreaterThan(0);
    });
  });

  it("returns only a fixed set of detail keys, never raw metadata", async () => {
    await scenario(async (s) => {
      const allowed = new Set([
        "transition",
        "from",
        "to",
        "role",
        "scope",
        "fields",
        "restricted",
        "item",
        "restriction",
      ]);
      for (const user of ["lead", "caseManager", "grcDirector", "triage"] as UserKey[]) {
        for (const r of await historyOf(s, user, caseA))
          for (const key of Object.keys(r.detail ?? {}))
            expect(allowed.has(key), `${r.action}.${key}`).toBe(true);
      }
    });
  });
});

describe("each event keeps its own audience", () => {
  it("conflict declarations: the person concerned and conflict managers only", async () => {
    await scenario(async (s) => {
      // Case A: three people declared. An investigator sees only their own declaration.
      const own = (await historyOf(s, "investigatorA", caseA)).filter(
        (r) => r.action === "CONFLICT_DECLARED",
      );
      expect(own.map((r) => r.subject_name)).toEqual(["Investigator Alpha"]);
      const manager = (await historyOf(s, "caseManager", caseA)).filter(
        (r) => r.action === "CONFLICT_DECLARED",
      );
      expect(manager.length).toBe(3);
      // Case C: investigator A declared a conflict and was removed. The remaining investigator sees the team change
      // but neither the declaration, nor the decision, nor the reason the assignment ended.
      const other = await historyOf(s, "investigatorB", caseConflict);
      expect(other.filter((r) => r.action.startsWith("CONFLICT_"))).toEqual([]);
      const ended = other.filter((r) => r.action === "CASE_UNASSIGNED");
      expect(ended.length).toBe(1);
      expect(ended[0]!.reason).toBeNull();
      expect(ended[0]!.subject_name).toBe("Investigator Alpha");
    });
  });

  it("team-change reasons: the full-roster audience, the person concerned and the actor", async () => {
    await scenario(async (s) => {
      const assigned = (rows: HistoryRow[]) =>
        Object.fromEntries(
          rows.filter((r) => r.action === "CASE_ASSIGNED").map((r) => [r.subject_name, r.reason]),
        );
      const investigator = assigned(await historyOf(s, "investigatorA", caseA));
      expect(investigator["Investigator Alpha"]).not.toBeNull(); // about them
      expect(investigator["Lead Investigator Delta"]).toBeNull(); // about someone else
      const lead = assigned(await historyOf(s, "lead", caseA)); // the case's lead manages the team
      expect(Object.values(lead).every((r) => r !== null)).toBe(true);
    });
  });

  it("access grants: the full-roster audience and the grantee, never an AUDIT-scope grant", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      await s.tx`select api.grant_case_access(${caseA}, ${USERS.dpo}, 'AUDIT', ${REASON}, null)`;
      const grants = async (user: UserKey) =>
        (await historyOf(s, user, caseA))
          .filter((r) => r.action === "CASE_ACCESS_GRANTED")
          .map((r) => `${r.subject_name}:${(r.detail as { scope: string }).scope}`)
          .sort();
      const full = [
        "Committee Chair Xi:COMMITTEE",
        "Committee Secretary Nu:COMMITTEE",
        "Triage Officer Beta:TRIAGE",
      ];
      expect(await grants("lead")).toEqual(full);
      expect(await grants("caseManager")).toEqual(full);
      expect(await grants("triage")).toEqual(["Triage Officer Beta:TRIAGE"]);
      expect(await grants("investigatorA")).toEqual([]);
      // The AUDIT grantee passes the case gate, and still never sees its own oversight grant.
      expect(await grants("dpo")).toEqual([]);
    });
  });

  it("legal hold: status for the case team, who and why only for the hold audience (DEC-10)", async () => {
    await scenario(async (s) => {
      // Requests already on the seed case (an earlier browser run may have left one) are not this test's.
      const requested = (rows: { action: string }[]) =>
        rows.filter((r) => r.action === "LEGAL_HOLD_REQUESTED").length;
      const before = requested(await historyOf(s, "grcDirector", caseA));
      await s.as("caseManager");
      await s.tx`select api.request_legal_hold(${caseA}, 'LITIGATION', ${REASON + " Request."})`;
      await s.as("grcDirector");
      await s.tx`select api.place_legal_hold(${caseA}, 'CASE', null, 'LITIGATION', ${REASON + " Preserve."}, null)`;

      for (const user of ["investigatorA", "lead", "committeeChair", "triage"] as UserKey[]) {
        const rows = await historyOf(s, user, caseA);
        const placed = rows.filter((r) => r.action === "LEGAL_HOLD_PLACED");
        expect(placed.length, user).toBe(1);
        expect(placed[0], user).toMatchObject({
          actor_id: null,
          actor_name: null,
          reason: null,
          detail: null,
        });
        expect(
          rows.filter((r) => r.action === "LEGAL_HOLD_REQUESTED"),
          user,
        ).toEqual([]);
        // "Legal hold active" stays visible to the case team (header indicator).
        const [o] = await s.tx<{ status: string }[]>`
          select legal_hold_status as status from case_mgmt.case_overview where id = ${caseA}`;
        expect(o?.status, user).toBe("ACTIVE");
      }
      // The requester sees their own request; the hold audience sees who placed it and the reason code.
      const requester = await historyOf(s, "caseManager", caseA);
      expect(requester.filter((r) => r.action === "LEGAL_HOLD_REQUESTED").length).toBe(1);
      expect(requester.find((r) => r.action === "LEGAL_HOLD_PLACED")?.actor_name).toBeNull();
      const director = await historyOf(s, "grcDirector", caseA);
      expect(director.find((r) => r.action === "LEGAL_HOLD_PLACED")).toMatchObject({
        actor_name: "GRC Director Zeta",
        reason: "LITIGATION",
      });
      expect(requested(director)).toBe(before + 1);
    });
  });

  it("records events: the records and hold audience only", async () => {
    await scenario(async (s) => {
      // Closing case B computes its retention schedule.
      await s.as("caseManager");
      await s.tx`select api.transition_case(${caseB}, 'SCREEN_OUT', ${REASON})`;
      // The investigator reads the case's story, closure included, but not its records work. (The case manager who
      // closed it sees the schedule its own act computed: everyone sees what they themselves did.)
      const team = await historyOf(s, "investigatorB", caseB);
      expect(team.map((r) => r.action)).toContain("CASE_CLOSED");
      expect(team.filter((r) => r.action.startsWith("RETENTION_"))).toEqual([]);
      const director = await historyOf(s, "grcDirector", caseB);
      expect(director.filter((r) => r.action.startsWith("RETENTION_")).length).toBeGreaterThan(0);
    });
  });

  it("evidence events follow the evidence's own rule: nobody sees an item outside their entitlement", async () => {
    await scenario(async (s) => {
      // The GRC Director joins case A and records a SECRET item; an investigator records a CONFIDENTIAL one.
      await s.as("caseManager");
      await s.tx`select api.assign_case(${caseA}, ${USERS.grcDirector}, 'CASE_OWNER', ${REASON})`;
      await s.tx`select api.grant_case_access(${caseA}, ${USERS.committee}, 'REVIEW', ${REASON}, null)`;
      const register = async (user: UserKey, level: string, file: string) => {
        await s.as(user);
        const [v] = await s.tx<{ v: string }[]>`
          select o_version_id as v from api.register_evidence_version(${caseA}, null, 'History probe (synthetic)', null,
            'DOCUMENT', 'Synthetic source', null, ${level}::core.classification_level, ${file}, 'application/pdf', 512,
            ${createHash("sha256").update(randomUUID()).digest("hex")})`;
        return v!.v;
      };
      const secret = await register("grcDirector", "SECRET", "secret.pdf");
      const confidential = await register("investigatorA", "CONFIDENTIAL", "confidential.pdf");
      // The ledger rows of the two receipts, read inside this transaction under AUDIT_VIEW.
      await s.as("dpo");
      const seqOf = async (v: string) =>
        (
          await s.tx<{ seq: string }[]>`
          select seq::text as seq from audit.audit_event where object_id = ${v} and action = 'EVIDENCE_RECEIVED'`
        )[0]!;
      const [secretSeq, confSeq] = [await seqOf(secret), await seqOf(confidential)];
      const seqs = async (user: UserKey) => (await historyOf(s, user, caseA)).map((r) => String(r.seq));
      // The investigators (CONFIDENTIAL clearance): the confidential item only.
      for (const user of ["investigatorA", "lead"] as UserKey[]) {
        const mine = await seqs(user);
        expect(mine, user).toContain(confSeq!.seq);
        expect(mine, user).not.toContain(secretSeq!.seq);
      }
      // The reviewer (REVIEW grant) is not the investigation team: neither item (DEC-09; packets at S5).
      const reviewer = await seqs("committee");
      expect(reviewer).not.toContain(confSeq!.seq);
      expect(reviewer).not.toContain(secretSeq!.seq);
      expect(await seqs("grcDirector")).toEqual(expect.arrayContaining([secretSeq!.seq, confSeq!.seq]));
    });
  });

  it("a classification change names a level only within the viewer's clearance, and above it nothing shows", async () => {
    await scenario(async (s) => {
      await s.as("grcDirector");
      await s.tx`select api.change_case_classification(${caseA}, 'SECRET'::core.classification_level, false, ${REASON})`;
      // While the case is SECRET, the CONFIDENTIAL team gets nothing: no history, no roster.
      expect(await historyOf(s, "investigatorA", caseA)).toEqual([]);
      expect(await rosterOf(s, "lead", caseA)).toEqual([]);
      await s.as("grcDirector");
      await s.tx`select api.change_case_classification(${caseA}, 'CONFIDENTIAL'::core.classification_level, false, ${REASON})`;
      const changes = async (user: UserKey) =>
        (await historyOf(s, user, caseA))
          .filter((r) => r.action === "CLASSIFICATION_CHANGED")
          .map((r) => r.detail);
      expect(await changes("investigatorA")).toEqual([
        { from: null, to: "CONFIDENTIAL", restricted: false },
        { from: "CONFIDENTIAL", to: null, restricted: false },
      ]);
      expect(await changes("grcDirector")).toEqual([
        { from: "SECRET", to: "CONFIDENTIAL", restricted: false },
        { from: "CONFIDENTIAL", to: "SECRET", restricted: false },
      ]);
    });
  });

  it("identity reveal and break-glass never reach history, and no reporter identity appears", async () => {
    await scenario(async (s) => {
      // Reporter identity resolution on case B (WB-SEED00000002 carries a synthetic identity).
      await s.as("grcDirector");
      const [req] = await s.tx<{ id: string }[]>`
        select api.request_identity_reveal(${caseB}, 'Synthetic: justified, proportionate request') as id`;
      await s.as("grcDeputy");
      await s.tx`select api.decide_identity_reveal(${req!.id}, true, 'Synthetic: approved for the test.')`;
      await s.as("grcDirector");
      await s.tx`select * from api.resolve_reporter_identity(${caseB}, 'Synthetic: contact the reporter.')`;
      // Break-glass on case A by a legal reviewer who knows the case through a legal-review task.
      await s.as("caseManager");
      await s.tx`select api.create_case_task(${caseA}, 'LEGAL_REVIEW', ${USERS.legal}, ${REASON})`;
      await s.as("legal");
      const [bg] = await s.tx<{ id: string }[]>`
        select api.request_break_glass(${caseA}, 'Synthetic: urgent preservation check for the test.', 60) as id`;
      await s.as("grcDirector");
      await s.tx`select api.decide_break_glass(${bg!.id}, true, 'Synthetic: approve.')`;

      for (const user of ["grcDirector", "grcDeputy", "investigatorB", "caseManager", "legal"] as UserKey[]) {
        for (const id of [caseA, caseB]) {
          const rows = await historyOf(s, user, id);
          const text = JSON.stringify(rows);
          expect(
            rows.filter((r) => /IDENTITY|BREAK_GLASS/.test(r.action)),
            `${user}`,
          ).toEqual([]);
          for (const leak of [
            "Reporter Gamma",
            "reporter.gamma@example.test",
            "+966 500000001",
            "1000000001",
          ])
            expect(text, `${user} ${leak}`).not.toContain(leak);
        }
      }
      // The break-glass holder can read the case, yet is on nobody's roster, their own included.
      for (const user of ["caseManager", "lead", "grcDirector", "legal"] as UserKey[])
        expect(
          (await rosterOf(s, user, caseA)).map((r) => nameOf(r.user_id)),
          user,
        ).not.toContain("legal");
    });
  });
});

describe("the access roster (DEC-08)", () => {
  it("is full only for those who manage the team; others see the team and their own basis", async () => {
    await scenario(async (s) => {
      const team = ["investigatorA:ASSIGNMENT:INVESTIGATOR", "lead:ASSIGNMENT:LEAD_INVESTIGATOR"];
      const grants = [
        "committeeChair:GRANT:COMMITTEE",
        "committeeSecretary:GRANT:COMMITTEE",
        "triage:GRANT:TRIAGE",
      ];
      const expected: Partial<Record<UserKey, string[]>> = {
        caseManager: [...team, ...grants],
        grcDirector: [...team, ...grants],
        grcDeputy: [...team, ...grants],
        lead: [...team, ...grants], // the case's assigned lead
        investigatorA: team,
        triage: [...team, "triage:GRANT:TRIAGE"],
        committeeChair: [...team, "committeeChair:GRANT:COMMITTEE"],
        committeeSecretary: [...team, "committeeSecretary:GRANT:COMMITTEE"],
      };
      for (const [user, want] of Object.entries(expected)) {
        const rows = await rosterOf(s, user as UserKey, caseA);
        expect(rows.map(rosterKey).sort(), user).toEqual([...want].sort());
        // "is_self" marks exactly the caller's own rows.
        for (const r of rows)
          expect(r.is_self, `${user} ${rosterKey(r)}`).toBe(r.user_id === USERS[user as UserKey]);
      }
    });
  });

  it("shows ended and revoked access to the full audience only, and never an AUDIT-scope grant", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      await s.tx`select api.grant_case_access(${caseA}, ${USERS.dpo}, 'AUDIT', ${REASON}, null)`;
      const [g] = await s.tx<{ id: string }[]>`
        select api.grant_case_access(${caseA}, ${USERS.investigatorB}, 'CASE', ${REASON}, null) as id`;
      await s.tx`select api.revoke_case_access(${g!.id}, ${REASON})`;
      const full = await rosterOf(s, "caseManager", caseA);
      expect(full.find((r) => nameOf(r.user_id) === "investigatorB")).toMatchObject({
        code: "CASE",
        status: "REVOKED",
      });
      expect(full.filter((r) => r.code === "AUDIT")).toEqual([]);
      expect(full.map((r) => nameOf(r.user_id))).not.toContain("dpo");
      // The investigator keeps the operational team only; the AUDIT grantee does not see its own oversight grant.
      expect((await rosterOf(s, "investigatorA", caseA)).map((r) => nameOf(r.user_id))).not.toContain(
        "investigatorB",
      );
      const auditor = await rosterOf(s, "dpo", caseA);
      expect(auditor.filter((r) => r.is_self)).toEqual([]);
      // Case C: the ended assignment of the investigator removed for a conflict is for the full audience only.
      expect((await rosterOf(s, "caseManager", caseConflict)).map(rosterKey)).toContain(
        "investigatorA:ASSIGNMENT:INVESTIGATOR",
      );
      expect((await rosterOf(s, "investigatorB", caseConflict)).map(rosterKey)).toEqual([
        "investigatorB:ASSIGNMENT:INVESTIGATOR",
      ]);
    });
  });

  it("returns no grant reason and no granting user", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      const [row] = await s.tx<
        Record<string, unknown>[]
      >`select * from api.case_access_roster(${caseA}) limit 1`;
      expect(Object.keys(row!).sort()).toEqual(
        [
          "code",
          "display_name",
          "display_name_ar",
          "ended_at",
          "is_self",
          "relationship",
          "since_at",
          "status",
          "until_at",
          "user_id",
        ].sort(),
      );
    });
  });
});

describe("function properties", () => {
  it("are STABLE SECURITY DEFINER with an empty search_path, executable by authenticated only", async () => {
    const rows = await admin<
      {
        name: string;
        secdef: boolean;
        volatile: string;
        config: string[] | null;
        anon: boolean;
        auth: boolean;
      }[]
    >`
      select p.proname as name, p.prosecdef as secdef, p.provolatile as volatile, p.proconfig as config,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'api' and p.proname in ('case_history', 'case_access_roster') order by 1`;
    expect(rows.map((r) => r.name)).toEqual(["case_access_roster", "case_history"]);
    for (const r of rows) {
      expect(r).toMatchObject({ secdef: true, volatile: "s", anon: false, auth: true });
      expect(r.config).toContain('search_path=""');
    }
  });
});

// The audit_event_read table policy still admits a viewable case's BUSINESS rows to its team (SECURITY_RULES L-4).
// The product never relies on that: case history is read only through api.case_history, and the one direct
// ledger query is Oversight's, which its own permissions gate. A new direct read anywhere fails here.
describe("the product reads the ledger directly in one place only", () => {
  const root = join(import.meta.dirname, "..", "..");
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (name === "node_modules" || name === ".next" || name.startsWith(".")) return [];
      if (statSync(full).isDirectory()) return sources(full);
      return /\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });

  it("selects from audit.audit_event only in the Oversight ledger query; case history uses api.case_history", () => {
    const files = [...sources(join(root, "apps")), ...sources(join(root, "packages"))];
    expect(files.length).toBeGreaterThan(50);
    const reads = files.flatMap((f) => {
      const text = readFileSync(f, "utf8");
      return [...text.matchAll(/\baudit\s*\.\s*audit_event\b/g)].map((m) => {
        // The enclosing class method: the last two-space-indented "name(" before the match.
        const method = [...text.slice(0, m.index).matchAll(/^ {2}(\w+)\(/gm)].at(-1)?.[1] ?? "(top level)";
        return `${relative(root, f)}#${method}`;
      });
    });
    expect(reads).toEqual(["packages/infrastructure/src/db/investigation-gateway.ts#auditLedger"]);
    const gateway = readFileSync(
      join(root, "packages/infrastructure/src/db/investigation-gateway.ts"),
      "utf8",
    );
    expect(gateway).toMatch(/from api\.case_history\(/);
  });
});
