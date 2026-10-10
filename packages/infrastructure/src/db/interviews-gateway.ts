// InterviewGateway over PostgreSQL (CDF-60, ADR-012). Reads go through RLS; writes only call the api.*
// interview commands. Nothing here reads protected_identity: a REPORTER interview has no name to read.
import type {
  InterviewDetail,
  InterviewListItem,
  InterviewNoticeInfo,
  InterviewParticipantInfo,
  InterviewRecordingInfo,
  StatementAckMethod,
  StatementVersionInfo,
} from "@cdf/contracts";
import type { InterviewGateway, RecordedStatement, UserRequestContext } from "@cdf/application";
import { withUserContext, type Sql, type Tx } from "./security-context";

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
type Dated<T, K extends keyof T> = Omit<T, K> & { [P in K]: Date | null };

const LIST_COLUMNS = (tx: Tx) => tx`
  i.id, i.case_id as "caseId", i.sequence_no as "sequenceNo", i.title, i.interviewee_label as "intervieweeLabel",
  i.interviewee_kind as "intervieweeKind", i.classification, i.status, i.scheduled_start as "scheduledStart",
  i.mode, i.created_by as "createdBy", u.display_name as "createdByName", i.updated_at as "updatedAt"`;

type ListRow = Dated<InterviewListItem, "scheduledStart" | "updatedAt">;
const toListItem = (r: ListRow): InterviewListItem => ({
  ...r,
  scheduledStart: iso(r.scheduledStart),
  updatedAt: iso(r.updatedAt)!,
});

export class PostgresInterviewGateway implements InterviewGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
  }

  listInterviews(ctx: UserRequestContext, caseId: string): Promise<InterviewListItem[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<ListRow[]>`
        select ${LIST_COLUMNS(tx)}
        from case_mgmt.interview i left join iam.user_profile u on u.id = i.created_by
        where i.case_id = ${caseId} order by i.sequence_no`;
      return rows.map(toListItem);
    });
  }

  getInterview(ctx: UserRequestContext, interviewId: string): Promise<InterviewDetail | null> {
    return this.run(ctx, async (tx) => {
      const [opened] = await tx<{ ok: boolean }[]>`select api.open_interview(${interviewId}) as ok`;
      if (!opened?.ok) return null;
      const [row] = await tx<
        (ListRow &
          Dated<
            Omit<
              InterviewDetail,
              keyof InterviewListItem | "participants" | "notices" | "statements" | "recordings"
            >,
            | "rightsAcknowledgedAt"
            | "conductedStartedAt"
            | "conductedEndedAt"
            | "preparedAt"
            | "reviewedAt"
            | "approvedAt"
            | "cancelledAt"
          >)[]
      >`
        select ${LIST_COLUMNS(tx)}, i.purpose, i.case_person_id as "casePersonId", i.location,
               i.duration_minutes as "durationMinutes", i.rights_ack_method as "rightsAckMethod",
               i.rights_notice_version as "rightsNoticeVersion", i.rights_acknowledged_at as "rightsAcknowledgedAt",
               i.conducted_started_at as "conductedStartedAt", i.conducted_ended_at as "conductedEndedAt",
               i.current_statement_version_id as "currentStatementVersionId", i.form_instance_id as "formInstanceId",
               i.prepared_by as "preparedBy", i.prepared_at as "preparedAt", i.reviewed_by as "reviewedBy",
               i.reviewed_at as "reviewedAt", i.approved_by as "approvedBy", i.approved_at as "approvedAt",
               i.cancelled_at as "cancelledAt", i.row_version as "rowVersion"
        from case_mgmt.interview i left join iam.user_profile u on u.id = i.created_by
        where i.id = ${interviewId}`;
      if (!row) return null;

      const participants = await tx<Dated<InterviewParticipantInfo, "addedAt">[]>`
        select p.id, p.user_id as "userId", u.display_name as "displayName", u.display_name_ar as "displayNameAr",
               p.participant_role as "participantRole", p.added_at as "addedAt"
        from case_mgmt.interview_participant p join iam.user_profile u on u.id = p.user_id
        where p.interview_id = ${interviewId}
        order by (p.participant_role = 'LEAD_INTERVIEWER') desc, p.added_at`;
      const notices = await tx<Dated<InterviewNoticeInfo, "scheduledStart" | "issuedAt">[]>`
        select n.id, n.notice_type as "noticeType", n.channel, n.scheduled_start as "scheduledStart",
               n.issued_by as "issuedBy", u.display_name as "issuedByName", n.issued_at as "issuedAt"
        from case_mgmt.interview_notice n left join iam.user_profile u on u.id = n.issued_by
        where n.interview_id = ${interviewId} order by n.seq`;
      const statements = await tx<
        (Dated<Omit<StatementVersionInfo, "acknowledgement">, "recordedAt"> & {
          ackMethod: StatementAckMethod | null;
          ackSha256: string | null;
          ackBy: string | null;
          ackByName: string | null;
          ackAt: Date | null;
        })[]
      >`
        select s.id, s.version_no as "versionNo", s.content, s.language, s.content_sha256 as "contentSha256",
               s.recorded_by as "recordedBy", u.display_name as "recordedByName", s.recorded_at as "recordedAt",
               a.method as "ackMethod", a.attested_sha256 as "ackSha256", a.recorded_by as "ackBy",
               au.display_name as "ackByName", a.recorded_at as "ackAt"
        from case_mgmt.interview_statement_version s
        left join iam.user_profile u on u.id = s.recorded_by
        left join case_mgmt.interview_statement_ack a on a.statement_version_id = s.id
        left join iam.user_profile au on au.id = a.recorded_by
        where s.interview_id = ${interviewId} order by s.version_no`;
      // RLS lists a link only when the evidence item is visible too; the join then succeeds under the same rule.
      const recordings = await tx<Dated<InterviewRecordingInfo, "linkedAt">[]>`
        select r.id, r.evidence_id as "evidenceId", e.sequence_no as "evidenceSequenceNo", e.title as "evidenceTitle",
               e.evidence_type as "evidenceType", r.linked_by as "linkedBy", u.display_name as "linkedByName",
               r.linked_at as "linkedAt"
        from case_mgmt.interview_recording r
        join evidence.evidence e on e.id = r.evidence_id
        left join iam.user_profile u on u.id = r.linked_by
        where r.interview_id = ${interviewId} order by r.linked_at, e.sequence_no`;

      return {
        ...toListItem(row),
        purpose: row.purpose,
        casePersonId: row.casePersonId,
        location: row.location,
        durationMinutes: row.durationMinutes,
        rightsAckMethod: row.rightsAckMethod,
        rightsNoticeVersion: row.rightsNoticeVersion,
        rightsAcknowledgedAt: iso(row.rightsAcknowledgedAt),
        conductedStartedAt: iso(row.conductedStartedAt),
        conductedEndedAt: iso(row.conductedEndedAt),
        currentStatementVersionId: row.currentStatementVersionId,
        formInstanceId: row.formInstanceId,
        preparedBy: row.preparedBy,
        preparedAt: iso(row.preparedAt),
        reviewedBy: row.reviewedBy,
        reviewedAt: iso(row.reviewedAt),
        approvedBy: row.approvedBy,
        approvedAt: iso(row.approvedAt),
        cancelledAt: iso(row.cancelledAt),
        rowVersion: row.rowVersion,
        participants: participants.map((p) => ({ ...p, addedAt: iso(p.addedAt)! })),
        notices: notices.map((n) => ({
          ...n,
          scheduledStart: iso(n.scheduledStart)!,
          issuedAt: iso(n.issuedAt)!,
        })),
        statements: statements.map((s) => ({
          id: s.id,
          versionNo: s.versionNo,
          content: s.content,
          language: s.language,
          contentSha256: s.contentSha256,
          recordedBy: s.recordedBy,
          recordedByName: s.recordedByName,
          recordedAt: iso(s.recordedAt)!,
          acknowledgement:
            s.ackMethod && s.ackSha256 && s.ackBy && s.ackAt
              ? {
                  method: s.ackMethod,
                  attestedSha256: s.ackSha256,
                  recordedBy: s.ackBy,
                  recordedByName: s.ackByName,
                  recordedAt: iso(s.ackAt)!,
                }
              : null,
        })),
        recordings: recordings.map((r) => ({ ...r, linkedAt: iso(r.linkedAt)! })),
      };
    });
  }

  planInterview(ctx: UserRequestContext, i: Parameters<InterviewGateway["planInterview"]>[1]) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select api.plan_interview(${i.caseId}, ${i.title}, ${i.purpose ?? null}, ${i.intervieweeKind},
          ${i.intervieweeLabel ?? null}, ${i.casePersonId ?? null}, ${i.classification}::core.classification_level) as id`;
      return row!.id;
    });
  }

  addParticipant(ctx: UserRequestContext, i: Parameters<InterviewGateway["addParticipant"]>[1]) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select api.add_interview_participant(${i.interviewId}, ${i.userId}, ${i.participantRole}) as id`;
      return row!.id;
    });
  }

  schedule(ctx: UserRequestContext, i: Parameters<InterviewGateway["schedule"]>[1]) {
    return this.run(ctx, async (tx) => {
      await tx`select api.schedule_interview(${i.interviewId}, ${i.scheduledStart}::timestamptz, ${i.durationMinutes},
        ${i.mode}, ${i.location ?? null})`;
    });
  }

  issueNotice(ctx: UserRequestContext, i: Parameters<InterviewGateway["issueNotice"]>[1]) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select api.issue_interview_notice(${i.interviewId}, ${i.noticeType}, ${i.channel}) as id`;
      return row!.id;
    });
  }

  recordRights(ctx: UserRequestContext, i: Parameters<InterviewGateway["recordRights"]>[1]) {
    return this.run(ctx, async (tx) => {
      await tx`select api.record_interview_rights(${i.interviewId}, ${i.method}, ${i.noticeVersion})`;
    });
  }

  recordConducted(ctx: UserRequestContext, i: Parameters<InterviewGateway["recordConducted"]>[1]) {
    return this.run(ctx, async (tx) => {
      await tx`select api.record_interview_conducted(${i.interviewId}, ${i.startedAt}::timestamptz, ${i.endedAt}::timestamptz)`;
    });
  }

  recordStatement(
    ctx: UserRequestContext,
    i: Parameters<InterviewGateway["recordStatement"]>[1],
  ): Promise<RecordedStatement> {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<RecordedStatement[]>`
        select o_version_id as "versionId", o_version_no as "versionNo", o_sha256 as "sha256"
        from api.record_interview_statement(${i.interviewId}, ${i.content}, ${i.language})`;
      return row!;
    });
  }

  acknowledgeStatement(ctx: UserRequestContext, i: Parameters<InterviewGateway["acknowledgeStatement"]>[1]) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select api.acknowledge_interview_statement(${i.versionId}, ${i.method}, ${i.attestedSha256}) as id`;
      return row!.id;
    });
  }

  linkRecording(ctx: UserRequestContext, i: Parameters<InterviewGateway["linkRecording"]>[1]) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select api.link_interview_recording(${i.interviewId}, ${i.evidenceId}) as id`;
      return row!.id;
    });
  }

  transition(ctx: UserRequestContext, i: Parameters<InterviewGateway["transition"]>[1]) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ status: string }[]>`
        select api.transition_interview(${i.interviewId}, ${i.action}, ${i.reason ?? null}) as status`;
      return row!.status;
    });
  }
}
