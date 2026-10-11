// Reporter «المبلّغ» (UX redesign S2; audit §22.6.1 tab 6; ADR-016 D4, DEC-06; CDF-119). The conversation with the
// reporter through the portal, who may write to the reporter, and REPORTER_COMMUNICATE delegations. The database
// decides everything shown here (migration 1840): the tab exists only for the conversation's readers, a reply form
// only for its correspondents, and the delegation controls only for those who manage the team. Every command is
// re-checked in the database. Nothing here touches the reporter's protected identity.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can } from "@cdf/authorization";
import { formatDateTime } from "@cdf/i18n";
import {
  CDFAlert,
  CDFCard,
  CDFCommandForm,
  CDFDateTime,
  CDFField,
  CDFTimeline,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { investigationService } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { delegateReporterAction, endReporterDelegationAction, reporterReplyAction } from "../actions";
import { CaseWorkspace, contentOpen, loadCase, personName } from "../workspace";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.caseReporter") };
}

export default async function CaseReporterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, ctx, t, c } = await loadCase(id);
  // Not a reader of this conversation: the same answer as a case that does not exist (G2).
  if (c.reporterConversation === "NONE") notFound();
  const view = await investigationService().caseReporterView(ctx, id);
  const open = contentOpen(c);
  const holders = c.assignments.filter(
    (a) => a.assignmentRole === "CASE_OWNER" || a.assignmentRole === "LEAD_INVESTIGATOR",
  );
  const delegatedIds = new Set(view.delegations.map((d) => d.userId));
  const eligible = c.assignments.filter(
    (a) => a.assignmentRole === "INVESTIGATOR" && !delegatedIds.has(a.userId),
  );
  const count = view.conversations.length;

  return (
    <CaseWorkspace c={c} actor={actor} t={t} tab="reporter">
      <p className="mb-4 text-cdf-text-secondary">{t("caseWorkspace.reporter.intro")}</p>
      {c.reporterConversation === "READ" ? (
        <div className="mb-4">
          <CDFAlert tone="info" testId="reporter-read-only">
            {t("caseWorkspace.reporter.readOnly")}
          </CDFAlert>
        </div>
      ) : null}
      {/* min-w-0: grid items default to min-width:auto, so long text would widen the page (WCAG 1.4.10). */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="min-w-0">
          {view.conversations.map((conv, i) => {
            const bodyId = count > 1 ? `body-${i + 1}` : "body";
            return (
              <CDFCard
                key={conv.reportId}
                title={
                  count > 1
                    ? t("caseWorkspace.reporter.conversationOf", { n: String(i + 1), count: String(count) })
                    : t("caseWorkspace.reporter.conversation")
                }
                testId="reporter-conversation"
              >
                <CDFTimeline
                  testId="reporter-messages"
                  empty={t("intake.noMessages")}
                  items={conv.messages.map((m, j) => ({
                    id: String(j),
                    title:
                      m.direction === "FROM_REPORTER" ? t("intake.fromReporter") : t("intake.toReporter"),
                    meta: formatDateTime(t.locale, m.createdAt),
                    body: m.body,
                  }))}
                />
                {conv.canSend && open ? (
                  <div className="mt-4 border-t border-cdf-border pt-4">
                    <CDFCommandForm
                      action={reporterReplyAction.bind(null, c.id, conv.reportId)}
                      locale={t.locale}
                      submitLabel={t("intake.sendReply")}
                      variant="secondary"
                      fieldLabels={{ body: t("intake.reply") }}
                      testId="reporter-reply-form"
                    >
                      <CDFField
                        id={bodyId}
                        label={t("intake.reply")}
                        hint={t("intake.replyHint")}
                        requiredLabel={t("common.required")}
                      >
                        <textarea
                          id={bodyId}
                          name="body"
                          aria-describedby={`${bodyId}-hint`}
                          className={textareaClass}
                          required
                          maxLength={4000}
                        />
                      </CDFField>
                    </CDFCommandForm>
                  </div>
                ) : null}
              </CDFCard>
            );
          })}
        </div>

        <div className="min-w-0">
          <section id="writers" tabIndex={-1}>
            <CDFCard title={t("caseWorkspace.reporter.whoTitle")} testId="reporter-writers">
              <p className="mb-3 text-sm">{t("caseWorkspace.reporter.whoIntro")}</p>
              {holders.length === 0 ? (
                <p className="mb-3 text-sm text-cdf-text-secondary">
                  {t("caseWorkspace.reporter.noOwnerOrLead")}
                </p>
              ) : (
                <ul className="mb-3" data-testid="reporter-holders">
                  {holders.map((a) => (
                    <li key={a.id} className="mb-1">
                      <bdi className="font-semibold">{personName(t, a)}</bdi> ·{" "}
                      {t.code("assignmentRole", a.assignmentRole)}
                      {a.userId === actor.userId ? <> ({t("caseWorkspace.reporter.you")})</> : null}
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="mb-2 font-semibold">{t("caseWorkspace.reporter.delegated")}</h3>
              {view.delegations.length === 0 ? (
                <p className="text-sm text-cdf-text-secondary" data-testid="reporter-no-delegations">
                  {t("caseWorkspace.reporter.noDelegations")}
                </p>
              ) : (
                <ul data-testid="reporter-delegations">
                  {view.delegations.map((d) => {
                    const who = personName(t, d);
                    return (
                      <li
                        key={d.id}
                        className="border-t border-cdf-border py-2 first:border-t-0"
                        data-testid={`reporter-delegation-${d.userId}`}
                      >
                        <p>
                          <bdi className="font-semibold">{who}</bdi>
                          {d.userId === actor.userId ? (
                            <> ({t("caseWorkspace.reporter.you")})</>
                          ) : null} · {t("caseWorkspace.reporter.delegatedOn")}{" "}
                          <CDFDateTime value={d.delegatedAt} locale={t.locale} dateOnly />
                        </p>
                        {view.canDelegate && open ? (
                          <CDFCommandForm
                            action={endReporterDelegationAction.bind(null, c.id, d.id)}
                            locale={t.locale}
                            submitLabel={t("caseWorkspace.reporter.end")}
                            submitName={`${t("caseWorkspace.reporter.end")}: ${who}`}
                            variant="secondary"
                            fieldLabels={{ reason: t("caseWorkspace.reporter.endReason") }}
                            testId={`reporter-end-${d.userId}`}
                          >
                            <CDFField
                              id={`endReason-${d.id}`}
                              label={t("caseWorkspace.reporter.endReason")}
                              requiredLabel={t("common.required")}
                            >
                              <input
                                id={`endReason-${d.id}`}
                                name="reason"
                                className={inputClass}
                                required
                                minLength={10}
                                maxLength={500}
                              />
                            </CDFField>
                          </CDFCommandForm>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              {view.canDelegate && can(actor, "CASE_ASSIGN") && open ? (
                <div className="mt-4 border-t border-cdf-border pt-4">
                  <h3 className="mb-2 font-semibold">{t("caseWorkspace.reporter.delegateTitle")}</h3>
                  {eligible.length === 0 ? (
                    <p className="text-sm text-cdf-text-secondary" data-testid="reporter-no-eligible">
                      {t("caseWorkspace.reporter.noEligible")}
                    </p>
                  ) : (
                    <CDFCommandForm
                      action={delegateReporterAction.bind(null, c.id)}
                      locale={t.locale}
                      submitLabel={t("caseWorkspace.reporter.delegate")}
                      variant="secondary"
                      fieldLabels={{
                        userId: t("caseWorkspace.reporter.delegatePerson"),
                        reason: t("caseWorkspace.reporter.reason"),
                      }}
                      testId="reporter-delegate-form"
                    >
                      <CDFField
                        id="userId"
                        label={t("caseWorkspace.reporter.delegatePerson")}
                        requiredLabel={t("common.required")}
                      >
                        <select id="userId" name="userId" className={inputClass} defaultValue="" required>
                          <option value="" disabled>
                            {t("caseWorkspace.reporter.choosePerson")}
                          </option>
                          {eligible.map((a) => (
                            <option key={a.id} value={a.userId}>
                              {personName(t, a)}
                            </option>
                          ))}
                        </select>
                      </CDFField>
                      <CDFField
                        id="delegateReason"
                        label={t("caseWorkspace.reporter.reason")}
                        hint={t("caseWorkspace.reporter.reasonHint")}
                        requiredLabel={t("common.required")}
                      >
                        <textarea
                          id="delegateReason"
                          name="reason"
                          aria-describedby="delegateReason-hint"
                          className={textareaClass}
                          required
                          minLength={10}
                          maxLength={500}
                        />
                      </CDFField>
                    </CDFCommandForm>
                  )}
                </div>
              ) : null}
            </CDFCard>
          </section>
        </div>
      </div>
    </CaseWorkspace>
  );
}
