// LegalReviewsGateway over PostgreSQL (UX redesign Phase 12 P12-3a; ADR-057, migrations 1900, 2030 and 2095). Reads
// call only the purpose read models api.legal_review_view (L1) and api.legal_review_choices (L2), and api.open_packet,
// the audited read of a packet's stored content; the gateway renames their keys and reads no case table. Writes only
// call the legal review and authority commands. Every method runs in its own transaction under the caller's security
// context.
import type {
  LegalReviewAct,
  LegalReviewChoices,
  LegalReviewView,
  PacketItem,
  PacketRecommendationItem,
  PacketView,
} from "@cdf/contracts";
import type { LegalReviewsGateway, UserRequestContext } from "@cdf/application";
import {
  account,
  each,
  iso,
  isoOrNull,
  revision,
  subject,
  yes,
  type RawAccount,
  type RawRevision,
  type RawSubject,
} from "./committee-proceedings-gateway";
import { withUserContext, type Sql, type Tx } from "./security-context";

// ---- The read models' JSON, as the database writes it (snake_case; timestamps as text) -------------------------
interface RawReview {
  request_id: string;
  package_round: number;
  status: LegalReviewView["status"];
  basis: LegalReviewView["basis"];
  reason: string;
  requested_at: string;
  requested_by: RawAccount | null;
  opinion: LegalReviewView["opinion"];
  opinion_text: string | null;
  opinion_at: string | null;
  revisions: RawRevision[] | null;
  packet_id: string;
  capabilities?: { may_give_opinion?: boolean | null; may_give_superseding_opinion?: boolean | null } | null;
  opinion_block: string | null;
  superseding_opinion_block: string | null;
}

type ChoiceFinding = LegalReviewChoices["findings"][number];

interface RawChoices {
  act: LegalReviewChoices["act"];
  package: {
    package_id: string;
    committee_proceeding_id: string;
    sequence_no: number;
    round_no: number;
    status: LegalReviewChoices["package"]["status"];
  };
  label_mode: LegalReviewChoices["labelMode"];
  restricted: boolean | null;
  items:
    | {
        item_id: string;
        item_type: LegalReviewChoices["items"][number]["itemType"];
        sanction_code: string | null;
      }[]
    | null;
  reviewers: RawAccount[] | null;
  findings:
    | {
        finding_id: string;
        version_no: number;
        result: ChoiceFinding["result"];
        proceeding_role: ChoiceFinding["proceedingRole"];
        allegation: { allegation_id: string; position: number | string; category: string };
        subject: RawSubject | null;
      }[]
    | null;
  minutes:
    | {
        minutes_id: string;
        meeting_id: string;
        meeting_sequence_no: number;
        version_no: number;
        status: string;
        finalised_at: string | null;
      }[]
    | null;
}

/** A packet item's stored snapshot: its keys depend on the item's kind and on the migration that wrote it. */
type Snapshot = Record<string, unknown>;

interface RawPacket {
  packet_id: string;
  purpose: PacketView["purpose"];
  classification: string;
  created_at: string;
  items:
    { position: number; kind: PacketItem["kind"]; source_id: string; snapshot: Snapshot | null }[] | null;
}

// ---- Mapping --------------------------------------------------------------------------------------------------
export function toLegalReviewView(r: RawReview): LegalReviewView {
  return {
    requestId: r.request_id,
    packageRound: r.package_round,
    status: r.status,
    basis: r.basis,
    reason: r.reason,
    requestedAt: iso(r.requested_at),
    requestedBy: r.requested_by ? account(r.requested_by) : null,
    opinion: r.opinion ?? null,
    opinionText: r.opinion_text ?? null,
    opinionAt: isoOrNull(r.opinion_at),
    revisions: each(r.revisions, revision),
    packetId: r.packet_id,
    capabilities: {
      mayGiveOpinion: yes(r.capabilities?.may_give_opinion),
      mayGiveSupersedingOpinion: yes(r.capabilities?.may_give_superseding_opinion),
    },
    opinionBlock: r.opinion_block ?? null,
    supersedingOpinionBlock: r.superseding_opinion_block ?? null,
  };
}

export function toLegalReviewChoices(v: RawChoices): LegalReviewChoices {
  return {
    act: v.act,
    package: {
      packageId: v.package.package_id,
      committeeProceedingId: v.package.committee_proceeding_id,
      sequenceNo: v.package.sequence_no,
      roundNo: v.package.round_no,
      status: v.package.status,
    },
    labelMode: v.label_mode,
    restricted: yes(v.restricted),
    items: each(v.items, (i) => ({
      itemId: i.item_id,
      itemType: i.item_type,
      sanctionCode: i.sanction_code ?? null,
    })),
    reviewers: each(v.reviewers, account),
    findings: each(v.findings, (f) => ({
      findingId: f.finding_id,
      versionNo: f.version_no,
      result: f.result,
      proceedingRole: f.proceeding_role,
      allegation: {
        allegationId: f.allegation.allegation_id,
        position: Number(f.allegation.position),
        category: f.allegation.category,
      },
      subject: f.subject ? subject(f.subject) : null,
    })),
    minutes: each(v.minutes, (m) => ({
      minutesId: m.minutes_id,
      meetingId: m.meeting_id,
      meetingSequenceNo: m.meeting_sequence_no,
      versionNo: m.version_no,
      status: m.status,
      finalisedAt: isoOrNull(m.finalised_at),
    })),
  };
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : fallback;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const objects = (v: unknown): Snapshot[] =>
  Array.isArray(v) ? v.filter((x): x is Snapshot => typeof x === "object" && x !== null) : [];

type Rec = PacketRecommendationItem;

/**
 * One packet item as stored: the snapshot keys of 1900 and 2030 both read. A packet for the authority made before
 * 2030 names one required authority and no rule; an opinion snapshotted then has no revision number (the first) and
 * was never superseded. A subject keeps the name stored when the packet was made, in every label mode (ruling 4).
 */
export function toPacketItem(i: NonNullable<RawPacket["items"]>[number]): PacketItem {
  const s = i.snapshot ?? {};
  const base = { position: i.position, sourceId: i.source_id };
  switch (i.kind) {
    case "RECOMMENDATION_ITEM": {
      const required = strings(s.required_authorities);
      const single = text(s.required_authority);
      const result = text(s.committee_result);
      return {
        kind: "RECOMMENDATION_ITEM",
        ...base,
        itemType: text(s.item_type) as Rec["itemType"],
        sanctionCode: text(s.sanction_code),
        proposedSanctionText: text(s.proposed_sanction_text),
        verificationStatus: text(s.verification_status) as Rec["verificationStatus"],
        description: text(s.description) ?? "",
        caseWide: s.case_wide === true,
        committeeResult: result === "APPROVED" || result === "REJECTED" ? result : null,
        subjects: objects(s.subjects).map((x) => ({
          subjectId: text(x.subject_id) ?? "",
          label: text(x.label),
          category: text(x.category) as Rec["subjects"][number]["category"],
        })),
        allegations: objects(s.allegations).map((x) => ({
          allegationId: text(x.allegation_id) ?? "",
          category: text(x.category) ?? "",
        })),
        requiresLegalJustification: s.requires_legal_justification === true,
        exclusivityGroup: text(s.exclusivity_group),
        dependsOn: strings(s.depends_on),
        requiredAuthorities: (required.length > 0
          ? required
          : single
            ? [single]
            : []) as Rec["requiredAuthorities"],
        authorityRuleSourceStatus: text(s.authority_rule_source_status) as Rec["authorityRuleSourceStatus"],
      };
    }
    case "FINDING":
      return {
        kind: "FINDING",
        ...base,
        result: text(s.result) as Extract<PacketItem, { kind: "FINDING" }>["result"],
        rationale: text(s.rationale) ?? "",
        versionNo: num(s.version_no, 1),
        allegationId: text(s.allegation_id) ?? "",
        allegationCategory: text(s.allegation_category) ?? "",
        subjectId: text(s.subject_id),
      };
    case "MINUTES":
      return {
        kind: "MINUTES",
        ...base,
        versionNo: num(s.version_no, 1),
        status: text(s.status) ?? "",
        narrative: text(s.narrative) ?? "",
        voteItems: objects(s.vote_items).map((x) => ({
          sequenceNo: num(x.sequence_no, 0),
          targetType: text(x.target_type) ?? "",
          title: text(x.title) ?? "",
          result: text(x.result),
          decidedByCastingVote: x.decided_by_casting_vote === true,
          approve: num(x.approve, 0),
          reject: num(x.reject, 0),
          abstain: num(x.abstain, 0),
        })),
      };
    case "LEGAL_OPINION":
      return {
        kind: "LEGAL_OPINION",
        ...base,
        opinion: text(s.opinion) as Extract<PacketItem, { kind: "LEGAL_OPINION" }>["opinion"],
        opinionText: text(s.opinion_text),
        packageRound: num(s.package_round, 1),
        revisionNo: num(s.revision_no, 1),
        superseded: s.superseded === true,
      };
  }
}

export function toPacketView(v: RawPacket): PacketView {
  return {
    packetId: v.packet_id,
    purpose: v.purpose,
    classification: v.classification,
    createdAt: iso(v.created_at),
    items: each(v.items, toPacketItem),
  };
}

// ---- Gateway --------------------------------------------------------------------------------------------------
export class PostgresLegalReviewsGateway implements LegalReviewsGateway {
  constructor(private readonly sql: Sql) {}

  /** One value from a one-row select written `... as v`, in the caller's security context. */
  private value<T>(ctx: UserRequestContext, query: (tx: Tx) => Promise<readonly { v: T }[]>): Promise<T> {
    return withUserContext(this.sql, ctx, async (tx) => {
      const [row] = await query(tx);
      return row!.v;
    });
  }

  async review(ctx: UserRequestContext, requestId: string): Promise<LegalReviewView> {
    return toLegalReviewView(
      await this.value<RawReview>(ctx, (tx) => tx`select api.legal_review_view(${requestId}) as v`),
    );
  }

  async choices(
    ctx: UserRequestContext,
    packageId: string,
    act: LegalReviewAct,
  ): Promise<LegalReviewChoices> {
    return toLegalReviewChoices(
      await this.value<RawChoices>(
        ctx,
        (tx) => tx`select api.legal_review_choices(${packageId}, ${act}) as v`,
      ),
    );
  }

  async openPacket(ctx: UserRequestContext, packetId: string): Promise<PacketView> {
    return toPacketView(
      await this.value<RawPacket>(ctx, (tx) => tx`select api.open_packet(${packetId}) as v`),
    );
  }

  requestLegalReview(
    ctx: UserRequestContext,
    i: { packageId: string; assignedTo: string; findingIds: string[]; minutesIds: string[]; reason: string },
  ) {
    return this.value<string>(
      ctx,
      (tx) => tx`
        select api.request_legal_review(${i.packageId}, ${i.assignedTo}, ${i.reason}, ${i.findingIds}::uuid[],
          ${i.minutesIds}::uuid[]) as v`,
    );
  }

  approveRestrictedLegalReview(
    ctx: UserRequestContext,
    i: { packageId: string; reviewerId: string; findingIds: string[]; minutesIds: string[]; reason: string },
  ) {
    return this.value<string>(
      ctx,
      (tx) => tx`
        select api.approve_restricted_legal_review(${i.packageId}, ${i.reviewerId}, ${i.findingIds}::uuid[],
          ${i.minutesIds}::uuid[], ${i.reason}) as v`,
    );
  }

  cancelLegalReviewRequest(ctx: UserRequestContext, i: { requestId: string; reason: string }) {
    return this.value<string>(
      ctx,
      (tx) => tx`select api.cancel_legal_review_request(${i.requestId}, ${i.reason}) as v`,
    );
  }

  async giveLegalOpinion(
    ctx: UserRequestContext,
    i: { requestId: string; opinion: string; opinionText?: string | undefined },
  ) {
    await withUserContext(this.sql, ctx, async (tx) => {
      await tx`select api.give_legal_opinion(${i.requestId}, ${i.opinion}, ${i.opinionText ?? null})`;
    });
  }

  giveSupersedingLegalOpinion(
    ctx: UserRequestContext,
    i: { requestId: string; opinion: string; opinionText?: string | undefined },
  ) {
    return this.value<string>(
      ctx,
      (tx) => tx`
        select api.give_superseding_legal_opinion(${i.requestId}, ${i.opinion}, ${i.opinionText ?? null}) as v`,
    );
  }

  submitToAuthority(ctx: UserRequestContext, i: { packageId: string }) {
    return this.value<string>(ctx, (tx) => tx`select api.submit_to_authority(${i.packageId}) as v`);
  }

  /**
   * The 13-argument command (2030). Item outcomes and conditions go as JSON arrays in the command's keys, or null when
   * the decision has none; further sources as a text array (empty when none).
   */
  recordAuthorityDecision(
    ctx: UserRequestContext,
    i: {
      packageId: string;
      authorityType: string;
      outcome: string;
      decidedAt: string;
      decidedByLabel: string;
      sourceDocumentReference: string;
      sourceSignature?: string | undefined;
      unsignedAttestation?: string | undefined;
      delegationReference?: string | undefined;
      additionalSourceReferences: string[];
      itemOutcomes?: { itemId: string; outcome: string; modification?: string | undefined }[] | undefined;
      conditions?:
        | { kind: string; text: string; itemId?: string | undefined; dueDate?: string | undefined }[]
        | undefined;
      reason?: string | undefined;
    },
  ) {
    const itemOutcomes = i.itemOutcomes?.map((x) => ({
      item_id: x.itemId,
      outcome: x.outcome,
      modification: x.modification ?? null,
    }));
    const conditions = i.conditions?.length
      ? i.conditions.map((c) => ({
          kind: c.kind,
          text: c.text,
          item_id: c.itemId ?? null,
          due_date: c.dueDate ?? null,
        }))
      : undefined;
    return this.value<string>(
      ctx,
      (tx) => tx`
        select api.record_authority_decision(${i.packageId}, ${i.authorityType}, ${i.outcome},
          ${i.decidedAt}::timestamptz, ${i.decidedByLabel}, ${i.sourceDocumentReference},
          ${itemOutcomes ? tx.json(itemOutcomes) : null}::jsonb, ${i.reason ?? null}, ${i.delegationReference ?? null},
          ${i.sourceSignature ?? null}, ${i.unsignedAttestation ?? null}, ${i.additionalSourceReferences}::text[],
          ${conditions ? tx.json(conditions) : null}::jsonb) as v`,
    );
  }
}
