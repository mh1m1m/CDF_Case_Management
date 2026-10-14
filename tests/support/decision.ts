// Recommendation package fixtures for the rebase security tests (migrations 1900 and 2030). Every call runs through the api.*
// commands as the acting user; nothing is inserted directly.
import { USERS, type Scenario, type UserKey } from "./db";
import { REASON, openWithPresent, scheduleMeeting, seat, type MeetingFixture } from "./committee";

/** Chair, secretary and two voting members. legalB holds LEGAL_REVIEWER and no seat: the legal reviewer. */
export const DECISION_SEATS: [UserKey, string][] = [
  ["committeeChair", "CHAIR"],
  ["committeeSecretary", "SECRETARY"],
  ["legal", "MEMBER"],
  ["lead", "MEMBER"],
];
export const DECISION_VOTERS: UserKey[] = ["committeeChair", "legal", "lead"];

export interface CaseFacts {
  proceeding: string;
  subject: string;
  allegation: string;
  finding: string;
}

/** Runs as the case manager right after the subject is added, before the allegation and finding. */
export type AfterSubject = (subject: string) => Promise<void>;

/** An investigation proceeding with one subject, one allegation against them and a substantiated finding. */
export async function caseFacts(
  s: Scenario,
  caseId: string,
  afterSubject?: AfterSubject,
): Promise<CaseFacts> {
  await s.as("caseManager");
  const [p] = await s.tx<{ id: string }[]>`
    select api.open_proceeding(${caseId}, 'INVESTIGATION', null, ${REASON}) as id`;
  const [subj] = await s.tx<{ id: string }[]>`
    select api.add_case_subject(${caseId}, 'Employee Sigma (synthetic)', 'EMPLOYEE', null) as id`;
  if (afterSubject) {
    await afterSubject(subj!.id);
    await s.as("caseManager");
  }
  const [a] = await s.tx<{ id: string }[]>`
    select api.add_allegation(${caseId}, 'FRAUD', 'Synthetic: allegation against Employee Sigma.', ${subj!.id}, null, null) as id`;
  await s.as("investigatorB");
  const [f] = await s.tx<{ id: string }[]>`
    select api.record_finding(${a!.id}, null, ${p!.id}, 'SUBSTANTIATED', 'Synthetic: finding rationale text.') as id`;
  return { proceeding: p!.id, subject: subj!.id, allegation: a!.id, finding: f!.id };
}

export interface PackageFixture extends CaseFacts {
  meeting: MeetingFixture;
  pkg: string;
  sanction: string;
  corrective: string;
}

/** DEC-F13 (migration 2030): submission fails closed while an adopted item type has no authority rule, and only the
 *  disciplinary rule is seeded. A fixture item of another type goes to the authority the disciplinary rule names (a
 *  synthetic SOURCE_REQUIRED rule set by the platform administrator), unless a rule for the type is already in force. */
export async function authorityRuleFor(s: Scenario, itemType: string): Promise<void> {
  await s.as("platformAdmin");
  const [r] = await s.tx<{ sanction: string; present: boolean }[]>`
    select (select authority_type from decision.action_authority_rule
            where item_type = 'DISCIPLINARY_SANCTION' and effective_from <= now()
              and (effective_to is null or effective_to > now())
            order by effective_from desc limit 1) as sanction,
           exists (select 1 from decision.action_authority_rule
                   where item_type = ${itemType} and effective_from <= now()
                     and (effective_to is null or effective_to > now())) as present`;
  if (!r!.present) {
    await s.tx`select api.set_action_authority_rule(${itemType}, ${r!.sanction}::text, now(), 'SOURCE_REQUIRED',
      'Synthetic: test fixture rule.')`;
  }
}

/** Seats the committee, refers the case, opens a meeting with the voters present and drafts a package holding a
 *  catalogue sanction on the subject and a case-wide corrective action. The subject has a defence notice on the
 *  allegation (AMB-026, migration 2030: the rule snapshot requires one before a sanction is adopted), and the
 *  corrective action has an authority rule (DEC-F13). */
export async function draftPackage(
  s: Scenario,
  committeeId: string,
  caseId: string,
  granularity: "PACKAGE" | "ITEM" = "PACKAGE",
  afterSubject?: AfterSubject,
): Promise<PackageFixture> {
  await seat(s, committeeId, DECISION_SEATS);
  await authorityRuleFor(s, "CORRECTIVE_ACTION");
  const facts = await caseFacts(s, caseId, afterSubject);
  await s.as("caseManager");
  await s.tx`select api.issue_defence_notice(${facts.subject}, 'Synthetic: you are invited to respond.',
    ${[facts.allegation]}::uuid[], now() + interval '10 days')`;
  const meeting = await scheduleMeeting(s, committeeId, caseId);
  await openWithPresent(s, meeting, DECISION_VOTERS);
  await s.as("committeeSecretary");
  const [pkg] = await s.tx<{ id: string }[]>`
    select api.create_recommendation_package(${meeting.committeeProceeding}, ${granularity}) as id`;
  const [sanction] = await s.tx<{ id: string }[]>`
    select api.add_recommendation_item(${pkg!.id}, 'DISCIPLINARY_SANCTION', 'WARNING', null,
      'Synthetic: written warning for Employee Sigma.', ${[facts.subject]}::uuid[], ${[facts.allegation]}::uuid[]) as id`;
  const [corrective] = await s.tx<{ id: string }[]>`
    select api.add_recommendation_item(${pkg!.id}, 'CORRECTIVE_ACTION', null, null,
      'Synthetic: strengthen the approval controls.', null, null) as id`;
  return { ...facts, meeting, pkg: pkg!.id, sanction: sanction!.id, corrective: corrective!.id };
}

/** Submits the package, opens its votes and has every voter cast the choice for each vote item (by item id, or
 *  'PACKAGE', and voter), then closes the items. Adoption is left to the caller. */
export async function closePackageVotes(
  s: Scenario,
  f: PackageFixture,
  choiceFor: (target: string, voter: UserKey) => string = () => "APPROVE",
  voters: UserKey[] = DECISION_VOTERS,
): Promise<void> {
  await s.as("committeeSecretary");
  await s.tx`select api.submit_package_for_vote(${f.pkg})`;
  await s.tx`select api.open_package_vote(${f.meeting.meeting}, ${f.pkg})`;
  const items = await s.tx<{ id: string; recommendation_item_id: string | null }[]>`
    select vi.id, vi.recommendation_item_id from committee.vote_item vi
    join decision.recommendation_package p on p.id = vi.package_id and vi.package_round = p.round_no
    where p.id = ${f.pkg} order by vi.sequence_no`;
  for (const item of items) {
    for (const user of voters) {
      await s.as(user);
      await s.tx`select api.cast_vote(${item.id}, ${choiceFor(item.recommendation_item_id ?? "PACKAGE", user)}, null)`;
    }
    await s.as("committeeSecretary");
    await s.tx`select api.close_vote_item(${item.id}, null)`;
  }
}

/** closePackageVotes, then records adoption. Returns the package status. */
export async function voteOnPackage(
  s: Scenario,
  f: PackageFixture,
  choiceFor: (target: string, voter: UserKey) => string = () => "APPROVE",
  voters: UserKey[] = DECISION_VOTERS,
): Promise<string> {
  await closePackageVotes(s, f, choiceFor, voters);
  const [r] = await s.tx<{ status: string }[]>`select api.record_package_adoption(${f.pkg}) as status`;
  return r!.status;
}

export async function packageStatus(s: Scenario, pkg: string): Promise<{ status: string; round_no: number }> {
  await s.as("committeeSecretary");
  const [r] = await s.tx<{ status: string; round_no: number }[]>`
    select status, round_no from decision.recommendation_package where id = ${pkg}`;
  return r!;
}

/** The secretary sends the adopted package to legalB with the finding; returns the request and packet ids. */
export async function requestLegalReview(
  s: Scenario,
  f: PackageFixture,
): Promise<{ request: string; packet: string }> {
  await s.as("committeeSecretary");
  const [r] = await s.tx<{ id: string }[]>`
    select api.request_legal_review(${f.pkg}, ${USERS.legalB}, ${REASON}, ${[f.finding]}::uuid[], null) as id`;
  const [k] = await s.tx<{ id: string }[]>`
    select id from decision.packet where legal_review_request_id = ${r!.id}`;
  return { request: r!.id, packet: k!.id };
}

export interface DecidedForSubjects extends PackageFixture {
  decision: string;
  /** Employee Sigma (the package's subject), linked to the portal account of `employee`. */
  sigma: string;
  /** Employee Tau on the same case, not in the decision, linked to `employeeB`. */
  tau: string;
}

/** Migration 2040 fixture: a package whose only active item is the WARNING sanction on Sigma (the case-wide corrective
 *  action withdrawn), adopted, reviewed by legalB and decided by the CEO an hour ago. Sigma and Tau are linked to the
 *  employee portal. Every step runs through the api.* commands. */
export async function decidedForSubjects(
  s: Scenario,
  committeeId: string,
  caseId: string,
  outcome = "APPROVE_AS_RECOMMENDED",
): Promise<DecidedForSubjects> {
  const f = await draftPackage(s, committeeId, caseId);
  await s.as("caseManager");
  const [tau] = await s.tx<{ id: string }[]>`
    select api.add_case_subject(${caseId}, 'Employee Tau (synthetic)', 'EMPLOYEE', null) as id`;
  await s.tx`select api.link_subject_portal_account(${f.subject}, ${USERS.employee}, ${REASON})`;
  await s.tx`select api.link_subject_portal_account(${tau!.id}, ${USERS.employeeB}, ${REASON})`;
  await s.as("committeeSecretary");
  await s.tx`select api.withdraw_recommendation_item(${f.corrective}, ${REASON})`;
  await voteOnPackage(s, f);
  const { request } = await requestLegalReview(s, f);
  await s.as("legalB");
  await s.tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`;
  await s.as("committeeSecretary");
  await s.tx`select api.submit_to_authority(${f.pkg})`;
  // Decided at now(), the adoption's own time: a decision may not fall on a Riyadh day before the adoption's (AMB-131),
  // and an hour earlier is the day before between 00:00 and 01:00 Riyadh time.
  const [d] = await s.tx<{ id: string }[]>`
    select api.record_authority_decision(${f.pkg}, 'CEO', ${outcome}, now(),
      'Chief Executive (synthetic)', 'MEMO-DEMO-2040', null, ${REASON}) as id`;
  return { ...f, decision: d!.id, sigma: f.subject, tau: tau!.id };
}
