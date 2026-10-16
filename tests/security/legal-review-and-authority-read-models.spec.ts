// UX redesign Phase 12, slice P12-3a, migration 2095 (ADR-057; Linear CDF-229): legal review and the authority's
// decision. api.legal_review_view (L1) gives the assigned reviewer their request and what the two opinion commands
// would answer; api.legal_review_choices (L2) gives the committee's secretary (REQUEST) and a restricted case's
// authority (APPROVE) the reviewers, findings and minutes their command accepts, on the bases the coordinator ruled
// (2026-10-15 06:50); api.committee_items_view (R2) gains each package's legal review and authority half and, for
// whoever runs the package commands, what asking for a review, cancelling one, submitting to the authority and
// recording its decision would answer now; api.case_history gains the package's legal-review and authority events.
//
// Three sweeps run in the states these tests build, for each caller:
//   * acts(): may_request_legal_review, may_cancel, may_submit_to_authority and may_record_authority_decision each
//     equal what their command answers, run and rolled back (a review asked of each holder of LEGAL_OPINION_GIVE, a
//     decision recorded for each active authority, every other choice valid). to_decide is exactly the authorities the
//     record command accepts, the same for every reader; record_outcomes holds APPROVE_AS_RECOMMENDED exactly where the
//     command accepts it; each refusal code is the command's, for whoever runs the package commands, where the act is
//     done. Every package, request, submission and decision is shown. The read without 2095's keys equals 2086's,
//     installed from its migration text and run side by side.
//   * opinions(): L1 is NOT_FOUND to everyone but the assignee who may still read the request's packet; for them,
//     may_give_opinion and may_give_superseding_opinion equal api.give_legal_opinion and
//     api.give_superseding_legal_opinion, run and rolled back, and each code is the command's. Where L1 is NOT_FOUND
//     neither command accepts. L1 writes nothing.
//   * choices(): L2 refuses exactly as its command does for every reviewer the command does not refuse as a choice.
//     Otherwise it lists every holder but the caller (ruling 1; on a restricted request, exactly the approval's
//     reviewer, ruling 2): a reviewer the command accepts is always listed, and a listed one is accepted unless the
//     command answers INVALID for them. Every finding and minutes listed is accepted, and they are the committee's scope
//     and the proceeding's approved minutes (on a restricted request, the approval's). One audit event with counts only
//     per answer, none on a refusal.
// Every step runs through the api.* commands as `authenticated`. The owner connection only installs 2086's definition,
// reads the ground truth (the role assignments to revoke among it), counts the ledger and sets clearances (no command
// writes them): raised for the restricted case, lowered to make a listed reviewer one the command refuses.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  USERS,
  caseId,
  ledgerMark,
  madeSince,
  ownerScenario,
  type OwnerScenario,
  type Scenario,
  type UserKey,
} from "../support/db";
import {
  REASON,
  committeeIds,
  openWithPresent,
  preliminaryReferral,
  scheduleMeeting,
  seat,
  type MeetingFixture,
} from "../support/committee";
import {
  DECISION_SEATS,
  DECISION_VOTERS,
  authorityRuleFor,
  caseFacts,
  closePackageVotes,
  draftPackage,
  requestLegalReview,
  voteOnPackage,
  type PackageFixture,
} from "../support/decision";
import { outcomes, without2095 } from "../support/capabilities";

const FIRM = "Synthetic: the committee's documented reasoning.";
const COMMENT = "Synthetic: the reviewer's comment on the adopted package.";
const CANCELLED = "Synthetic: the wrong reviewer was asked.";
const MEMO = "MEMO-DEMO-2095";
const OUTCOMES = [
  "APPROVE_AS_RECOMMENDED",
  "MODIFY",
  "REJECT",
  "RETURN_TO_COMMITTEE",
  "APPROVE_PARTIALLY",
  "OTHER",
];
/** The package's legal-review and authority events in the case's history (migration 2095). */
const PACKAGE_EVENTS = [
  "LEGAL_REVIEW_REQUESTED",
  "LEGAL_REVIEW_CANCELLED",
  "LEGAL_OPINION_GIVEN",
  "LEGAL_OPINION_SUPERSEDED",
  "RECOMMENDATION_PACKAGE_SUBMITTED_TO_AUTHORITY",
  "AUTHORITY_DECISION_RECORDED",
  "AUTHORITY_DECISION_SUPERSEDED",
  "RESTRICTED_LEGAL_REVIEW_APPROVED",
];

let caseB: string, caseExec: string, ic: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  caseExec = await caseId("0003");
  ({ ic } = await committeeIds());
});

const claims = (user: UserKey) => JSON.stringify({ sub: USERS[user], role: "authenticated" });
const keyOf = (id: string) => (Object.keys(USERS) as UserKey[]).find((k) => USERS[k] === id) ?? id;

/** The rows of the audit ledger this scenario wrote so far (the owner reads its own transaction). */
async function ledger(s: OwnerScenario): Promise<number> {
  await s.asOwner();
  const [r] = await s.tx<{ n: number }[]>`
    select count(*)::int as n from audit.audit_event where request_id = current_setting('cdf.request_id')::uuid`;
  return r!.n;
}

/** This scenario's audit rows of `action`, oldest first. */
async function events(s: OwnerScenario, action: string) {
  await s.asOwner();
  return s.tx<
    {
      actor_id: string;
      case_id: string;
      category: string;
      outcome: string;
      object_type: string;
      object_id: string;
      reason: string | null;
      metadata: Record<string, unknown>;
    }[]
  >`select actor_id, case_id, category, outcome, object_type, object_id, reason, metadata
    from audit.audit_event where request_id = current_setting('cdf.request_id')::uuid and action = ${action}
    order by seq`;
}

// ---- R2: api.committee_items_view with the legal review and authority half -----------------------------------------

const PACKAGE_FLAGS = [
  "may_add_item",
  "may_record_adoption",
  "may_record_authority_decision",
  "may_request_legal_review",
  "may_return_to_committee",
  "may_submit_for_vote",
  "may_submit_to_authority",
];
const PACKAGE_KEYS = [
  "adopted_at",
  "authority",
  "capabilities",
  "decided_at",
  "items",
  "legal_review",
  "open_vote_in",
  "package_id",
  "record_block",
  "record_outcomes",
  "record_supersedes",
  "request_legal_review_block",
  "round_no",
  "sequence_no",
  "status",
  "submit_block",
  "vote_granularity",
];

interface RequestRow {
  request_id: string;
  package_round: number;
  status: string;
  basis: string;
  reason: string;
  reviewer: { user_id: string; display_name: string; display_name_ar: string | null };
  opinion: string | null;
  opinion_text: string | null;
  packet_id: string | null;
  revisions: { revision_id: string; revision_no: number; opinion: string; opinion_text: string | null }[];
  cancellation: { reason: string; cancelled_at: string } | null;
  capabilities: { may_cancel: boolean };
}
interface ToDecide {
  authority_type: string;
  item_ids: string[];
  completes_round: boolean;
}
interface DecisionRow {
  decision_id: string;
  package_round: number;
  authority_type: string;
  outcome: string;
  decided_by_label: string;
  reason: string | null;
  delegation_reference: string | null;
  source_signature: string | null;
  sources: { position: number; reference: string; is_primary: boolean }[];
  scope: { item_id: string; item_outcome: string; modification: string | null }[];
  conditions: unknown[];
  superseded: { superseded_by: string; superseded_at: string } | null;
}
interface PackageRow {
  package_id: string;
  sequence_no: number;
  status: string;
  round_no: number;
  capabilities: Record<string, boolean>;
  request_legal_review_block: string | null;
  submit_block: string | null;
  record_block: string | null;
  record_outcomes: string[];
  record_supersedes: { decisions: number; corrective_actions: number } | null;
  adopted_at: string | null;
  decided_at: string | null;
  legal_review: { required: boolean; requests: RequestRow[] };
  authority: {
    rules: {
      item_type: string;
      rule_id: string | null;
      authority_types: string[];
      source_status: string | null;
      coverage: string;
      setting_disagreement: boolean;
    }[];
    submissions: {
      submission_id: string;
      package_round: number;
      packet_id: string;
      basis: string;
      requirements: { item_id: string; authority_type: string; rule_source_status: string }[];
    }[];
    decisions: DecisionRow[];
    to_decide: ToDecide[];
  };
}
interface ItemsView {
  committee_proceeding_id: string;
  packages: PackageRow[];
}

/** The caller's R2, or null when it is NOT_FOUND to them. Every capability a boolean, every list a list. */
async function itemsView(s: OwnerScenario, user: UserKey, cp: string): Promise<ItemsView | null> {
  await s.as(user);
  let v: ItemsView | null = null;
  try {
    await s.tx.savepoint(async (sp) => {
      const [r] = await sp<{ v: ItemsView }[]>`select api.committee_items_view(${cp}) as v`;
      v = r!.v;
    });
  } catch (error) {
    if ((error as Error).message === "CDF_NOT_FOUND") return null;
    throw error;
  }
  const seen = v as ItemsView | null;
  for (const p of seen?.packages ?? []) {
    expect(Object.keys(p).sort(), `${user}: a package's keys`).toEqual(PACKAGE_KEYS);
    expect(Object.keys(p.capabilities).sort(), `${user}: a package's capabilities`).toEqual(PACKAGE_FLAGS);
    for (const f of PACKAGE_FLAGS) expect(typeof p.capabilities[f], `${user} ${f}`).toBe("boolean");
    expect(typeof p.legal_review.required, `${user}: legal_review.required`).toBe("boolean");
    for (const r of p.legal_review.requests) {
      expect(Object.keys(r.capabilities), `${user}: a request's capabilities`).toEqual(["may_cancel"]);
      expect(typeof r.capabilities.may_cancel, `${user} may_cancel`).toBe("boolean");
    }
    expect(Array.isArray(p.record_outcomes), `${user} record_outcomes`).toBe(true);
    expect(Array.isArray(p.authority.to_decide), `${user} to_decide`).toBe(true);
  }
  return seen;
}

/** The secretary's R2 package, by position. */
async function secretaryPackage(s: OwnerScenario, cp: string, n = 0): Promise<PackageRow> {
  return (await itemsView(s, "committeeSecretary", cp))!.packages[n]!;
}

const MIGRATIONS = "infrastructure/supabase/migrations";

/** 2086's api.committee_items_view, renamed into pg_temp so that it runs beside the live one in one transaction. */
function definition2086(): string {
  const text = readFileSync(`${MIGRATIONS}/20261007002086_package_builder_and_invite_choices.sql`, "utf8");
  const head = /create (?:or replace )?function api\.committee_items_view\(p_committee_proceeding_id uuid\)/;
  const start = text.search(head);
  const end = text.indexOf("\n$$;", start);
  if (start < 0 || end < 0) throw new Error("api.committee_items_view not found in 2086");
  return text
    .slice(start, end + "\n$$;".length)
    .replace(head, "create function pg_temp.committee_items_view_2086(p_committee_proceeding_id uuid)");
}

/** Installs 2086's definition on the owner connection; the scenario's rollback removes it. */
async function install(s: OwnerScenario): Promise<void> {
  await s.asOwner();
  await s.tx.unsafe(definition2086());
}

/** One definition's answer for the user whose claims are set: the read, or the error it raised. */
async function runAs(s: OwnerScenario, fn: string, cp: string): Promise<{ view?: unknown; error?: string }> {
  let view: unknown;
  try {
    await s.tx.savepoint(async (sp) => {
      const [r] = await sp.unsafe(`select ${fn}($1) as v`, [cp]);
      view = r!.v;
    });
  } catch (error) {
    return { error: (error as Error).message };
  }
  return { view };
}

/** AGENT-09: the live read without 2095's keys is 2086's, for this caller, in this state. */
async function sameAs2086(s: OwnerScenario, user: UserKey, cp: string): Promise<void> {
  await s.asOwner();
  await s.tx`select set_config('request.jwt.claims', ${claims(user)}, true)`;
  const before = await runAs(s, "pg_temp.committee_items_view_2086", cp);
  const after = await runAs(s, "api.committee_items_view", cp);
  expect(after.error, `${user}: the same refusal`).toBe(before.error);
  if (before.error === undefined)
    expect(without2095(after.view), `${user}: 2086's read`).toEqual(before.view);
}

interface Truth {
  open: boolean;
  holders: string[];
  authorities: string[];
  packages: {
    id: string;
    status: string;
    round_no: number;
    required: boolean;
    adopted_at: string | null;
    decided_at: string | null;
  }[];
  requests: { id: string; package_id: string }[];
  submissions: { id: string; package_id: string }[];
  decisions: { id: string; package_id: string; superseded_by: string | null }[];
}

/** The proceeding's packages, requests, submissions and decisions in R2's order, as the table owner reads them. */
async function truth(s: OwnerScenario, cp: string): Promise<Truth> {
  await s.asOwner();
  const [c] = await s.tx<{ status: string }[]>`
    select status from committee.committee_proceeding where id = ${cp}`;
  const holders = await s.tx<{ id: string }[]>`
    select u.id from iam.user_profile u where authz.user_has_permission(u.id, 'LEGAL_OPINION_GIVE') order by u.id`;
  const authorities = await s.tx<{ code: string }[]>`
    select code from decision.authority_type where is_active order by code collate "C"`;
  const packages = await s.tx<Truth["packages"]>`
    select p.id, p.status, p.round_no, decision.legal_review_required(p.id) as required,
           to_jsonb(p.adopted_at) #>> '{}' as adopted_at, to_jsonb(p.decided_at) #>> '{}' as decided_at
    from decision.recommendation_package p where p.committee_proceeding_id = ${cp} order by p.sequence_no`;
  const requests = await s.tx<Truth["requests"]>`
    select r.id, r.package_id from decision.legal_review_request r
    join decision.recommendation_package p on p.id = r.package_id
    where p.committee_proceeding_id = ${cp} order by r.requested_at, r.id`;
  const submissions = await s.tx<Truth["submissions"]>`
    select x.id, x.package_id from decision.authority_submission x
    join decision.recommendation_package p on p.id = x.package_id
    where p.committee_proceeding_id = ${cp} order by x.package_round`;
  const decisions = await s.tx<Truth["decisions"]>`
    select d.id, d.package_id, ss.superseded_by from decision.authority_decision d
    join decision.recommendation_package p on p.id = d.package_id
    left join decision.authority_decision_supersession ss on ss.decision_id = d.id
    where p.committee_proceeding_id = ${cp} order by d.package_round, d.recorded_at, d.id`;
  return {
    open: c!.status === "OPEN",
    holders: holders.map((r) => r.id),
    authorities: authorities.map((r) => r.code),
    packages: [...packages],
    requests: [...requests],
    submissions: [...submissions],
    decisions: [...decisions],
  };
}

/**
 * The code R2 shows for an act: null once any valid choice is accepted; otherwise the one refusal every valid choice
 * gets, as R2 names it (a conflict code), only where the act is done and only for whoever runs the commands (a
 * NOT_FOUND or FORBIDDEN refusal shows nothing).
 */
function blockOf(atStep: boolean, answers: (true | string)[], label: string): string | null {
  if (answers.includes(true)) return null;
  const codes = [...new Set(answers as string[])];
  expect(
    codes.length,
    `${label}: one refusal for every valid choice (${codes.join(", ")})`,
  ).toBeLessThanOrEqual(1);
  const c = codes[0];
  return atStep && c?.startsWith("CDF_CONFLICT:") ? c.slice("CDF_CONFLICT:".length) : null;
}

/** An authority or outcome the record command refuses as the choice made, not as the package's state. */
const CHOICE_REFUSALS = new Set([
  "CDF_CONFLICT:AUTHORITY_TYPE_MISMATCH",
  "CDF_CONFLICT:AUTHORITY_ALREADY_DECIDED",
]);

const recordSql = (pkg: string, authority: string, outcome: string, items: string | null = null) =>
  `select api.record_authority_decision('${pkg}', '${authority}', '${outcome}', now(), 'Authority (synthetic)', '${MEMO}', ${items ?? "null"}, '${REASON}')`;

/** Callers of the act sweep: the secretary, the chair, two members (legal also holds LEGAL_OPINION_GIVE), the legal
 *  reviewer without a seat, the case team, the case manager, a platform administrator and a committee administrator
 *  without a seat. */
const CALLERS: UserKey[] = [
  "committeeSecretary",
  "committeeChair",
  "legal",
  "lead",
  "legalB",
  "investigatorB",
  "caseManager",
  "platformAdmin",
  "grcDirector",
];

/** The act sweep (see the header) for each caller, in the proceeding's current state. */
async function acts(s: OwnerScenario, cp: string, callers: UserKey[] = CALLERS): Promise<void> {
  const t = await truth(s, cp);
  const toDecide = new Map<string, string>();
  for (const user of callers) {
    const v = await itemsView(s, user, cp);
    const probes: Record<string, string> = {};
    for (const p of t.packages) {
      for (const h of t.holders)
        probes[`request:${p.id}:${h}`] =
          `select api.request_legal_review('${p.id}', '${h}', '${REASON}', null, null)`;
      probes[`submit:${p.id}`] = `select api.submit_to_authority('${p.id}')`;
      for (const a of t.authorities)
        for (const o of ["APPROVE_AS_RECOMMENDED", "RETURN_TO_COMMITTEE"])
          probes[`record:${p.id}:${a}:${o}`] = recordSql(p.id, a, o);
    }
    for (const r of t.requests)
      probes[`cancel:${r.id}`] = `select api.cancel_legal_review_request('${r.id}', '${REASON}')`;
    const o = await outcomes(s, user, probes);
    if (!v) {
      // NOT_FOUND: no command accepts. A committee proceeding no longer open is NOT_FOUND to the committee side while
      // the commands do not check it (ADR-057, "Known limitations"): the page offers less there, never more.
      if (t.open)
        expect(
          Object.keys(o).filter((k) => o[k] === true),
          `${user}: nothing accepted, unseen`,
        ).toEqual([]);
    } else {
      expect(
        v.packages.map((p) => p.package_id),
        `${user}: every package of the proceeding`,
      ).toEqual(t.packages.map((p) => p.id));
      for (const p of v.packages) {
        const id = p.package_id;
        const tp = t.packages.find((x) => x.id === id)!;
        const label = `${user}: package ${p.sequence_no} (${p.status})`;
        // Asking for a review: some holder of LEGAL_OPINION_GIVE accepted. A holder the command answers INVALID for is
        // a choice the command refuses, not the package's state.
        const asked = t.holders.map((h) => o[`request:${id}:${h}`]!);
        expect(p.capabilities.may_request_legal_review, `${label} may_request_legal_review`).toBe(
          asked.includes(true),
        );
        expect(p.request_legal_review_block, `${label} request_legal_review_block`).toBe(
          blockOf(
            tp.status === "ADOPTED",
            asked.filter((x) => x !== "CDF_INVALID:assigned_to"),
            `${label} request`,
          ),
        );
        // Submission.
        const submitted = o[`submit:${id}`]!;
        expect(p.capabilities.may_submit_to_authority, `${label} may_submit_to_authority`).toBe(
          submitted === true,
        );
        expect(p.submit_block, `${label} submit_block`).toBe(
          blockOf(tp.status === "ADOPTED", [submitted], `${label} submit`),
        );
        // Recording: RETURN_TO_COMMITTEE is never refused for a taint, so the authorities it is accepted for are the
        // authorities the command accepts.
        const returned = t.authorities.filter((a) => o[`record:${id}:${a}:RETURN_TO_COMMITTEE`] === true);
        const approved = t.authorities.filter((a) => o[`record:${id}:${a}:APPROVE_AS_RECOMMENDED`] === true);
        expect(p.capabilities.may_record_authority_decision, `${label} may_record_authority_decision`).toBe(
          returned.length > 0,
        );
        expect(
          approved.filter((a) => !returned.includes(a)),
          `${label}: an approval only where a return is accepted`,
        ).toEqual([]);
        if (p.capabilities.may_record_authority_decision) {
          expect(
            p.authority.to_decide.map((x) => x.authority_type),
            `${label} to_decide`,
          ).toEqual(returned);
          expect(p.record_outcomes, `${label} record_outcomes`).toEqual(
            approved.length === 0 ? ["RETURN_TO_COMMITTEE"] : OUTCOMES,
          );
          if (approved.length > 0)
            expect(approved, `${label}: every authority approves or none`).toEqual(returned);
        } else {
          expect(p.record_outcomes, `${label} record_outcomes`).toEqual([]);
          expect(p.record_supersedes, `${label} record_supersedes`).toBeNull();
        }
        const recorded = t.authorities
          .map((a) => o[`record:${id}:${a}:RETURN_TO_COMMITTEE`]!)
          .filter((x) => x === true || !CHOICE_REFUSALS.has(x));
        expect(p.record_block, `${label} record_block`).toBe(
          blockOf(tp.status === "AWAITING_AUTHORITY", recorded, `${label} record`),
        );
        // The authorities still to decide are the package's state: the same for every reader, and none unless the
        // package is with the authority.
        const seenToDecide = JSON.stringify(p.authority.to_decide);
        expect(toDecide.get(id) ?? seenToDecide, `${label}: to_decide as every reader reads it`).toBe(
          seenToDecide,
        );
        toDecide.set(id, seenToDecide);
        if (tp.status !== "AWAITING_AUTHORITY")
          expect(p.authority.to_decide, `${label} to_decide`).toEqual([]);
        expect(
          {
            status: p.status,
            round_no: p.round_no,
            required: p.legal_review.required,
            adopted_at: p.adopted_at,
            decided_at: p.decided_at,
          },
          `${label}: the package`,
        ).toEqual({
          status: tp.status,
          round_no: tp.round_no,
          required: tp.required,
          adopted_at: tp.adopted_at,
          decided_at: tp.decided_at,
        });
        // Every request of the package, each with its cancellation answer; every submission and decision.
        expect(
          p.legal_review.requests.map((r) => r.request_id),
          `${label}: the requests`,
        ).toEqual(t.requests.filter((r) => r.package_id === id).map((r) => r.id));
        for (const r of p.legal_review.requests)
          expect(r.capabilities.may_cancel, `${label}: may_cancel a request ${r.status}`).toBe(
            o[`cancel:${r.request_id}`] === true,
          );
        expect(
          p.authority.submissions.map((x) => x.submission_id),
          `${label}: the submissions`,
        ).toEqual(t.submissions.filter((x) => x.package_id === id).map((x) => x.id));
        expect(
          p.authority.decisions.map((d) => [d.decision_id, d.superseded?.superseded_by ?? null]),
          `${label}: the decisions`,
        ).toEqual(t.decisions.filter((d) => d.package_id === id).map((d) => [d.id, d.superseded_by]));
      }
    }
    await sameAs2086(s, user, cp);
  }
}

/** The package's status after `sql` runs as the secretary, rolled back. */
async function statusAfter(s: OwnerScenario, pkg: string, sql: string): Promise<string> {
  await s.as("committeeSecretary");
  let status = "";
  try {
    await s.tx.savepoint(async (sp) => {
      await sp.unsafe(sql);
      const [r] = await sp<{ status: string }[]>`
        select status from decision.recommendation_package where id = ${pkg}`;
      status = r!.status;
      throw new Error("PROBE_ROLLBACK");
    });
  } catch (error) {
    if ((error as Error).message !== "PROBE_ROLLBACK") throw error;
  }
  return status;
}

// ---- L1: api.legal_review_view ---------------------------------------------------------------------------------------

interface ReviewView {
  request_id: string;
  package_round: number;
  status: string;
  basis: string;
  reason: string;
  requested_by: { user_id: string; display_name: string; display_name_ar: string | null };
  opinion: string | null;
  opinion_text: string | null;
  revisions: { revision_id: string; revision_no: number; opinion: string; opinion_text: string | null }[];
  packet_id: string;
  capabilities: { may_give_opinion: boolean; may_give_superseding_opinion: boolean };
  opinion_block: string | null;
  superseding_opinion_block: string | null;
}

/** The caller's L1, or null when it is NOT_FOUND to them. */
async function reviewView(s: OwnerScenario, user: UserKey, request: string): Promise<ReviewView | null> {
  await s.as(user);
  let v: ReviewView | null = null;
  try {
    await s.tx.savepoint(async (sp) => {
      const [r] = await sp<{ v: ReviewView }[]>`select api.legal_review_view(${request}) as v`;
      v = r!.v;
    });
  } catch (error) {
    if ((error as Error).message === "CDF_NOT_FOUND") return null;
    throw error;
  }
  return v;
}

/** A command's answer as L1 names it: null when accepted, otherwise its code. */
const codeOf = (a: true | string | undefined) =>
  a === true || a === undefined ? null : a.replace(/^CDF_(CONFLICT:)?/, "");

const REVIEW_CALLERS: UserKey[] = [
  "legalB",
  "legal",
  "committeeSecretary",
  "committeeChair",
  "lead",
  "investigatorB",
  "caseManager",
  "platformAdmin",
  "grcDirector",
];

/** The opinion sweep (see the header). Returns the assignee's L1, or null when nobody reads it. */
async function opinions(
  s: OwnerScenario,
  request: string,
  callers: UserKey[] = REVIEW_CALLERS,
): Promise<ReviewView | null> {
  await s.asOwner();
  const [r] = await s.tx<
    {
      assigned_to: string;
      package_round: number;
      status: string;
      basis: string;
      reason: string;
      requested_by: string;
      opinion: string | null;
      opinion_text: string | null;
      packet_id: string;
    }[]
  >`select r.assigned_to, r.package_round, r.status, r.basis, r.reason, r.requested_by, r.opinion, r.opinion_text,
           (select k.id from decision.packet k where k.legal_review_request_id = r.id) as packet_id
    from decision.legal_review_request r where r.id = ${request}`;
  const revisions = await s.tx<{ id: string }[]>`
    select id from decision.legal_opinion_revision where request_id = ${request} order by revision_no`;
  let seen: ReviewView | null = null;
  for (const user of callers) {
    const written = await ledger(s);
    const v = await reviewView(s, user, request);
    expect(await ledger(s), `${user}: L1 writes nothing`).toBe(written);
    const o = await outcomes(s, user, {
      opinion: `select api.give_legal_opinion('${request}', 'CONCURS', null)`,
      superseding: `select api.give_superseding_legal_opinion('${request}', 'CONCURS', null)`,
    });
    if (!v) {
      expect([o.opinion, o.superseding], `${user}: no opinion accepted where L1 is NOT_FOUND`).not.toContain(
        true,
      );
      continue;
    }
    expect(USERS[user], `${user}: only the assignee reads L1`).toBe(r!.assigned_to);
    expect(v.capabilities, `${user}: the opinion capabilities`).toEqual({
      may_give_opinion: o.opinion === true,
      may_give_superseding_opinion: o.superseding === true,
    });
    expect(v.opinion_block, `${user} opinion_block`).toBe(codeOf(o.opinion));
    expect(v.superseding_opinion_block, `${user} superseding_opinion_block`).toBe(codeOf(o.superseding));
    expect(v, `${user}: the request`).toMatchObject({
      request_id: request,
      package_round: r!.package_round,
      status: r!.status,
      basis: r!.basis,
      reason: r!.reason,
      requested_by: { user_id: r!.requested_by },
      opinion: r!.opinion,
      opinion_text: r!.opinion_text,
      packet_id: r!.packet_id,
    });
    expect(
      v.revisions.map((x) => x.revision_id),
      `${user}: the revisions`,
    ).toEqual(revisions.map((x) => x.id));
    seen = v;
  }
  return seen;
}

// ---- L2: api.legal_review_choices ------------------------------------------------------------------------------------

interface Choices {
  act: string;
  package: {
    package_id: string;
    committee_proceeding_id: string;
    sequence_no: number;
    round_no: number;
    status: string;
  };
  label_mode: string;
  restricted: boolean;
  items: { item_id: string; item_type: string; sanction_code: string | null }[];
  reviewers: { user_id: string; display_name: string; display_name_ar: string | null }[];
  findings: {
    finding_id: string;
    version_no: number;
    result: string;
    proceeding_role: string;
    allegation: { allegation_id: string; position: number; category: string };
    subject: Record<string, unknown> | null;
  }[];
  minutes: {
    minutes_id: string;
    meeting_id: string;
    meeting_sequence_no: number;
    version_no: number;
    status: string;
  }[];
}

async function choicesOf(
  s: OwnerScenario,
  user: UserKey,
  pkg: string,
  act: string,
): Promise<{ view?: Choices; error?: string }> {
  await s.as(user);
  let view: Choices | undefined;
  try {
    await s.tx.savepoint(async (sp) => {
      const [r] = await sp<{ v: Choices }[]>`select api.legal_review_choices(${pkg}, ${act}) as v`;
      view = r!.v;
    });
  } catch (error) {
    return { error: (error as Error).message };
  }
  return { view };
}

const uuids = (ids: string[]) =>
  ids.length ? `array[${ids.map((x) => `'${x}'`).join(", ")}]::uuid[]` : "null";
const sorted = (xs: string[]) => [...xs].sort();

/** The choice sweep (see the header) for `act`. Returns the first caller's answer, or null when every call refused. */
async function choices(
  s: OwnerScenario,
  pkg: string,
  act: "REQUEST" | "APPROVE",
  callers: UserKey[],
): Promise<Choices | null> {
  await s.asOwner();
  const holders = (
    await s.tx<{ id: string }[]>`
      select u.id from iam.user_profile u where authz.user_has_permission(u.id, 'LEGAL_OPINION_GIVE') order by u.id`
  ).map((r) => r.id);
  const [p] = await s.tx<
    { case_id: string; status: string; round_no: number; cp: string; restricted: boolean }[]
  >`select p.case_id, p.status, p.round_no, p.committee_proceeding_id as cp, c.is_restricted as restricted
    from decision.recommendation_package p join case_mgmt.case_record c on c.id = p.case_id where p.id = ${pkg}`;
  const [approval] = await s.tx<{ reviewer_id: string; finding_ids: string[]; minutes_ids: string[] }[]>`
    select reviewer_id, finding_ids, minutes_ids from decision.restricted_legal_review_approval
    where package_id = ${pkg} and legal_review_request_id is null and package_round = ${p!.round_no}`;
  const scope = (
    await s.tx<{ id: string }[]>`
      select f.id from case_mgmt.finding f join case_mgmt.allegation a on a.id = f.allegation_id
      where f.case_id = ${p!.case_id} and a.status <> 'WITHDRAWN'
        and decision.finding_in_committee_scope(f.id, ${p!.cp})`
  ).map((r) => r.id);
  const approvedMinutes = (
    await s.tx<{ id: string }[]>`
      select mi.id from committee.minutes mi join committee.meeting m on m.id = mi.meeting_id
      where m.committee_proceeding_id = ${p!.cp} and mi.status in ('APPROVED', 'DEEMED_APPROVED')`
  ).map((r) => r.id);
  const adopted = (
    await s.tx<{ id: string }[]>`
      select id from decision.recommendation_item
      where package_id = ${pkg} and status = 'ACTIVE' and committee_result = 'APPROVED' order by added_at, id`
  ).map((r) => r.id);
  // On a restricted case the request takes exactly the approval (ruling 2).
  const scoped = act === "REQUEST" && p!.restricted;
  const command = (h: string, findings: string[] = [], minutes: string[] = []) =>
    act === "REQUEST"
      ? `select api.request_legal_review('${pkg}', '${h}', '${REASON}', ${uuids(findings)}, ${uuids(minutes)})`
      : `select api.approve_restricted_legal_review('${pkg}', '${h}', ${uuids(findings)}, ${uuids(minutes)}, '${REASON}')`;
  const invalid = act === "REQUEST" ? "CDF_INVALID:assigned_to" : "CDF_INVALID:reviewer_id";
  let first: Choices | null = null;
  for (const user of callers) {
    const before = (await events(s, "LEGAL_REVIEW_CHOICES_VIEWED")).length;
    const r = await choicesOf(s, user, pkg, act);
    const after = await events(s, "LEGAL_REVIEW_CHOICES_VIEWED");
    const o = await outcomes(s, user, Object.fromEntries(holders.map((h) => [h, command(h)])));
    if (r.error !== undefined) {
      // The command's refusal for every reviewer it does not refuse as the choice made.
      for (const h of holders.filter((x) => o[x] !== invalid))
        expect(o[h], `${user}: ${act} with ${keyOf(h)} refused as L2 refuses`).toBe(r.error);
      expect(after.length, `${user}: a refusal writes nothing`).toBe(before);
      continue;
    }
    const v = r.view!;
    const listed = v.reviewers.map((x) => x.user_id);
    // The seat basis (ruling 1): every holder but the caller; on a restricted request, the approval's reviewer only.
    expect(sorted(listed), `${user}: the reviewers`).toEqual(
      sorted(holders.filter((h) => h !== USERS[user] && (!scoped || h === approval?.reviewer_id))),
    );
    for (const h of holders) {
      if (o[h] === true) expect(listed, `${user}: ${keyOf(h)} is accepted, so listed`).toContain(h);
      if (listed.includes(h))
        expect(
          [true, invalid],
          `${user}: ${keyOf(h)} is listed: accepted, or a choice the command refuses`,
        ).toContain(o[h]);
    }
    // The findings and minutes: the committee's scope and the proceeding's approved minutes, or the approval's.
    expect(sorted(v.findings.map((f) => f.finding_id)), `${user}: the findings`).toEqual(
      sorted(scoped ? (approval?.finding_ids ?? []) : scope),
    );
    expect(sorted(v.minutes.map((m) => m.minutes_id)), `${user}: the minutes`).toEqual(
      sorted(scoped ? approvedMinutes.filter((m) => approval?.minutes_ids.includes(m)) : approvedMinutes),
    );
    const reviewer = holders.find((h) => o[h] === true);
    if (reviewer) {
      const listedFindings = v.findings.map((f) => f.finding_id);
      const listedMinutes = v.minutes.map((m) => m.minutes_id);
      const each = await outcomes(s, user, {
        all: command(reviewer, listedFindings, listedMinutes),
        ...Object.fromEntries(listedFindings.map((f) => [`finding:${f}`, command(reviewer, [f])])),
        ...Object.fromEntries(listedMinutes.map((m) => [`minutes:${m}`, command(reviewer, [], [m])])),
      });
      for (const [k, a] of Object.entries(each)) expect(a, `${user}: ${k} accepted`).toBe(true);
    }
    expect(v.act).toBe(act);
    expect(v.restricted, `${user}: restricted`).toBe(p!.restricted);
    expect(v.package, `${user}: the package`).toMatchObject({
      package_id: pkg,
      committee_proceeding_id: p!.cp,
      status: p!.status,
      round_no: p!.round_no,
    });
    expect(
      v.items.map((i) => i.item_id),
      `${user}: the adopted items`,
    ).toEqual(adopted);
    // One audit event, counts only.
    expect(after.length, `${user}: one audit event`).toBe(before + 1);
    expect(after.at(-1), `${user}: the audit event`).toEqual({
      actor_id: USERS[user],
      case_id: p!.case_id,
      category: "BUSINESS",
      outcome: "SUCCESS",
      object_type: "recommendation_package",
      object_id: pkg,
      reason: null,
      metadata: {
        act,
        restricted: p!.restricted,
        reviewers: v.reviewers.length,
        findings: v.findings.length,
        minutes: v.minutes.length,
      },
    });
    first ??= v;
  }
  return first;
}

// ---- Fixtures ------------------------------------------------------------------------------------------------------

/** draftPackage's package, with the committee's proceeding referred from the investigation that recorded the finding,
 *  so the finding is in the committee's scope (decision.finding_in_committee_scope), and a finding of another of the
 *  case's proceedings, which is not. */
async function referredPackage(s: Scenario, caseId: string): Promise<PackageFixture & { sibling: string }> {
  await seat(s, ic, DECISION_SEATS);
  await authorityRuleFor(s, "CORRECTIVE_ACTION");
  const facts = await caseFacts(s, caseId);
  await s.as("caseManager");
  await s.tx`select api.issue_defence_notice(${facts.subject}, 'Synthetic: you are invited to respond.',
    ${[facts.allegation]}::uuid[], now() + interval '10 days')`;
  const [other] = await s.tx<{ id: string }[]>`
    select api.open_proceeding(${caseId}, 'LEGAL_REVIEW', null, ${REASON}) as id`;
  await s.as("investigatorB");
  const [sibling] = await s.tx<{ id: string }[]>`
    select api.record_finding(${facts.allegation}, null, ${other!.id}, 'NOT_SUBSTANTIATED',
      'Synthetic: a finding of another proceeding.') as id`;
  const meeting = await scheduleMeeting(s, ic, caseId, facts.proceeding);
  await openWithPresent(s, meeting, DECISION_VOTERS);
  await s.as("committeeSecretary");
  const [pkg] = await s.tx<{ id: string }[]>`
    select api.create_recommendation_package(${meeting.committeeProceeding}, 'PACKAGE') as id`;
  const [sanction] = await s.tx<{ id: string }[]>`
    select api.add_recommendation_item(${pkg!.id}, 'DISCIPLINARY_SANCTION', 'WARNING', null,
      'Synthetic: written warning for Employee Sigma.', ${[facts.subject]}::uuid[], ${[facts.allegation]}::uuid[]) as id`;
  const [corrective] = await s.tx<{ id: string }[]>`
    select api.add_recommendation_item(${pkg!.id}, 'CORRECTIVE_ACTION', null, null,
      'Synthetic: strengthen the approval controls.', null, null) as id`;
  return {
    ...facts,
    meeting,
    pkg: pkg!.id,
    sanction: sanction!.id,
    corrective: corrective!.id,
    sibling: sibling!.id,
  };
}

/** `raiser` raises a conflict on `subject`'s participation in the meeting; the chair upholds it. */
async function upheldOn(s: Scenario, m: MeetingFixture, subject: UserKey, raiser: UserKey): Promise<void> {
  await s.as(raiser);
  const [c] = await s.tx<{ id: string }[]>`
    select api.raise_meeting_conflict(${m.participant[subject]!}, 'Synthetic: the member is related to the subject.') as id`;
  await s.as("committeeChair");
  await s.tx`select api.decide_meeting_conflict(${c!.id}, 'UPHELD', 'Synthetic: the relationship is confirmed.')`;
}

/** legalB reviews the adopted package and concurs; returns the request. */
async function reviewed(s: Scenario, f: PackageFixture): Promise<string> {
  const { request } = await requestLegalReview(s, f);
  await s.as("legalB");
  await s.tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`;
  return request;
}

/** After a re-vote resolution: the secretary opens the package's vote of `round`, `votes` are cast, the vote closes and
 *  the package is adopted. */
async function revote(
  s: Scenario,
  f: PackageFixture,
  round: number,
  votes: Partial<Record<UserKey, string>>,
): Promise<void> {
  await s.as("committeeSecretary");
  await s.tx`select api.open_package_vote(${f.meeting.meeting}, ${f.pkg})`;
  const [vi] = await s.tx<{ id: string }[]>`
    select id from committee.vote_item where package_id = ${f.pkg} and package_round = ${round}`;
  for (const [u, choice] of Object.entries(votes) as [UserKey, string][]) {
    await s.as(u);
    await s.tx`select api.cast_vote(${vi!.id}, ${choice}, null)`;
  }
  await s.as("committeeSecretary");
  await s.tx`select api.close_vote_item(${vi!.id}, null)`;
  const [r] = await s.tx<{ status: string }[]>`select api.record_package_adoption(${f.pkg}) as status`;
  expect(r!.status, `round ${round} adopted`).toBe("ADOPTED");
}

/** The secretary records the authority's decision, decided now; returns it. */
async function record(
  s: Scenario,
  pkg: string,
  authority: string,
  outcome: string,
  memo = MEMO,
): Promise<string> {
  await s.as("committeeSecretary");
  const [d] = await s.tx<{ id: string }[]>`
    select api.record_authority_decision(${pkg}, ${authority}, ${outcome}, now(), 'Authority (synthetic)', ${memo},
      null, ${REASON}) as id`;
  return d!.id;
}

/** Chair and lead approve, legal rejects: the lead's vote decides. */
const decisive = (_target: string, voter: UserKey) => (voter === "legal" ? "REJECT" : "APPROVE");

interface HistoryRow {
  seq: string;
  action: string;
  actor_id: string | null;
  actor_name: string | null;
  subject_name: string | null;
  reason: string | null;
  detail: unknown;
}

/** The package events of a case's history the user reads, made after `mark`, oldest first. */
async function packageHistory(
  s: Scenario,
  user: UserKey,
  target: string,
  mark: bigint,
): Promise<HistoryRow[]> {
  await s.as(user);
  const rows = await s.tx<HistoryRow[]>`select * from api.case_history(${target}, 500)`;
  return madeSince([...rows], mark)
    .filter((r) => PACKAGE_EVENTS.includes(r.action))
    .reverse();
}

describe("api.committee_items_view, api.legal_review_view and api.legal_review_choices (migration 2095, ADR-057)", () => {
  it("a review the rules require, through to each authority's decision: asked, cancelled, asked again, answered and superseded, submitted, decided by two authorities; each capability is its command's answer", async () => {
    await ownerScenario(async (s) => {
      const mark = await ledgerMark();
      await install(s);
      // The board decides corrective actions here and the CEO sanctions: two authorities in one round.
      await s.as("platformAdmin");
      await s.tx`select api.set_action_authority_rule('CORRECTIVE_ACTION', 'BOARD', now(), 'SOURCE_REQUIRED',
        'Synthetic: the board decides corrective actions in this test.')`;
      const f = await referredPackage(s, caseB);
      const cp = f.meeting.committeeProceeding;

      // 1. A draft: nothing after the adoption is offered to anyone.
      await acts(s, cp);
      let p = await secretaryPackage(s, cp);
      expect(p.capabilities).toMatchObject({
        may_request_legal_review: false,
        may_submit_to_authority: false,
        may_record_authority_decision: false,
      });
      expect([p.request_legal_review_block, p.submit_block, p.record_block]).toEqual([null, null, null]);

      // 2. Adopted: the rules require a review of the sanction (DEC-F12), and the submission waits for its opinion.
      //    The rules in force for the adopted item types are shown as configured (DEC-F13).
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      await acts(s, cp);
      p = await secretaryPackage(s, cp);
      expect(p.capabilities).toMatchObject({
        may_request_legal_review: true,
        may_submit_to_authority: false,
        may_record_authority_decision: false,
      });
      expect([p.request_legal_review_block, p.submit_block, p.record_block]).toEqual([
        null,
        "LEGAL_REVIEW_REQUIRED",
        null,
      ]);
      expect(p.legal_review).toEqual({ required: true, requests: [] });
      expect(p.authority.rules).toEqual([
        {
          item_type: "CORRECTIVE_ACTION",
          rule_id: expect.any(String),
          authority_types: ["BOARD"],
          source_status: "SOURCE_REQUIRED",
          coverage: "SOURCE_REQUIRED",
          setting_disagreement: false,
        },
        {
          item_type: "DISCIPLINARY_SANCTION",
          rule_id: expect.any(String),
          authority_types: ["CEO"],
          source_status: "OWNER_DEFAULT",
          coverage: "OWNER_DEFAULT",
          // FINAL_DISCIPLINARY_AUTHORITY is still SOURCE_REQUIRED.
          setting_disagreement: true,
        },
      ]);
      const asked = (await choices(s, f.pkg, "REQUEST", [
        "committeeSecretary",
        "committeeChair",
        "legal",
        "legalB",
        "caseManager",
        "platformAdmin",
      ]))!;
      // Both holders, by name (Legal Reviewer Omicron, Legal Reviewer Pi); the committee's scope as R1 gives it: the
      // referred investigation's finding, not the other proceeding's.
      expect(asked.reviewers.map((r) => r.user_id)).toEqual([USERS.legal, USERS.legalB]);
      await s.as("committeeSecretary");
      const [r1] = await s.tx<
        {
          v: {
            findings: {
              finding_id: string;
              allegation_id: string;
              subject_id: string | null;
              proceeding_role: string;
              version_no: number;
              result: string;
            }[];
            allegations: { allegation_id: string; position: number; category: string }[];
          };
        }[]
      >`select api.committee_scope_choices(${cp}) as v`;
      expect(
        asked.findings.map((x) => ({
          finding_id: x.finding_id,
          proceeding_role: x.proceeding_role,
          version_no: x.version_no,
          result: x.result,
        })),
      ).toEqual(
        r1!.v.findings.map((x) => ({
          finding_id: x.finding_id,
          proceeding_role: x.proceeding_role,
          version_no: x.version_no,
          result: x.result,
        })),
      );
      const allegation = new Map(
        r1!.v.allegations.map((a) => [
          a.allegation_id,
          { allegation_id: a.allegation_id, position: a.position, category: a.category },
        ]),
      );
      expect(asked.findings.map((x) => x.allegation)).toEqual(
        r1!.v.findings.map((x) => allegation.get(x.allegation_id)),
      );
      expect(asked.findings.map((x) => x.subject?.subject_id ?? null)).toEqual(
        r1!.v.findings.map((x) => x.subject_id),
      );
      expect(asked.findings.map((x) => [x.finding_id, x.proceeding_role])).toEqual([[f.finding, "REFERRED"]]);
      expect(asked.findings.map((x) => x.finding_id)).not.toContain(f.sibling);
      expect(asked.items.map((i) => i.item_id).sort()).toEqual([f.sanction, f.corrective].sort());
      //    A listed reviewer the case gate refuses (legal, cleared below the case): still listed, and the command
      //    answers INVALID for them. No list says who is cleared (DEC-F19).
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'INTERNAL' where id = ${USERS.legal}`;
      expect(
        (await choices(s, f.pkg, "REQUEST", ["committeeSecretary"]))!.reviewers.map((r) => r.user_id),
      ).toEqual([USERS.legal, USERS.legalB]);
      expect(
        await outcomes(s, "committeeSecretary", {
          legal: `select api.request_legal_review('${f.pkg}', '${USERS.legal}', '${REASON}', null, null)`,
        }),
      ).toEqual({ legal: "CDF_INVALID:assigned_to" });
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'CONFIDENTIAL' where id = ${USERS.legal}`;
      //    APPROVE is for a restricted case only: the command's refusal, here and for anyone.
      expect(
        await choices(s, f.pkg, "APPROVE", ["committeeSecretary", "caseManager", "platformAdmin"]),
      ).toBeNull();
      //    Any other act is invalid input.
      expect((await choicesOf(s, "committeeSecretary", f.pkg, "OTHER")).error).toBe("CDF_INVALID:act");
      //    The minutes: none while in review; once every attending member approves them, offered and accepted.
      await s.as("committeeSecretary");
      await s.tx`select api.close_meeting(${f.meeting.meeting}, ${REASON})`;
      const [minutes] = await s.tx<{ id: string }[]>`
        select api.generate_minutes(${f.meeting.meeting}, 'Synthetic minutes narrative.') as id`;
      expect((await choices(s, f.pkg, "REQUEST", ["committeeSecretary"]))!.minutes).toEqual([]);
      for (const u of DECISION_VOTERS) {
        await s.as(u);
        await s.tx`select api.review_minutes(${minutes!.id}, 'APPROVE', null)`;
      }
      expect(
        (await choices(s, f.pkg, "REQUEST", ["committeeSecretary"]))!.minutes.map((m) => m.minutes_id),
      ).toEqual([minutes!.id]);

      // 3. Asked of legalB: the reviewer reads the request and may answer it; the secretary may cancel it.
      const first = (await requestLegalReview(s, f)).request;
      await acts(s, cp);
      let review = (await opinions(s, first))!;
      expect(review).toMatchObject({
        status: "ASSIGNED",
        basis: "RULE",
        reason: REASON,
        requested_by: { user_id: USERS.committeeSecretary },
        capabilities: { may_give_opinion: true, may_give_superseding_opinion: false },
        opinion_block: null,
        superseding_opinion_block: "OPINION_NOT_GIVEN",
      });
      p = await secretaryPackage(s, cp);
      expect(p.status).toBe("IN_LEGAL_REVIEW");
      expect(
        p.legal_review.requests.map((r) => [r.status, r.reviewer.user_id, r.capabilities.may_cancel]),
      ).toEqual([["ASSIGNED", USERS.legalB, true]]);
      expect([p.capabilities.may_request_legal_review, p.request_legal_review_block]).toEqual([false, null]);
      expect(await choices(s, f.pkg, "REQUEST", ["committeeSecretary"])).toBeNull();

      // 4. Cancelled (AMB-115): the reviewer no longer reads it, and the package is adopted again.
      await s.as("committeeSecretary");
      await s.tx`select api.cancel_legal_review_request(${first}, ${CANCELLED})`;
      await acts(s, cp);
      expect(await opinions(s, first)).toBeNull();
      p = await secretaryPackage(s, cp);
      expect(p.legal_review.requests[0]).toMatchObject({
        request_id: first,
        status: "CANCELLED",
        cancellation: { reason: CANCELLED },
        capabilities: { may_cancel: false },
      });
      expect(p.capabilities.may_request_legal_review).toBe(true);

      // 5. Asked again and answered: an opinion is given once; a superseding one is open until the submission.
      const second = await reviewed(s, f);
      await acts(s, cp);
      review = (await opinions(s, second))!;
      expect(review).toMatchObject({
        status: "OPINION_GIVEN",
        opinion: "CONCURS",
        capabilities: { may_give_opinion: false, may_give_superseding_opinion: true },
        opinion_block: "OPINION_ALREADY_GIVEN",
        superseding_opinion_block: null,
      });
      p = await secretaryPackage(s, cp);
      expect(p.capabilities).toMatchObject({ may_request_legal_review: true, may_submit_to_authority: true });

      // 6. A superseding opinion with a comment: both are kept (AMB-117).
      await s.as("legalB");
      await s.tx`select api.give_superseding_legal_opinion(${second}, 'CONCURS_WITH_COMMENTS', ${COMMENT})`;
      review = (await opinions(s, second, ["legalB", "committeeSecretary", "investigatorB"]))!;
      expect(review.revisions).toMatchObject([
        { revision_no: 2, opinion: "CONCURS_WITH_COMMENTS", opinion_text: COMMENT },
      ]);
      expect(review.capabilities.may_give_superseding_opinion).toBe(true);
      p = await secretaryPackage(s, cp);
      // By id: both requests were made in this test's one transaction, at the same now().
      expect(p.legal_review.requests.map((r) => r.request_id).sort()).toEqual([first, second].sort());
      expect(p.legal_review.requests.find((r) => r.request_id === second)!.revisions).toMatchObject([
        { revision_no: 2, opinion_text: COMMENT },
      ]);

      // 7. Submitted: two authorities, and neither's decision alone completes the round. The reviewer's superseding
      //    path closes with the submission. A sanction rule set after the submission changes nothing in this round:
      //    the round requires what the submission recorded (DEC-F13).
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      await s.as("platformAdmin");
      await s.tx`select api.set_action_authority_rule('DISCIPLINARY_SANCTION', 'BOARD', now(), 'SOURCE_REQUIRED',
        'Synthetic: the board decides sanctions from now on.')`;
      await acts(s, cp);
      review = (await opinions(s, second))!;
      expect(review.superseding_opinion_block).toBe("PACKAGE_NOT_ADOPTED");
      p = await secretaryPackage(s, cp);
      expect(p.authority.to_decide).toEqual([
        { authority_type: "BOARD", item_ids: [f.corrective], completes_round: false },
        { authority_type: "CEO", item_ids: [f.sanction], completes_round: false },
      ]);
      //    The rules show what a submission would snapshot now.
      expect(p.authority.rules.map((r) => [r.item_type, r.authority_types])).toEqual([
        ["CORRECTIVE_ACTION", ["BOARD"]],
        ["DISCIPLINARY_SANCTION", ["BOARD"]],
      ]);
      expect(p.record_outcomes).toEqual(OUTCOMES);
      expect(p.record_supersedes).toBeNull();
      expect(p.authority.submissions).toMatchObject([{ package_round: 1, basis: "SUBMISSION" }]);
      expect(
        p.authority.submissions[0]!.requirements.map((q) => [
          q.item_id,
          q.authority_type,
          q.rule_source_status,
        ]).sort(),
      ).toEqual(
        [
          [f.corrective, "BOARD", "SOURCE_REQUIRED"],
          [f.sanction, "CEO", "OWNER_DEFAULT"],
        ].sort(),
      );
      //    item_ids are the scope the command takes: item outcomes for exactly them are accepted, for any other set not.
      const partial = (items: string[]) =>
        recordSql(
          f.pkg,
          "CEO",
          "APPROVE_PARTIALLY",
          `'${JSON.stringify(items.map((i) => ({ item_id: i, outcome: "APPROVED" })))}'::jsonb`,
        );
      expect(
        await outcomes(s, "committeeSecretary", {
          exact: partial([f.sanction]),
          other: partial([f.corrective]),
          both: partial([f.sanction, f.corrective]),
        }),
      ).toEqual({ exact: true, other: "CDF_INVALID:item_outcomes", both: "CDF_INVALID:item_outcomes" });
      //    completes_round: either decision alone leaves the package with the authority.
      for (const a of ["BOARD", "CEO"])
        expect(await statusAfter(s, f.pkg, recordSql(f.pkg, a, "APPROVE_AS_RECOMMENDED")), a).toBe(
          "AWAITING_AUTHORITY",
        );

      // 8. The CEO decides the sanction: the reviewer's purpose has ended, and the board's decision now completes the
      //    round.
      await record(s, f.pkg, "CEO", "APPROVE_AS_RECOMMENDED");
      await acts(s, cp);
      expect(await opinions(s, second)).toBeNull();
      p = await secretaryPackage(s, cp);
      expect(p.authority.to_decide).toEqual([
        { authority_type: "BOARD", item_ids: [f.corrective], completes_round: true },
      ]);
      expect(await statusAfter(s, f.pkg, recordSql(f.pkg, "BOARD", "APPROVE_AS_RECOMMENDED"))).toBe(
        "DECIDED",
      );

      // 9. The board decides: the package is decided, and nothing is offered.
      await record(s, f.pkg, "BOARD", "APPROVE_AS_RECOMMENDED");
      await acts(s, cp);
      p = await secretaryPackage(s, cp);
      expect(p.status).toBe("DECIDED");
      expect(p.decided_at).not.toBeNull();
      expect(p.authority.to_decide).toEqual([]);
      expect(
        [...p.authority.decisions]
          .sort((a, b) => a.authority_type.localeCompare(b.authority_type))
          .map((d) => ({
            authority_type: d.authority_type,
            outcome: d.outcome,
            sources: d.sources,
            scope: d.scope,
            conditions: d.conditions,
            superseded: d.superseded,
          })),
      ).toEqual([
        {
          authority_type: "BOARD",
          outcome: "APPROVE_AS_RECOMMENDED",
          sources: [{ position: 1, reference: MEMO, is_primary: true }],
          scope: [{ item_id: f.corrective, item_outcome: "APPROVED", modification: null }],
          conditions: [],
          superseded: null,
        },
        {
          authority_type: "CEO",
          outcome: "APPROVE_AS_RECOMMENDED",
          sources: [{ position: 1, reference: MEMO, is_primary: true }],
          scope: [{ item_id: f.sanction, item_outcome: "APPROVED", modification: null }],
          conditions: [],
          superseded: null,
        },
      ]);

      // The case's history: every one of these events reaches the case team as a code and a time, nothing more; the
      // committee side and the reviewer read no case history.
      const expected = [
        "LEGAL_REVIEW_REQUESTED",
        "LEGAL_REVIEW_CANCELLED",
        "LEGAL_REVIEW_REQUESTED",
        "LEGAL_OPINION_GIVEN",
        "LEGAL_OPINION_SUPERSEDED",
        "RECOMMENDATION_PACKAGE_SUBMITTED_TO_AUTHORITY",
        "AUTHORITY_DECISION_RECORDED",
        "AUTHORITY_DECISION_RECORDED",
      ];
      for (const u of ["caseManager", "investigatorB"] as const) {
        const rows = await packageHistory(s, u, caseB, mark);
        expect(
          rows.map((r) => r.action),
          u,
        ).toEqual(expected);
        for (const r of rows)
          expect(r, `${u} ${r.action}`).toMatchObject({
            actor_id: null,
            actor_name: null,
            subject_name: null,
            reason: null,
            detail: null,
          });
      }
      for (const u of ["committeeSecretary", "committeeChair", "legalB", "platformAdmin"] as const)
        expect(await packageHistory(s, u, caseB, mark), u).toEqual([]);
    });
  });

  it("a review the secretary elects: asked of a member who also reviews (cancelled, then refused once they lose the reviewer role), then superseded by an opinion that returns the package; a package that needs no review waits for an authority rule, then goes to the authority at once, which returns it", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      await seat(s, ic, DECISION_SEATS);
      // The secretary also holds LEGAL_OPINION_GIVE here, and is never their own reviewer.
      await s.as("platformAdmin");
      await s.tx`select api.grant_role(${USERS.committeeSecretary}, 'LEGAL_REVIEWER', 'Synthetic: the secretary also reviews.')`;
      const facts = await caseFacts(s, caseB);
      const meeting = await scheduleMeeting(s, ic, caseB);
      await openWithPresent(s, meeting, DECISION_VOTERS);
      const cp = meeting.committeeProceeding;
      // Two packages, each with one corrective action and no sanction: no rule requires a review, and no rule in force
      // names the authority for corrective actions yet.
      const fixtures: PackageFixture[] = [];
      for (const text of [
        "Synthetic: strengthen the approval controls.",
        "Synthetic: train the approvers.",
      ]) {
        await s.as("committeeSecretary");
        const [pkg] = await s.tx<{ id: string }[]>`
          select api.create_recommendation_package(${cp}, 'PACKAGE') as id`;
        const [item] = await s.tx<{ id: string }[]>`
          select api.add_recommendation_item(${pkg!.id}, 'CORRECTIVE_ACTION', null, null, ${text}, null, null) as id`;
        const f: PackageFixture = {
          ...facts,
          meeting,
          pkg: pkg!.id,
          sanction: item!.id,
          corrective: item!.id,
        };
        await closePackageVotes(s, f);
        await s.tx`select api.record_package_adoption(${f.pkg})`;
        fixtures.push(f);
      }
      const [a, b] = fixtures as [PackageFixture, PackageFixture];
      //    The submission fails closed without a rule (DEC-F13), and the rules say so.
      await acts(s, cp);
      for (const n of [0, 1]) {
        const p = await secretaryPackage(s, cp, n);
        expect(p.legal_review.required).toBe(false);
        expect(p.capabilities).toMatchObject({
          may_request_legal_review: true,
          may_submit_to_authority: false,
        });
        expect(p.submit_block).toBe("AUTHORITY_RULE_MISSING");
        expect(p.authority.rules).toEqual([
          {
            item_type: "CORRECTIVE_ACTION",
            rule_id: null,
            authority_types: [],
            source_status: null,
            coverage: "NO_RULE",
            setting_disagreement: false,
          },
        ]);
      }
      await authorityRuleFor(s, "CORRECTIVE_ACTION");
      await acts(s, cp);
      for (const n of [0, 1]) {
        const p = await secretaryPackage(s, cp, n);
        expect(p.capabilities).toMatchObject({
          may_request_legal_review: true,
          may_submit_to_authority: true,
        });
      }
      expect(
        sorted((await choices(s, a.pkg, "REQUEST", ["committeeSecretary"]))!.reviewers.map((r) => r.user_id)),
      ).toEqual(sorted([USERS.legal, USERS.legalB]));

      // Package A, asked of legal, who sits on the committee and so reads the packet as a member too. Cancelled: legal
      // still reads the request, which says it is cancelled. Asked again, then legal loses the reviewer role: legal
      // still reads it, and may give neither opinion (FORBIDDEN).
      const askLegal = async () => {
        await s.as("committeeSecretary");
        const [r] = await s.tx<{ id: string }[]>`
          select api.request_legal_review(${a.pkg}, ${USERS.legal}, ${REASON}, null, null) as id`;
        return r!.id;
      };
      const cancelled = await askLegal();
      await s.tx`select api.cancel_legal_review_request(${cancelled}, ${CANCELLED})`;
      let review = (await opinions(s, cancelled, ["legal", "legalB", "committeeSecretary"]))!;
      expect([review.status, review.opinion_block]).toEqual(["CANCELLED", "REQUEST_CANCELLED"]);
      const unanswered = await askLegal();
      await s.asOwner();
      const [role] = await s.tx<{ id: string }[]>`
        select id from iam.user_role_assignment
        where user_id = ${USERS.legal} and role_code = 'LEGAL_REVIEWER' and status = 'ACTIVE'`;
      await s.as("platformAdmin");
      await s.tx`select api.revoke_role(${role!.id}, ${REASON})`;
      review = (await opinions(s, unanswered, ["legal", "legalB", "committeeSecretary"]))!;
      expect(review).toMatchObject({
        status: "ASSIGNED",
        capabilities: { may_give_opinion: false, may_give_superseding_opinion: false },
        opinion_block: "FORBIDDEN",
        superseding_opinion_block: "FORBIDDEN",
      });
      await s.as("committeeSecretary");
      await s.tx`select api.cancel_legal_review_request(${unanswered}, ${CANCELLED})`;

      // Then legalB: concurs, then supersedes it with CONFLICTS, which returns the package (AMB-117). Nothing after the
      // adoption is offered on a returned package.
      const request = await reviewed(s, a);
      review = (await opinions(s, request, ["legalB", "committeeSecretary"]))!;
      expect(review).toMatchObject({
        basis: "SECRETARY_ELECTED",
        capabilities: { may_give_superseding_opinion: true },
      });
      await s.as("legalB");
      await s.tx`select api.give_superseding_legal_opinion(${request}, 'CONFLICTS', ${COMMENT})`;
      await acts(s, cp);
      review = (await opinions(s, request))!;
      expect(review).toMatchObject({
        capabilities: { may_give_opinion: false, may_give_superseding_opinion: false },
        opinion_block: "OPINION_ALREADY_GIVEN",
        superseding_opinion_block: "PACKAGE_NOT_ADOPTED",
      });
      let p = await secretaryPackage(s, cp, 0);
      expect(p.status).toBe("RETURNED_BY_LEGAL");
      expect([p.request_legal_review_block, p.submit_block, p.record_block]).toEqual([null, null, null]);

      // Package B: straight to the authority, whose single decision completes the round; it returns the package.
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${b.pkg})`;
      await acts(s, cp);
      p = await secretaryPackage(s, cp, 1);
      expect(p.authority.to_decide).toEqual([
        { authority_type: "CEO", item_ids: [b.corrective], completes_round: true },
      ]);
      expect(p.legal_review.requests).toEqual([]);
      await record(s, b.pkg, "CEO", "RETURN_TO_COMMITTEE");
      await acts(s, cp, ["committeeSecretary", "committeeChair", "investigatorB"]);
      p = await secretaryPackage(s, cp, 1);
      expect(p.status).toBe("RETURNED_BY_AUTHORITY");
      // The returned package is the committee's to edit and put to the vote again (2086); nothing after the adoption.
      expect(p.capabilities).toEqual({
        may_add_item: true,
        may_submit_for_vote: true,
        may_record_adoption: false,
        may_return_to_committee: false,
        may_request_legal_review: false,
        may_submit_to_authority: false,
        may_record_authority_decision: false,
      });
      expect([p.request_legal_review_block, p.submit_block, p.record_block]).toEqual([null, null, null]);
    });
  });

  it("a taint waits for the committee (DEC-AMB-003): no opinion, no new request, and the authority may only return the package; the committee's confirmation gives them back", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      // Everyone approves: no single vote decides, so the committee may confirm its result after a conflict. A first
      // review is answered before the conflict is upheld; a second is open when it is.
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      const answered = await reviewed(s, f);
      const { request } = await requestLegalReview(s, f);
      await upheldOn(s, f.meeting, "lead", "legal");
      await acts(s, cp, ["committeeSecretary", "committeeChair", "legalB", "investigatorB"]);
      let review = (await opinions(s, request, ["legalB", "committeeSecretary"]))!;
      expect(review).toMatchObject({
        capabilities: { may_give_opinion: false },
        opinion_block: "TAINTED_BY_CONFLICT",
      });
      //    Cancelling is not progress: the secretary may still cancel, and the package may not be asked again.
      let p = await secretaryPackage(s, cp);
      expect(p.legal_review.requests.find((r) => r.request_id === request)!.capabilities.may_cancel).toBe(
        true,
      );
      await s.as("committeeSecretary");
      await s.tx`select api.cancel_legal_review_request(${request}, ${CANCELLED})`;
      await acts(s, cp, ["committeeSecretary", "committeeChair", "investigatorB"]);
      p = await secretaryPackage(s, cp);
      expect([p.capabilities.may_request_legal_review, p.request_legal_review_block]).toEqual([
        false,
        "TAINTED_BY_CONFLICT",
      ]);
      expect(await choices(s, f.pkg, "REQUEST", ["committeeSecretary"])).toBeNull();
      //    The answered review would let the package go to the authority, but neither the submission nor a superseding
      //    opinion moves while the taint waits.
      expect([p.capabilities.may_submit_to_authority, p.submit_block]).toEqual([
        false,
        "TAINTED_BY_CONFLICT",
      ]);
      review = (await opinions(s, answered, ["legalB"]))!;
      expect([review.capabilities.may_give_superseding_opinion, review.superseding_opinion_block]).toEqual([
        false,
        "TAINTED_BY_CONFLICT",
      ]);

      // The committee confirms its result: the one package vote carried both items, so one confirmation clears both,
      // and the review may be asked and answered again.
      await s.as("committeeSecretary");
      await s.tx`select api.resolve_conflict_taint(${f.corrective}, 'CONFIRM', ${FIRM})`;
      await acts(s, cp, ["committeeSecretary", "investigatorB"]);
      const again = await reviewed(s, f);
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;

      // A conflict on legal's participation, raised by the secretary (the lead, found conflicted, raises none) and
      // upheld while the package is with the authority: the authority may only return it.
      await upheldOn(s, f.meeting, "legal", "committeeSecretary");
      await acts(s, cp);
      await opinions(s, again, ["legalB"]);
      p = await secretaryPackage(s, cp);
      expect(p.capabilities.may_record_authority_decision).toBe(true);
      expect(p.record_outcomes).toEqual(["RETURN_TO_COMMITTEE"]);
      expect(p.record_block).toBeNull();
      await record(s, f.pkg, "CEO", "RETURN_TO_COMMITTEE");
      await acts(s, cp, ["committeeSecretary", "committeeChair", "investigatorB"]);
      expect((await secretaryPackage(s, cp)).status).toBe("RETURNED_BY_AUTHORITY");
    });
  });

  it("a re-decision after the committee votes again supersedes the earlier round's decisions and freezes their actions: what recording would supersede is given as counts, and is what the command then does, with two authorities to a round and after a second re-vote (DEC-AMB-013, DEC-AMB-014, ruling 3)", async () => {
    await ownerScenario(async (s) => {
      const mark = await ledgerMark();
      await install(s);
      await s.as("platformAdmin");
      await s.tx`select api.grant_role(${USERS.financeEmployee}, 'IMPLEMENTATION_OWNER',
        'Synthetic: implementation owner for the test')`;
      // The board decides corrective actions here, and the CEO the sanction: two authorities decide every round.
      await s.tx`select api.set_action_authority_rule('CORRECTIVE_ACTION', 'BOARD', now(), 'SOURCE_REQUIRED',
        'Synthetic: the board decides corrective actions.')`;
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      expect(await voteOnPackage(s, f, decisive)).toBe("ADOPTED");
      await reviewed(s, f);
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      const d1 = await record(s, f.pkg, "CEO", "APPROVE_AS_RECOMMENDED", "MEMO-DEMO-2095-1");
      const b1 = await record(s, f.pkg, "BOARD", "APPROVE_AS_RECOMMENDED", "MEMO-DEMO-2095-1B");
      await s.as("caseManager");
      await s.tx`select api.open_corrective_action(${f.corrective}, 'Synthetic: strengthen approval controls',
        'Synthetic: add a second approver to payments above the threshold.', ${USERS.financeEmployee},
        (now() at time zone 'Asia/Riyadh')::date + 5)`;

      // The lead's decisive vote is found conflicted; the committee votes again without them (legal approves, the
      // chair abstains), adopts, and the new round is reviewed and submitted.
      await upheldOn(s, f.meeting, "lead", "legal");
      await s.as("committeeSecretary");
      await s.tx`select api.resolve_conflict_taint(${f.sanction}, 'RE_VOTE', ${FIRM})`;
      await revote(s, f, 2, { committeeChair: "ABSTAIN", legal: "APPROVE" });
      await acts(s, cp, ["committeeSecretary", "committeeChair", "investigatorB"]);
      expect((await secretaryPackage(s, cp)).submit_block).toBe("LEGAL_REVIEW_REQUIRED");
      await reviewed(s, f);
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;

      // The decision that completes the round would supersede the first round's two decisions and freeze its one
      // action. The first of the round's two decisions completes nothing, and the counts stay those of the first round.
      await acts(s, cp);
      let p = await secretaryPackage(s, cp);
      expect(p.round_no).toBe(2);
      expect(p.authority.to_decide).toEqual([
        { authority_type: "BOARD", item_ids: [f.corrective], completes_round: false },
        { authority_type: "CEO", item_ids: [f.sanction], completes_round: false },
      ]);
      expect(p.record_supersedes).toEqual({ decisions: 2, corrective_actions: 1 });
      //    Only the secretary is told (counts, ruling 3); the case team and members read null.
      for (const u of ["committeeChair", "investigatorB", "caseManager"] as const)
        expect((await itemsView(s, u, cp))!.packages[0]!.record_supersedes, u).toBeNull();
      const d2 = await record(s, f.pkg, "CEO", "APPROVE_AS_RECOMMENDED", "MEMO-DEMO-2095-2");
      await acts(s, cp, ["committeeSecretary", "committeeChair", "investigatorB"]);
      p = await secretaryPackage(s, cp);
      expect(p.authority.to_decide).toEqual([
        { authority_type: "BOARD", item_ids: [f.corrective], completes_round: true },
      ]);
      expect(p.record_supersedes).toEqual({ decisions: 2, corrective_actions: 1 });
      const before = (await events(s, "CORRECTIVE_ACTION_FROZEN")).length;
      const b2 = await record(s, f.pkg, "BOARD", "APPROVE_AS_RECOMMENDED", "MEMO-DEMO-2095-2B");
      await s.asOwner();
      const superseded = await s.tx<{ decision_id: string }[]>`
        select decision_id from decision.authority_decision_supersession where package_id = ${f.pkg}`;
      //    Which decision of the new round supersedes each is the record command's (CDF-228, placed in 2170).
      expect(sorted(superseded.map((x) => x.decision_id))).toEqual(sorted([d1, b1]));
      expect((await events(s, "CORRECTIVE_ACTION_FROZEN")).length - before).toBe(1);

      // Decided again: the earlier decisions are marked superseded, never edited; nothing more is offered.
      await acts(s, cp);
      const decided = await secretaryPackage(s, cp);
      expect(decided.record_supersedes).toBeNull();
      expect(decided.authority.decisions.map((d) => [d.package_round, d.superseded === null])).toEqual([
        [1, false],
        [1, false],
        [2, true],
        [2, true],
      ]);
      expect(
        sorted(decided.authority.decisions.filter((d) => d.package_round === 2).map((d) => d.decision_id)),
      ).toEqual(sorted([d2, b2]));
      expect(decided.authority.submissions.map((x) => x.package_round)).toEqual([1, 2]);
      const history = (await packageHistory(s, "caseManager", caseB, mark)).map((r) => r.action);
      expect(history.filter((x) => x === "AUTHORITY_DECISION_SUPERSEDED")).toHaveLength(2);

      // Legal then declares a conflict, which taints their decisive vote of the second round: the committee votes a
      // third time, the chair alone. The first remediation is closed and counts for nothing: recording now would
      // supersede the second round's two decisions and no action (the frozen one executes the first round's).
      await s.as("legal");
      await s.tx`select api.declare_meeting_conflict(${f.meeting.participant.legal!}, 'CONFLICT_DECLARED',
        'Synthetic: a relationship came to light.')`;
      await s.as("committeeSecretary");
      await s.tx`select api.resolve_conflict_taint(${f.sanction}, 'RE_VOTE', ${FIRM})`;
      await revote(s, f, 3, { committeeChair: "APPROVE" });
      await reviewed(s, f);
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      await acts(s, cp, ["committeeSecretary", "committeeChair", "investigatorB"]);
      p = await secretaryPackage(s, cp);
      expect([p.round_no, p.record_supersedes]).toEqual([3, { decisions: 2, corrective_actions: 0 }]);
    });
  });

  it("a restricted case (DEC-F20): the secretary waits for the case authority's approval, which only the case owner gives from the same choices; the request then takes exactly the approval's reviewer and scope (ruling 2)", async () => {
    await ownerScenario(async (s) => {
      const mark = await ledgerMark();
      await install(s);
      // AGENT-09 W2 on the restricted SECRET case 0003 (owner grcDirector): referred after its preliminary review and
      // its authority's approval; a cleared member adopts a corrective action. legalB is cleared to SECRET; legal is
      // not.
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET'
                 where id in (${USERS.committeeSecretary}, ${USERS.legalB})`;
      await seat(s, ic, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["grcDeputy", "MEMBER"],
      ]);
      await authorityRuleFor(s, "CORRECTIVE_ACTION");
      await preliminaryReferral(s, caseExec);
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_committee_referral(${caseExec}, ${ic}, ${REASON})`;
      const [cp] = await s.tx<{ id: string }[]>`
        select api.refer_case_to_committee(${caseExec}, ${ic}, null, ${REASON}) as id`;
      const [proceeding] = await s.tx<{ id: string }[]>`
        select api.open_proceeding(${caseExec}, 'INVESTIGATION', null, ${REASON}) as id`;
      const [subject] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseExec}, 'Employee Phi (synthetic)', 'EMPLOYEE', null) as id`;
      const [allegation] = await s.tx<{ id: string }[]>`
        select api.add_allegation(${caseExec}, 'FRAUD', 'Synthetic: allegation against Employee Phi.', ${subject!.id},
          null, null) as id`;
      const [finding] = await s.tx<{ id: string }[]>`
        select api.record_finding(${allegation!.id}, null, ${proceeding!.id}, 'SUBSTANTIATED',
          'Synthetic: finding rationale text.') as id`;
      await s.as("committeeSecretary");
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp!.id}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`;
      const [part] = await s.tx<{ id: string }[]>`
        select id from committee.meeting_participant where meeting_id = ${m!.id} and user_id = ${USERS.grcDeputy}`;
      await s.as("grcDeputy");
      await s.tx`select api.declare_meeting_conflict(${part!.id}, 'NO_CONFLICT', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${m!.id}, ${REASON})`;
      await s.tx`select api.record_attendance(${part!.id}, 'PRESENT')`;
      const [pkg] = await s.tx<
        { id: string }[]
      >`select api.create_recommendation_package(${cp!.id}, 'PACKAGE') as id`;
      await s.tx`select api.add_recommendation_item(${pkg!.id}, 'CORRECTIVE_ACTION', null, null,
        'Synthetic: tighten the approval controls.', null, null)`;
      await s.tx`select api.submit_package_for_vote(${pkg!.id})`;
      await s.tx`select api.open_package_vote(${m!.id}, ${pkg!.id})`;
      const [vi] = await s.tx<
        { id: string }[]
      >`select id from committee.vote_item where package_id = ${pkg!.id}`;
      await s.as("grcDeputy");
      await s.tx`select api.cast_vote(${vi!.id}, 'APPROVE', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${vi!.id}, null)`;
      await s.tx`select api.record_package_adoption(${pkg!.id})`;
      const callers: UserKey[] = [
        "committeeSecretary",
        "committeeChair",
        "grcDeputy",
        "grcDirector",
        "legalB",
        "legal",
        "platformAdmin",
      ];

      // 1. No approval: the secretary may not ask yet; the command answers AUTHORITY_APPROVAL_REQUIRED for the cleared
      //    reviewer (and INVALID for legal), and L2 refuses with it.
      await acts(s, cp!.id, callers);
      let p = await secretaryPackage(s, cp!.id);
      expect([p.capabilities.may_request_legal_review, p.request_legal_review_block]).toEqual([
        false,
        "AUTHORITY_APPROVAL_REQUIRED",
      ]);
      expect(await choices(s, pkg!.id, "REQUEST", ["committeeSecretary"])).toBeNull();

      // 2. The case owner, its Restricted Case Authority, approves from the same choices as an unrestricted request:
      //    both holders (legal listed, though the case gate refuses them), the committee's scope and approved minutes.
      //    Anyone else gets the command's refusal.
      const approve = (await choices(s, pkg!.id, "APPROVE", [
        "grcDirector",
        "committeeSecretary",
        "grcDeputy",
        "committeeChair",
        "legalB",
        "platformAdmin",
      ]))!;
      expect(approve.reviewers.map((r) => r.user_id)).toEqual([USERS.legal, USERS.legalB]);
      expect(approve.restricted).toBe(true);
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_legal_review(${pkg!.id}, ${USERS.legalB}, ${[finding!.id]}::uuid[],
        null, ${REASON})`;
      //    One approval pending at a time: the command and L2 both refuse a second.
      expect(await choices(s, pkg!.id, "APPROVE", ["grcDirector"])).toBeNull();

      // 3. The request takes exactly the approval: legalB and the finding it names; never the approval's reason.
      await acts(s, cp!.id, callers);
      p = await secretaryPackage(s, cp!.id);
      expect([p.capabilities.may_request_legal_review, p.request_legal_review_block]).toEqual([true, null]);
      const asked = (await choices(s, pkg!.id, "REQUEST", [
        "committeeSecretary",
        "committeeChair",
        "grcDirector",
      ]))!;
      expect(asked).toMatchObject({ restricted: true, minutes: [] });
      expect(asked.reviewers.map((r) => r.user_id)).toEqual([USERS.legalB]);
      expect(asked.findings.map((x) => x.finding_id)).toEqual([finding!.id]);
      expect(JSON.stringify(asked)).not.toContain(REASON);
      await s.as("committeeSecretary");
      const [request] = await s.tx<{ id: string }[]>`
        select api.request_legal_review(${pkg!.id}, ${USERS.legalB}, ${REASON}, ${[finding!.id]}::uuid[], null) as id`;
      await acts(s, cp!.id, callers);
      let review = (await opinions(s, request!.id, [
        "legalB",
        "legal",
        "committeeSecretary",
        "grcDirector",
      ]))!;
      expect(review.capabilities.may_give_opinion).toBe(true);
      //    The approval is spent, and the package is in legal review: the authority may not approve another
      //    (PACKAGE_NOT_ADOPTED, as the command answers).
      expect(await choices(s, pkg!.id, "APPROVE", ["grcDirector"])).toBeNull();

      // The case's history: the approval reaches the case authority only; the request reaches whoever reads the case
      // (a CASE grant here), as codes and times.
      await s.as("grcDirector");
      await s.tx`select api.grant_case_access(${caseExec}, ${USERS.grcDeputy}, 'CASE', ${REASON}, null)`;
      expect((await packageHistory(s, "grcDirector", caseExec, mark)).map((r) => r.action)).toEqual([
        "RESTRICTED_LEGAL_REVIEW_APPROVED",
        "LEGAL_REVIEW_REQUESTED",
      ]);
      expect((await packageHistory(s, "grcDeputy", caseExec, mark)).map((r) => r.action)).toEqual([
        "LEGAL_REVIEW_REQUESTED",
      ]);
      for (const r of await packageHistory(s, "grcDirector", caseExec, mark))
        expect(r, r.action).toMatchObject({ actor_id: null, reason: null, detail: null });
      expect(await packageHistory(s, "committeeSecretary", caseExec, mark)).toEqual([]);

      // 4. Answered: the approval went with its request, so another review waits for another approval.
      await s.as("legalB");
      await s.tx`select api.give_legal_opinion(${request!.id}, 'CONCURS', null)`;
      await acts(s, cp!.id, callers);
      p = await secretaryPackage(s, cp!.id);
      expect([p.capabilities.may_request_legal_review, p.request_legal_review_block]).toEqual([
        false,
        "AUTHORITY_APPROVAL_REQUIRED",
      ]);
      expect(await choices(s, pkg!.id, "REQUEST", ["committeeSecretary"])).toBeNull();

      // 5. An approval of one round is not one of the next: the authority approves again, the committee takes the
      //    package back and adopts it in a second round, and the secretary waits again. The opinion was about the
      //    first round's adoption, so it may no longer be superseded.
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_legal_review(${pkg!.id}, ${USERS.legalB}, ${[finding!.id]}::uuid[],
        null, ${REASON})`;
      await s.as("committeeSecretary");
      await s.tx`select api.return_package_to_committee(${pkg!.id}, ${REASON})`;
      await s.tx`select api.submit_package_for_vote(${pkg!.id})`;
      await s.tx`select api.open_package_vote(${m!.id}, ${pkg!.id})`;
      const [vi2] = await s.tx<{ id: string }[]>`
        select id from committee.vote_item where package_id = ${pkg!.id} and package_round = 2`;
      await s.as("grcDeputy");
      await s.tx`select api.cast_vote(${vi2!.id}, 'APPROVE', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${vi2!.id}, null)`;
      await s.tx`select api.record_package_adoption(${pkg!.id})`;
      await acts(s, cp!.id, callers);
      p = await secretaryPackage(s, cp!.id);
      expect([p.round_no, p.capabilities.may_request_legal_review, p.request_legal_review_block]).toEqual([
        2,
        false,
        "AUTHORITY_APPROVAL_REQUIRED",
      ]);
      review = (await opinions(s, request!.id, ["legalB", "committeeSecretary"]))!;
      expect([review.capabilities.may_give_superseding_opinion, review.superseding_opinion_block]).toEqual([
        false,
        "PACKAGE_NOT_ADOPTED",
      ]);

      // 6. The meeting's minutes, once approved, are among the authority's choices; an approval that names none gives
      //    the secretary none (ruling 2).
      await s.as("committeeSecretary");
      await s.tx`select api.close_meeting(${m!.id}, ${REASON})`;
      const [minutes] = await s.tx<{ id: string }[]>`
        select api.generate_minutes(${m!.id}, 'Synthetic minutes narrative.') as id`;
      await s.as("grcDeputy");
      await s.tx`select api.review_minutes(${minutes!.id}, 'APPROVE', null)`;
      expect(
        (await choices(s, pkg!.id, "APPROVE", ["grcDirector"]))!.minutes.map((x) => x.minutes_id),
      ).toEqual([minutes!.id]);
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_legal_review(${pkg!.id}, ${USERS.legalB}, ${[finding!.id]}::uuid[],
        null, ${REASON})`;
      const again = (await choices(s, pkg!.id, "REQUEST", ["committeeSecretary"]))!;
      expect([
        again.reviewers.map((r) => r.user_id),
        again.findings.map((x) => x.finding_id),
        again.minutes,
      ]).toEqual([[USERS.legalB], [finding!.id], []]);

      // 7. Asked again; then the case owner loses the GRC Director role, and with it the Restricted Case Authority.
      //    They still read the case as its owner, and may not approve (FORBIDDEN, as the command answers).
      await s.as("committeeSecretary");
      await s.tx`select api.request_legal_review(${pkg!.id}, ${USERS.legalB}, ${REASON}, ${[finding!.id]}::uuid[], null)`;
      await s.asOwner();
      const [role] = await s.tx<{ id: string }[]>`
        select id from iam.user_role_assignment
        where user_id = ${USERS.grcDirector} and role_code = 'GRC_DIRECTOR' and status = 'ACTIVE'`;
      await s.as("platformAdmin");
      await s.tx`select api.revoke_role(${role!.id}, ${REASON})`;
      expect((await choicesOf(s, "grcDirector", pkg!.id, "APPROVE")).error).toBe("CDF_FORBIDDEN");
      expect(await choices(s, pkg!.id, "APPROVE", ["grcDirector"])).toBeNull();
    });
  });

  it("voted item by item: an item the committee rejects is not the authority's; the rules, the choices and what the authority decides cover the adopted items only", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB, "ITEM");
      const cp = f.meeting.committeeProceeding;
      expect(await voteOnPackage(s, f, (target) => (target === f.corrective ? "REJECT" : "APPROVE"))).toBe(
        "ADOPTED",
      );
      await acts(s, cp, ["committeeSecretary", "committeeChair", "investigatorB"]);
      let p = await secretaryPackage(s, cp);
      expect(p.authority.rules.map((r) => r.item_type)).toEqual(["DISCIPLINARY_SANCTION"]);
      expect(
        (await choices(s, f.pkg, "REQUEST", ["committeeSecretary"]))!.items.map((i) => i.item_id),
      ).toEqual([f.sanction]);
      await reviewed(s, f);
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      await acts(s, cp, ["committeeSecretary", "committeeChair", "investigatorB"]);
      p = await secretaryPackage(s, cp);
      expect(p.authority.to_decide).toEqual([
        { authority_type: "CEO", item_ids: [f.sanction], completes_round: true },
      ]);
      expect(p.authority.submissions[0]!.requirements.map((r) => r.item_id)).toEqual([f.sanction]);
    });
  });

  it("an allegation withdrawn after its finding (2090): L2 no longer lists the finding, as R1 does not, while the request command would still take it; the page offers less, never more", async () => {
    await ownerScenario(async (s) => {
      const f = await referredPackage(s, caseB);
      const cp = f.meeting.committeeProceeding;
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      // A second allegation, in no item, with a finding of the referred investigation: in the committee's scope.
      await s.as("caseManager");
      const [x] = await s.tx<{ id: string }[]>`
        select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: a second allegation against Employee Sigma.',
          ${f.subject}, null, null) as id`;
      await s.as("investigatorB");
      const [found] = await s.tx<{ id: string }[]>`
        select api.record_finding(${x!.id}, null, ${f.proceeding}, 'NOT_SUBSTANTIATED',
          'Synthetic: the second allegation is not supported.') as id`;
      const listed = async () =>
        sorted(
          (await choices(s, f.pkg, "REQUEST", ["committeeSecretary"]))!.findings.map((g) => g.finding_id),
        );
      const r1 = async () => {
        await s.as("committeeSecretary");
        const [r] = await s.tx<{ v: { findings: { finding_id: string }[] } }[]>`
          select api.committee_scope_choices(${cp}) as v`;
        return sorted(r!.v.findings.map((g) => g.finding_id));
      };
      const open = await listed();
      expect(open).toEqual(sorted([f.finding, found!.id]));
      expect(await r1()).toEqual(open);
      // Withdrawn, its finding kept (2090): neither read offers the finding now.
      await s.as("caseManager");
      await s.tx`select api.withdraw_allegation(${x!.id}, ${REASON})`;
      const withdrawn = await listed();
      expect(withdrawn).toEqual([f.finding]);
      expect(await r1()).toEqual(withdrawn);
      // The request command takes any finding of the case, this one too.
      expect(
        await outcomes(s, "committeeSecretary", {
          withdrawn: `select api.request_legal_review('${f.pkg}', '${USERS.legalB}', '${REASON}', ${uuids([found!.id])}, null)`,
        }),
      ).toEqual({ withdrawn: true });
    });
  });

  it("known limitation (ADR-057): once the committee's proceeding is closed, the committee side no longer reads R2 while the authority command still accepts; the page offers less, never more", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      await reviewed(s, f);
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      await s.asOwner();
      const [own] = await s.tx<{ proceeding_id: string }[]>`
        select proceeding_id from committee.committee_proceeding where id = ${cp}`;
      await s.as("caseManager");
      await s.tx`select api.close_proceeding(${own!.proceeding_id}, 'CONCLUDED', 'DECISION_RECORDED', ${REASON})`;
      await acts(s, cp, ["committeeSecretary", "committeeChair", "investigatorB", "caseManager"]);
      expect(await itemsView(s, "committeeSecretary", cp)).toBeNull();
      expect(
        await outcomes(s, "committeeSecretary", {
          record: recordSql(f.pkg, "CEO", "APPROVE_AS_RECOMMENDED"),
        }),
      ).toEqual({ record: true });
      const team = (await itemsView(s, "investigatorB", cp))!;
      for (const p of team.packages) {
        expect(Object.values(p.capabilities).every((x) => x === false)).toBe(true);
        expect(p.record_outcomes).toEqual([]);
        expect(p.authority.to_decide.map((x) => x.authority_type)).toEqual(["CEO"]);
      }
    });
  });
});

describe("migration 2095: helpers, grants and what the reads write", () => {
  const HELPERS = [
    "authority_to_decide",
    "legal_opinion_refusal",
    "legal_review_cancel_refusal",
    "legal_review_request_refusal",
    "managed_package_refusal",
    "package_authority_rules",
    "record_refusal",
    "record_supersedes",
    "round_requirements",
    "submit_refusal",
    "superseding_opinion_refusal",
  ];
  const COMMANDS = [
    "approve_restricted_legal_review",
    "cancel_legal_review_request",
    "give_legal_opinion",
    "give_superseding_legal_opinion",
    "record_authority_decision",
    "request_legal_review",
    "submit_to_authority",
  ];

  it("every helper is internal and stable, the new reads are granted to authenticated only, and no read runs a command or a subtransaction to find its answer", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      const rows = await s.tx<
        {
          schema: string;
          name: string;
          volatile: string;
          authenticated: boolean;
          anon: boolean;
          src: string;
        }[]
      >`select n.nspname as schema, p.proname as name, p.provolatile as volatile, p.prosrc as src,
               has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
               has_function_privilege('anon', p.oid, 'execute') as anon
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where (n.nspname = 'decision' and p.proname = any(${HELPERS}))
           or (n.nspname = 'api' and p.proname in ('legal_review_view', 'legal_review_choices', 'committee_items_view'))
        order by 1, 2`;
      expect(
        rows.filter((r) => r.schema === "decision").map((r) => [r.name, r.volatile, r.authenticated, r.anon]),
      ).toEqual(HELPERS.map((h) => [h, "s", false, false]));
      expect(
        rows.filter((r) => r.schema === "api").map((r) => [r.name, r.volatile, r.authenticated, r.anon]),
      ).toEqual([
        ["committee_items_view", "v", true, false],
        ["legal_review_choices", "v", true, false],
        ["legal_review_view", "s", true, false],
      ]);
      for (const r of rows) {
        const code = r.src.replace(/--[^\n]*/g, "");
        expect(code, `${r.name}: no subtransaction`).not.toMatch(/\bexception\b/i);
        for (const c of COMMANDS) expect(code, `${r.name} runs ${c}`).not.toContain(`api.${c}(`);
        expect(code, `${r.name} takes no lock`).not.toMatch(/\bfor (update|share)\b/i);
      }
    });
  });
});
