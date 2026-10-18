// Administration › Corrective-action policy (UX redesign Phase 12 P12-8a; ADR-051's P12-8a amendment; DEC-F25 to
// DEC-F27). The policy administrator's register: for each type of action, its due date, reminders, escalation and
// what completing it needs, version by version, with the kinds of evidence and the action pools. A period nobody has
// set says so; it is never guessed. Read in the administrator's own context after the database confirms
// CORRECTIVE_ACTION_POLICY_ADMIN; anyone else gets the uniform not-found, recorded as ACCESS_DENIED. Read only:
// creating a pool waits (coordinator ruling F12), and changing a policy is a later slice.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { AdminCorrectiveActionPolicy, AdminCorrectiveActionPolicyPage } from "@cdf/contracts";
import { formatDays, formatList, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import { CDFBadge, CDFCard, CDFConfiguredValue, CDFDescriptionList, CDFTable } from "@cdf/ui";
import { administrationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { AdminFrame } from "../admin-frame";
import { SOURCE, day, period, personName, sourceLabel, stateLabel, stateTone } from "../labels";

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
    <AdminFrame t={t} actor={actor} view="corrective-action-policy" intro={t("admin.actions.intro")}>
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
  const testId = `admin-action-policy-${p.actionType}`;
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
