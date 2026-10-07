// InvestigationGateway over PostgreSQL. Reads go through RLS (SELECT); writes only call api.* commands.
// Every method runs in its own transaction under the caller's security context (ADR-003).
import type {
  Actor,
  AuditTimelineEntry,
  CaseAssignment,
  CaseDetail,
  CaseDiscoveryResult,
  CaseListItem,
  IntakeReportItem,
  MyCaseTask,
  MyWorkSummary,
  RecordsCatalogueEntry,
  ReportDetail,
  TransitionOption,
  UserDirectoryEntry,
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
               description, incident_date::text as "incidentDate", location, language
        from intake.report where id = ${reportId}`;
      if (!r) return null;
      const messages = await tx<
        { direction: "FROM_REPORTER" | "TO_REPORTER"; body: string; createdAt: Date }[]
      >`
        select direction, body, created_at as "createdAt" from intake.report_message where report_id = ${reportId} order by created_at`;
      return {
        ...(r as unknown as ReportDetail),
        receivedAt: iso(r.receivedAt as Date)!,
        messages: messages.map((m) => ({ ...m, createdAt: iso(m.createdAt)! })),
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
    i: { reportId: string; title: string; summary: string; classification: string; isRestricted: boolean },
  ) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select api.create_case_from_report(${i.reportId}, ${i.title}, ${i.summary},
          ${i.classification}::core.classification_level, ${i.isRestricted}) as id`;
      return row!.id;
    });
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
               records_state as "recordsState", created_at as "createdAt", opened_at as "openedAt", row_version as "rowVersion"
        from case_mgmt.case_overview where id = ${caseId}`;
      if (!c) return null;
      const allegations = await tx<CaseDetail["allegations"]>`
        select id, category, description, status from case_mgmt.allegation where case_id = ${caseId} order by created_at`;
      const assignments = await tx<(Omit<CaseAssignment, "assignedAt"> & { assignedAt: Date })[]>`
        select a.id, a.user_id as "userId", coalesce(u.display_name, '—') as "displayName",
               a.assignment_role as "assignmentRole", a.assigned_at as "assignedAt"
        from case_mgmt.case_assignment a left join iam.user_profile u on u.id = a.user_id
        where a.case_id = ${caseId} and a.status = 'ACTIVE' order by a.assigned_at`;
      const transitions = await tx<TransitionOption[]>`
        select code, to_state as "toState", name_en as "nameEn", name_ar as "nameAr", reason_required as "reasonRequired",
               allowed, coalesce(blocking_reasons, '{}') as "blockingReasons"
        from api.available_transitions(${caseId}) where is_enabled`;
      const [conflict] = await tx<{ status: string }[]>`
        select status from case_mgmt.conflict_check where case_id = ${caseId} and user_id = authz.current_user_id() and is_current`;
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
        allegations: [...allegations],
        assignments: assignments.map((a) => ({ ...a, assignedAt: iso(a.assignedAt)! })),
        transitions: [...transitions],
        myConflictStatus: conflict?.status ?? null,
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

  transitionCase(ctx: UserRequestContext, i: { caseId: string; transitionCode: string; reason?: string }) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<
        { state: string }[]
      >`select api.transition_case(${i.caseId}, ${i.transitionCode}, ${i.reason ?? null}) as state`;
      return row!.state;
    });
  }

  caseTimeline(ctx: UserRequestContext, caseId: string): Promise<AuditTimelineEntry[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<(Omit<AuditTimelineEntry, "occurredAt"> & { occurredAt: Date })[]>`
        select e.seq::int as seq, e.occurred_at as "occurredAt", e.action, e.actor_id as "actorId",
               u.display_name as "actorName", e.reason
        from audit.audit_event e left join iam.user_profile u on u.id = e.actor_id
        where e.case_id = ${caseId} and e.category = 'BUSINESS' and e.action <> 'CASE_VIEWED'
        order by e.seq desc limit 200`;
      return rows.map((r) => ({ ...r, occurredAt: iso(r.occurredAt)! }));
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
