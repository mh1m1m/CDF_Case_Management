// Administration › Sectors (UX redesign Phase 12 P12-8a and P12-8b; ADR-051's P12-8a amendment, ADR-063). The sector
// administrator's register: who holds each sector position, and the referral approvals sector heads have delegated
// (Q1–Q4), as recorded, revoked ones included. Read in the administrator's own context after the database confirms
// SECTOR_ADMIN; anyone else gets the uniform not-found, recorded as ACCESS_DENIED. Three forms, each shown only where
// the database says its command would accept the caller now (api.admin_sector_capabilities, 2127 and 2128): creating a
// sector, ending a position not yet ended (now or from a date, with the decree or source reference an end dated before
// now requires: 2128, the owner's decision F7 = B; shown on the register once recorded), and revoking a delegation that
// has not ended. Position appointments wait for migration 2160 (the owner's F5 decision); since 2127 nobody appoints
// themselves (F6, CDF-259).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  SECTOR_POSITIONS,
  type AdminSector,
  type AdminSectorDelegation,
  type AdminSectorsPage,
} from "@cdf/contracts";
import { formatDays, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFCommandForm,
  CDFConfiguredValue,
  CDFField,
  CDFTable,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { administrationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { confirmation } from "../../confirmations";
import { AdminFrame } from "../admin-frame";
import { ADMIN_CODES, day, period, personName, stateLabel, stateTone } from "../labels";
import { EndForm } from "../end-form";
import { createSectorAction, endSectorMembershipAction, revokeDelegationAction } from "./actions";

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
    <AdminFrame t={t} views={page.views} view="sectors" intro={t("admin.sectors.intro")}>
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
      {page.capabilities.mayCreateSector ? <CreateSectorCard t={t} /> : null}
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
  // The positions the database says may be ended now (2128): not yet ended, whatever their period.
  const endable = positions.filter((p) => p.mayEnd);
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
                      {p.endReference ? (
                        <>
                          {" "}
                          {t("admin.endReference")} <bdi className="break-words">{p.endReference}</bdi>
                        </>
                      ) : null}
                    </p>
                  ) : null}
                </>
              ),
            },
          ]}
        />
        {endable.length > 0 ? (
          <EndForm
            t={t}
            id={`admin-end-position-form-${s.code}`}
            title={t("admin.sectors.endTitle")}
            intro={t("admin.sectors.endIntro")}
            rowLabel={t("admin.sectors.endPosition")}
            rows={endable.map((p) => ({
              membershipId: p.membershipId,
              label: t("admin.sectors.endOption", {
                holder: isolate(who(p.userId)),
                position: t(`admin.sectors.positionValue.${p.position}` as MessageKey),
                period: period(t, p.effectiveFrom, p.effectiveTo),
              }),
            }))}
            action={endSectorMembershipAction}
            act="endSectorMembership"
            submitLabel={t("admin.sectors.end")}
            submitName={t("admin.sectors.endIn", { sector: isolate(name) })}
            done={t("admin.sectors.endDone")}
          />
        ) : null}
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
        {delegations.some((d) => d.mayRevoke) ? (
          <RevokeForm
            t={t}
            sector={s}
            name={name}
            delegations={delegations.filter((d) => d.mayRevoke)}
            who={who}
          />
        ) : null}
      </section>
    </CDFCard>
  );
}

/**
 * Revoke a delegation that has not ended: only those the database says may be revoked now are offered
 * (`may_revoke`). It ends at once and stays on record as revoked; decisions the delegate already recorded stand.
 */
function RevokeForm({
  t,
  sector,
  name,
  delegations,
  who,
}: {
  t: Translator;
  sector: AdminSector;
  name: string;
  delegations: AdminSectorDelegation[];
  who: (id: string | null) => string;
}) {
  const id = `admin-revoke-form-${sector.code}`;
  return (
    <section className="mt-6 border-t border-cdf-border pt-4" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`} className="mb-2 font-semibold">
        {t("admin.sectors.revokeTitle")}
      </h4>
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.sectors.revokeIntro")}</p>
      <CDFCommandForm
        action={revokeDelegationAction}
        locale={t.locale}
        submitLabel={t("admin.sectors.revoke")}
        submitName={t("admin.sectors.revokeIn", { sector: isolate(name) })}
        variant="danger"
        testId={id}
        successMessage={t("admin.sectors.revoked")}
        leaveWarning={t("common.leaveWarning")}
        codeSections={ADMIN_CODES}
        fieldLabels={{
          delegationId: t("admin.sectors.revokeDelegation"),
          reason: t("admin.sectors.revokeReason"),
        }}
        confirm={confirmation(t, "revokeReferralDelegation")}
      >
        <CDFField
          id={`${id}-delegation`}
          label={t("admin.sectors.revokeDelegation")}
          requiredLabel={t("common.required")}
        >
          <select id={`${id}-delegation`} name="delegationId" className={inputClass} defaultValue="" required>
            <option value="" disabled>
              {t("common.choose")}
            </option>
            {delegations.map((d) => (
              <option key={d.delegationId} value={d.delegationId}>
                {t("admin.sectors.revokeOption", {
                  delegator: isolate(who(d.delegatorId)),
                  delegate: isolate(who(d.delegateId)),
                  period: period(t, d.effectiveFrom, d.effectiveTo),
                })}
              </option>
            ))}
          </select>
        </CDFField>
        <CDFField
          id={`${id}-reason`}
          label={t("admin.sectors.revokeReason")}
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
    </section>
  );
}

/** Create a sector: active, with no head or members until they are appointed (not on this page yet). */
function CreateSectorCard({ t }: { t: Translator }) {
  const id = "admin-sector-form";
  return (
    <CDFCard title={t("admin.sectors.createTitle")} testId="admin-sector-create">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.sectors.createIntro")}</p>
      <CDFCommandForm
        action={createSectorAction}
        locale={t.locale}
        submitLabel={t("admin.sectors.create")}
        variant="primary"
        testId={id}
        successMessage={t("admin.sectors.created")}
        leaveWarning={t("common.leaveWarning")}
        codeSections={ADMIN_CODES}
        fieldLabels={{
          code: t("admin.sectors.code"),
          nameEn: t("admin.sectors.nameEn"),
          nameAr: t("admin.sectors.nameAr"),
        }}
        confirm={confirmation(t, "createSector")}
      >
        <CDFField
          id={`${id}-code`}
          label={t("admin.sectors.code")}
          hint={t("admin.sectors.codeHint")}
          requiredLabel={t("common.required")}
        >
          <input
            id={`${id}-code`}
            name="code"
            type="text"
            className={inputClass}
            aria-describedby={`${id}-code-hint`}
            dir="ltr"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            minLength={2}
            maxLength={20}
            required
          />
        </CDFField>
        <CDFField
          id={`${id}-name-en`}
          label={t("admin.sectors.nameEn")}
          hint={t("admin.sectors.nameHint")}
          requiredLabel={t("common.required")}
        >
          <input
            id={`${id}-name-en`}
            name="nameEn"
            type="text"
            className={inputClass}
            aria-describedby={`${id}-name-en-hint`}
            dir="ltr"
            lang="en"
            minLength={2}
            maxLength={120}
            required
          />
        </CDFField>
        <CDFField
          id={`${id}-name-ar`}
          label={t("admin.sectors.nameAr")}
          hint={t("admin.sectors.nameHint")}
          requiredLabel={t("common.required")}
        >
          <input
            id={`${id}-name-ar`}
            name="nameAr"
            type="text"
            className={inputClass}
            aria-describedby={`${id}-name-ar-hint`}
            dir="rtl"
            lang="ar"
            minLength={2}
            maxLength={120}
            required
          />
        </CDFField>
      </CDFCommandForm>
    </CDFCard>
  );
}
