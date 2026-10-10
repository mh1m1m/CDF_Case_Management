import { notFound } from "next/navigation";
import { can } from "@cdf/authorization";
import { ASSIGNMENT_ROLES, PRIORITIES } from "@cdf/contracts";
import { formatDateTime, type MessageKey } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFDescriptionList,
  CDFField,
  CDFPageHeader,
  CDFProgressTracker,
  CDFTimeline,
  classificationTone,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { STATES } from "@cdf/workflow";
import { evidenceService, investigationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { ActionForm } from "../../action-form";
import { AppNav } from "../../app-nav";
import { assignAction, declareConflictAction, transitionAction, updateDetailsAction } from "./actions";
import { EvidencePanel } from "./evidence-panel";

const UUID = /^[0-9a-f-]{36}$/i;

export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { actor, ctx } = await requireActor();
  const t = await getTranslator();
  const service = investigationService();
  // open_case audits CASE_VIEWED or a SECURITY denial; invisible and missing cases are indistinguishable.
  const c = await service.getCase(ctx, id);
  if (!c) notFound();
  const [timeline, directory, evidence] = await Promise.all([
    service.caseTimeline(ctx, id),
    can(actor, "CASE_ASSIGN") ? service.directory(ctx) : Promise.resolve([]),
    evidenceService().listEvidence(ctx, id),
  ]);
  // Mirrors authz.can_upload_evidence for the UI only; the database decides (§19).
  const canUpload =
    can(actor, "EVIDENCE_UPLOAD") &&
    c.recordsState === "ACTIVE" &&
    (can(actor, "CASE_EDIT_ALL") ||
      c.assignments.some(
        (a) =>
          a.userId === actor.userId &&
          ["CASE_OWNER", "LEAD_INVESTIGATOR", "INVESTIGATOR"].includes(a.assignmentRole),
      ));
  const name = (n: { displayName: string; displayNameAr?: string }) =>
    t.locale === "ar" && n.displayNameAr ? n.displayNameAr : n.displayName;

  return (
    <>
      <AppNav actor={actor} t={t} current="cases" />
      <CDFPageHeader
        title={`${c.caseNumber} · ${c.title}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <CDFBadge tone={classificationTone(c.classification)} testId="case-classification">
              {t(`classification.${c.classification}` as MessageKey)}
            </CDFBadge>
            {c.isRestricted ? <CDFBadge tone="danger">{t("classification.restrictedCase")}</CDFBadge> : null}
            <CDFBadge tone="info" testId="case-state">
              {(t.locale === "ar" ? c.stateNameAr : c.stateNameEn) ?? "—"}
            </CDFBadge>
          </div>
        }
      />
      <CDFProgressTracker
        label={t("cases.progress")}
        current={c.currentState}
        steps={STATES.filter((s) => s.sequence <= 150).map((s) => ({
          code: s.code,
          label: t.locale === "ar" ? s.nameAr : s.nameEn,
        }))}
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div>
          <CDFCard title={t("cases.details")}>
            <CDFDescriptionList
              items={[
                { term: t("cases.summary"), value: c.summary },
                {
                  term: t("cases.priority"),
                  value: c.priority ? t(`priority.${c.priority}` as MessageKey) : "—",
                },
                { term: t("cases.source"), value: c.source },
                {
                  term: t("cases.reporterRef"),
                  value: c.reporterWbId ? (
                    <span dir="ltr" title={t("cases.reporterRefHint")}>
                      {c.reporterWbId}
                    </span>
                  ) : (
                    "—"
                  ),
                },
                ...(c.openedAt
                  ? [{ term: t("cases.openedAt"), value: formatDateTime(t.locale, c.openedAt) }]
                  : []),
              ]}
            />
            {can(actor, "CASE_EDIT_ALL") ? (
              <details className="mt-4">
                <summary className="cursor-pointer font-semibold">{t("cases.editDetails")}</summary>
                <div className="mt-3">
                  <ActionForm
                    action={updateDetailsAction.bind(null, c.id)}
                    locale={t.locale}
                    submitLabel={t("common.save")}
                    variant="secondary"
                    testId="details-form"
                    successMessage={t("common.saved")}
                  >
                    <input type="hidden" name="expectedVersion" value={c.rowVersion} />
                    <CDFField id="title" label={t("intake.caseTitle")}>
                      <input id="title" name="title" defaultValue={c.title} className={inputClass} required />
                    </CDFField>
                    <CDFField id="summary" label={t("intake.caseSummary")}>
                      <textarea
                        id="summary"
                        name="summary"
                        defaultValue={c.summary}
                        className={textareaClass}
                        required
                      />
                    </CDFField>
                    <CDFField id="priority" label={t("cases.priority")}>
                      <select
                        id="priority"
                        name="priority"
                        defaultValue={c.priority ?? ""}
                        className={inputClass}
                      >
                        <option value="">—</option>
                        {PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {t(`priority.${p}` as MessageKey)}
                          </option>
                        ))}
                      </select>
                    </CDFField>
                  </ActionForm>
                </div>
              </details>
            ) : null}
          </CDFCard>

          <CDFCard title={t("cases.allegations")}>
            <ul className="list-disc ps-5">
              {c.allegations.map((a) => (
                <li key={a.id} className="mb-2">
                  <span className="font-semibold">{t.code("category", a.category, "common.none")}</span>:{" "}
                  {a.description}
                </li>
              ))}
            </ul>
          </CDFCard>

          <EvidencePanel
            c={c}
            items={evidence}
            canUpload={canUpload}
            canDownload={can(actor, "EVIDENCE_DOWNLOAD")}
            clearance={actor.clearance}
            t={t}
          />

          <CDFCard title={t("cases.transitionsTitle")} testId="transitions-card">
            {c.transitions.length === 0 ? (
              <p className="text-cdf-text-secondary">{t("cases.noTransitions")}</p>
            ) : null}
            <ul>
              {c.transitions.map((tr) => (
                <li
                  key={tr.code}
                  className="mb-4 border-b border-cdf-border pb-4 last:border-0"
                  data-testid={`transition-${tr.code}`}
                >
                  <p className="mb-2 font-semibold">{t.locale === "ar" ? tr.nameAr : tr.nameEn}</p>
                  {tr.allowed ? (
                    <ActionForm
                      action={transitionAction.bind(null, c.id, tr.code)}
                      locale={t.locale}
                      submitLabel={t("cases.perform")}
                      variant="secondary"
                      fieldLabels={{ reason: t("cases.transitionReason") }}
                    >
                      {tr.reasonRequired ? (
                        <CDFField
                          id={`reason-${tr.code}`}
                          label={t("cases.transitionReason")}
                          hint={t("intake.reasonHint")}
                        >
                          <textarea
                            id={`reason-${tr.code}`}
                            name="reason"
                            aria-describedby={`reason-${tr.code}-hint`}
                            className={textareaClass}
                            required
                            minLength={10}
                          />
                        </CDFField>
                      ) : null}
                    </ActionForm>
                  ) : (
                    <div>
                      <CDFBadge tone="neutral">{t("cases.blocked")}</CDFBadge>
                      <ul
                        className="mt-1 list-disc ps-5 text-sm text-cdf-text-secondary"
                        data-testid={`blocked-${tr.code}`}
                      >
                        {tr.blockingReasons.map((r) => (
                          <li key={r}>{t.code("codes", r, "errors.CONFLICT")}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </CDFCard>

          <CDFCard title={t("cases.timeline")}>
            <CDFTimeline
              testId="audit-timeline"
              empty={t("cases.noTimeline")}
              items={timeline.map((e) => ({
                id: String(e.seq),
                title: t.code("auditAction", e.action, "common.none"),
                meta: `${formatDateTime(t.locale, e.occurredAt)} · ${e.actorName ?? "—"}`,
                body: e.reason,
              }))}
            />
          </CDFCard>
        </div>

        <div>
          <CDFCard title={t("cases.team")} testId="team-card">
            {c.assignments.length === 0 ? (
              <p className="text-cdf-text-secondary">{t("cases.noTeam")}</p>
            ) : (
              <ul className="mb-4" data-testid="team-list">
                {c.assignments.map((a) => (
                  <li key={a.id} className="mb-1">
                    <span className="font-semibold">{a.displayName}</span> ·{" "}
                    {t(`assignmentRole.${a.assignmentRole}` as MessageKey)}
                  </li>
                ))}
              </ul>
            )}
            {can(actor, "CASE_ASSIGN") ? (
              <div className="border-t border-cdf-border pt-4">
                <h3 className="mb-2 font-semibold">{t("cases.assignTitle")}</h3>
                <ActionForm
                  action={assignAction.bind(null, c.id)}
                  locale={t.locale}
                  submitLabel={t("cases.assign")}
                  variant="secondary"
                  fieldLabels={{
                    userId: t("cases.person"),
                    assignmentRole: t("cases.role"),
                    reason: t("cases.assignReason"),
                  }}
                  testId="assign-form"
                >
                  <CDFField id="userId" label={t("cases.person")}>
                    <select id="userId" name="userId" className={inputClass} defaultValue="" required>
                      <option value="" disabled>
                        {t("cases.choosePerson")}
                      </option>
                      {directory.map((u) => (
                        <option key={u.id} value={u.id}>
                          {name(u)}
                        </option>
                      ))}
                    </select>
                  </CDFField>
                  <CDFField id="assignmentRole" label={t("cases.role")}>
                    <select
                      id="assignmentRole"
                      name="assignmentRole"
                      className={inputClass}
                      defaultValue="INVESTIGATOR"
                    >
                      {ASSIGNMENT_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {t(`assignmentRole.${r}` as MessageKey)}
                        </option>
                      ))}
                    </select>
                  </CDFField>
                  <CDFField id="assignReason" label={t("cases.assignReason")}>
                    <input id="assignReason" name="reason" className={inputClass} required minLength={5} />
                  </CDFField>
                </ActionForm>
              </div>
            ) : null}
          </CDFCard>

          {can(actor, "CONFLICT_DECLARE") ? (
            <CDFCard title={t("cases.conflictTitle")} testId="conflict-card">
              <p className="mb-2 text-sm">{t("cases.conflictIntro")}</p>
              <p className="mb-3 font-semibold" data-testid="my-conflict-status">
                {c.myConflictStatus
                  ? t("cases.yourDeclaration", {
                      status: t(`conflictStatus.${c.myConflictStatus}` as MessageKey),
                    })
                  : t("cases.noDeclaration")}
              </p>
              {!c.myConflictStatus ? (
                <ActionForm
                  action={declareConflictAction.bind(null, c.id)}
                  locale={t.locale}
                  submitLabel={t("cases.declare")}
                  variant="secondary"
                  fieldLabels={{ declaration: t("cases.declaration") }}
                  testId="conflict-form"
                >
                  <fieldset className="mb-3">
                    <legend className="sr-only">{t("cases.conflictTitle")}</legend>
                    <label className="mb-2 flex items-center gap-2">
                      <input
                        type="radio"
                        name="hasConflict"
                        value="false"
                        defaultChecked
                        className="size-5"
                      />{" "}
                      {t("cases.noConflict")}
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="radio" name="hasConflict" value="true" className="size-5" />{" "}
                      {t("cases.hasConflict")}
                    </label>
                  </fieldset>
                  <p className="mb-2 text-sm text-cdf-warning">{t("cases.conflictWarning")}</p>
                  <CDFField id="declaration" label={t("cases.declaration")}>
                    <textarea
                      id="declaration"
                      name="declaration"
                      className={textareaClass}
                      required
                      minLength={5}
                    />
                  </CDFField>
                </ActionForm>
              ) : null}
            </CDFCard>
          ) : null}
        </div>
      </div>
    </>
  );
}
