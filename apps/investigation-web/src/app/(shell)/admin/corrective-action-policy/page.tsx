// Administration › Corrective-action policy (UX redesign Phase 12 P12-8a and P12-8b; ADR-051's P12-8a amendment,
// ADR-063; DEC-F25 to DEC-F27). The policy administrator's register: for each type of action, its due date, reminders,
// escalation and what completing it needs, version by version, with the kinds of evidence and the action pools. A
// period nobody has set says so; it is never guessed. Read in the administrator's own context after the database
// confirms CORRECTIVE_ACTION_POLICY_ADMIN; anyone else gets the uniform not-found, recorded as ACCESS_DENIED. One form
// per type of action, shown only where the database says api.set_corrective_action_policy would accept the caller now
// (api.admin_corrective_action_policy_capabilities, 2127): a new version from a later date with all twelve of the
// command's values (G8), always provisional, and never asking for less completion evidence than a version in force or
// scheduled (coordinator ruling on F4, 2026-10-18 21:17). Creating a pool waits (coordinator ruling F12).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  CORRECTIVE_ACTION_TYPES,
  ESCALATION_RECIPIENT_KINDS,
  type AdminCorrectiveActionPolicy,
  type AdminCorrectiveActionPolicyPage,
  type CorrectiveActionType,
} from "@cdf/contracts";
import { formatDays, formatList, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFCommandForm,
  CDFConfiguredValue,
  CDFDescriptionList,
  CDFField,
  CDFFieldError,
  CDFTable,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { needsEvidenceReference } from "@cdf/application";
import { administrationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { confirmation } from "../../confirmations";
import { AdminFrame } from "../admin-frame";
import {
  ADMIN_CODES,
  SOURCE,
  day,
  period,
  personName,
  plusDays,
  sourceLabel,
  stateLabel,
  stateTone,
} from "../labels";
import { setCorrectiveActionPolicyAction } from "./actions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("admin.views.corrective-action-policy") };
}

/** An evidence kind's name in the reader's language: the catalogue's, else the action pages' words, else the code. */
function evidenceName(t: Translator, page: AdminCorrectiveActionPolicyPage, code: string): string {
  const entry = page.evidenceTypes.find((e) => e.code === code);
  if (entry) return t.locale === "ar" ? entry.nameAr : entry.nameEn;
  const key = `correctiveActions.evidenceType.${code}`;
  const text = t(key as MessageKey);
  return text === key ? code : text;
}

export default async function AdminCorrectiveActionPolicyRegister() {
  const { actor, ctx } = await requireActor();
  const page = await administrationService().correctiveActionPolicy(ctx, actor);
  if (!page) notFound();
  const t = await getTranslator();
  const current = page.policies.filter((p) => p.state !== "ENDED");
  const ended = page.policies.filter((p) => p.state === "ENDED").reverse();
  return (
    <AdminFrame t={t} views={page.views} view="corrective-action-policy" intro={t("admin.actions.intro")}>
      {current.length === 0 ? (
        <p className="mb-6 text-cdf-text-secondary">{t("admin.actions.noPolicies")}</p>
      ) : null}
      {current.map((p) => (
        <PolicyCard key={p.policyId} t={t} page={page} policy={p} />
      ))}
      {ended.length > 0 ? (
        <details className="mb-6" data-testid="admin-action-policies-ended">
          <summary className="cursor-pointer font-semibold">
            {t("admin.actions.endedVersions", { count: ended.length })}
          </summary>
          <ul className="mt-2 grid gap-1 text-sm">
            {ended.map((p) => (
              <li key={p.policyId}>
                {t(`correctiveActions.type.${p.actionType}` as MessageKey)} ·{" "}
                {period(t, p.effectiveFrom, p.effectiveTo)} · {sourceLabel(t, p.sourceStatus)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <CDFCard title={t("admin.actions.evidenceTitle")} testId="admin-evidence-types">
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.actions.evidenceIntro")}</p>
        <CDFTable
          caption={t("admin.actions.evidenceTitle")}
          testId="admin-evidence-type-list"
          rows={page.evidenceTypes}
          rowKey={(e) => e.code}
          empty={t("admin.actions.noEvidenceTypes")}
          columns={[
            {
              header: t("admin.actions.evidenceKind"),
              cell: (e) => <bdi>{t.locale === "ar" ? e.nameAr : e.nameEn}</bdi>,
            },
            {
              header: t("admin.columns.status"),
              cell: (e) => t(e.isActive ? "admin.active" : "admin.inactive"),
            },
          ]}
        />
      </CDFCard>

      <CDFCard title={t("admin.actions.poolsTitle")} testId="admin-action-pools">
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.actions.poolsIntro")}</p>
        {page.pools.length === 0 ? (
          <p className="text-cdf-text-secondary" data-testid="admin-action-pools-none">
            {t("admin.actions.noPools")}
          </p>
        ) : (
          <ul className="grid gap-3" data-testid="admin-action-pool-list">
            {page.pools.map((pool) => (
              <li key={pool.poolId} className="rounded-cdf-md border border-cdf-border p-3">
                <p className="font-semibold">
                  <bdi>{pool.name}</bdi>{" "}
                  <CDFBadge tone={pool.isActive ? "success" : "neutral"}>
                    {t(pool.isActive ? "admin.active" : "admin.inactive")}
                  </CDFBadge>
                </p>
                <p className="text-sm text-cdf-text-secondary">
                  {t("admin.recordedBy", {
                    name: isolate(personName(t, page.people, pool.createdBy, actor.userId)),
                    date: day(t, pool.createdAt),
                  })}
                </p>
                <p className="text-sm">
                  {pool.members.filter((m) => m.removedAt === null).length === 0
                    ? t("admin.actions.poolNoMembers")
                    : formatList(
                        t.locale,
                        pool.members
                          .filter((m) => m.removedAt === null)
                          .map((m) => personName(t, page.people, m.userId, actor.userId)),
                      )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CDFCard>

      {page.capabilities.maySetPolicy ? (
        <CDFCard title={t("admin.actions.formTitle")} testId="admin-action-policy-change">
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.actions.formIntro")}</p>
          <div className="grid gap-2">
            {CORRECTIVE_ACTION_TYPES.map((type) => (
              <PolicyForm key={type} t={t} page={page} type={type} />
            ))}
          </div>
        </CDFCard>
      ) : null}

      <p className="text-sm text-cdf-text-secondary" data-testid="admin-actions-later">
        {t("admin.actions.later")}
      </p>
    </AdminFrame>
  );
}

function PolicyCard({
  t,
  page,
  policy: p,
}: {
  t: Translator;
  page: AdminCorrectiveActionPolicyPage;
  policy: AdminCorrectiveActionPolicy;
}) {
  // An empty setting is said as what it does (notify.emit_due_reminders): no reminder, no repeat, no notice.
  const days = (n: number) => isolate(formatDays(t.locale, n));
  const or = (n: number | null, none: MessageKey, some: MessageKey) =>
    n === null ? t(none) : t(some, { days: days(n) });
  // The version in force keeps the type's own id; a version that starts later is told apart by its own.
  const testId =
    p.state === "IN_FORCE"
      ? `admin-action-policy-${p.actionType}`
      : `admin-action-policy-${p.actionType}-${p.policyId}`;
  return (
    <CDFCard
      title={t(`correctiveActions.type.${p.actionType}` as MessageKey)}
      testId={testId}
      actions={<CDFBadge tone={stateTone(p.state)}>{stateLabel(t, p.state)}</CDFBadge>}
    >
      <p className="mb-3 text-sm">
        <CDFConfiguredValue
          value={period(t, p.effectiveFrom, p.effectiveTo)}
          source={SOURCE[p.sourceStatus]}
          sourceLabel={sourceLabel(t, p.sourceStatus)}
          testId={`${testId}-source`}
        />
      </p>
      <CDFDescriptionList
        items={[
          {
            term: t("admin.actions.defaultDue"),
            value:
              p.defaultDueDays === null ? t("admin.notConfigured") : formatDays(t.locale, p.defaultDueDays),
          },
          {
            term: t("admin.actions.reminderBefore"),
            value: or(p.reminderDaysBefore, "admin.actions.noReminder", "admin.actions.beforeDue"),
          },
          {
            term: t("admin.actions.reminderRepeat"),
            value: or(p.reminderRepeatDays, "admin.actions.noRepeat", "admin.actions.repeatEvery"),
          },
          {
            term: t("admin.actions.overdueAfter"),
            value: or(p.overdueAfterDays, "admin.actions.off", "admin.actions.afterDue"),
          },
          {
            term: t("admin.actions.escalateAfter"),
            value: or(p.escalateAfterDays, "admin.actions.off", "admin.actions.afterDue"),
          },
          {
            term: t("admin.actions.completionEvidence"),
            value: t(`admin.actions.completion.${p.completionEvidence}` as MessageKey),
          },
          {
            term: t("admin.actions.allowedEvidence"),
            value:
              p.allowedEvidenceTypes === null
                ? t("admin.actions.anyEvidence")
                : formatList(
                    t.locale,
                    p.allowedEvidenceTypes.map((code) => evidenceName(t, page, code)),
                  ),
          },
          {
            term: t("admin.actions.escalationSteps"),
            value:
              p.steps.length === 0 ? (
                t("admin.actions.noSteps")
              ) : (
                <ol className="grid gap-1">
                  {p.steps.map((s) => (
                    <li key={s.stepNo}>
                      {t("admin.actions.step", {
                        days: days(s.afterDaysOverdue),
                        recipient:
                          s.recipientKind === "ROLE" && s.roleCode
                            ? t("admin.actions.recipientRole", { role: isolate(t.code("role", s.roleCode)) })
                            : t(`admin.actions.recipient.${s.recipientKind}` as MessageKey),
                      })}
                    </li>
                  ))}
                </ol>
              ),
          },
        ]}
      />
    </CDFCard>
  );
}

/** The escalation rows a version form shows: the last version's steps and room for more, at most ten (2040). */
const stepRows = (steps: number) => Math.min(10, Math.max(5, steps + 2));

/**
 * What a new version of a type's policy may ask for, by the versions in force or scheduled (coordinator ruling on F4):
 * a note alone only where none of them needs a reference, and only kinds every one of them that lists kinds accepts.
 * The service checks the same under the command's lock (`looserCompletionRule`); this only keeps the form honest.
 */
function completionBounds(
  page: AdminCorrectiveActionPolicyPage,
  open: readonly AdminCorrectiveActionPolicy[],
) {
  const noteAllowed = !open.some((p) => needsEvidenceReference(p.completionEvidence));
  const lists = open.map((p) => p.allowedEvidenceTypes).filter((l): l is string[] => l !== null);
  const active = page.evidenceTypes.filter((e) => e.isActive);
  const kinds = lists.length === 0 ? active : active.filter((e) => lists.every((l) => l.includes(e.code)));
  return { noteAllowed, limited: lists.length > 0, kinds };
}

/**
 * A new version of one type's policy from a later date, starting from the latest version in force or scheduled. Every
 * value is sent (G8): an empty period is "not set", as the register says it. The database answers the start date,
 * each value and a later version (LATER_POLICY_EXISTS); the service refuses a looser completion rule.
 */
function PolicyForm({
  t,
  page,
  type,
}: {
  t: Translator;
  page: AdminCorrectiveActionPolicyPage;
  type: CorrectiveActionType;
}) {
  const id = `admin-action-policy-form-${type}`;
  const open = page.policies.filter((p) => p.actionType === type && p.state !== "ENDED");
  const latest = open.at(-1);
  const bounds = completionBounds(page, open);
  const name = t(`correctiveActions.type.${type}` as MessageKey);
  const ticked = new Set(latest?.allowedEvidenceTypes ?? []);
  const rows = stepRows(latest?.steps.length ?? 0);
  const value = (n: number | null | undefined) => (n === null || n === undefined ? undefined : String(n));
  const dayField = (
    field:
      | "defaultDueDays"
      | "reminderDaysBefore"
      | "reminderRepeatDays"
      | "overdueAfterDays"
      | "escalateAfterDays",
    label: MessageKey,
    hint: MessageKey,
    min: number,
    max: number,
  ) => (
    <CDFField id={`${id}-${field}`} label={t(label)} hint={t(hint)} optionalLabel={t("common.optional")}>
      <input
        id={`${id}-${field}`}
        name={field}
        type="number"
        inputMode="numeric"
        className={inputClass}
        defaultValue={value(latest?.[field])}
        aria-describedby={`${id}-${field}-hint`}
        min={min}
        max={max}
        step={1}
      />
    </CDFField>
  );
  return (
    <details className="rounded-cdf-md border border-cdf-border p-3" data-testid={`${id}-details`}>
      <summary className="cursor-pointer font-semibold">
        {t("admin.actions.formSummary", { type: isolate(name) })}
      </summary>
      <div className="mt-3">
        <p className="mb-3 text-sm text-cdf-text-secondary">
          {latest
            ? t("admin.actions.startsFromLatest", { date: day(t, latest.effectiveFrom) })
            : t("admin.actions.startsFromNone")}
        </p>
        <CDFCommandForm
          action={setCorrectiveActionPolicyAction}
          locale={t.locale}
          submitLabel={t("admin.actions.record")}
          submitName={t("admin.actions.recordFor", { type: isolate(name) })}
          variant="primary"
          testId={id}
          successMessage={t("admin.actions.recorded")}
          leaveWarning={t("common.leaveWarning")}
          codeSections={ADMIN_CODES}
          fieldLabels={{
            defaultDueDays: t("admin.actions.defaultDue"),
            reminderDaysBefore: t("admin.actions.reminderBefore"),
            reminderRepeatDays: t("admin.actions.reminderRepeat"),
            overdueAfterDays: t("admin.actions.overdueAfter"),
            escalateAfterDays: t("admin.actions.escalateAfter"),
            completionEvidence: t("admin.actions.completionEvidence"),
            allowedEvidenceTypes: t("admin.actions.allowedEvidence"),
            effectiveFrom: t("admin.startsOn"),
            reason: t("admin.calendar.reason"),
            ...Object.fromEntries(
              Array.from({ length: rows }, (_, k) => [
                [`escalationSteps.${k}.afterDaysOverdue`, t("admin.actions.stepDays", { step: k + 1 })],
                [`escalationSteps.${k}.recipientKind`, t("admin.actions.stepRecipient", { step: k + 1 })],
                [`escalationSteps.${k}.roleCode`, t("admin.actions.stepRole", { step: k + 1 })],
              ]).flat(),
            ),
          }}
          confirm={confirmation(t, "setCorrectiveActionPolicy")}
        >
          <input type="hidden" name="actionType" value={type} />
          {dayField("defaultDueDays", "admin.actions.defaultDue", "admin.actions.defaultDueHint", 1, 730)}
          {dayField(
            "reminderDaysBefore",
            "admin.actions.reminderBefore",
            "admin.actions.reminderBeforeHint",
            1,
            90,
          )}
          {dayField(
            "reminderRepeatDays",
            "admin.actions.reminderRepeat",
            "admin.actions.reminderRepeatHint",
            1,
            90,
          )}
          {dayField(
            "overdueAfterDays",
            "admin.actions.overdueAfter",
            "admin.actions.overdueAfterHint",
            0,
            365,
          )}
          {dayField(
            "escalateAfterDays",
            "admin.actions.escalateAfter",
            "admin.actions.escalateAfterHint",
            1,
            365,
          )}

          <fieldset className="mb-4" aria-describedby={`${id}-completion-hint`}>
            <legend className="mb-1 font-semibold">
              {t("admin.actions.completionEvidence")}
              <span className="ms-2 text-sm font-normal text-cdf-text-secondary">
                ({t("common.required")})
              </span>
            </legend>
            <p id={`${id}-completion-hint`} className="mb-2 text-sm text-cdf-text-secondary">
              {t(bounds.noteAllowed ? "admin.actions.completionHint" : "admin.actions.completionFixed")}
            </p>
            <div className="grid gap-2">
              {(bounds.noteAllowed
                ? (["REFERENCE_REQUIRED", "NOTE_ONLY"] as const)
                : (["REFERENCE_REQUIRED"] as const)
              ).map((rule) => (
                <div key={rule} className="flex items-center gap-2">
                  <input
                    id={`${id}-completion-${rule}`}
                    type="radio"
                    name="completionEvidence"
                    value={rule}
                    defaultChecked={(latest?.completionEvidence ?? "REFERENCE_REQUIRED") === rule}
                    className="size-5 shrink-0"
                    data-testid={`${id}-completion-${rule}`}
                  />
                  <label htmlFor={`${id}-completion-${rule}`}>
                    {t(`admin.actions.completion.${rule}` as MessageKey)}
                  </label>
                </div>
              ))}
            </div>
            <CDFFieldError id={`${id}-completion-REFERENCE_REQUIRED`} />
          </fieldset>

          <fieldset className="mb-4" aria-describedby={`${id}-kinds-hint`}>
            <legend className="mb-1 font-semibold">
              {t("admin.actions.allowedEvidence")}
              <span className="ms-2 text-sm font-normal text-cdf-text-secondary">
                ({t(bounds.limited ? "common.required" : "common.optional")})
              </span>
            </legend>
            <p id={`${id}-kinds-hint`} className="mb-2 text-sm text-cdf-text-secondary">
              {t(bounds.limited ? "admin.actions.kindsLimited" : "admin.actions.kindsHint")}
            </p>
            {bounds.kinds.length === 0 ? (
              <p className="text-sm" data-testid={`${id}-no-kinds`}>
                {t("admin.actions.noKindsOffered")}
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {bounds.kinds.map((e) => (
                  <div key={e.code} className="flex items-center gap-2">
                    <input
                      id={`${id}-kind-${e.code}`}
                      type="checkbox"
                      name="allowedEvidenceTypes"
                      value={e.code}
                      defaultChecked={ticked.has(e.code)}
                      className="size-5 shrink-0"
                      data-testid={`${id}-kind-${e.code}`}
                    />
                    <label htmlFor={`${id}-kind-${e.code}`}>
                      <bdi>{t.locale === "ar" ? e.nameAr : e.nameEn}</bdi>
                    </label>
                  </div>
                ))}
              </div>
            )}
            {bounds.kinds[0] ? <CDFFieldError id={`${id}-kind-${bounds.kinds[0].code}`} /> : null}
          </fieldset>

          <fieldset className="mb-4" aria-describedby={`${id}-steps-hint`}>
            <legend className="mb-1 font-semibold">
              {t("admin.actions.escalationSteps")}
              <span className="ms-2 text-sm font-normal text-cdf-text-secondary">
                ({t("common.optional")})
              </span>
            </legend>
            <p id={`${id}-steps-hint`} className="mb-2 text-sm text-cdf-text-secondary">
              {t("admin.actions.stepsHint")}
            </p>
            <ol className="grid gap-3">
              {Array.from({ length: rows }, (_, k) => {
                const step = latest?.steps[k];
                const row = `${id}-step-${k}`;
                return (
                  <li key={k} className="rounded-cdf-md border border-cdf-border p-3" data-testid={row}>
                    <p className="mb-2 font-semibold">{t("admin.actions.stepTitle", { step: k + 1 })}</p>
                    <div className="grid gap-x-4 sm:grid-cols-3">
                      <CDFField id={`${row}-days`} label={t("admin.actions.stepDaysLabel")}>
                        <input
                          id={`${row}-days`}
                          name={`escalationSteps.${k}.afterDaysOverdue`}
                          type="number"
                          inputMode="numeric"
                          className={inputClass}
                          defaultValue={value(step?.afterDaysOverdue)}
                          min={0}
                          max={365}
                          step={1}
                        />
                      </CDFField>
                      <CDFField id={`${row}-recipient`} label={t("admin.actions.stepRecipientLabel")}>
                        <select
                          id={`${row}-recipient`}
                          name={`escalationSteps.${k}.recipientKind`}
                          className={inputClass}
                          defaultValue={step?.recipientKind ?? ""}
                        >
                          <option value="">{t("admin.actions.noStep")}</option>
                          {ESCALATION_RECIPIENT_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                              {t(`admin.actions.recipientOption.${kind}` as MessageKey)}
                            </option>
                          ))}
                        </select>
                      </CDFField>
                      <CDFField id={`${row}-role`} label={t("admin.actions.stepRoleLabel")}>
                        <select
                          id={`${row}-role`}
                          name={`escalationSteps.${k}.roleCode`}
                          className={inputClass}
                          defaultValue={step?.roleCode ?? ""}
                        >
                          <option value="">{t("admin.actions.noRole")}</option>
                          {page.roles.map((r) => (
                            <option key={r.code} value={r.code}>
                              {t.locale === "ar" ? r.nameAr : r.nameEn}
                            </option>
                          ))}
                        </select>
                      </CDFField>
                    </div>
                  </li>
                );
              })}
            </ol>
          </fieldset>

          <CDFField
            id={`${id}-from`}
            label={t("admin.startsOn")}
            hint={t("admin.actions.fromHint")}
            requiredLabel={t("common.required")}
          >
            <input
              id={`${id}-from`}
              name="effectiveFrom"
              type="date"
              className={inputClass}
              min={plusDays(page.today, 1)}
              aria-describedby={`${id}-from-hint`}
              required
            />
          </CDFField>
          <CDFField
            id={`${id}-reason`}
            label={t("admin.calendar.reason")}
            hint={t("admin.calendar.reasonHint")}
            requiredLabel={t("common.required")}
          >
            <textarea
              id={`${id}-reason`}
              name="reason"
              className={textareaClass}
              aria-describedby={`${id}-reason-hint`}
              minLength={5}
              maxLength={2000}
              required
            />
          </CDFField>
        </CDFCommandForm>
      </div>
    </details>
  );
}
