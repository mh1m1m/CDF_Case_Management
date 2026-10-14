// ADR-016 D6 · DEC-09 (migration 1850; audit UX-072, RI-11): evidence need-to-know. Seeing a case is not seeing
// its evidence. The investigation team (case manager, owner, lead, investigators, a CASE grant, an approved
// break-glass) sees TEAM items within clearance; LEADS items only the case manager, owner and lead. Triage,
// committee, review, audit, GRC oversight, legal and records get no item, no version, no custody and no download,
// as for an item that does not exist. The reporter's files follow the same team, plus triage while its TRIAGE
// grant lasts. Records gets lifecycle metadata only.
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import { USERS, admin, caseId, ownerScenario, scenario, type Scenario, type UserKey } from "../support/db";
import { closeAndArchive, giveTask, recordsState } from "../support/records";
import {
  defenceNotice,
  packetWith,
  setPacketPolicy,
  storeEvidence,
  storeRendition,
} from "../support/evidence";

const REASON = "Synthetic: need-to-know test reason.";
const CASE_B_REF = "WB-SEED00000002"; // case CDF-DEMO-2026-0002 (investigator B; triage holds a TRIAGE grant)
const seedHmac = (ref: string) =>
  createHash("sha256").update(`unusable-seed-secret:${ref}`, "utf8").digest("hex");
const sha = () => createHash("sha256").update(randomUUID()).digest("hex");

let caseA: string, caseB: string;
beforeAll(async () => {
  [caseA, caseB] = await Promise.all([caseId("0001"), caseId("0002")]);
});

interface Item {
  evidenceId: string;
  versionId: string;
}
/** Registers and stores one item as `user`; leaves the scenario acting as `user`. */
async function stored(
  s: Scenario,
  user: UserKey,
  target: string,
  classification = "CONFIDENTIAL",
): Promise<Item> {
  await s.as(user);
  const [row] = await s.tx<Item[]>`
    select o_evidence_id as "evidenceId", o_version_id as "versionId"
    from api.register_evidence_version(${target}, null, 'Need-to-know probe (synthetic)', null, 'DOCUMENT',
      'Synthetic source', null, ${classification}::core.classification_level, 'probe.pdf', 'application/pdf', 1024, ${sha()})`;
  await s.tx`select api.complete_evidence_version(${row!.versionId}, 'CLEAN', 'test-scanner')`;
  return row!;
}
const restrict = (tx: Tx, id: string, to: string, reason = REASON) =>
  tx`select api.set_evidence_restriction(${id}, ${to}, ${reason})`;

/** What `user` gets of one item: the row, its versions, its custody, a download and the case itself. */
async function reach(s: Scenario, user: UserKey, item: Item, target: string) {
  await s.as(user);
  const n = async (q: PromiseLike<ArrayLike<unknown>>) => (await q).length;
  const [cv] = await s.tx<{ ok: boolean }[]>`select authz.can_view_case(${target}) as ok`;
  return {
    case: cv!.ok,
    item: await n(s.tx`select 1 from evidence.evidence where id = ${item.evidenceId}`),
    versions: await n(s.tx`select 1 from evidence.evidence_version where evidence_id = ${item.evidenceId}`),
    // Received and stored; downloads by earlier viewers in the same test add custody rows of their own.
    custody: await n(
      s.tx`select 1 from evidence.custody_event where evidence_id = ${item.evidenceId} and event_type <> 'DOWNLOADED'`,
    ),
    download: await n(s.tx`select 1 from api.open_evidence_version(${item.versionId})`),
  };
}
const NOTHING = { item: 0, versions: 0, custody: 0, download: 0 };
const EVERYTHING = { item: 1, versions: 1, custody: 2, download: 1 };

async function history(s: Scenario, user: UserKey, target: string) {
  await s.as(user);
  return s.tx<{ action: string; reason: string | null; detail: Record<string, unknown> | null }[]>`
    select action, reason, detail from api.case_history(${target}, 500)`;
}

describe("DEC-09: evidence follows the investigation team, not case visibility", () => {
  it("each role on a case it can see: only the team gets the item, its versions, custody and download", async () => {
    await scenario(async (s) => {
      const item = await stored(s, "investigatorA", caseA);
      await s.as("caseManager");
      await s.tx`select api.grant_case_access(${caseA}, ${USERS.dpo}, 'AUDIT', ${REASON}, null)`;
      await s.tx`select api.grant_case_access(${caseA}, ${USERS.grcDeputy}, 'CASE', ${REASON}, null)`;
      await s.tx`select api.assign_case(${caseA}, ${USERS.legal}, 'REVIEWER', ${REASON})`;
      const team: UserKey[] = ["investigatorA", "lead", "caseManager", "grcDeputy"];
      // Every one of these can see the case; none of them is the investigation team.
      const seeCaseOnly: UserKey[] = [
        "grcDirector", // CASE_VIEW_ALL oversight (packets at S5)
        "legal", // REVIEWER assignment
        "dpo", // AUDIT grant
      ];
      const outsiders: UserKey[] = [
        "investigatorB",
        "records",
        "platformAdmin",
        "internalAudit",
        "soc",
        // S3 (ADR-016 D2, D3): triage's grant ended at hand-over, and committee roles open no case.
        "triage",
        "committeeChair",
        "committeeSecretary",
        "committee",
      ];
      for (const user of team)
        expect(await reach(s, user, item, caseA), user).toEqual({ case: true, ...EVERYTHING });
      for (const user of seeCaseOnly)
        expect(await reach(s, user, item, caseA), user).toEqual({ case: true, ...NOTHING });
      for (const user of outsiders)
        expect(await reach(s, user, item, caseA), user).toEqual({ case: false, ...NOTHING });
    });
  });

  it("a denied download is recorded like one on an item that does not exist", async () => {
    await ownerScenario(async (s) => {
      const item = await stored(s, "investigatorA", caseA);
      for (const user of ["grcDirector", "committeeChair"] as UserKey[]) {
        await s.as(user);
        expect(await s.tx`select 1 from api.open_evidence_version(${item.versionId})`, user).toHaveLength(0);
      }
      await s.asOwner();
      const denials = await s.tx<{ actor_id: string; outcome: string }[]>`
        select actor_id, outcome from audit.audit_event
         where action = 'EVIDENCE_ACCESS_DENIED' and object_id = ${item.versionId} order by seq`;
      expect(denials).toEqual([
        { actor_id: USERS.grcDirector, outcome: "DENIED" },
        { actor_id: USERS.committeeChair, outcome: "DENIED" },
      ]);
    });
  });

  it("approved break-glass reaches TEAM items for its window, never LEADS items", async () => {
    await scenario(async (s) => {
      const open = await stored(s, "investigatorA", caseA);
      const limited = await stored(s, "investigatorA", caseA);
      await s.as("lead");
      await restrict(s.tx, limited.evidenceId, "LEADS");
      await giveTask(s, caseA, "legal", "LEGAL_REVIEW");
      await s.as("legal");
      expect(await reach(s, "legal", open, caseA)).toMatchObject(NOTHING);
      const [bg] = await s.tx<{ id: string }[]>`
        select api.request_break_glass(${caseA}, 'Synthetic: urgent preservation check for the suite.', 60) as id`;
      await s.as("grcDirector");
      await s.tx`select api.decide_break_glass(${bg!.id}, true, 'Synthetic: urgent preservation check.')`;
      expect(await reach(s, "legal", open, caseA)).toEqual({ case: true, ...EVERYTHING });
      expect(await reach(s, "legal", limited, caseA)).toEqual({ case: true, ...NOTHING });
      await s.as("legal");
      await s.tx`select api.end_break_glass(${bg!.id})`;
      expect(await reach(s, "legal", open, caseA)).toMatchObject(NOTHING);
    });
  });

  it("a new version needs the item itself: an item above clearance or limited to the leads is not found", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      await s.tx`select api.assign_case(${caseA}, ${USERS.grcDirector}, 'CASE_OWNER', ${REASON})`;
      const secret = await stored(s, "grcDirector", caseA, "SECRET");
      const limited = await stored(s, "investigatorA", caseA);
      await s.as("lead");
      await restrict(s.tx, limited.evidenceId, "LEADS");
      const addVersion = (id: string) => (tx: Tx) =>
        tx`select * from api.register_evidence_version(${caseA}, ${id}, null, null, null, null, null, null,
             'v2.pdf', 'application/pdf', 1024, ${sha()})`;
      await s.as("investigatorA");
      await s.expectError("CDF_NOT_FOUND", addVersion(secret.evidenceId));
      await s.expectError("CDF_NOT_FOUND", addVersion(limited.evidenceId));
      await s.as("lead"); // CONFIDENTIAL clearance: the SECRET item is not theirs either
      await s.expectError("CDF_NOT_FOUND", addVersion(secret.evidenceId));
      expect(await addVersion(limited.evidenceId)(s.tx)).toHaveLength(1);
    });
  });
});

describe("DEC-09: an item may be limited to the case leads", () => {
  it("LEADS hides the item from investigators and CASE grants; opening it again restores them; both audited", async () => {
    await ownerScenario(async (s) => {
      const item = await stored(s, "investigatorA", caseA);
      const [row] = await s.tx<{ seq: number }[]>`
        select sequence_no as seq from evidence.evidence where id = ${item.evidenceId}`;
      const seq = row!.seq;
      // Only this item's events: the seed case may carry restriction changes from other runs.
      const mine = <E extends { action: string; detail: Record<string, unknown> | null }>(events: E[]) =>
        events.filter((e) => e.action === "EVIDENCE_RESTRICTION_CHANGED" && e.detail?.item === seq);
      await s.as("caseManager");
      await s.tx`select api.grant_case_access(${caseA}, ${USERS.grcDeputy}, 'CASE', ${REASON}, null)`;
      await s.as("lead");
      await restrict(s.tx, item.evidenceId, "LEADS", "Synthetic: medical record, leads only.");
      for (const user of ["investigatorA", "grcDeputy", "grcDirector"] as UserKey[])
        expect(await reach(s, user, item, caseA), user).toEqual({ case: true, ...NOTHING });
      for (const user of ["lead", "caseManager"] as UserKey[])
        expect(await reach(s, user, item, caseA), user).toMatchObject({ item: 1, versions: 1, download: 1 });
      // The restriction event reaches only those who may see the item.
      const leadEvents = mine(await history(s, "lead", caseA));
      expect(leadEvents).toHaveLength(1);
      expect(leadEvents[0]!.detail).toEqual({ item: seq, restriction: "LEADS" });
      expect(leadEvents[0]!.reason).toBe("Synthetic: medical record, leads only.");
      for (const user of ["investigatorA", "triage", "grcDirector"] as UserKey[])
        expect(mine(await history(s, user, caseA)), user).toEqual([]);

      await s.as("caseManager");
      await restrict(s.tx, item.evidenceId, "TEAM", "Synthetic: needed by the whole team now.");
      expect(await reach(s, "investigatorA", item, caseA)).toEqual({ case: true, ...EVERYTHING });
      const seen = mine(await history(s, "investigatorA", caseA));
      expect(seen.map((e) => e.detail!.restriction)).toEqual(["TEAM", "LEADS"]);

      await s.asOwner();
      const audit = await s.tx<{ actor_id: string; reason: string; metadata: Record<string, unknown> }[]>`
        select actor_id, reason, metadata from audit.audit_event
         where action = 'EVIDENCE_RESTRICTION_CHANGED' and object_id = ${item.evidenceId} order by seq`;
      expect(audit.map((a) => [a.actor_id, a.metadata.from, a.metadata.to])).toEqual([
        [USERS.lead, "TEAM", "LEADS"],
        [USERS.caseManager, "LEADS", "TEAM"],
      ]);
      expect(audit[0]!.reason).toBe("Synthetic: medical record, leads only.");
      expect(audit[0]!.metadata).toMatchObject({
        evidence_id: item.evidenceId,
        sequence_no: expect.any(Number),
      });
    });
  });

  it("only the leads change it; everyone else is refused as forbidden or not found", async () => {
    await scenario(async (s) => {
      const item = await stored(s, "investigatorA", caseA);
      await s.as("investigatorA"); // sees the item, does not direct the investigation
      await s.expectError("CDF_FORBIDDEN", (tx) => restrict(tx, item.evidenceId, "LEADS"));
      for (const user of [
        "investigatorB",
        "triage",
        "grcDirector",
        "committeeChair",
        "records",
      ] as UserKey[]) {
        await s.as(user);
        await s.expectError("CDF_NOT_FOUND", (tx) => restrict(tx, item.evidenceId, "LEADS"));
      }
      await s.as("lead");
      await s.expectError("CDF_NOT_FOUND", (tx) => restrict(tx, randomUUID(), "LEADS"));
      await s.expectError("CDF_INVALID:restriction", (tx) => restrict(tx, item.evidenceId, "NOBODY"));
      await s.expectError("CDF_INVALID:reason", (tx) => restrict(tx, item.evidenceId, "LEADS", "short"));
      await s.expectError("CDF_CONFLICT:RESTRICTION_UNCHANGED", (tx) =>
        restrict(tx, item.evidenceId, "TEAM"),
      );
      await s.expectError(
        "permission denied",
        (tx) => tx`update evidence.evidence set restriction = 'LEADS' where id = ${item.evidenceId}`,
      );
      await s.as(null);
      await s.expectError("permission denied", (tx) => restrict(tx, item.evidenceId, "LEADS"));
    });
  });

  it("an archived case never opens an item again, but may still limit one", async () => {
    await scenario(async (s) => {
      const limited = await stored(s, "caseManager", caseB, "RESTRICTED");
      const open = await stored(s, "caseManager", caseB, "RESTRICTED");
      await restrict(s.tx, limited.evidenceId, "LEADS");
      await closeAndArchive(s, caseB);
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:RECORDS_READ_ONLY", (tx) => restrict(tx, limited.evidenceId, "TEAM"));
      await restrict(s.tx, open.evidenceId, "LEADS");
      expect(await reach(s, "investigatorB", open, caseB)).toMatchObject(NOTHING);
    });
  });
});

describe("DEC-09: records gets lifecycle metadata, never an item, its content or its download", () => {
  it("the archived case is in the records view; its evidence answers like a missing item", async () => {
    await scenario(async (s) => {
      const item = await stored(s, "caseManager", caseB, "RESTRICTED");
      await closeAndArchive(s, caseB);
      await s.as("records");
      expect((await recordsState(s.tx, caseB)).records_state).toBe("ARCHIVED");
      expect(await reach(s, "records", item, caseB)).toMatchObject(NOTHING);
      await s.as("records");
      await s.expectError("CDF_NOT_FOUND", (tx) => restrict(tx, item.evidenceId, "LEADS"));
      await s.expectError(
        "CDF_NOT_FOUND",
        (
          tx,
        ) => tx`select * from api.register_evidence_version(${caseB}, ${item.evidenceId}, null, null, null, null,
                     null, null, 'x.pdf', 'application/pdf', 10, ${sha()})`,
      );
    });
  });
});

describe("DEC-09: the reporter's files after a case exists", () => {
  /** Registers and stores an attachment on the report as the anonymous portal. */
  async function attachment(s: Scenario, ref: string): Promise<string> {
    await s.as(null);
    const [row] = await s.tx<{ attachment_id: string }[]>`
      select attachment_id from public_api.register_report_attachment(${ref}, ${seedHmac(ref)}, 'REPORT', 'pdf',
        'application/pdf', 2048, ${sha()})`;
    await s.tx`select public_api.complete_report_attachment(${ref}, ${seedHmac(ref)}, ${row!.attachment_id}, 'CLEAN', 'test-scanner')`;
    return row!.attachment_id;
  }
  async function files(s: Scenario, user: UserKey, id: string) {
    await s.as(user);
    return {
      listed: (await s.tx`select 1 from intake.report_attachment where id = ${id}`).length,
      download: (await s.tx`select 1 from api.open_report_attachment(${id})`).length,
    };
  }

  it("the team and triage (while its grant lasts) see them; case visibility alone does not", async () => {
    await scenario(async (s) => {
      const id = await attachment(s, CASE_B_REF);
      expect(await files(s, "investigatorB", id)).toEqual({ listed: 1, download: 1 });
      expect(await files(s, "caseManager", id)).toEqual({ listed: 1, download: 1 });
      // Triage reads what screening needs; it holds no evidence download right.
      expect(await files(s, "triage", id)).toEqual({ listed: 1, download: 0 });
      for (const user of ["grcDirector", "grcDeputy", "committee", "intake", "records"] as UserKey[])
        expect(await files(s, user, id), user).toEqual({ listed: 0, download: 0 });

      // Only a TRIAGE grant reaches them: an AUDIT grant sees the case, not its reporter's files. COMMITTEE and
      // REVIEW grants cannot be made any more (S3, DEC-02).
      const grants = [["dpo", "AUDIT"]] as const;
      await s.as("caseManager");
      for (const [user, scope] of [
        ["committeeChair", "COMMITTEE"],
        ["committee", "REVIEW"],
      ] as const)
        await s.expectError(
          "CDF_INVALID:scope",
          (tx) => tx`select api.grant_case_access(${caseB}, ${USERS[user]}, ${scope}, ${REASON}, null)`,
        );
      for (const [user, scope] of grants)
        await s.tx`select api.grant_case_access(${caseB}, ${USERS[user]}, ${scope}, ${REASON}, null)`;
      for (const [user] of grants) {
        await s.as(user);
        const [cv] = await s.tx<{ ok: boolean }[]>`select authz.can_view_case(${caseB}) as ok`;
        expect(cv!.ok, user).toBe(true);
        expect(await files(s, user, id), user).toEqual({ listed: 0, download: 0 });
      }

      // Hand-over ends the TRIAGE grant in the same transaction (DEC-03, S3); its end ends the files too. Closing
      // at screening leaves the triage stages, so it is a hand-over.
      await s.as("caseManager");
      await s.tx`select api.transition_case(${caseB}, 'SCREEN_OUT', 'Synthetic: screened out for the suite.')`;
      expect(await files(s, "triage", id)).toEqual({ listed: 0, download: 0 });
    });
  });

  it("history shows the files' events to the same people only", async () => {
    await scenario(async (s) => {
      await attachment(s, CASE_B_REF);
      const fileEvents = async (user: UserKey) =>
        (await history(s, user, caseB)).filter((e) => e.action.startsWith("REPORT_ATTACHMENT_")).length;
      expect(await fileEvents("investigatorB")).toBeGreaterThan(0);
      expect(await fileEvents("triage")).toBeGreaterThan(0);
      expect(await fileEvents("grcDirector")).toBe(0);
    });
  });
});

describe("DEC-09 functions", () => {
  it("are SECURITY DEFINER with an empty search path, closed to anon, and never read the identity vault", async () => {
    const rows = await admin<
      { fn: string; definer: boolean; config: string[] | null; anon: boolean; src: string }[]
    >`
      select p.oid::regprocedure::text as fn, p.prosecdef as definer, p.proconfig as config,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon, p.prosrc as src
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where (n.nspname = 'authz' and p.proname in ('is_evidence_team', 'is_evidence_lead', 'can_view_report_files',
                                                     'can_view_evidence', 'can_download_report_attachment'))
          or (n.nspname = 'api' and p.proname = 'set_evidence_restriction')
       order by 1`;
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.definer, r.fn).toBe(true);
      expect(r.config, r.fn).toContain('search_path=""');
      expect(r.anon, r.fn).toBe(false);
      expect(r.src, r.fn).not.toContain("protected_identity");
    }
  });
});

describe("ambiguity register: the Defence Packet gives no general evidence access (migration 2050, ADR-041)", () => {
  it("T-AMB-094: excluded evidence cannot be added to a packet, by the command or on the table", async () => {
    await ownerScenario(async (s) => {
      await setPacketPolicy(s);
      const n = await defenceNotice(s, caseA);
      const kept = await storeEvidence(s, "investigatorA", caseA);
      const excluded = await storeEvidence(s, "investigatorA", caseA);
      await s.as("lead");
      await s.tx`select api.exclude_evidence(${excluded.evidenceId}, 'Synthetic: obtained outside the mandate.')`;
      const { packet } = await packetWith(s, "lead", n.notice, [kept.versionId]);
      await s.expectError(
        "CDF_CONFLICT:EVIDENCE_EXCLUDED",
        (tx) => tx`select api.add_defence_packet_item(${packet}, ${excluded.versionId})`,
      );
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:EVIDENCE_EXCLUDED",
        (tx) => tx`select api.add_defence_packet_item(${packet}, ${excluded.versionId})`,
      );
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:EVIDENCE_EXCLUDED",
        (
          tx,
        ) => tx`insert into grievance.defence_packet_item (packet_id, position, evidence_id, source_version_id, added_by)
                   values (${packet}, 9, ${excluded.evidenceId}, ${excluded.versionId}, ${USERS.lead})`,
      );
      expect(
        await s.tx`select evidence_id from grievance.defence_packet_item where packet_id = ${packet}`,
      ).toEqual([{ evidence_id: kept.evidenceId }]);
    });
  });

  it("T-AMB-102: a packet holder views a cleared item inline and can never download evidence", async () => {
    await ownerScenario(async (s) => {
      await setPacketPolicy(s);
      const n = await defenceNotice(s, caseA);
      const a = await storeEvidence(s, "investigatorA", caseA);
      const redacted = await storeRendition(s, "lead", a.versionId);
      const { packet, items } = await packetWith(s, "lead", n.notice, [a.versionId]);
      await s.as("caseManager");
      await s.tx`select api.review_defence_packet_item(${items[0]!}, 'CLEARED_REDACTED', ${redacted.versionId},
                   'Ledger extract (redacted)', ${[
                     "REPORTER",
                     "WITNESS",
                     "CONFIDENTIALITY",
                     "PRIVILEGE",
                     "RESTRICTED_INFORMATION",
                     "OTHER_PROTECTED",
                   ]}::text[], null)`;
      await s.as("lead");
      await s.tx`select api.submit_defence_packet(${packet})`;
      // The subject: the viewer serves the cleared rendition inline; the download gate returns nothing for any version.
      await s.as("employee");
      const [o] = await s.tx<{ o_disposition: string; o_version_id: string }[]>`
        select o_disposition, o_version_id from api.open_defence_packet_item(${items[0]!})`;
      expect(o).toEqual({ o_disposition: "INLINE", o_version_id: redacted.versionId });
      for (const version of [a.versionId, redacted.versionId])
        expect(await s.tx`select 1 from api.open_evidence_version(${version})`, version).toEqual([]);
      expect(await s.tx`select 1 from evidence.evidence_version`).toEqual([]);
      // Seeing the item in a packet gives nothing on the case: no other item, no custody, no new version.
      await s.expectError(
        "CDF_NOT_FOUND",
        (
          tx,
        ) => tx`select * from api.register_evidence_version(${caseA}, ${a.evidenceId}, null, null, null, null, null,
                     null, 'x.pdf', 'application/pdf', 10, ${sha()})`,
      );
      // PACKET_EVIDENCE_DOWNLOAD is false until DEC-67 is answered; only a recorded policy version changes the
      // disposition, and even then the evidence download gate stays closed to the subject.
      await setPacketPolicy(s, { download: true });
      await s.as("employee");
      const [o2] = await s.tx<{ o_disposition: string }[]>`
        select o_disposition from api.open_defence_packet_item(${items[0]!})`;
      expect(o2!.o_disposition).toBe("ATTACHMENT");
      expect(await s.tx`select 1 from api.open_evidence_version(${redacted.versionId})`).toEqual([]);
      // No application role can change the policy.
      for (const u of ["employee", "caseManager", "platformAdmin"] as const) {
        await s.as(u);
        await s.expectError(
          "permission denied",
          (tx) => tx`update grievance.defence_packet_policy set packet_evidence_download = true`,
        );
      }
    });
  });
});
