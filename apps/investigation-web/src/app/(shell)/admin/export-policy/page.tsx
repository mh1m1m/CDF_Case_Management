// Administration › Export policy (UX redesign Phase 12 P12-8a and P12-8b; ADR-051's P12-8a amendment, ADR-063; DEC-F21
// to DEC-F24). The export policy administrator's register: the rules every export is checked against, the purposes a
// requester picks from, the approved external domains, each approval stage's pool and the configuration warnings,
// which carry ids, stages and times only. It opens only where authz.is_export_policy_admin() does, never to whoever
// holds an export approval permission (DEC-F24); anyone else gets the uniform not-found, recorded as ACCESS_DENIED.
// Three forms, each shown only where the database says its command would accept the caller now
// (api.admin_export_policy_capabilities, 2127; coordinator ruling on F4, 2026-10-18 21:17): a rule for a new code that
// only adds a requirement or a refusal, always provisional; a new purpose; and a change to a purpose at the version read
// (F13), never to a legacy one. No control changes a source status. A new version of a recorded rule waits for the CDF
// source and dual control (2160), approver pools change only with dual control (DEC-12), and no command keeps the
// domain list yet.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  CLASSIFICATION_LEVELS,
  EXPORT_OBJECT_TYPES,
  EXPORT_RULE_ADD_ACTIONS,
  EXPORT_RULE_AUDIENCES,
  type AdminExportPolicyPage,
  type AdminExportPurpose,
  type AdminExportRule,
} from "@cdf/contracts";
import { isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFCommandForm,
  CDFConfiguredValue,
  CDFField,
  CDFFieldError,
  CDFIdentifier,
  CDFTable,
  inputClass,
  textareaClass,
} from "@cdf/ui";
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
import { addExportPurposeAction, addExportRuleAction, editExportPurposeAction } from "./actions";

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
    <AdminFrame t={t} views={page.views} view="export-policy" intro={t("admin.exports.intro")}>
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
        {page.capabilities.maySetRule ? <RuleForm t={t} page={page} /> : null}
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
        {page.capabilities.mayAddPurpose || purposes.some((p) => p.maySet) ? (
          <p className="mt-3 text-sm text-cdf-text-secondary" data-testid="admin-export-purpose-own-entry">
            {t("admin.exports.ownEntry")}
          </p>
        ) : null}
        {purposes.some((p) => p.maySet) ? (
          <PurposeEdits t={t} purposes={purposes.filter((p) => p.maySet)} />
        ) : null}
        {page.capabilities.mayAddPurpose ? <AddPurposeForm t={t} page={page} /> : null}
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

/** A radio button in a group; its first control carries the group's server error (CDFCommandForm's locate). */
function Radio({ id, name, value, label }: { id: string; name: string; value: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <input
        id={`${id}-${name}-${value}`}
        type="radio"
        name={name}
        value={value}
        className="size-5 shrink-0"
        data-testid={`${id}-${name}-${value}`}
      />
      <label htmlFor={`${id}-${name}-${value}`}>{label}</label>
    </div>
  );
}

/** A group's legend with the visible "(Required)" marker (WCAG 3.3.2). */
function Legend({ t, text }: { t: Translator; text: string }) {
  return (
    <legend className="mb-1 font-semibold">
      {text}
      <span className="ms-2 text-sm font-normal text-cdf-text-secondary">({t("common.required")})</span>
    </legend>
  );
}

/**
 * A rule for a new code (coordinator ruling on F4): whom it applies to and what it does, from a date after today.
 * Only the actions that add a requirement or a refusal are offered (EXPORT_RULE_ADD_ACTIONS, never NONE); the
 * service refuses a code already recorded (RULE_CODE_EXISTS) under the command's own lock, and the command records
 * the rule as provisional, awaiting the CDF source.
 */
function RuleForm({ t, page }: { t: Translator; page: AdminExportPolicyPage }) {
  const id = "admin-export-rule-form";
  return (
    <section className="mt-6 border-t border-cdf-border pt-4" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="mb-2 font-semibold">
        {t("admin.exports.addRuleTitle")}
      </h3>
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.exports.addRuleIntro")}</p>
      <CDFCommandForm
        action={addExportRuleAction}
        locale={t.locale}
        submitLabel={t("admin.exports.addRule")}
        variant="primary"
        testId={id}
        successMessage={t("admin.exports.ruleAdded")}
        leaveWarning={t("common.leaveWarning")}
        codeSections={ADMIN_CODES}
        fieldLabels={{
          code: t("admin.exports.ruleCode"),
          audience: t("admin.exports.appliesTo"),
          minClassification: t("admin.exports.classificationLabel"),
          objectType: t("admin.exports.contentLabel"),
          restrictedOnly: t("admin.exports.restrictedOnly"),
          action: t("admin.exports.effect"),
          effectiveFrom: t("admin.startsOn"),
          reason: t("admin.calendar.reason"),
        }}
        confirm={confirmation(t, "addExportRule")}
      >
        <CDFField
          id={`${id}-code`}
          label={t("admin.exports.ruleCode")}
          hint={t("admin.exports.ruleCodeHint")}
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
            minLength={3}
            maxLength={60}
            required
          />
        </CDFField>
        <fieldset className="mb-4">
          <Legend t={t} text={t("admin.exports.appliesTo")} />
          <div className="grid gap-2">
            {EXPORT_RULE_AUDIENCES.map((a) => (
              <Radio
                key={a}
                id={id}
                name="audience"
                value={a}
                label={t(`admin.exports.audience.${a}` as MessageKey)}
              />
            ))}
          </div>
          <CDFFieldError id={`${id}-audience-${EXPORT_RULE_AUDIENCES[0]}`} />
        </fieldset>
        <CDFField
          id={`${id}-classification`}
          label={t("admin.exports.classificationLabel")}
          hint={t("admin.exports.classificationHint")}
          optionalLabel={t("common.optional")}
        >
          <select
            id={`${id}-classification`}
            name="minClassification"
            className={inputClass}
            defaultValue=""
            aria-describedby={`${id}-classification-hint`}
          >
            <option value="">{t("admin.exports.anyClassification")}</option>
            {CLASSIFICATION_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t.code("classification", level)}
              </option>
            ))}
          </select>
        </CDFField>
        <CDFField
          id={`${id}-content`}
          label={t("admin.exports.contentLabel")}
          hint={t("admin.exports.contentHint")}
          optionalLabel={t("common.optional")}
        >
          <select
            id={`${id}-content`}
            name="objectType"
            className={inputClass}
            defaultValue=""
            aria-describedby={`${id}-content-hint`}
          >
            <option value="">{t("admin.exports.anyContent")}</option>
            {EXPORT_OBJECT_TYPES.map((o) => (
              <option key={o} value={o}>
                {labelOr(t, "exports.objectType", o)}
              </option>
            ))}
          </select>
        </CDFField>
        <div className="mb-4 flex items-center gap-2">
          <input
            id={`${id}-restricted`}
            name="restrictedOnly"
            type="checkbox"
            className="size-5 shrink-0"
            data-testid={`${id}-restricted`}
          />
          <label htmlFor={`${id}-restricted`}>{t("admin.exports.restrictedOnly")}</label>
        </div>
        <fieldset className="mb-4">
          <Legend t={t} text={t("admin.exports.effect")} />
          <div className="grid gap-2">
            {EXPORT_RULE_ADD_ACTIONS.map((a) => (
              <Radio
                key={a}
                id={id}
                name="action"
                value={a}
                label={t(`admin.exports.action.${a}` as MessageKey)}
              />
            ))}
          </div>
          <CDFFieldError id={`${id}-action-${EXPORT_RULE_ADD_ACTIONS[0]}`} />
        </fieldset>
        <CDFField
          id={`${id}-from`}
          label={t("admin.startsOn")}
          hint={t("admin.startsOnHint")}
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
        <ReasonField t={t} id={id} />
      </CDFCommandForm>
    </section>
  );
}

function ReasonField({ t, id, label }: { t: Translator; id: string; label?: string }) {
  return (
    <CDFField
      id={`${id}-reason`}
      label={label ?? t("admin.calendar.reason")}
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
  );
}

/**
 * A purpose's names, justification, whether it is offered and its place in the list. OTHER always needs a
 * justification, so its box is fixed on. No field changes the source status: saving records the administrator's own
 * catalogue entry (DEC-F21).
 */
function PurposeFields({
  t,
  id,
  purpose,
  sortOrder,
}: {
  t: Translator;
  id: string;
  purpose?: AdminExportPurpose;
  /** A new purpose's place: after the last purpose offered, which the administrator may change. */
  sortOrder?: number;
}) {
  const other = purpose?.code === "OTHER";
  return (
    <>
      <CDFField
        id={`${id}-name-en`}
        label={t("admin.sectors.nameEn")}
        hint={t("admin.exports.purposeNameHint")}
        requiredLabel={t("common.required")}
      >
        <input
          id={`${id}-name-en`}
          name="nameEn"
          type="text"
          className={inputClass}
          defaultValue={purpose?.nameEn}
          aria-describedby={`${id}-name-en-hint`}
          dir="ltr"
          lang="en"
          minLength={3}
          maxLength={200}
          required
        />
      </CDFField>
      <CDFField
        id={`${id}-name-ar`}
        label={t("admin.sectors.nameAr")}
        hint={t("admin.exports.purposeNameHint")}
        requiredLabel={t("common.required")}
      >
        <input
          id={`${id}-name-ar`}
          name="nameAr"
          type="text"
          className={inputClass}
          defaultValue={purpose?.nameAr}
          aria-describedby={`${id}-name-ar-hint`}
          dir="rtl"
          lang="ar"
          minLength={3}
          maxLength={200}
          required
        />
      </CDFField>
      {other ? (
        <>
          <input type="hidden" name="requiresJustification" value="on" />
          <p className="mb-4 text-sm" data-testid={`${id}-justification-fixed`}>
            {t("admin.exports.otherAlwaysJustified")}
          </p>
        </>
      ) : (
        <div className="mb-4 flex items-center gap-2">
          <input
            id={`${id}-justification`}
            name="requiresJustification"
            type="checkbox"
            defaultChecked={purpose?.requiresJustification ?? false}
            className="size-5 shrink-0"
            data-testid={`${id}-justification`}
          />
          <label htmlFor={`${id}-justification`}>{t("admin.exports.justification")}</label>
        </div>
      )}
      <div className="mb-4 flex items-center gap-2">
        <input
          id={`${id}-active`}
          name="isActive"
          type="checkbox"
          defaultChecked={purpose?.isActive ?? true}
          className="size-5 shrink-0"
          data-testid={`${id}-active`}
        />
        <label htmlFor={`${id}-active`}>{t("admin.exports.offered")}</label>
      </div>
      <CDFField
        id={`${id}-sort`}
        label={t("admin.exports.sortOrder")}
        hint={t("admin.exports.sortOrderHint")}
        requiredLabel={t("common.required")}
      >
        <input
          id={`${id}-sort`}
          name="sortOrder"
          type="number"
          inputMode="numeric"
          className={inputClass}
          defaultValue={String(purpose?.sortOrder ?? sortOrder ?? "")}
          aria-describedby={`${id}-sort-hint`}
          min={1}
          max={899}
          step={1}
          required
        />
      </CDFField>
    </>
  );
}

/** One disclosure per purpose the database says may be changed now; each saves at the version this page read (F13). */
function PurposeEdits({ t, purposes }: { t: Translator; purposes: AdminExportPurpose[] }) {
  return (
    <section
      className="mt-6 border-t border-cdf-border pt-4"
      aria-labelledby="admin-export-purpose-edit-title"
    >
      <h3 id="admin-export-purpose-edit-title" className="mb-2 font-semibold">
        {t("admin.exports.editTitle")}
      </h3>
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.exports.editIntro")}</p>
      <div className="grid gap-2">
        {purposes.map((p) => {
          const id = `admin-export-purpose-form-${p.code}`;
          const name = t.locale === "ar" ? p.nameAr : p.nameEn;
          // Keyed by the code only: after a save the form starts again from the purpose as now recorded, its version
          // included, and keeps its "saved" message (CDFCommandForm resets to the page's new values).
          return (
            <details
              key={p.code}
              className="rounded-cdf-md border border-cdf-border p-3"
              data-testid={`${id}-details`}
            >
              <summary className="cursor-pointer font-semibold">
                {t("admin.exports.editSummary", { purpose: isolate(name) })}
              </summary>
              <div className="mt-3">
                <CDFCommandForm
                  action={editExportPurposeAction}
                  locale={t.locale}
                  submitLabel={t("admin.exports.savePurpose")}
                  submitName={t("admin.exports.savePurposeIn", { purpose: isolate(name) })}
                  variant="secondary"
                  testId={id}
                  successMessage={t("admin.exports.purposeSaved")}
                  leaveWarning={t("common.leaveWarning")}
                  codeSections={ADMIN_CODES}
                  fieldLabels={{
                    nameEn: t("admin.sectors.nameEn"),
                    nameAr: t("admin.sectors.nameAr"),
                    requiresJustification: t("admin.exports.justification"),
                    isActive: t("admin.exports.offered"),
                    sortOrder: t("admin.exports.sortOrder"),
                    reason: t("admin.calendar.reason"),
                  }}
                  confirm={confirmation(t, "editExportPurpose")}
                >
                  <input type="hidden" name="code" value={p.code} />
                  <input type="hidden" name="expectedVersion" value={String(p.rowVersion)} />
                  <PurposeFields t={t} id={id} purpose={p} />
                  <ReasonField t={t} id={id} />
                </CDFCommandForm>
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

/** A purpose for a new code (F11: the code's shape is checked; a code already in the catalogue is refused). */
function AddPurposeForm({ t, page }: { t: Translator; page: AdminExportPolicyPage }) {
  const id = "admin-export-purpose-form";
  const last = Math.max(0, ...page.purposes.filter((p) => !p.isLegacy).map((p) => p.sortOrder));
  const next = Math.min(899, last + 10);
  return (
    <section className="mt-6 border-t border-cdf-border pt-4" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="mb-2 font-semibold">
        {t("admin.exports.addPurposeTitle")}
      </h3>
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.exports.addPurposeIntro")}</p>
      <CDFCommandForm
        action={addExportPurposeAction}
        locale={t.locale}
        submitLabel={t("admin.exports.addPurpose")}
        variant="primary"
        testId={id}
        successMessage={t("admin.exports.purposeAdded")}
        leaveWarning={t("common.leaveWarning")}
        codeSections={["admin.exports.addPurposeCodes", ...ADMIN_CODES]}
        fieldLabels={{
          code: t("admin.exports.purposeCode"),
          nameEn: t("admin.sectors.nameEn"),
          nameAr: t("admin.sectors.nameAr"),
          requiresJustification: t("admin.exports.justification"),
          isActive: t("admin.exports.offered"),
          sortOrder: t("admin.exports.sortOrder"),
          reason: t("admin.calendar.reason"),
        }}
        confirm={confirmation(t, "addExportPurpose")}
      >
        <CDFField
          id={`${id}-code`}
          label={t("admin.exports.purposeCode")}
          hint={t("admin.exports.purposeCodeHint")}
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
            minLength={3}
            maxLength={60}
            required
          />
        </CDFField>
        <PurposeFields t={t} id={id} sortOrder={next} />
        <ReasonField t={t} id={id} />
      </CDFCommandForm>
    </section>
  );
}
