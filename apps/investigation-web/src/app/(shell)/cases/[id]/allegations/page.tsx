// Allegations «الادعاءات» (UX redesign S2; Phase 12 P12-1, ADR-017; AMB-029, AMB-105). Who the case is about,
// what is alleged about each of them and what each proceeding found, one path per person. It shows what RLS
// returned to the caller. A form appears only where the database would accept its command (authz.can_edit_case on
// an active case for people and allegations, authz.can_record_findings for findings); every command checks again.
import type { Metadata } from "next";
import {
  FINDING_RESULTS,
  REPORT_CATEGORIES,
  SUBJECT_CATEGORIES,
  isClosedAllegation,
  type AllegationView,
  type CaseStructure,
  type FindingView,
  type ProceedingView,
} from "@cdf/contracts";
import {
  TERMINAL_PROCEEDING_STATUSES,
  currentFindings,
  governingFinding,
  proceedingDisplayNumber,
  subjectPath,
  type SubjectPath,
} from "@cdf/domain";
import { formatDate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFCard,
  CDFCommandForm,
  CDFEmptyState,
  CDFField,
  CDFProgressTracker,
  CDFStatusBadge,
  inputClass,
  textareaClass,
  type CDFProgressState,
} from "@cdf/ui";
import { caseStructureService } from "@/server/container";
import { getTranslator } from "@/server/locale";
import {
  addAllegationAction,
  addSubjectAction,
  linkAllegationSubjectAction,
  recordFindingAction,
} from "../structure-actions";
import { CaseWorkspace, loadCase, personName, tabHref } from "../workspace";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.caseAllegations") };
}

const PATH_STEPS = ["ALLEGED", "FOUND", "COMMITTEE"] as const;

/** A step is done only when every allegation about the person has reached it. */
function pathStates(p: SubjectPath): CDFProgressState[] {
  const all = (n: number) => p.allegations > 0 && n === p.allegations;
  const done = [p.allegations > 0, all(p.found), all(p.committee)];
  const current = done.indexOf(false);
  return done.map((d, i) => (d ? "done" : i === current ? "current" : "upcoming"));
}

function recorder(t: Translator, f: FindingView): string {
  const date = formatDate(t.locale, f.recordedAt);
  return f.recordedByName
    ? t("caseStructure.recordedBy", {
        date,
        name: personName(t, { displayName: f.recordedByName, displayNameAr: f.recordedByNameAr }),
      })
    : t("caseStructure.recordedOn", { date });
}

export default async function CaseAllegationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, ctx, t, c } = await loadCase(id);
  const s = await caseStructureService().structure(ctx, id);

  // case_mgmt.lock_editable_case: an editor, on an active case. authz.can_record_findings needs an active case too.
  const canEdit = c.can.edit && c.recordsState === "ACTIVE";
  const canFind = s.canRecordFindings && s.findingsVisible;
  const current = currentFindings(s.findings);
  const number = new Map(s.allegations.map((a, i) => [a.id, i + 1]));
  const groups = [
    ...s.subjects.map((subject) => ({
      key: subject.id,
      testId: `allegations-about-${s.subjects.indexOf(subject) + 1}`,
      title: t("caseStructure.allegationsFor", { name: subject.displayName }),
      items: s.allegations.filter((a) => a.subjectId === subject.id),
    })),
    {
      key: "unlinked",
      testId: "allegations-unlinked",
      title: t("caseStructure.unlinkedTitle"),
      items: s.allegations.filter((a) => a.subjectId === null),
    },
  ].filter((g) => g.items.length > 0);

  return (
    <CaseWorkspace c={c} actor={actor} t={t} tab="allegations">
      <p className="mb-4 text-cdf-text-secondary">{t("caseStructure.allegationsIntro")}</p>

      <CDFCard title={t("caseStructure.subjectsTitle")} testId="subjects">
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("caseStructure.subjectsIntro")}</p>
        {s.subjects.length === 0 ? (
          <p className="text-cdf-text-secondary" data-testid="subjects-empty">
            {t("caseStructure.noSubjects")}
          </p>
        ) : (
          <>
            <ul className="grid gap-4">
              {s.subjects.map((subject, i) => {
                const path = subjectPath(s.allegations, current, s.proceedings, subject.id);
                const states = pathStates(path);
                return (
                  <li
                    key={subject.id}
                    className="border-b border-cdf-border pb-4 last:border-0 last:pb-0"
                    data-testid={`subject-${i + 1}`}
                  >
                    <h3 className="font-semibold">
                      <bdi>{subject.displayName}</bdi>
                      <span className="ms-2 text-sm font-normal text-cdf-text-secondary">
                        {t.code("subjectCategory", subject.subjectCategory, "common.none")}
                      </span>
                    </h3>
                    <p
                      className="mb-2 text-sm text-cdf-text-secondary"
                      data-testid={`subject-${i + 1}-facts`}
                    >
                      {t("caseStructure.subjectFacts", {
                        allegations: path.allegations,
                        committee: path.committee,
                      })}
                    </p>
                    <CDFProgressTracker
                      label={t("caseStructure.pathLabel", { name: subject.displayName })}
                      current={PATH_STEPS[states.indexOf("current")] ?? null}
                      testId={`subject-${i + 1}-path`}
                      stateLabels={{
                        done: t("cases.stepDone"),
                        current: t("cases.stepCurrent"),
                        upcoming: t("cases.stepUpcoming"),
                      }}
                      steps={PATH_STEPS.map((code, k) => ({
                        code,
                        label: t(`caseStructure.path.${code}` as MessageKey),
                        state: states[k],
                      }))}
                    />
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-sm text-cdf-text-secondary">{t("caseStructure.pathLater")}</p>
          </>
        )}
        {canEdit ? (
          <details className="mt-4 border-t border-cdf-border pt-3" data-testid="add-subject">
            <summary className="cursor-pointer font-semibold">{t("caseStructure.addSubjectTitle")}</summary>
            <div className="mt-3">
              <CDFCommandForm
                action={addSubjectAction.bind(null, c.id)}
                locale={t.locale}
                submitLabel={t("caseStructure.addSubject")}
                successMessage={t("caseStructure.subjectAdded")}
                testId="add-subject-form"
                fieldLabels={{
                  displayLabel: t("caseStructure.displayLabel"),
                  subjectCategory: t("caseStructure.subjectCategoryLabel"),
                }}
              >
                <CDFField
                  id="subjectLabel"
                  label={t("caseStructure.displayLabel")}
                  hint={t("caseStructure.displayLabelHint")}
                >
                  <input
                    id="subjectLabel"
                    name="displayLabel"
                    className={inputClass}
                    required
                    minLength={2}
                    maxLength={200}
                    aria-describedby="subjectLabel-hint"
                  />
                </CDFField>
                <CDFField id="subjectCategory" label={t("caseStructure.subjectCategoryLabel")}>
                  <select
                    id="subjectCategory"
                    name="subjectCategory"
                    className={inputClass}
                    defaultValue="EMPLOYEE"
                  >
                    {SUBJECT_CATEGORIES.map((k) => (
                      <option key={k} value={k}>
                        {t.code("subjectCategory", k)}
                      </option>
                    ))}
                  </select>
                </CDFField>
              </CDFCommandForm>
            </div>
          </details>
        ) : null}
      </CDFCard>

      {s.allegations.length === 0 ? (
        <CDFEmptyState title={t("caseWorkspace.noAllegations")} testId="allegations-empty" />
      ) : (
        <div data-testid="allegations">
          {!s.findingsVisible ? (
            <p className="mb-4 text-sm text-cdf-text-secondary" data-testid="findings-hidden">
              {t("caseStructure.findingsHidden")}
            </p>
          ) : null}
          {groups.map((g) => (
            <CDFCard key={g.key} title={g.title} testId={g.testId}>
              <ul className="grid gap-4">
                {g.items.map((a) => (
                  <Allegation
                    key={a.id}
                    t={t}
                    caseId={c.id}
                    s={s}
                    a={a}
                    n={number.get(a.id)!}
                    current={current}
                    canEdit={canEdit}
                    canFind={canFind}
                  />
                ))}
              </ul>
            </CDFCard>
          ))}
        </div>
      )}

      {canEdit ? (
        <CDFCard title={t("caseStructure.addAllegationTitle")} testId="add-allegation-card">
          <CDFCommandForm
            action={addAllegationAction.bind(null, c.id)}
            locale={t.locale}
            submitLabel={t("caseStructure.addAllegation")}
            successMessage={t("caseStructure.allegationAdded")}
            leaveWarning={t("common.leaveWarning")}
            testId="add-allegation-form"
            fieldLabels={{
              category: t("caseStructure.categoryLabel"),
              description: t("caseStructure.descriptionLabel"),
              subjectId: t("caseStructure.personLabel"),
              policyReference: t("caseStructure.policyReference"),
              lawReference: t("caseStructure.lawReference"),
            }}
          >
            <CDFField id="allegationCategory" label={t("caseStructure.categoryLabel")}>
              <select id="allegationCategory" name="category" className={inputClass} required defaultValue="">
                <option value="" disabled>
                  {t("common.choose")}
                </option>
                {REPORT_CATEGORIES.map((k) => (
                  <option key={k} value={k}>
                    {t.code("category", k)}
                  </option>
                ))}
              </select>
            </CDFField>
            <CDFField id="allegationDescription" label={t("caseStructure.descriptionLabel")}>
              <textarea
                id="allegationDescription"
                name="description"
                className={textareaClass}
                required
                minLength={10}
                maxLength={8000}
              />
            </CDFField>
            <CDFField
              id="allegationSubject"
              label={t("caseStructure.personLabel")}
              optionalLabel={t("common.optional")}
            >
              <select id="allegationSubject" name="subjectId" className={inputClass} defaultValue="">
                <option value="">{t("caseStructure.personNone")}</option>
                {s.subjects.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.displayName}
                  </option>
                ))}
              </select>
            </CDFField>
            <ReferenceFields t={t} idPrefix="allegation" />
          </CDFCommandForm>
        </CDFCard>
      ) : null}
    </CaseWorkspace>
  );
}

/** Optional policy and law references, shared by adding an allegation and tying one to a person. */
function ReferenceFields({ t, idPrefix }: { t: Translator; idPrefix: string }) {
  return (
    <>
      {(["policy", "law"] as const).map((kind) => (
        <CDFField
          key={kind}
          id={`${idPrefix}-${kind}`}
          label={t(`caseStructure.${kind}Reference`)}
          hint={t("caseStructure.referenceHint")}
          optionalLabel={t("common.optional")}
        >
          <input
            id={`${idPrefix}-${kind}`}
            name={`${kind}Reference`}
            className={inputClass}
            maxLength={200}
            aria-describedby={`${idPrefix}-${kind}-hint`}
          />
        </CDFField>
      ))}
    </>
  );
}

/** One allegation: what is alleged, its references, and its findings with their versions (AMB-029). */
function Allegation({
  t,
  caseId,
  s,
  a,
  n,
  current,
  canEdit,
  canFind,
}: {
  t: Translator;
  caseId: string;
  s: CaseStructure;
  a: AllegationView;
  /** Its place in the case, oldest first: a display number only. */
  n: number;
  current: FindingView[];
  canEdit: boolean;
  canFind: boolean;
}) {
  const name = `${t("caseStructure.allegationNumber", { n })} · ${t.code("category", a.category, "common.none")}`;
  const proceeding = (pid: string) => s.proceedings.find((p) => p.id === pid);
  const proceedingName = (p: ProceedingView | undefined) =>
    p
      ? `${proceedingDisplayNumber(p.sequenceNo)} · ${t.code("proceedingType", p.proceedingType, "common.none")}`
      : "—";
  const subjectIndex = (subjectId: string | null) => s.subjects.findIndex((x) => x.id === subjectId) + 1;
  const subjectName = (subjectId: string | null) =>
    s.subjects.find((x) => x.id === subjectId)?.displayName ?? t("caseStructure.wholeAllegation");
  const open = s.proceedings.filter((p) => !TERMINAL_PROCEEDING_STATUSES.includes(p.status));
  // Withdrawn, or superseded by a correction (2090): the database refuses a subject link or a finding on it.
  const closed = isClosedAllegation(a.status);

  // One line per person and proceeding, in proceeding order: its current version, with earlier ones folded away.
  const lines = current
    .filter((f) => f.allegationId === a.id)
    .sort(
      (x, y) =>
        (proceeding(x.proceedingId)?.sequenceNo ?? 0) - (proceeding(y.proceedingId)?.sequenceNo ?? 0) ||
        subjectIndex(x.subjectId) - subjectIndex(y.subjectId),
    );
  const governing = (f: FindingView) => governingFinding(current, s.proceedings, a.id, f.subjectId);
  const refs = [
    a.policyReference ? t("caseStructure.policyRef", { ref: a.policyReference }) : null,
    a.lawReference ? t("caseStructure.lawRef", { ref: a.lawReference }) : null,
  ].filter((x): x is string => x !== null);

  return (
    <li className="border-b border-cdf-border pb-4 last:border-0 last:pb-0" data-testid={`allegation-${n}`}>
      <h3 className="flex flex-wrap items-center gap-2 font-semibold">
        <span>{name}</span>
        <CDFStatusBadge domain="allegation" status={a.status} testId={`allegation-${n}-status`}>
          {t.code("caseWorkspace.allegationStatus", a.status, "common.none")}
        </CDFStatusBadge>
      </h3>
      <p className="mt-1 whitespace-pre-wrap break-words">
        <bdi dir="auto">{a.description}</bdi>
      </p>
      {refs.length > 0 ? (
        <p className="mt-1 text-sm" data-testid={`allegation-${n}-refs`}>
          <span className="font-semibold">{t("caseStructure.references")}:</span>{" "}
          {refs.map((r, i) => (
            <span key={r}>
              {i > 0 ? " · " : null}
              <bdi dir="auto">{r}</bdi>
            </span>
          ))}
        </p>
      ) : null}
      {a.subjectId === null ? (
        <p className="mt-1 text-sm text-cdf-text-secondary">{t("caseStructure.noSubject")}</p>
      ) : null}

      {a.subjectId === null && canEdit && !closed && s.subjects.length > 0 ? (
        <details className="mt-3 border-t border-cdf-border pt-3" data-testid={`allegation-${n}-link`}>
          <summary className="cursor-pointer font-semibold">{t("caseStructure.linkSubject")}</summary>
          <div className="mt-3">
            <CDFCommandForm
              action={linkAllegationSubjectAction.bind(null, caseId, a.id)}
              locale={t.locale}
              submitLabel={t("caseStructure.linkSubject")}
              submitName={t("caseStructure.linkSubjectName", { what: name })}
              successMessage={t("caseStructure.linked")}
              testId={`allegation-${n}-link-form`}
              fieldLabels={{
                subjectId: t("caseStructure.personLabel"),
                policyReference: t("caseStructure.policyReference"),
                lawReference: t("caseStructure.lawReference"),
              }}
            >
              <CDFField id={`link-${n}-subject`} label={t("caseStructure.personLabel")}>
                <select
                  id={`link-${n}-subject`}
                  name="subjectId"
                  className={inputClass}
                  required
                  defaultValue=""
                >
                  <option value="" disabled>
                    {t("common.choose")}
                  </option>
                  {s.subjects.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.displayName}
                    </option>
                  ))}
                </select>
              </CDFField>
              <ReferenceFields t={t} idPrefix={`link-${n}`} />
            </CDFCommandForm>
          </div>
        </details>
      ) : null}

      {s.findingsVisible ? (
        <div className="mt-3" data-testid={`allegation-${n}-findings`}>
          <h4 className="mb-2 font-semibold">{t("caseStructure.findingsTitle")}</h4>
          {lines.length === 0 ? (
            <p className="text-sm text-cdf-text-secondary">{t("caseStructure.noFindings")}</p>
          ) : (
            <>
              <ul className="grid gap-3">
                {lines.map((f) => {
                  const g = governing(f);
                  const earlier = s.findings
                    .filter(
                      (x) =>
                        x.allegationId === f.allegationId &&
                        x.subjectId === f.subjectId &&
                        x.proceedingId === f.proceedingId &&
                        x.versionNo < f.versionNo,
                    )
                    .sort((x, y) => y.versionNo - x.versionNo);
                  const p = proceeding(f.proceedingId);
                  return (
                    <li
                      key={f.id}
                      className="rounded-cdf-md border border-cdf-border p-3"
                      data-testid={`finding-${n}-${p?.sequenceNo ?? 0}-${subjectIndex(f.subjectId)}`}
                      data-governing={g?.id === f.id ? "true" : "false"}
                    >
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">
                          {t("caseStructure.findingFor", {
                            who: subjectName(f.subjectId),
                            proceeding: proceedingName(p),
                          })}
                        </span>
                        <CDFStatusBadge domain="finding" status={f.result}>
                          {t.code("findingResult", f.result, "common.none")}
                        </CDFStatusBadge>
                        <span className="text-sm text-cdf-text-secondary">
                          {t("caseStructure.version", { n: f.versionNo })}
                        </span>
                      </p>
                      {g ? (
                        <p className="text-sm">
                          {g.id === f.id ? (
                            <strong>{t("caseStructure.governing")}</strong>
                          ) : (
                            t("caseStructure.onRecord")
                          )}
                        </p>
                      ) : null}
                      <p className="mt-1 whitespace-pre-wrap break-words">
                        <bdi dir="auto">{f.rationale}</bdi>
                      </p>
                      <p className="mt-1 text-sm text-cdf-text-secondary">{recorder(t, f)}</p>
                      {earlier.length > 0 ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-sm font-semibold">
                            {t("caseStructure.earlierVersions", { count: earlier.length })}
                          </summary>
                          <ul className="mt-2 grid gap-2 text-sm">
                            {earlier.map((x) => (
                              <li key={x.id} className="border-s-2 border-cdf-border ps-3">
                                <p>
                                  {t("caseStructure.version", { n: x.versionNo })} ·{" "}
                                  {t.code("findingResult", x.result, "common.none")} · {recorder(t, x)}
                                </p>
                                <p className="whitespace-pre-wrap break-words">
                                  <bdi dir="auto">{x.rationale}</bdi>
                                </p>
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {lines.some((f) => !governing(f)) ? (
                <p
                  className="mt-2 text-sm text-cdf-text-secondary"
                  data-testid={`allegation-${n}-no-governing`}
                >
                  {t("caseStructure.noGoverning")}
                </p>
              ) : null}
            </>
          )}

          {canFind && !closed ? (
            open.length === 0 ? (
              <p className="mt-3 text-sm" data-testid={`allegation-${n}-needs-proceeding`}>
                {t("caseStructure.needsProceeding")}{" "}
                <a
                  href={`${tabHref(caseId, "proceedings")}#open-proceeding`}
                  className="font-semibold underline underline-offset-4"
                >
                  {t("caseStructure.toProceedings")}
                </a>
              </p>
            ) : (
              <details
                className="mt-3 border-t border-cdf-border pt-3"
                data-testid={`allegation-${n}-record`}
              >
                <summary className="cursor-pointer font-semibold">{t("caseStructure.recordFinding")}</summary>
                <div className="mt-3">
                  <p className="mb-3 text-sm text-cdf-text-secondary">{t("caseStructure.newVersionHint")}</p>
                  <CDFCommandForm
                    action={recordFindingAction.bind(null, caseId, a.id)}
                    locale={t.locale}
                    submitLabel={t("caseStructure.recordFinding")}
                    submitName={t("caseStructure.recordFindingName", { what: name })}
                    successMessage={t("caseStructure.findingRecorded")}
                    leaveWarning={t("common.leaveWarning")}
                    testId={`allegation-${n}-record-form`}
                    fieldLabels={{
                      proceedingId: t("caseStructure.proceedingLabel"),
                      subjectId: t("caseStructure.personLabel"),
                      result: t("caseStructure.resultLabel"),
                      rationale: t("caseStructure.rationaleLabel"),
                    }}
                  >
                    <CDFField id={`finding-${n}-proceeding`} label={t("caseStructure.proceedingLabel")}>
                      <select
                        id={`finding-${n}-proceeding`}
                        name="proceedingId"
                        className={inputClass}
                        required
                        defaultValue={open.at(-1)!.id}
                      >
                        {open.map((p) => (
                          <option key={p.id} value={p.id}>
                            {proceedingName(p)}
                          </option>
                        ))}
                      </select>
                    </CDFField>
                    <CDFField id={`finding-${n}-subject`} label={t("caseStructure.personLabel")}>
                      <select
                        id={`finding-${n}-subject`}
                        name="subjectId"
                        className={inputClass}
                        defaultValue={a.subjectId ?? ""}
                      >
                        {/* Without a person, the database records the finding for the allegation's own subject. */}
                        {a.subjectId === null ? (
                          <option value="">{t("caseStructure.wholeAllegation")}</option>
                        ) : null}
                        {s.subjects.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.displayName}
                          </option>
                        ))}
                      </select>
                    </CDFField>
                    <CDFField id={`finding-${n}-result`} label={t("caseStructure.resultLabel")}>
                      <select
                        id={`finding-${n}-result`}
                        name="result"
                        className={inputClass}
                        required
                        defaultValue=""
                      >
                        <option value="" disabled>
                          {t("common.choose")}
                        </option>
                        {FINDING_RESULTS.map((r) => (
                          <option key={r} value={r}>
                            {t.code("findingResult", r)}
                          </option>
                        ))}
                      </select>
                    </CDFField>
                    <CDFField id={`finding-${n}-rationale`} label={t("caseStructure.rationaleLabel")}>
                      <textarea
                        id={`finding-${n}-rationale`}
                        name="rationale"
                        className={textareaClass}
                        required
                        minLength={10}
                        maxLength={8000}
                      />
                    </CDFField>
                  </CDFCommandForm>
                </div>
              </details>
            )
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
