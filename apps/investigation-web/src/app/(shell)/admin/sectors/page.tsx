// Administration › Sectors (UX redesign Phase 12 P12-8a; ADR-051's P12-8a amendment). The sector administrator's
// register: who holds each sector position, and the referral approvals sector heads have delegated (Q1–Q4), as
// recorded, revoked ones included. Read in the administrator's own context after the database confirms SECTOR_ADMIN;
// anyone else gets the uniform not-found, recorded as ACCESS_DENIED. Read only: position appointments wait (coordinator
// rulings F5 and F7), and the self-appointment form stays hidden until the check that narrows it (F6, CDF-259).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SECTOR_POSITIONS, type AdminSector, type AdminSectorsPage } from "@cdf/contracts";
import { formatDays, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import { CDFBadge, CDFCard, CDFConfiguredValue, CDFTable } from "@cdf/ui";
import { administrationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { AdminFrame } from "../admin-frame";
import { day, period, personName, stateLabel, stateTone } from "../labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("admin.views.sectors") };
}

export default async function AdminSectorsRegister() {
  const { actor, ctx } = await requireActor();
  const page = await administrationService().sectors(ctx, actor);
  if (!page) notFound();
  const t = await getTranslator();
  const limit = page.delegationLimit;
  return (
    <AdminFrame t={t} actor={actor} view="sectors" intro={t("admin.sectors.intro")}>
      <CDFCard title={t("admin.sectors.limitTitle")} testId="admin-delegation-limit">
        <p className="text-sm">
          <CDFConfiguredValue
            value={
              limit.status === "CONFIGURED" && limit.value !== null && /^\d+$/.test(limit.value)
                ? formatDays(t.locale, Number(limit.value))
                : t("admin.notConfigured")
            }
            source={limit.status === "CONFIGURED" ? "CONFIGURED" : "SOURCE_REQUIRED"}
            sourceLabel={t(`admin.settingStatus.${limit.status}` as MessageKey)}
            testId="admin-delegation-limit-value"
          />
        </p>
        <p className="mt-2 text-sm text-cdf-text-secondary">{t("admin.sectors.limitIntro")}</p>
      </CDFCard>
      {page.sectors.length === 0 ? (
        <p className="mb-6 text-cdf-text-secondary">{t("admin.sectors.none")}</p>
      ) : null}
      {page.sectors.map((s) => (
        <SectorCard key={s.sectorId} t={t} page={page} sector={s} me={actor.userId} />
      ))}
      <p className="text-sm text-cdf-text-secondary" data-testid="admin-sectors-later">
        {t("admin.sectors.later")}
      </p>
    </AdminFrame>
  );
}

function SectorCard({
  t,
  page,
  sector: s,
  me,
}: {
  t: Translator;
  page: AdminSectorsPage;
  sector: AdminSector;
  me: string;
}) {
  const name = t.locale === "ar" ? s.nameAr : s.nameEn;
  const who = (id: string | null) => personName(t, page.people, id, me);
  const order = { IN_FORCE: 0, SCHEDULED: 1, ENDED: 2 } as const;
  const positions = page.positions
    .filter((p) => p.sectorId === s.sectorId)
    .sort(
      (a, b) =>
        order[a.state] - order[b.state] ||
        SECTOR_POSITIONS.indexOf(a.position) - SECTOR_POSITIONS.indexOf(b.position) ||
        a.effectiveFrom.localeCompare(b.effectiveFrom),
    );
  const delegations = page.delegations.filter((d) => d.sectorId === s.sectorId);
  const testId = `admin-sector-${s.code}`;
  return (
    <CDFCard
      title={name}
      testId={testId}
      actions={
        <CDFBadge tone={s.isActive ? "success" : "neutral"} testId={`${testId}-status`}>
          {t(s.isActive ? "admin.active" : "admin.inactive")}
        </CDFBadge>
      }
    >
      <section className="mb-6" aria-labelledby={`${testId}-positions`}>
        <h3 id={`${testId}-positions`} className="mb-2 font-semibold">
          {t("admin.sectors.positionsTitle")}
        </h3>
        <CDFTable
          caption={t("admin.sectors.positionsCaption", { sector: isolate(name) })}
          testId={`${testId}-position-list`}
          rows={positions}
          rowKey={(p) => p.membershipId}
          empty={t("admin.sectors.noPositions")}
          columns={[
            { header: t("admin.columns.holder"), cell: (p) => <bdi>{who(p.userId)}</bdi> },
            {
              header: t("admin.sectors.position"),
              cell: (p) => t(`admin.sectors.positionValue.${p.position}` as MessageKey),
            },
            { header: t("admin.columns.period"), cell: (p) => period(t, p.effectiveFrom, p.effectiveTo) },
            {
              header: t("admin.columns.state"),
              cell: (p) => <CDFBadge tone={stateTone(p.state)}>{stateLabel(t, p.state)}</CDFBadge>,
            },
            {
              header: t("admin.columns.reference"),
              cell: (p) => <bdi className="break-words">{p.appointmentReference}</bdi>,
            },
            {
              header: t("admin.columns.recorded"),
              cell: (p) => (
                <>
                  {p.appointedBy ? t("admin.recordedByOnly", { name: isolate(who(p.appointedBy)) }) : null}
                  {p.endedAt ? (
                    <p className="text-cdf-text-secondary">
                      {t("admin.endedOn", { date: day(t, p.endedAt) })}
                      {p.endReason ? (
                        <>
                          {" "}
                          <bdi>{p.endReason}</bdi>
                        </>
                      ) : null}
                    </p>
                  ) : null}
                </>
              ),
            },
          ]}
        />
      </section>
      <section aria-labelledby={`${testId}-delegations`}>
        <h3 id={`${testId}-delegations`} className="mb-2 font-semibold">
          {t("admin.sectors.delegationsTitle")}
        </h3>
        <p className="mb-2 text-sm text-cdf-text-secondary">{t("admin.sectors.delegationsIntro")}</p>
        <CDFTable
          caption={t("admin.sectors.delegationsCaption", { sector: isolate(name) })}
          testId={`${testId}-delegation-list`}
          rows={delegations}
          rowKey={(d) => d.delegationId}
          empty={t("admin.sectors.noDelegations")}
          columns={[
            { header: t("admin.sectors.delegator"), cell: (d) => <bdi>{who(d.delegatorId)}</bdi> },
            { header: t("admin.sectors.delegate"), cell: (d) => <bdi>{who(d.delegateId)}</bdi> },
            { header: t("admin.columns.period"), cell: (d) => period(t, d.effectiveFrom, d.effectiveTo) },
            {
              header: t("admin.columns.state"),
              cell: (d) => (
                <>
                  <CDFBadge tone={stateTone(d.state)}>{stateLabel(t, d.state)}</CDFBadge>
                  {d.revokedAt ? (
                    <p className="text-sm text-cdf-text-secondary">
                      {t("admin.sectors.revokedOn", { date: day(t, d.revokedAt) })}
                    </p>
                  ) : null}
                </>
              ),
            },
            {
              header: t("admin.sectors.evidence"),
              cell: (d) => <bdi className="break-words">{d.evidenceReference}</bdi>,
            },
          ]}
        />
      </section>
    </CDFCard>
  );
}
