// InvestigationGateway over PostgreSQL. Reads go through RLS (SELECT); writes only call api.* commands.
// Every method runs in its own transaction under the caller's security context (ADR-003).
import type {
  Actor,
  AuditTimelineEntry,
  CaseAccessRosterEntry,
  CaseAssignment,
  CaseCapabilities,
  CaseDetail,
  CaseDiscoveryResult,
  CaseListItem,
  CaseReporterView,
  ConversationAccess,
  EvidenceAccess,
  CasePathStep,
  IntakeReportItem,
  LedgerEntry,
  MyAccessEntry,
  MyArea,
  MyCaseTask,
  MyWorkSummary,
  PendingConflict,
  RecordsCatalogueEntry,
  RetentionQueueEntry,
  ReportDetail,
  ReportMessage,
  RestrictedCaseAuthority,
  TransitionOption,
  UserDirectoryEntry,
  UserRegisterEntry,
  WorkItem,
} from "@cdf/contracts";
import type { InvestigationGateway, UserRequestContext } from "@cdf/application";
import { withUserContext, type Sql, type Tx } from "./security-context";

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

const CASE_COLUMNS = (tx: Tx) => tx`
  id, case_number as "caseNumber", title, classification, is_restricted as "isRestricted", priority,
  current_state as "currentState", state_name_en as "stateNameEn", state_name_ar as "stateNameAr",
  state_due_at as "stateDueAt", assigned_investigator_id as "assignedInvestigatorId", updated_at as "updatedAt"`;

type CaseRow = Omit<CaseListItem, "stateDueAt" | "updatedAt"> & { stateDueAt: Date | null; updatedAt: Date };
const toCaseItem = (r: CaseRow): CaseListItem => ({
  ...r,
  stateDueAt: iso(r.stateDueAt),
  updatedAt: iso(r.updatedAt)!,
});

export class PostgresInvestigationGateway implements InvestigationGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
  }

  loadActor(ctx: UserRequestContext): Promise<Actor | null> {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<Omit<Actor, "permissions">[]>`
        select p.id as "userId", p.email, p.display_name as "displayName", p.display_name_ar as "displayNameAr",
               authz.current_roles() as roles, authz.current_clearance() as clearance
        from iam.user_profile p where p.id = authz.current_user_id()`;
      if (!row) return null;
      const perms = await tx<{ code: Actor["permissions"][number] }[]>`
        select distinct permission_code as code from iam.role_permission where role_code = any(${row.roles}) order by 1`;
      return { ...row, permissions: perms.map((p) => p.code) };
    });
  }

  listIntakeReports(ctx: UserRequestContext): Promise<IntakeReportItem[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<(Omit<IntakeReportItem, "receivedAt"> & { receivedAt: Date })[]>`
        select id, report_ref as "reportRef", category, reporter_mode as "reporterMode", status, classification,
               received_at as "receivedAt", case_id as "caseId"
        from intake.report where case_id is null order by received_at desc limit 200`;
      return rows.map((r) => ({ ...r, receivedAt: iso(r.receivedAt)! }));
    });
  }

  getReport(ctx: UserRequestContext, reportId: string): Promise<ReportDetail | null> {
    return this.run(ctx, async (tx) => {
      const [opened] = await tx<{ ok: boolean }[]>`select api.open_report(${reportId}) as ok`;
      if (!opened?.ok) return null;
      const [r] = await tx`
        select id, report_ref as "reportRef", category, reporter_mode as "reporterMode", status, classification,
               received_at as "receivedAt", case_id as "caseId", subject_description as "subjectDescription",
               description, incident_date::text as "incidentDate",
               to_char(incident_time, 'HH24:MI') as "incidentTime", location,
               relationship_to_fund as "relationshipToFund", relationship_other as "relationshipOther",
               category_other as "categoryOther", willing_to_cooperate as "willingToCooperate", language
        from intake.report where id = ${reportId}`;
      if (!r) return null;
      // DEC-06: row-level security returns the messages only to the conversation's readers.
      const messages = await tx<
        { direction: "FROM_REPORTER" | "TO_REPORTER"; body: string; createdAt: Date }[]
      >`
        select direction, body, created_at as "createdAt" from intake.report_message where report_id = ${reportId} order by created_at`;
      const [access] = await tx<{ access: ConversationAccess; files: boolean }[]>`
        select case when authz.can_message_reporter(${reportId}) then 'SEND'
                    when authz.can_read_reporter_conversation(${reportId}) then 'READ'
                    else 'NONE' end as access,
               authz.can_view_report_files(${reportId}) as files`;
      return {
        ...(r as unknown as ReportDetail),
        receivedAt: iso(r.receivedAt as Date)!,
        messages: messages.map((m) => ({ ...m, createdAt: iso(m.createdAt)! })),
        conversation: access?.access ?? "NONE",
        filesVisible: access?.files ?? false,
      };
    });
  }

  triageReport(
    ctx: UserRequestContext,
    i: { reportId: string; outcome: string; reason: string; referredTo?: string; duplicateOf?: string },
  ) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select api.triage_report(${i.reportId}, ${i.outcome}, ${i.reason}, ${i.referredTo ?? null}, ${i.duplicateOf ?? null}) as id`;
      return row!.id;
    });
  }

  replyToReporter(ctx: UserRequestContext, i: { reportId: string; body: string }) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`select api.reply_to_reporter(${i.reportId}, ${i.body}) as id`;
      return row!.id;
    });
  }

  createCaseFromReport(
    ctx: UserRequestContext,
    i: {
      reportId: string;
      title: string;
      summary: string;
      classification: string;
      isRestricted: boolean;
      restrictedAuthorityId?: string | undefined;
    },
  ) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select api.create_case_from_report(${i.reportId}, ${i.title}, ${i.summary},
          ${i.classification}::core.classification_level, ${i.isRestricted},
          ${i.restrictedAuthorityId ?? null}::uuid) as id`;
      return row!.id;
    });
  }

  /** People who may be named as a restricted case's accountable authority at this classification (DEC-01). */
  listRestrictedCaseAuthorities(
    ctx: UserRequestContext,
    reportId: string,
    classification: string,
  ): Promise<RestrictedCaseAuthority[]> {
    return this.run(
      ctx,
      (tx) => tx<RestrictedCaseAuthority[]>`
      select user_id as "userId", display_name as "displayName", display_name_ar as "displayNameAr"
      from api.list_restricted_case_authorities(${reportId}, ${classification}::core.classification_level)`,
    );
  }

  listCases(ctx: UserRequestContext): Promise<CaseListItem[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<
        CaseRow[]
      >`select ${CASE_COLUMNS(tx)} from case_mgmt.case_overview order by updated_at desc limit 200`;
      return rows.map(toCaseItem);
    });
  }

  getCase(ctx: UserRequestContext, caseId: string): Promise<CaseDetail | null> {
    return this.run(ctx, async (tx) => {
      const [opened] = await tx<{ ok: boolean }[]>`select api.open_case(${caseId}) as ok`;
      if (!opened?.ok) return null;
      const [c] = await tx<(CaseRow & Record<string, unknown>)[]>`
        select ${CASE_COLUMNS(tx)}, summary, source, source_report_id as "sourceReportId", reporter_wb_id as "reporterWbId",
               records_state as "recordsState", created_at as "createdAt", opened_at as "openedAt", row_version as "rowVersion",
               entered_state_at as "enteredStateAt", legal_hold_status as "legalHoldStatus", owner_id as "ownerId"
        from case_mgmt.case_overview where id = ${caseId}`;
      if (!c) return null;
      const [owner] = c.ownerId
        ? await tx<NonNullable<CaseDetail["owner"]>[]>`
            select id as "userId", display_name as "displayName", display_name_ar as "displayNameAr"
            from iam.user_profile where id = ${c.ownerId as string}`
        : [];
      const path = await tx<(Omit<CasePathStep, "occurredAt"> & { occurredAt: Date })[]>`
        select transition_code as "transitionCode", from_state as "fromState", to_state as "toState",
               occurred_at as "occurredAt"
        from workflow.workflow_transition_event where case_id = ${caseId} order by occurred_at, id`;
      const allegations = await tx<CaseDetail["allegations"]>`
        select id, category, description, status from case_mgmt.allegation where case_id = ${caseId} order by created_at`;
      const assignments = await tx<(Omit<CaseAssignment, "assignedAt"> & { assignedAt: Date })[]>`
        select a.id, a.user_id as "userId", coalesce(u.display_name, '—') as "displayName",
               u.display_name_ar as "displayNameAr", a.assignment_role as "assignmentRole", a.assigned_at as "assignedAt"
        from case_mgmt.case_assignment a left join iam.user_profile u on u.id = a.user_id
        where a.case_id = ${caseId} and a.status = 'ACTIVE' order by a.assigned_at`;
      // Disabled steps come back too, so the page can say "later in this case" instead of "no steps" (UX-006).
      // Eligible roles are reference data (role_permission is readable by every signed-in user); never people.
      const transitions = await tx<TransitionOption[]>`
        select t.code, t.to_state as "toState", t.name_en as "nameEn", t.name_ar as "nameAr",
               t.reason_required as "reasonRequired", t.is_enabled as enabled, t.allowed,
               coalesce(t.blocking_reasons, '{}') as "blockingReasons",
               coalesce((select array_agg(distinct rp.role_code order by rp.role_code)
                           from workflow.workflow_instance wi
                           join workflow.workflow_transition_definition d
                             on d.workflow_code = wi.workflow_code and d.code = t.code
                           join iam.role_permission rp on rp.permission_code = d.required_permission
                           join iam.role r on r.code = rp.role_code and not r.is_technical
                          where wi.case_id = ${caseId}), '{}') as "eligibleRoles"
        from api.available_transitions(${caseId}) t`;
      const [conflict] = await tx<{ status: string }[]>`
        select status from case_mgmt.conflict_check where case_id = ${caseId} and user_id = authz.current_user_id() and is_current`;
      // The caller's part in the reporter conversation (DEC-06), over the reports behind the case.
      const [conversation] = await tx<{ access: ConversationAccess }[]>`
        select case when bool_or(authz.can_message_reporter(r.id)) then 'SEND'
                    when bool_or(authz.can_read_reporter_conversation(r.id)) then 'READ'
                    else 'NONE' end as access
        from intake.report r where r.case_id = ${caseId}`;
      // The caller's evidence need-to-know (DEC-09): the register for the team, the reporter's files for triage.
      const [evidence] = await tx<{ access: EvidenceAccess }[]>`
        select case when authz.is_evidence_lead(${caseId}) then 'LEADS'
                    when authz.is_evidence_team(${caseId}) then 'TEAM'
                    when exists (select 1 from intake.report r
                                  where r.case_id = ${caseId} and authz.can_view_report_files(r.id)) then 'REPORTER_FILES'
                    else 'NONE' end as access`;
      // What the caller may do here, from the database's own rules (UX-116); every command checks again.
      const [can] = await tx<CaseCapabilities[]>`
        select authz.can_edit_case(${caseId}) as edit, authz.can_assign_case(${caseId}) as assign,
               authz.can_upload_evidence(${caseId}) as "uploadEvidence",
               authz.can_conduct_interviews(${caseId}) as "conductInterviews",
               authz.can_review_interviews(${caseId}) as "reviewInterviews",
               authz.can_approve_interviews(${caseId}) as "approveInterviews",
               coalesce((select array_agg(l::text order by l)
                           from unnest(enum_range(null::core.classification_level)) l
                          where l >= ${c.classification as string}::core.classification_level
                            and l <= authz.current_clearance()), '{}') as classifications`;
      return {
        ...toCaseItem(c),
        summary: c.summary as string,
        source: c.source as string,
        sourceReportId: (c.sourceReportId as string | null) ?? null,
        reporterWbId: (c.reporterWbId as string | null) ?? null,
        recordsState: c.recordsState as string,
        createdAt: iso(c.createdAt as Date)!,
        openedAt: iso(c.openedAt as Date | null),
        rowVersion: c.rowVersion as number,
        enteredStateAt: iso(c.enteredStateAt as Date | null),
        owner: owner ?? null,
        legalHoldStatus: c.legalHoldStatus === "ACTIVE" ? "ACTIVE" : "NONE",
        path: path.map((p) => ({ ...p, occurredAt: iso(p.occurredAt)! })),
        allegations: [...allegations],
        assignments: assignments.map((a) => ({ ...a, assignedAt: iso(a.assignedAt)! })),
        transitions: [...transitions],
        myConflictStatus: conflict?.status ?? null,
        reporterConversation: conversation?.access ?? "NONE",
        evidenceAccess: evidence?.access ?? "NONE",
        can: can!,
      };
    });
  }

  updateCaseDetails(
    ctx: UserRequestContext,
    i: { caseId: string; title: string; summary: string; priority?: string; expectedVersion: number },
  ) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ v: number }[]>`
        select api.update_case_details(${i.caseId}, ${i.title}, ${i.summary}, ${i.priority ?? null}, ${i.expectedVersion}) as v`;
      return row!.v;
    });
  }

  assignCase(
    ctx: UserRequestContext,
    i: { caseId: string; userId: string; assignmentRole: string; reason: string },
  ) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<
        { id: string }[]
      >`select api.assign_case(${i.caseId}, ${i.userId}, ${i.assignmentRole}, ${i.reason}) as id`;
      return row!.id;
    });
  }

  declareConflict(ctx: UserRequestContext, i: { caseId: string; hasConflict: boolean; declaration: string }) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<
        { id: string }[]
      >`select api.declare_conflict(${i.caseId}, ${i.hasConflict}, ${i.declaration}) as id`;
      return row!.id;
    });
  }

  pendingConflicts(ctx: UserRequestContext, caseId: string): Promise<PendingConflict[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<(Omit<PendingConflict, "declaredAt"> & { declaredAt: Date })[]>`
        select k.id, k.user_id as "userId", u.display_name as "displayName", u.display_name_ar as "displayNameAr",
               k.declaration, k.declared_at as "declaredAt"
        from case_mgmt.conflict_check k join iam.user_profile u on u.id = k.user_id
        where k.case_id = ${caseId} and k.is_current and k.status = 'CONFLICT_DECLARED'
        order by k.declared_at`;
      return rows.map((r) => ({ ...r, declaredAt: iso(r.declaredAt)! }));
    });
  }

  decideConflict(ctx: UserRequestContext, i: { conflictId: string; decision: string; reason: string }) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<
        { id: string }[]
      >`select api.decide_conflict(${i.conflictId}, ${i.decision}, ${i.reason}) as id`;
      return row!.id;
    });
  }

  transitionCase(ctx: UserRequestContext, i: { caseId: string; transitionCode: string; reason?: string }) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<
        { state: string }[]
      >`select api.transition_case(${i.caseId}, ${i.transitionCode}, ${i.reason ?? null}) as state`;
      return row!.state;
    });
  }

  // The case's history for its team (ADR-016 D5, DEC-08/DEC-10). The database applies actor access, each
  // action's audience, object entitlement and classification; page views stay in the ledger for Oversight.
  caseTimeline(ctx: UserRequestContext, caseId: string, limit = 200): Promise<AuditTimelineEntry[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<(Omit<AuditTimelineEntry, "occurredAt"> & { occurredAt: Date })[]>`
        select seq::int as seq, occurred_at as "occurredAt", action, actor_id as "actorId",
               actor_name as "actorName", actor_name_ar as "actorNameAr", subject_name as "subjectName",
               subject_name_ar as "subjectNameAr", reason, detail
        from api.case_history(${caseId}, ${limit})`;
      return rows.map((r) => ({ ...r, occurredAt: iso(r.occurredAt)! }));
    });
  }

  // Who has access and on what basis (DEC-08): the full roster only for those who manage the team.
  caseAccessRoster(ctx: UserRequestContext, caseId: string): Promise<CaseAccessRosterEntry[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<
        (Omit<CaseAccessRosterEntry, "sinceAt" | "untilAt" | "endedAt"> & {
          sinceAt: Date;
          untilAt: Date | null;
          endedAt: Date | null;
        })[]
      >`
        select user_id as "userId", display_name as "displayName", display_name_ar as "displayNameAr",
               relationship, code, since_at as "sinceAt", until_at as "untilAt", ended_at as "endedAt", status,
               is_self as "isSelf"
        from api.case_access_roster(${caseId})`;
      return rows.map((r) => ({
        ...r,
        sinceAt: iso(r.sinceAt)!,
        untilAt: iso(r.untilAt),
        endedAt: iso(r.endedAt),
      }));
    });
  }

  // The conversation with the reporter (DEC-06). The database decides who reads and who writes; row-level security
  // filters the messages and the delegations again.
  caseReporterView(ctx: UserRequestContext, caseId: string): Promise<CaseReporterView> {
    return this.run(ctx, async (tx) => {
      const reports = await tx<{ reportId: string; canSend: boolean }[]>`
        select r.id as "reportId", authz.can_message_reporter(r.id) as "canSend"
        from intake.report r
        where r.case_id = ${caseId} and authz.can_read_reporter_conversation(r.id)
        order by r.received_at, r.id`;
      const ids = reports.map((r) => r.reportId);
      const messages = ids.length
        ? await tx<(Omit<ReportMessage, "createdAt"> & { reportId: string; createdAt: Date })[]>`
            select report_id as "reportId", direction, body, created_at as "createdAt"
            from intake.report_message where report_id = any(${ids}::uuid[]) order by created_at, id`
        : [];
      const delegations = await tx<
        (Omit<CaseReporterView["delegations"][number], "delegatedAt"> & { delegatedAt: Date })[]
      >`
        select d.id, d.user_id as "userId", coalesce(u.display_name, '—') as "displayName",
               u.display_name_ar as "displayNameAr", d.delegated_at as "delegatedAt"
        from case_mgmt.reporter_communication_delegation d left join iam.user_profile u on u.id = d.user_id
        where d.case_id = ${caseId} and d.ended_at is null order by d.delegated_at, d.id`;
      const [manage] = await tx<{ ok: boolean }[]>`select authz.can_assign_case(${caseId}) as ok`;
      return {
        conversations: reports.map((r) => ({
          reportId: r.reportId,
          canSend: r.canSend,
          messages: messages
            .filter((m) => m.reportId === r.reportId)
            .map(({ direction, body, createdAt }) => ({ direction, body, createdAt: iso(createdAt)! })),
        })),
        delegations: delegations.map((d) => ({ ...d, delegatedAt: iso(d.delegatedAt)! })),
        canDelegate: manage?.ok === true,
      };
    });
  }

  delegateReporterCommunication(
    ctx: UserRequestContext,
    i: { caseId: string; userId: string; reason: string },
  ) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select api.delegate_reporter_communication(${i.caseId}, ${i.userId}, ${i.reason}) as id`;
      return row!.id;
    });
  }

  endReporterCommunication(
    ctx: UserRequestContext,
    i: { caseId: string; delegationId: string; reason: string },
  ) {
    return this.run(ctx, async (tx) => {
      await tx`select api.end_reporter_communication(${i.delegationId}, ${i.reason})`;
    });
  }

  directory(ctx: UserRequestContext): Promise<UserDirectoryEntry[]> {
    return this.run(ctx, (tx) =>
      tx<UserDirectoryEntry[]>`
      select id, display_name as "displayName", display_name_ar as "displayNameAr", department
      from iam.user_profile where status = 'ACTIVE' order by display_name`.then((r) => [...r]),
    );
  }

  // ---- Purpose-bound records and legal access (ADR-014) ------------------------------------------
  // Totals come from the database and count authorised rows only (§17): never a global count.
  searchRecordsCatalogue(
    ctx: UserRequestContext,
    i: {
      caseNumber?: string;
      archiveStatus?: string;
      legalHoldStatus?: string;
      limit: number;
      offset: number;
    },
  ): Promise<{ total: number; items: RecordsCatalogueEntry[] }> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<
        (Omit<RecordsCatalogueEntry, "closedDate" | "retentionStartDate" | "retentionEndDate"> & {
          closedDate: Date | null;
          retentionStartDate: Date | null;
          retentionEndDate: Date | null;
          totalCount: string;
        })[]
      >`
        select case_id as "caseId", case_number as "caseNumber", case_type as "caseType", classification,
               closed_date as "closedDate", retention_class as "retentionClass",
               retention_start_date as "retentionStartDate", retention_end_date as "retentionEndDate",
               legal_hold_status as "legalHoldStatus", archive_status as "archiveStatus",
               disposition_status as "dispositionStatus", record_owner as "recordOwner", total_count as "totalCount"
        from api.search_records_catalogue(${i.caseNumber ?? null}, ${i.archiveStatus ?? null},
                                          ${i.legalHoldStatus ?? null}, ${i.limit}, ${i.offset})`;
      return {
        total: Number(rows[0]?.totalCount ?? 0),
        items: rows.map(({ totalCount: _total, ...r }) => ({
          ...r,
          closedDate: iso(r.closedDate),
          retentionStartDate: iso(r.retentionStartDate),
          retentionEndDate: iso(r.retentionEndDate),
        })),
      };
    });
  }

  myCaseTasks(ctx: UserRequestContext): Promise<MyCaseTask[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<
        (Omit<MyCaseTask, "dueDate" | "expiresAt"> & { dueDate: string | null; expiresAt: Date })[]
      >`
        select task_id as "taskId", case_id as "caseId", case_number as "caseNumber", task_type as "taskType",
               category, purpose, scope, status, due_date::text as "dueDate", expires_at as "expiresAt",
               legal_hold_status as "legalHoldStatus", archive_status as "archiveStatus"
        from api.my_case_tasks()`;
      return rows.map((r) => ({ ...r, expiresAt: iso(r.expiresAt)! }));
    });
  }

  myWorkSummary(ctx: UserRequestContext): Promise<MyWorkSummary> {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<MyWorkSummary[]>`
        select my_retention_tasks as "myRetentionTasks", my_disposition_tasks as "myDispositionTasks",
               pending_archive_transfers as "pendingArchiveTransfers", assigned_legal_holds as "assignedLegalHolds",
               my_legal_reviews as "myLegalReviews", my_legal_hold_requests as "myLegalHoldRequests"
        from api.my_work_summary()`;
      return row!;
    });
  }

  myAreas(ctx: UserRequestContext): Promise<MyArea[]> {
    return this.run(
      ctx,
      (tx) => tx<MyArea[]>`
        select area_code as area, actionable_count as "actionableCount", default_view as "defaultView"
        from api.my_areas()`,
    );
  }

  myWorkItems(ctx: UserRequestContext): Promise<WorkItem[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<
        (Omit<WorkItem, "dueAt" | "sinceAt"> & { dueAt: Date | null; sinceAt: Date | null })[]
      >`
        select area, view, category, target_type as "targetType", target_id as "targetId", case_id as "caseId",
               case_number as "caseNumber", due_at as "dueAt", due_source as "dueSource", since_at as "sinceAt"
        from api.my_work_items()`;
      return rows.map((r) => ({ ...r, dueAt: iso(r.dueAt), sinceAt: iso(r.sinceAt) }));
    });
  }

  retentionReviewQueue(ctx: UserRequestContext): Promise<RetentionQueueEntry[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<(Omit<RetentionQueueEntry, "archivedAt"> & { archivedAt: Date | null })[]>`
        select case_id as "caseId", case_number as "caseNumber", classification, archived_at as "archivedAt",
               retention_class as "retentionClass", legal_hold_status as "legalHoldStatus"
        from api.retention_review_queue()`;
      return rows.map((r) => ({ ...r, archivedAt: iso(r.archivedAt) }));
    });
  }

  myAccess(ctx: UserRequestContext): Promise<MyAccessEntry[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<
        (Omit<MyAccessEntry, "sinceAt" | "untilAt"> & { sinceAt: Date | null; untilAt: Date | null })[]
      >`
        select basis, code, case_id as "caseId", case_number as "caseNumber", since_at as "sinceAt",
               until_at as "untilAt", target_id as "targetId"
        from api.my_access()`;
      return rows.map((r) => ({ ...r, sinceAt: iso(r.sinceAt), untilAt: iso(r.untilAt) }));
    });
  }

  auditLedger(
    ctx: UserRequestContext,
    categories: readonly LedgerEntry["category"][],
    limit: number,
  ): Promise<LedgerEntry[]> {
    return this.run(ctx, async (tx) => {
      // Metadata columns only: no reason, details, object id or case id (DEC-11).
      const rows = await tx<(Omit<LedgerEntry, "occurredAt"> & { occurredAt: Date })[]>`
        select seq::int as seq, occurred_at as "occurredAt", action, category, actor_type as "actorType",
               coalesce(actor_roles, '{}') as "actorRoles", object_type as "objectType", outcome
        from audit.audit_event where category = any(${[...categories]}::text[])
        order by seq desc limit ${limit}`;
      return rows.map((r) => ({ ...r, occurredAt: iso(r.occurredAt)! }));
    });
  }

  auditChainBreaks(ctx: UserRequestContext): Promise<number> {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ n: number }[]>`select count(*)::int as n from api.verify_audit_chain()`;
      return row!.n;
    });
  }

  userRegister(ctx: UserRequestContext): Promise<UserRegisterEntry[]> {
    return this.run(ctx, (tx) =>
      tx<UserRegisterEntry[]>`
        select p.id, p.display_name as "displayName", p.display_name_ar as "displayNameAr", p.email, p.department,
               p.status::text as status,
               coalesce(array_agg(a.role_code order by a.role_code) filter (where a.role_code is not null), '{}') as roles
        from iam.user_profile p
        left join iam.user_role_assignment a on a.user_id = p.id and a.status = 'ACTIVE'
        group by p.id, p.display_name, p.display_name_ar, p.email, p.department, p.status
        order by p.display_name`.then((r) => [...r]),
    );
  }

  requestCaseForLegalHold(
    ctx: UserRequestContext,
    i: { caseReference: string; justification: string; reasonCode: string },
  ): Promise<CaseDiscoveryResult> {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<CaseDiscoveryResult[]>`
        select outcome, request_id as "requestId"
        from api.request_case_for_legal_hold(${i.caseReference}, ${i.justification}, ${i.reasonCode})`;
      return row!;
    });
  }
}
