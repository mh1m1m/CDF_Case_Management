// Evidence, Defence Packet and prior-sanctions fixtures for the migration 2050 security tests (ADR-041). Every step runs
// through the api.* commands as the acting user, except setPacketPolicy, which records a new version of the
// migration-managed Defence Packet policy on the owner connection (no command writes it; LEGAL_PRIVILEGE_RULE is
// SOURCE_REQUIRED and the values here are synthetic, for the test only).
import { createHash, randomUUID } from "node:crypto";
import { USERS, type OwnerScenario, type Scenario, type UserKey } from "./db";

export const REASON_2050 = "Synthetic: evidence half test reason.";
export const SYNTHETIC_PRIVILEGE_RULE = "SYNTHETIC-PRIVILEGE-RULE-2050";
export const ALL_CHECKS = [
  "REPORTER",
  "WITNESS",
  "CONFIDENTIALITY",
  "PRIVILEGE",
  "RESTRICTED_INFORMATION",
  "OTHER_PROTECTED",
];

export const newSha = () => createHash("sha256").update(randomUUID()).digest("hex");

export interface StoredVersion {
  evidenceId: string;
  versionId: string;
  versionNo: number;
  objectKey: string;
  sha256: string;
}

/** `user` registers and completes a new evidence item on `caseId` (or a new version of `evidenceId`). */
export async function storeEvidence(
  s: Scenario,
  user: UserKey,
  caseId: string,
  opts: { evidenceId?: string; title?: string; classification?: string } = {},
): Promise<StoredVersion> {
  await s.as(user);
  const sha256 = newSha();
  const isNew = !opts.evidenceId;
  const [row] = await s.tx<Omit<StoredVersion, "sha256">[]>`
    select o_evidence_id as "evidenceId", o_version_id as "versionId", o_version_no as "versionNo",
           o_object_key as "objectKey"
    from api.register_evidence_version(${caseId}, ${opts.evidenceId ?? null},
      ${isNew ? (opts.title ?? "Synthetic ledger extract") : null}, null, ${isNew ? "DOCUMENT" : null},
      ${isNew ? "Synthetic source" : null}, null,
      ${isNew ? (opts.classification ?? "CONFIDENTIAL") : null}::core.classification_level,
      'ledger.pdf', 'application/pdf', 2048, ${sha256})`;
  await s.tx`select api.complete_evidence_version(${row!.versionId}, 'CLEAN', 'test-scanner')`;
  return { ...row!, sha256 };
}

/** `user` (an evidence lead) registers and completes a redacted rendition of `sourceVersionId`. */
export async function storeRendition(
  s: Scenario,
  user: UserKey,
  sourceVersionId: string,
): Promise<StoredVersion> {
  await s.as(user);
  const sha256 = newSha();
  const [row] = await s.tx<Omit<StoredVersion, "sha256">[]>`
    select o_evidence_id as "evidenceId", o_version_id as "versionId", o_version_no as "versionNo",
           o_object_key as "objectKey"
    from api.register_evidence_rendition(${sourceVersionId}, 'ledger-redacted.pdf', 'application/pdf', 1024,
      ${sha256})`;
  await s.tx`select api.complete_evidence_version(${row!.versionId}, 'CLEAN', 'test-scanner')`;
  return { ...row!, sha256 };
}

/**
 * Ends the Defence Packet policy in force and records a new version from then, a minute ago at most (owner fixture). By
 * default it records a synthetic LEGAL_PRIVILEGE_RULE and keeps the narrow defaults otherwise.
 */
export async function setPacketPolicy(
  s: OwnerScenario,
  policy: { privilegeRule?: string | null; reviewerMustDiffer?: boolean; download?: boolean } = {},
): Promise<void> {
  const rule = policy.privilegeRule === undefined ? SYNTHETIC_PRIVILEGE_RULE : policy.privilegeRule;
  await s.asOwner();
  // now() is fixed for the transaction, so a later version in the same scenario starts a second after the previous one.
  const [ended] = await s.tx<{ at: Date }[]>`
    update grievance.defence_packet_policy
    set effective_to = greatest(effective_from + interval '1 second', now() - interval '1 minute')
    where effective_to is null returning effective_to as at`;
  await s.tx`insert into grievance.defence_packet_policy (effective_from, reviewer_must_differ, packet_evidence_download,
                                                          privilege_rule_reference, privilege_source_status)
             values (${ended!.at}, ${policy.reviewerMustDiffer ?? true}, ${policy.download ?? false},
                     ${rule}, ${rule === null ? "SOURCE_REQUIRED" : "APPROVED"})`;
}

export interface PacketCase {
  subject: string;
  allegation: string;
  notice: string;
}

/**
 * `manager` adds a subject linked to `portalUser`'s account, an allegation against them and an open DEFENCE notice on
 * `caseId`.
 */
export async function defenceNotice(
  s: Scenario,
  caseId: string,
  manager: UserKey = "caseManager",
  portalUser: UserKey = "employee",
  label = "Employee Sigma (synthetic)",
): Promise<PacketCase> {
  await s.as(manager);
  const [subj] = await s.tx<{ id: string }[]>`
    select api.add_case_subject(${caseId}, ${label}, 'EMPLOYEE', null) as id`;
  await s.tx`select api.link_subject_portal_account(${subj!.id}, ${USERS[portalUser]}, ${REASON_2050})`;
  const [a] = await s.tx<{ id: string }[]>`
    select api.add_allegation(${caseId}, 'FRAUD', ${"Synthetic: allegation against " + label + "."}, ${subj!.id},
      null, null) as id`;
  const [n] = await s.tx<{ id: string }[]>`
    select api.issue_defence_notice(${subj!.id}, 'Synthetic: you are invited to respond.', ${[a!.id]}::uuid[],
      now() + interval '10 days') as id`;
  return { subject: subj!.id, allegation: a!.id, notice: n!.id };
}

/** `chooser` opens a packet on `notice` and adds `versions` in order; returns the packet and its item ids. */
export async function packetWith(
  s: Scenario,
  chooser: UserKey,
  notice: string,
  versions: string[],
): Promise<{ packet: string; items: string[] }> {
  await s.as(chooser);
  const [k] = await s.tx<{ id: string }[]>`select api.create_defence_packet(${notice}) as id`;
  const items: string[] = [];
  for (const v of versions) {
    const [i] = await s.tx<{ id: string }[]>`select api.add_defence_packet_item(${k!.id}, ${v}) as id`;
    items.push(i!.id);
  }
  return { packet: k!.id, items };
}

/** `reviewer` clears `item` as is, under the title the subject will see. */
export async function clearAsIs(
  s: Scenario,
  reviewer: UserKey,
  item: string,
  title = "Item for your defence",
) {
  await s.as(reviewer);
  const [r] = await s.tx<{ id: string }[]>`
    select api.review_defence_packet_item(${item}, 'CLEARED_AS_IS', null, ${title}, ${ALL_CHECKS}::text[], null) as id`;
  return r!.id;
}

/** `reviewer` withholds `item` with a note. */
export async function withhold(s: Scenario, reviewer: UserKey, item: string) {
  await s.as(reviewer);
  await s.tx`select api.review_defence_packet_item(${item}, 'WITHHELD', null, null, ${["REPORTER"]}::text[],
    'Synthetic: names a witness; withheld.')`;
}

/** What the acting subject reads of their notice's released packets: item titles by packet. */
export async function subjectView(s: Scenario, notice: string): Promise<string[][]> {
  const [r] = await s.tx<{ v: { packets: { items: { title: string }[] }[] } }[]>`
    select api.my_defence_packet(${notice}) as v`;
  return r!.v.packets.map((k) => k.items.map((i) => i.title));
}

export interface PriorSanction {
  /** Employee Sigma's executed WARNING on case B, final: its grievance window ended and nothing is open on it. */
  caseB: string;
  sigma: string;
  person: string;
  decision: string;
  execution: string;
  /** The same person as a subject of case 0004, which the Investigation Committee now handles. */
  requestingCase: string;
  requestingSubject: string;
  committeeProceeding: string;
}

/**
 * A final sanction for the prior-sanctions extract (DEC-AMB-005): Sigma is decided a WARNING on case B through the
 * committee, the decision notice was delivered 35 days ago (its 30-day grievance window ended), no grievance was filed,
 * and the sanction was executed two days ago. The same person is a subject of case 0004 (owner fixture: no command
 * links a person across cases), which is referred to the Investigation Committee, whose seats are DECISION_SEATS.
 * With `restricted`, case B is then restricted under the GRC Director as its owner (its Restricted Case Authority).
 */
export async function priorFinalSanction(
  s: OwnerScenario,
  ids: { ic: string; gc: string; caseB: string; requestingCase: string },
  restricted = false,
): Promise<PriorSanction> {
  const { decidedForSubjects } = await import("./decision");
  const { oldDeliveryNotice, recordDelivery, executeSanction } = await import("./grievance");
  const { refer } = await import("./committee");
  const f = await decidedForSubjects(s, ids.ic, ids.caseB);
  const old = await oldDeliveryNotice(s, ids.caseB, ids.gc, f.sigma, f.decision, 40);
  await recordDelivery(s, old, 35);
  const [x] = await executeSanction(s, f.sanction, f.sigma, "2 days");
  const execution = (x as { id: string }).id;
  await s.asOwner();
  const [p] = await s.tx<{ person_id: string }[]>`
    select person_id from case_mgmt.case_subject where id = ${f.sigma}`;
  await s.tx`insert into case_mgmt.case_person (case_id, person_id, role, added_by)
             values (${ids.requestingCase}, ${p!.person_id}, 'SUBJECT', ${USERS.caseManager})`;
  const [rs] = await s.tx<{ id: string }[]>`
    insert into case_mgmt.case_subject (case_id, person_id, subject_category, added_by)
    values (${ids.requestingCase}, ${p!.person_id}, 'EMPLOYEE', ${USERS.caseManager}) returning id`;
  if (restricted) {
    await s.as("caseManager");
    await s.tx`select api.assign_case(${ids.caseB}, ${USERS.grcDirector}, 'CASE_OWNER', ${REASON_2050})`;
    await s.as("grcDirector");
    await s.tx`select api.change_case_classification(${ids.caseB}, c.classification, true, ${REASON_2050})
               from case_mgmt.case_record c where c.id = ${ids.caseB}`;
  }
  const committeeProceeding = await refer(s, ids.ic, ids.requestingCase);
  return {
    caseB: ids.caseB,
    sigma: f.sigma,
    person: p!.person_id,
    decision: f.decision,
    execution,
    requestingCase: ids.requestingCase,
    requestingSubject: rs!.id,
    committeeProceeding,
  };
}

/** The committee secretary asks for the prior final sanctions of the requesting case's subject. */
export async function requestExtract(s: Scenario, p: PriorSanction): Promise<string> {
  await s.as("committeeSecretary");
  const [x] = await s.tx<{ id: string }[]>`
    select api.request_sanction_extract(${p.committeeProceeding}, ${p.requestingSubject},
      'Synthetic: the committee weighs the severity of the sanction.') as id`;
  return x!.id;
}
