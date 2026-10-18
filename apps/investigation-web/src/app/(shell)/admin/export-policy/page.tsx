// Administration › Export policy (UX redesign Phase 12 P12-8a; ADR-051's P12-8a amendment; DEC-F21 to DEC-F24). The
// export policy administrator's register: the rules every export is checked against, the purposes a requester picks
// from, the approved external domains, each approval stage's pool and the configuration warnings, which carry ids,
// stages and times only. It opens only where authz.is_export_policy_admin() does, never to whoever holds an export
// approval permission (DEC-F24); anyone else gets the uniform not-found, recorded as ACCESS_DENIED. Read only: approver
// pools change only with dual control (DEC-12), and no command keeps the domain list yet.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { AdminExportRule } from "@cdf/contracts";
import { isolate, type MessageKey, type Translator } from "@cdf/i18n";
import { CDFBadge, CDFCard, CDFConfiguredValue, CDFIdentifier, CDFTable } from "@cdf/ui";
import { administrationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { AdminFrame } from "../admin-frame";
import { SOURCE, day, period, personName, sourceLabel, stateLabel, stateTone } from "../labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("admin.views.export-policy") };
}

/** A label from a section, else the code as written. */
function labelOr(t: Translator, section: string, code: string): string {
  const key = `${section}.${code}`;
  const text = t(key as MessageKey);
  return text === key ? code : text;
}

/** What a rule matches, fact by fact: audience, classification, content and restricted cases. */
function appliesTo(t: Translator, r: AdminExportRule): string[] {
  return [
    t(`admin.exports.audience.${r.audience}` as MessageKey),
    ...(r.minClassification
      ? [t("admin.exports.fromClassification", { level: t.code("classification", r.minClassification) })]
      : []),
    ...(r.objectType
      ? [t("admin.exports.holding", { content: labelOr(t, "exports.objectType", r.objectType) })]
      : []),
    ...(r.restrictedOnly ? [t("admin.exports.restrictedOnly")] : []),
  ];
}

/** A short display reference for an id: never a key, never looked up. */
const shortRef = (id: string) => id.slice(0, 8).toUpperCase();

export default async function AdminExportPolicyRegister() {
  const { actor, ctx } = await requireActor();
  const page = await administrationService().exportPolicy(ctx, actor);
  if (!page) notFound();
  const t = await getTranslator();
  const me = actor.userId;
  const who = (id: string | null) => personName(t, page.people, id, me);
  const purposes = [...page.purposes].sort((a, b) => Number(a.isLegacy) - Number(b.isLegacy));
  return (
    <AdminFrame t={t} actor={actor} view="export-policy" intro={t("admin.exports.intro")}>
      <CDFCard title={t("admin.exports.rulesTitle")} testId="admin-export-rules">
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.exports.rulesIntro")}</p>
        <CDFTable
          caption={t("admin.exports.rulesTitle")}
          testId="admin-export-rule-list"
          rows={page.rules}
          rowKey={(r) => r.ruleId}
          empty={t("admin.exports.noRules")}
          columns={[
            {
              header: t("admin.exports.rule"),
              cell: (r) => (
                <span data-testid={`admin-export-rule-${r.code}`}>
                  {labelOr(t, "exports.rule", r.code)}
                  {r.code === "RESTRICTED_CASE_AUTHORITY" ? (
                    <p className="text-sm text-cdf-text-secondary" data-testid="admin-export-rule-protected">
                      {t("admin.exports.protected")}
                    </p>
                  ) : null}
                </span>
              ),
            },
            { header: t("admin.exports.appliesTo"), cell: (r) => appliesTo(t, r).join(" · ") },
            {
              header: t("admin.exports.effect"),
              cell: (r) => t(`admin.exports.action.${r.action}` as MessageKey),
            },
            {
              header: t("admin.columns.source"),
              cell: (r) => (
                <CDFConfiguredValue
                  value=""
                  source={SOURCE[r.sourceStatus]}
                  sourceLabel={sourceLabel(t, r.sourceStatus)}
                />
              ),
            },
            { header: t("admin.columns.period"), cell: (r) => period(t, r.effectiveFrom, r.effectiveTo) },
            {
              header: t("admin.columns.state"),
              cell: (r) => <CDFBadge tone={stateTone(r.state)}>{stateLabel(t, r.state)}</CDFBadge>,
            },
          ]}
        />
      </CDFCard>

      <CDFCard title={t("admin.exports.purposesTitle")} testId="admin-export-purposes">
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.exports.purposesIntro")}</p>
        <CDFTable
          caption={t("admin.exports.purposesTitle")}
          testId="admin-export-purpose-list"
          rows={purposes}
          rowKey={(p) => p.code}
          empty={t("admin.exports.noPurposes")}
          columns={[
            {
              header: t("admin.exports.purpose"),
              cell: (p) => (
                <span data-testid={`admin-export-purpose-${p.code}`}>
                  <bdi>{t.locale === "ar" ? p.nameAr : p.nameEn}</bdi>
                </span>
              ),
            },
            {
              header: t("admin.exports.justification"),
              cell: (p) => t(p.requiresJustification ? "common.yes" : "common.no"),
            },
            {
              header: t("admin.columns.status"),
              cell: (p) =>
                t(p.isLegacy ? "admin.exports.legacy" : p.isActive ? "admin.active" : "admin.inactive"),
            },
            {
              header: t("admin.columns.source"),
              cell: (p) => (
                <CDFConfiguredValue
                  value=""
                  source={SOURCE[p.sourceStatus]}
                  sourceLabel={sourceLabel(t, p.sourceStatus)}
                />
              ),
            },
          ]}
        />
      </CDFCard>

      <CDFCard title={t("admin.exports.domainsTitle")} testId="admin-export-domains">
        {page.approvedDomains.status === "CONFIGURED" && page.approvedDomains.domains.length > 0 ? (
          <ul className="grid gap-1" data-testid="admin-export-domain-list">
            {page.approvedDomains.domains.map((d) => (
              <li key={d}>
                <CDFIdentifier>{d}</CDFIdentifier>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">
            <CDFConfiguredValue
              value={t("exports.domainsNotConfigured")}
              source="SOURCE_REQUIRED"
              sourceLabel={t(`admin.settingStatus.${page.approvedDomains.status}` as MessageKey)}
              testId="admin-export-domains-value"
            />
          </p>
        )}
      </CDFCard>

      <CDFCard title={t("admin.exports.poolsTitle")} testId="admin-export-pools">
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.exports.poolsIntro")}</p>
        <ul className="mb-3 grid gap-1 text-sm">
          {page.warnings.pools.map((p) => (
            <li key={p.stage} data-testid={`admin-export-pool-${p.stage}`} data-in-use={p.inUse}>
              <span className="font-semibold">{t("admin.exports.stage", { stage: p.stage })}</span>{" "}
              {!p.inUse
                ? t("admin.exports.poolNotInUse")
                : p.activeMembers === 0
                  ? t("admin.exports.poolEmpty")
                  : t("admin.exports.poolInUse", { count: p.activeMembers })}
            </li>
          ))}
        </ul>
        <CDFTable
          caption={t("admin.exports.poolMembers")}
          testId="admin-export-pool-members"
          rows={page.pool}
          rowKey={(m) => m.memberId}
          empty={t("admin.exports.noPoolMembers")}
          columns={[
            { header: t("admin.exports.stageLabel"), cell: (m) => String(m.stage) },
            { header: t("admin.columns.holder"), cell: (m) => <bdi>{who(m.userId)}</bdi> },
            {
              header: t("admin.columns.recorded"),
              cell: (m) => (
                <>
                  {t("admin.recordedBy", { name: isolate(who(m.addedBy)), date: day(t, m.addedAt) })}
                  {m.revokedAt ? (
                    <p className="text-cdf-text-secondary">
                      {t("admin.exports.removedOn", { date: day(t, m.revokedAt) })}
                    </p>
                  ) : null}
                </>
              ),
            },
          ]}
        />
      </CDFCard>

      <CDFCard title={t("admin.exports.warningsTitle")} testId="admin-export-warnings">
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.exports.warningsIntro")}</p>
        <CDFTable
          caption={t("admin.exports.warningsTitle")}
          testId="admin-export-warning-list"
          rows={page.warnings.warnings}
          rowKey={(w) => w.warningId}
          empty={t("admin.exports.noWarnings")}
          columns={[
            {
              header: t("admin.exports.request"),
              cell: (w) => <CDFIdentifier>{shortRef(w.requestId)}</CDFIdentifier>,
            },
            { header: t("admin.exports.stageLabel"), cell: (w) => String(w.stage) },
            { header: t("admin.exports.raised"), cell: (w) => day(t, w.raisedAt) },
            {
              header: t("admin.exports.stillBlocked"),
              cell: (w) => t(w.stillBlocked ? "common.yes" : "common.no"),
            },
          ]}
        />
      </CDFCard>

      <p className="text-sm text-cdf-text-secondary" data-testid="admin-export-later">
        {t("admin.exports.later")}
      </p>
    </AdminFrame>
  );
}
