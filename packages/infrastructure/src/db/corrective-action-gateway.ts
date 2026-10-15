// CorrectiveActionGateway over PostgreSQL (ADR-033, migration 1940). Every call runs the api.* command, or reads
// through RLS, in the caller's security context: the database decides ownership, the case gate and the authority.
import type { CorrectiveActionGateway, UserRequestContext } from "@cdf/application";
import type { CorrectiveAction, CorrectiveActionStatus, CorrectiveActionType } from "@cdf/contracts";
import { withUserContext, type Sql, type Tx } from "./security-context";

type P<K extends keyof CorrectiveActionGateway> = Parameters<CorrectiveActionGateway[K]>[1];

interface ActionRow {
  id: string;
  case_id: string;
  recommendation_item_id: string | null;
  action_type: CorrectiveActionType;
  sequence_no: number;
  title: string;
  description: string;
  owner_id: string;
  due_date: string;
  status: CorrectiveActionStatus;
  percent_complete: number;
}

export class PostgresCorrectiveActionGateway implements CorrectiveActionGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
  }

  setPolicy(ctx: UserRequestContext, i: P<"setPolicy">): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select api.set_corrective_action_policy(${i.actionType}, ${i.defaultDueDays ?? null}::int,
          ${i.reminderDaysBefore ?? null}::int, ${i.escalateAfterDays ?? null}::int, ${i.completionEvidence},
          ${i.effectiveFrom}::timestamptz, ${i.sourceStatus}, ${i.reason}) as id`;
      return r!.id;
    });
  }

  open(ctx: UserRequestContext, i: P<"open">): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select api.open_corrective_action(${i.itemId}, ${i.title}, ${i.description}, ${i.ownerId},
          ${i.dueDate ?? null}::date) as id`;
      return r!.id;
    });
  }

  async assignOwner(ctx: UserRequestContext, i: P<"assignOwner">): Promise<void> {
    await this.run(
      ctx,
      (tx) => tx`select api.assign_corrective_action_owner(${i.actionId}, ${i.ownerId}, ${i.reason})`,
    );
  }

  async changeDueDate(ctx: UserRequestContext, i: P<"changeDueDate">): Promise<void> {
    await this.run(
      ctx,
      (tx) =>
        tx`select api.change_corrective_action_due_date(${i.actionId}, ${i.dueDate}::date, ${i.reason})`,
    );
  }

  async recordProgress(ctx: UserRequestContext, i: P<"recordProgress">): Promise<void> {
    await this.run(
      ctx,
      (tx) =>
        tx`select api.record_corrective_action_progress(${i.actionId}, ${i.percentComplete}, ${i.note})`,
    );
  }

  async submitCompletion(ctx: UserRequestContext, i: P<"submitCompletion">): Promise<void> {
    await this.run(
      ctx,
      (tx) =>
        tx`select api.submit_corrective_action_completion(${i.actionId}, ${i.note}, ${i.evidenceReference ?? null})`,
    );
  }

  verify(ctx: UserRequestContext, i: P<"verify">): Promise<CorrectiveActionStatus> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ status: CorrectiveActionStatus }[]>`
        select api.verify_corrective_action(${i.actionId}, ${i.decision}, ${i.note ?? null}) as status`;
      return r!.status;
    });
  }

  async reopen(ctx: UserRequestContext, i: P<"reopen">): Promise<void> {
    await this.run(ctx, (tx) => tx`select api.reopen_corrective_action(${i.actionId}, ${i.reason})`);
  }

  async waive(ctx: UserRequestContext, i: P<"waive">): Promise<void> {
    await this.run(
      ctx,
      (tx) =>
        tx`select api.waive_corrective_action(${i.actionId}, ${i.sourceDocumentReference}, ${i.reason})`,
    );
  }

  list(ctx: UserRequestContext, filter: P<"list">): Promise<CorrectiveAction[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<ActionRow[]>`
        select a.id, a.case_id, a.recommendation_item_id, a.action_type, a.sequence_no, a.title, a.description,
               a.owner_id, a.due_date::text as due_date, a.status, a.percent_complete
        from decision.corrective_action a
        where (${filter.caseId ?? null}::uuid is null or a.case_id = ${filter.caseId ?? null}::uuid)
          and (not ${filter.mine ?? false} or a.owner_id = authz.current_user_id())
        order by a.due_date, a.sequence_no
        limit 500`;
      return rows.map((r) => ({
        id: r.id,
        caseId: r.case_id,
        recommendationItemId: r.recommendation_item_id,
        actionType: r.action_type,
        sequenceNo: r.sequence_no,
        title: r.title,
        description: r.description,
        ownerId: r.owner_id,
        dueDate: r.due_date,
        status: r.status,
        percentComplete: r.percent_complete,
      }));
    });
  }
}
