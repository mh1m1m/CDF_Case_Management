// People & access «الفريق والصلاحيات» (UX redesign S2; audit §22.6.1 tab 7; CDF-119). The team and its case
// roles, assigning a person, conflict declarations to decide (UX-016, RC-10: their S2 home) and the viewer's own
// declaration. Every command is re-checked in the database; the assign and decide controls are offered only to
// holders of the permission, as a pre-check (G16).
import type { Metadata } from "next";
import { can } from "@cdf/authorization";
import { ASSIGNMENT_ROLES } from "@cdf/contracts";
import { formatDateTime, type MessageKey } from "@cdf/i18n";
import {
  CDFAlert,
  CDFCard,
  CDFCommandForm,
  CDFDecisionPanel,
  CDFDescriptionList,
  CDFField,
  CDFFieldError,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { investigationService } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { confirmation } from "../../../confirmations";
import { assignAction, decideConflictAction, declareConflictAction } from "../actions";
import { CaseWorkspace, contentOpen, loadCase, personName } from "../workspace";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.casePeople") };
}

export default async function CasePeoplePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const decided = (await searchParams).decided === "conflict";
  const { actor, ctx, t, c } = await loadCase(id);
  const service = investigationService();
  const [directory, pendingConflicts] = await Promise.all([
    can(actor, "CASE_ASSIGN") ? service.directory(ctx) : Promise.resolve([]),
    // Other people's open declarations, for CONFLICT_MANAGE holders only (the service filters out the caller's).
    service.pendingConflicts(ctx, actor, id),
  ]);
  const open = contentOpen(c);

  return (
    <CaseWorkspace c={c} actor={actor} t={t} tab="people">
      {decided ? (
        <div className="mb-4">
          <CDFAlert tone="success" testId="conflict-decided">
            {t("cases.conflictDecided")}
          </CDFAlert>
        </div>
      ) : null}
      <p className="mb-4 text-cdf-text-secondary">{t("caseWorkspace.peopleIntro")}</p>
      {/* min-w-0: grid items default to min-width:auto, so a wide table would widen the page (WCAG 1.4.10). */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="min-w-0">
          <section id="team" tabIndex={-1}>
            <CDFCard title={t("cases.team")} testId="team-card">
              {c.assignments.length === 0 ? (
                <p className="text-cdf-text-secondary">{t("cases.noTeam")}</p>
              ) : (
                <ul className="mb-4" data-testid="team-list">
                  {c.assignments.map((a) => (
                    <li key={a.id} className="mb-1">
                      <bdi className="font-semibold">{personName(t, a)}</bdi> ·{" "}
                      {t(`assignmentRole.${a.assignmentRole}` as MessageKey)}
                    </li>
                  ))}
                </ul>
              )}
              {can(actor, "CASE_ASSIGN") && open ? (
                <div className="border-t border-cdf-border pt-4">
                  <h3 className="mb-2 font-semibold">{t("cases.assignTitle")}</h3>
                  <CDFCommandForm
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
                    <CDFField id="userId" label={t("cases.person")} requiredLabel={t("common.required")}>
                      <select id="userId" name="userId" className={inputClass} defaultValue="" required>
                        <option value="" disabled>
                          {t("cases.choosePerson")}
                        </option>
                        {directory.map((u) => (
                          <option key={u.id} value={u.id}>
                            {personName(t, u)}
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
                    <CDFField
                      id="assignReason"
                      label={t("cases.assignReason")}
                      requiredLabel={t("common.required")}
                    >
                      <input id="assignReason" name="reason" className={inputClass} required minLength={5} />
                    </CDFField>
                  </CDFCommandForm>
                </div>
              ) : null}
            </CDFCard>
          </section>
        </div>

        <div className="min-w-0">
          {pendingConflicts.length > 0 ? (
            // My Work and the case banner link here (#conflict-decisions) for each open declaration to decide.
            <div id="conflict-decisions" tabIndex={-1}>
              <CDFCard title={t("cases.conflictDecisionsTitle")} testId="conflict-decisions">
                <p className="mb-3 text-sm">{t("cases.conflictDecisionsIntro")}</p>
                {pendingConflicts.map((k) => {
                  const who = personName(t, k);
                  return (
                    <div
                      key={k.id}
                      className="mb-4 border-t border-cdf-border pt-4 first-of-type:border-t-0 first-of-type:pt-0"
                      data-testid={`conflict-decision-${k.id}`}
                    >
                      <h3 className="font-semibold">{t("cases.conflictDeclaredBy", { name: who })}</h3>
                      <CDFDescriptionList
                        items={[
                          {
                            term: t("cases.conflictDeclaredOn"),
                            value: formatDateTime(t.locale, k.declaredAt),
                          },
                          ...(k.declaration
                            ? [{ term: t("cases.conflictDeclarationText"), value: k.declaration }]
                            : []),
                        ]}
                      />
                      <CDFCommandForm
                        action={decideConflictAction.bind(null, c.id, k.id)}
                        locale={t.locale}
                        submitLabel={t("cases.conflictDecide")}
                        submitName={`${t("cases.conflictDecide")}: ${who}`}
                        fieldLabels={{
                          decision: t("cases.conflictDecision"),
                          reason: t("cases.conflictReason"),
                        }}
                        testId={`conflict-decide-form-${k.id}`}
                      >
                        <CDFDecisionPanel
                          id={`decision-${k.id}`}
                          name="decision"
                          legend={t("cases.conflictDecision")}
                          requiredLabel={t("common.required")}
                          options={[
                            {
                              value: "CONFLICT_CONFIRMED",
                              label: t("cases.conflictConfirm"),
                              consequence: t("cases.conflictConfirmConsequence", { name: who }),
                              testId: "conflict-confirm",
                            },
                            {
                              value: "CONFLICT_CLEARED",
                              label: t("cases.conflictClear"),
                              consequence: t("cases.conflictClearConsequence", { name: who }),
                              testId: "conflict-clear",
                            },
                          ]}
                          reason={{
                            name: "reason",
                            label: t("cases.conflictReason"),
                            hint: t("cases.conflictReasonHint"),
                            requiredLabel: t("common.required"),
                            minLength: 10,
                            maxLength: 2000,
                            always: true,
                          }}
                        />
                      </CDFCommandForm>
                    </div>
                  );
                })}
              </CDFCard>
            </div>
          ) : null}

          {can(actor, "CONFLICT_DECLARE") ? (
            <section id="conflict" tabIndex={-1}>
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
                  <CDFCommandForm
                    action={declareConflictAction.bind(null, c.id)}
                    locale={t.locale}
                    submitLabel={t("cases.declare")}
                    variant="secondary"
                    fieldLabels={{
                      hasConflict: t("cases.conflictTitle"),
                      declaration: t("cases.declaration"),
                    }}
                    testId="conflict-form"
                    // Declaring a conflict removes the declarant's own access at once: confirm that answer only.
                    confirm={{
                      ...confirmation(t, "declareConflict"),
                      when: { field: "hasConflict", equals: "true" },
                    }}
                  >
                    {/* No default answer (UX-019): the declarant chooses; an unanswered submit is refused. */}
                    <fieldset className="mb-3">
                      <legend className="sr-only">{t("cases.conflictTitle")}</legend>
                      <label className="mb-2 flex items-center gap-2">
                        <input
                          id="hasConflict-no"
                          type="radio"
                          name="hasConflict"
                          value="false"
                          required
                          className="size-5"
                          data-testid="conflict-no"
                        />{" "}
                        {t("cases.noConflict")}
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="hasConflict"
                          value="true"
                          required
                          className="size-5"
                          data-testid="conflict-yes"
                        />{" "}
                        {t("cases.hasConflict")}
                      </label>
                      <CDFFieldError id="hasConflict-no" />
                    </fieldset>
                    <p className="mb-2 text-sm text-cdf-warning">{t("cases.conflictWarning")}</p>
                    <CDFField
                      id="declaration"
                      label={t("cases.declaration")}
                      requiredLabel={t("common.required")}
                    >
                      <textarea
                        id="declaration"
                        name="declaration"
                        className={textareaClass}
                        required
                        minLength={5}
                      />
                    </CDFField>
                  </CDFCommandForm>
                ) : null}
              </CDFCard>
            </section>
          ) : null}
        </div>
      </div>
    </CaseWorkspace>
  );
}
