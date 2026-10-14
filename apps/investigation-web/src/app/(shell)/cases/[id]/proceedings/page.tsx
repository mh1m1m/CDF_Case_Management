// Proceedings «الإجراءات» (Phase 12 P12-1; ADR-017 to ADR-019, migration 1870). The work on a case, one proceeding at
// a time, and its referral to the Investigation Committee (after the preliminary review referred it, AMB-018; DEC-61
// for a restricted case). It shows what RLS returned to the caller; the committee snapshot, and what a referral would
// copy now (migration 2045), arrive as counts per seat and standing, never as people. A form appears only where the
// database would accept its command (authz.can_edit_case on an active case; the case owner as Restricted Case
// Authority for the approval), and every command checks again.
import type { Metadata } from "next";
import {
  CLOSED_PROCEEDING_STATUSES,
  OPEN_PROCEEDING_STATUSES,
  OPENABLE_PROCEEDING_TYPES,
  OUTCOME_CODES_NOT_OFFERED,
  STATUS_CODES,
  type CaseDetail,
  type CaseStructure,
  type CommitteeProceedingView,
  type CommitteeReferralPreview,
  type ProceedingView,
  type StatusCodeDimension,
} from "@cdf/contracts";
import {
  PARALLEL_PROCEEDING_TYPES,
  TERMINAL_PROCEEDING_STATUSES,
  proceedingDisplayNumber,
} from "@cdf/domain";
import { formatDate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFCard,
  CDFCommandForm,
  CDFConfiguredValue,
  CDFDescriptionList,
  CDFField,
  CDFStatusBadge,
  CDFWorkflowGuide,
  inputClass,
  textareaClass,
  type CDFProgressState,
  type CDFValueSource,
} from "@cdf/ui";
import { caseStructureService, type RequestScope } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { confirmation } from "../../../confirmations";
import {
  approveRestrictedReferralAction,
  closeProceedingAction,
  openProceedingAction,
  referToCommitteeAction,
  updateProceedingStateAction,
} from "../structure-actions";
import { CaseWorkspace, loadCase, personName } from "../workspace";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.caseProceedings") };
}

const isOpen = (p: ProceedingView) => !TERMINAL_PROCEEDING_STATUSES.includes(p.status);

const RULE_SOURCE: Record<CommitteeProceedingView["rules"]["sourceStatus"], CDFValueSource> = {
  OWNER_DEFAULT: "OWNER_DEFAULT",
  SOURCE_REQUIRED: "SOURCE_REQUIRED",
  APPROVED: "CONFIGURED",
};

/** Active codes the database offers that this version also knows (the shared schema checks the same list). */
function codes(s: CaseStructure, dimension: StatusCodeDimension): string[] {
  const known: readonly string[] = STATUS_CODES[dimension];
  return s.statusCodes[dimension].filter((c) => known.includes(c));
}

export default async function CaseProceedingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, ctx, t, c } = await loadCase(id);
  const s = await caseStructureService().structure(ctx, id);

  // case_mgmt.lock_editable_case: an editor, on an active case.
  const active = c.recordsState === "ACTIVE";
  const canEdit = c.can.edit && active;
  const name = (p: ProceedingView | undefined) =>
    p
      ? `${proceedingDisplayNumber(p.sequenceNo)} · ${t.code("proceedingType", p.proceedingType, "common.none")}`
      : "—";
  const byId = (pid: string | null) => s.proceedings.find((p) => p.id === pid);
  const committeeName = (committeeId: string) => {
    const k = s.committees.find((x) => x.id === committeeId);
    return k ? t.code("committeeName", k.code, "common.none") : "—";
  };
  // Types that already have an open proceeding are refused (PROCEEDING_ALREADY_OPEN), except the parallel ones.
  const openable = OPENABLE_PROCEEDING_TYPES.filter(
    (type) =>
      PARALLEL_PROCEEDING_TYPES.includes(type) ||
      !s.proceedings.some((p) => p.proceedingType === type && isOpen(p)),
  );

  return (
    <CaseWorkspace c={c} actor={actor} t={t} tab="proceedings">
      <p className="mb-4 text-cdf-text-secondary">{t("caseStructure.proceedingsIntro")}</p>

      <CDFCard title={t("caseStructure.proceedingsTitle")} testId="proceedings">
        {s.proceedings.length === 0 ? (
          <p className="text-cdf-text-secondary" data-testid="proceedings-empty">
            {t("caseStructure.noProceedings")}
          </p>
        ) : (
          <ul className="grid gap-4">
            {s.proceedings.map((p) => (
              <Proceeding
                key={p.id}
                t={t}
                s={s}
                p={p}
                caseId={c.id}
                canEdit={canEdit}
                name={name}
                byId={byId}
              />
            ))}
          </ul>
        )}
      </CDFCard>

      {canEdit ? (
        <div id="open-proceeding" className="scroll-mt-4">
          <CDFCard title={t("caseStructure.openTitle")} testId="open-proceeding-card">
            <p className="mb-3 text-sm text-cdf-text-secondary">{t("caseStructure.committeeFromReferral")}</p>
            <CDFCommandForm
              action={openProceedingAction.bind(null, c.id)}
              locale={t.locale}
              submitLabel={t("caseStructure.openProceeding")}
              successMessage={t("caseStructure.opened")}
              testId="open-proceeding-form"
              fieldLabels={{
                proceedingType: t("caseStructure.typeLabel"),
                parentProceedingId: t("caseStructure.parentLabel"),
                reason: t("caseStructure.reasonLabel"),
              }}
            >
              <CDFField id="proceedingType" label={t("caseStructure.typeLabel")}>
                <select
                  id="proceedingType"
                  name="proceedingType"
                  className={inputClass}
                  required
                  defaultValue=""
                >
                  <option value="" disabled>
                    {t("common.choose")}
                  </option>
                  {openable.map((type) => (
                    <option key={type} value={type}>
                      {t.code("proceedingType", type)}
                    </option>
                  ))}
                </select>
              </CDFField>
              <ParentField t={t} s={s} id="proceedingParent" name={name} />
              <ReasonField t={t} id="proceedingReason" />
            </CDFCommandForm>
          </CDFCard>
        </div>
      ) : null}

      <Referral
        t={t}
        s={s}
        c={c}
        ctx={ctx}
        actorId={actor.userId}
        canEdit={canEdit}
        active={active}
        name={name}
      />

      {s.referralApprovals.length > 0 ? (
        <CDFCard title={t("caseStructure.approvalsTitle")} testId="referral-approvals">
          <ul className="grid gap-2">
            {s.referralApprovals.map((a, i) => (
              <li
                key={a.id}
                data-testid={`referral-approval-${i + 1}`}
                data-used={a.usedAt ? "true" : "false"}
              >
                <span className="font-semibold">{committeeName(a.committeeId)}</span>
                {" · "}
                {a.approvedByName
                  ? t("caseStructure.approvalBy", {
                      date: formatDate(t.locale, a.approvedAt),
                      name: personName(t, {
                        displayName: a.approvedByName,
                        displayNameAr: a.approvedByNameAr,
                      }),
                    })
                  : t("caseStructure.approvedOn", { date: formatDate(t.locale, a.approvedAt) })}
                {" · "}
                {a.usedAt
                  ? t("caseStructure.approvalUsed", { date: formatDate(t.locale, a.usedAt) })
                  : t("caseStructure.approvalUnused")}
              </li>
            ))}
          </ul>
        </CDFCard>
      ) : null}

      {s.committeeProceedings.map((cp) => (
        <Snapshot
          key={cp.id}
          t={t}
          cp={cp}
          committee={committeeName(cp.committeeId)}
          p={byId(cp.proceedingId)}
        />
      ))}
    </CaseWorkspace>
  );
}

function ReasonField({ t, id }: { t: Translator; id: string }) {
  return (
    <CDFField id={id} label={t("caseStructure.reasonLabel")}>
      <textarea id={id} name="reason" className={textareaClass} required minLength={5} maxLength={2000} />
    </CDFField>
  );
}

function ParentField({
  t,
  s,
  id,
  name,
  defaultValue = "",
}: {
  t: Translator;
  s: CaseStructure;
  id: string;
  name: (p: ProceedingView) => string;
  defaultValue?: string;
}) {
  return (
    <CDFField id={id} label={t("caseStructure.parentLabel")} optionalLabel={t("common.optional")}>
      <select id={id} name="parentProceedingId" className={inputClass} defaultValue={defaultValue}>
        <option value="">{t("caseStructure.parentNone")}</option>
        {s.proceedings.map((p) => (
          <option key={p.id} value={p.id}>
            {name(p)}
          </option>
        ))}
      </select>
    </CDFField>
  );
}

/** One proceeding: where it stands, and for an editor of an open one, its state change and its closing. */
function Proceeding({
  t,
  s,
  p,
  caseId,
  canEdit,
  name,
  byId,
}: {
  t: Translator;
  s: CaseStructure;
  p: ProceedingView;
  caseId: string;
  canEdit: boolean;
  name: (p: ProceedingView | undefined) => string;
  byId: (pid: string | null) => ProceedingView | undefined;
}) {
  const k = p.sequenceNo;
  const parent = byId(p.parentProceedingId);
  const label = name(p);
  const outcomes = codes(s, "OUTCOME_CODE").filter(
    (o) => !(OUTCOME_CODES_NOT_OFFERED as readonly string[]).includes(o),
  );
  return (
    <li className="border-b border-cdf-border pb-4 last:border-0 last:pb-0" data-testid={`proceeding-${k}`}>
      <h3 className="flex flex-wrap items-center gap-2 font-semibold">
        <span dir="ltr">{proceedingDisplayNumber(k)}</span>
        <span>{t.code("proceedingType", p.proceedingType, "common.none")}</span>
        <CDFStatusBadge domain="proceeding" status={p.status} testId={`proceeding-${k}-status`}>
          {t.code("proceedingStatus", p.status, "common.none")}
        </CDFStatusBadge>
      </h3>
      <ul className="mt-1 grid gap-0.5 text-sm text-cdf-text-secondary">
        {parent ? (
          <li>{t("caseStructure.partOf", { number: proceedingDisplayNumber(parent.sequenceNo) })}</li>
        ) : null}
        {p.waitingReason ? (
          <li data-testid={`proceeding-${k}-waiting`}>
            {t("caseStructure.waiting", { reason: t.code("waitingReason", p.waitingReason, "common.none") })}
          </li>
        ) : null}
        {p.suspensionReason ? (
          <li data-testid={`proceeding-${k}-suspended`}>
            {t("caseStructure.suspended", {
              reason: t.code("suspensionReason", p.suspensionReason, "common.none"),
            })}
          </li>
        ) : null}
        {p.outcomeCode ? (
          <li data-testid={`proceeding-${k}-outcome`}>
            {t("caseStructure.outcome", { outcome: t.code("outcomeCode", p.outcomeCode, "common.none") })}
          </li>
        ) : null}
        <li>
          {t("caseStructure.openedOn", { date: formatDate(t.locale, p.openedAt) })}
          {p.closedAt
            ? ` · ${t("caseStructure.closedOn", { date: formatDate(t.locale, p.closedAt) })}`
            : null}
        </li>
      </ul>

      {canEdit && isOpen(p) ? (
        <>
          <details className="mt-3 border-t border-cdf-border pt-3" data-testid={`proceeding-${k}-state`}>
            <summary className="cursor-pointer font-semibold">{t("caseStructure.changeState")}</summary>
            <div className="mt-3">
              <CDFCommandForm
                action={updateProceedingStateAction.bind(null, caseId, p.id)}
                locale={t.locale}
                submitLabel={t("caseStructure.changeState")}
                submitName={t("caseStructure.changeStateName", { what: label })}
                successMessage={t("caseStructure.stateSaved")}
                testId={`proceeding-${k}-state-form`}
                fieldLabels={{
                  status: t("caseStructure.newStatus"),
                  waitingReason: t("caseStructure.waitingReasonLabel"),
                  suspensionReason: t("caseStructure.suspensionReasonLabel"),
                  reason: t("caseStructure.reasonLabel"),
                }}
              >
                <CDFField id={`state-${k}-status`} label={t("caseStructure.newStatus")}>
                  <select
                    id={`state-${k}-status`}
                    name="status"
                    className={inputClass}
                    required
                    defaultValue={p.status}
                  >
                    {OPEN_PROCEEDING_STATUSES.map((st) => (
                      <option key={st} value={st}>
                        {t.code("proceedingStatus", st)}
                      </option>
                    ))}
                  </select>
                </CDFField>
                <CDFField
                  id={`state-${k}-waiting`}
                  label={t("caseStructure.waitingReasonLabel")}
                  optionalLabel={t("common.optional")}
                >
                  <select
                    id={`state-${k}-waiting`}
                    name="waitingReason"
                    className={inputClass}
                    defaultValue={p.waitingReason ?? ""}
                  >
                    <option value="">{t("caseStructure.nothing")}</option>
                    {codes(s, "WAITING_REASON").map((r) => (
                      <option key={r} value={r}>
                        {t.code("waitingReason", r)}
                      </option>
                    ))}
                  </select>
                </CDFField>
                <CDFField
                  id={`state-${k}-suspension`}
                  label={t("caseStructure.suspensionReasonLabel")}
                  hint={t("caseStructure.suspensionHint")}
                  optionalLabel={t("common.optional")}
                >
                  <select
                    id={`state-${k}-suspension`}
                    name="suspensionReason"
                    className={inputClass}
                    defaultValue={p.suspensionReason ?? ""}
                    aria-describedby={`state-${k}-suspension-hint`}
                  >
                    <option value="">{t("caseStructure.nothing")}</option>
                    {codes(s, "SUSPENSION_REASON").map((r) => (
                      <option key={r} value={r}>
                        {t.code("suspensionReason", r)}
                      </option>
                    ))}
                  </select>
                </CDFField>
                <ReasonField t={t} id={`state-${k}-reason`} />
              </CDFCommandForm>
            </div>
          </details>
          <details className="mt-3 border-t border-cdf-border pt-3" data-testid={`proceeding-${k}-close`}>
            <summary className="cursor-pointer font-semibold">{t("caseStructure.closeProceeding")}</summary>
            <div className="mt-3">
              <CDFCommandForm
                action={closeProceedingAction.bind(null, caseId, p.id)}
                locale={t.locale}
                submitLabel={t("caseStructure.closeProceeding")}
                submitName={t("caseStructure.closeProceedingName", { what: label })}
                successMessage={t("caseStructure.closed")}
                variant="danger"
                confirm={confirmation(t, "closeProceeding")}
                testId={`proceeding-${k}-close-form`}
                fieldLabels={{
                  status: t("caseStructure.howItEnds"),
                  outcomeCode: t("caseStructure.outcomeLabel"),
                  reason: t("caseStructure.reasonLabel"),
                }}
              >
                <CDFField id={`close-${k}-status`} label={t("caseStructure.howItEnds")}>
                  <select
                    id={`close-${k}-status`}
                    name="status"
                    className={inputClass}
                    required
                    defaultValue=""
                  >
                    <option value="" disabled>
                      {t("common.choose")}
                    </option>
                    {CLOSED_PROCEEDING_STATUSES.map((st) => (
                      <option key={st} value={st}>
                        {t.code("proceedingStatus", st)}
                      </option>
                    ))}
                  </select>
                </CDFField>
                <CDFField
                  id={`close-${k}-outcome`}
                  label={t("caseStructure.outcomeLabel")}
                  hint={t("caseStructure.outcomeHint")}
                  optionalLabel={t("common.optional")}
                >
                  <select
                    id={`close-${k}-outcome`}
                    name="outcomeCode"
                    className={inputClass}
                    defaultValue=""
                    aria-describedby={`close-${k}-outcome-hint`}
                  >
                    <option value="">{t("caseStructure.nothing")}</option>
                    {outcomes.map((o) => (
                      <option key={o} value={o}>
                        {t.code("outcomeCode", o)}
                      </option>
                    ))}
                  </select>
                </CDFField>
                <ReasonField t={t} id={`close-${k}-reason`} />
              </CDFCommandForm>
            </div>
          </details>
        </>
      ) : null}
    </li>
  );
}

/**
 * Referral to the Investigation Committee (ADR-018; DEC-61 and DEC-F19; AMB-018). A case that did not arrive as a
 * direct referral or grievance goes there only once its preliminary review referred it, approved (migration 2030). A
 * restricted case also needs its Restricted Case Authority's approval, which the database ties to the case owner and
 * checks again; one approval serves one referral. A step's form appears only once the steps before it are done,
 * with what the referral would copy now. Grievance proceedings come from a grievance, not from here.
 */
async function Referral({
  t,
  s,
  c,
  ctx,
  actorId,
  canEdit,
  active,
  name,
}: {
  t: Translator;
  s: CaseStructure;
  c: CaseDetail;
  ctx: RequestScope["ctx"];
  actorId: string;
  canEdit: boolean;
  active: boolean;
  name: (p: ProceedingView) => string;
}) {
  const ic = s.committees.find((k) => k.kind === "INVESTIGATION" && k.isActive);
  if (!ic) return null;
  const mine = s.committeeProceedings.filter((cp) => cp.committeeId === ic.id);
  const withCommittee = mine.find((cp) => cp.status === "OPEN");
  const last = mine.at(-1);
  const pending = s.referralApprovals.find((a) => a.committeeId === ic.id && a.usedAt === null);
  const restricted = c.isRestricted;
  const isOwner = c.owner?.userId === actorId;
  const number = (cp: CommitteeProceedingView) => {
    const p = s.proceedings.find((x) => x.id === cp.proceedingId);
    return p ? proceedingDisplayNumber(p.sequenceNo) : "—";
  };

  type Step = "PRELIMINARY" | "APPROVAL" | "REFERRAL" | "COMMITTEE";
  const steps: Step[] = [
    ...(s.preliminaryReferral === "NOT_REQUIRED" ? [] : (["PRELIMINARY"] as const)),
    ...(restricted ? (["APPROVAL"] as const) : []),
    "REFERRAL",
    "COMMITTEE",
  ];
  // Each step is done on its own record: an approval given before the preliminary review ended shows as given.
  const done: Record<Step, boolean> = {
    PRELIMINARY: !!withCommittee || s.preliminaryReferral !== "AWAITED",
    APPROVAL: !!withCommittee || !!pending,
    REFERRAL: !!withCommittee,
    COMMITTEE: false,
  };
  const current = steps.find((step) => !done[step]) ?? "COMMITTEE";
  const state = (step: Step): CDFProgressState =>
    done[step] ? "done" : step === current ? "current" : "upcoming";

  const now = withCommittee
    ? t("caseStructure.now.referred", {
        date: formatDate(t.locale, withCommittee.referredAt),
        number: number(withCommittee),
      })
    : current === "PRELIMINARY"
      ? t("caseStructure.now.awaitingPreliminary")
      : current === "APPROVAL"
        ? t("caseStructure.now.awaitingApproval")
        : pending
          ? t("caseStructure.now.approved", { date: formatDate(t.locale, pending.approvedAt) })
          : last
            ? t("caseStructure.now.ended", { number: number(last) })
            : t("caseStructure.now.notReferred");
  const next = withCommittee
    ? t("caseStructure.next.committee")
    : current === "PRELIMINARY"
      ? t("caseStructure.next.preliminary")
      : current === "APPROVAL"
        ? c.owner
          ? t("caseStructure.next.authority", { name: personName(t, c.owner) })
          : t("caseStructure.next.none")
        : t("caseStructure.next.caseTeam");
  const canApprove = current === "APPROVAL" && isOwner && active;
  const canRefer = current === "REFERRAL" && canEdit;
  // Asked only of whoever can act on the referral here; the database answers with the referral's own checks, and
  // null (no preview) when it refuses.
  const preview =
    canApprove || canRefer ? await caseStructureService().referralPreview(ctx, c.id, ic.id) : null;
  const facts = preview ? previewFacts(t, preview) : [];
  const you = withCommittee
    ? t("caseStructure.you.withCommittee")
    : !active
      ? t("caseStructure.you.readOnly")
      : current === "PRELIMINARY"
        ? canEdit
          ? t("caseStructure.you.awaitPreliminary")
          : t("caseStructure.you.cannotEdit")
        : current === "APPROVAL"
          ? isOwner
            ? t("caseStructure.you.canApprove")
            : canEdit
              ? t("caseStructure.you.awaitApproval")
              : t("caseStructure.you.cannotEdit")
          : canEdit
            ? t("caseStructure.you.canRefer")
            : t("caseStructure.you.cannotEdit");
  // ASK ONCE, DERIVE: the referral usually follows the latest investigation.
  const parent = [...s.proceedings]
    .reverse()
    .find((p) => p.proceedingType === "INVESTIGATION" || p.proceedingType === "REINVESTIGATION");

  return (
    <CDFWorkflowGuide
      id="referral"
      testId="referral-guide"
      title={t("caseStructure.referralTitle")}
      trackerLabel={t("caseStructure.guide.tracker")}
      steps={steps.map((code) => ({
        code,
        label: t(`caseStructure.steps.${code}` as MessageKey),
        state: state(code),
      }))}
      current={current}
      stateLabels={{
        done: t("cases.stepDone"),
        current: t("cases.stepCurrent"),
        upcoming: t("cases.stepUpcoming"),
      }}
      now={<span data-testid="referral-now">{now}</span>}
      nextActor={<span data-testid="referral-next">{next}</span>}
      you={you}
      canAct={canApprove || canRefer}
      labels={{
        now: t("caseStructure.guide.now"),
        nextActor: t("caseStructure.guide.next"),
        you: t("caseStructure.guide.you"),
      }}
    >
      {preview ? <ReferralPreview t={t} preview={preview} /> : null}
      {canApprove ? (
        <div className="w-full">
          <CDFCommandForm
            action={approveRestrictedReferralAction.bind(null, c.id, ic.id)}
            locale={t.locale}
            submitLabel={t("caseStructure.approve")}
            successMessage={t("caseStructure.approved")}
            variant="primary"
            confirm={{
              ...confirmation(t, "approveRestrictedReferral", [
                {
                  term: t("confirm.acts.approveRestrictedReferral.uncleared"),
                  value: t("confirm.acts.approveRestrictedReferral.unclearedValue"),
                },
                {
                  term: t("confirm.acts.approveRestrictedReferral.singleUse"),
                  value: t("confirm.acts.approveRestrictedReferral.singleUseValue"),
                },
                ...facts,
              ]),
              tone: "primary",
            }}
            testId="approve-referral-form"
            fieldLabels={{ reason: t("caseStructure.reasonLabel") }}
          >
            <ReasonField t={t} id="approveReason" />
          </CDFCommandForm>
        </div>
      ) : null}
      {canRefer ? (
        <div className="w-full">
          <CDFCommandForm
            action={referToCommitteeAction.bind(null, c.id, ic.id)}
            locale={t.locale}
            submitLabel={t("caseStructure.refer")}
            successMessage={t("caseStructure.referred")}
            variant="primary"
            confirm={{ ...confirmation(t, "referToCommittee", facts), tone: "primary" }}
            testId="refer-form"
            fieldLabels={{
              parentProceedingId: t("caseStructure.parentLabel"),
              reason: t("caseStructure.reasonLabel"),
            }}
          >
            <ParentField t={t} s={s} id="referParent" name={name} defaultValue={parent?.id ?? ""} />
            <ReasonField t={t} id="referReason" />
          </CDFCommandForm>
        </div>
      ) : null}
    </CDFWorkflowGuide>
  );
}

/** A referral preview's totals, as the confirmation's facts: counts only (DEC-AMB-012 preview rule). */
function previewFacts(t: Translator, v: CommitteeReferralPreview): { term: string; value: string }[] {
  return [
    { term: t("caseStructure.voting"), value: String(v.voting) },
    { term: t("caseStructure.preview.cleared"), value: String(v.cleared) },
    { term: t("caseStructure.preview.notCleared"), value: String(v.notCleared) },
    ...(v.firewallRestricted > 0
      ? [{ term: t("caseStructure.firewall"), value: String(v.firewallRestricted) }]
      : []),
  ];
}

/**
 * What the referral would copy now (migration 2045; DEC-F19): the committee's members in office, counted per seat,
 * and the voting, cleared, not cleared and firewall totals. Counts only: no person, and no flag per seat, since a
 * flag on a seat one person holds would tell that person's clearance or conflict (coordinator ruling, 2026-10-14).
 * The referral copies the committee as it is when it is made.
 */
function ReferralPreview({ t, preview: v }: { t: Translator; preview: CommitteeReferralPreview }) {
  return (
    <section className="w-full" aria-labelledby="referral-preview-title" data-testid="referral-preview">
      <h3 id="referral-preview-title" className="mb-1 font-semibold">
        {t("caseStructure.preview.title")}
      </h3>
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("caseStructure.preview.intro")}</p>
      {v.seats.length === 0 ? (
        <p className="text-sm" data-testid="referral-preview-empty">
          {t("caseStructure.preview.empty")}
        </p>
      ) : (
        <div data-testid="referral-preview-seats">
          <CDFDescriptionList
            items={[
              ...v.seats.map((x) => ({
                term: t.code("committeeSeat", x.seat, "common.none"),
                value: String(x.count),
              })),
              { term: t("caseStructure.voting"), value: String(v.voting) },
              { term: t("caseStructure.preview.cleared"), value: String(v.cleared) },
              {
                term: t("caseStructure.preview.notCleared"),
                value: <span data-testid="referral-preview-not-cleared">{v.notCleared}</span>,
              },
              ...(v.firewallRestricted > 0
                ? [{ term: t("caseStructure.firewall"), value: String(v.firewallRestricted) }]
                : []),
            ]}
          />
        </div>
      )}
    </section>
  );
}

/** The committee as copied at referral: counts per seat and standing, and the rules in force then (DEC-F19). */
function Snapshot({
  t,
  cp,
  committee,
  p,
}: {
  t: Translator;
  cp: CommitteeProceedingView;
  committee: string;
  p: ProceedingView | undefined;
}) {
  const r = cp.rules;
  const yesNo = (v: boolean) => (v ? t("common.yes") : t("common.no"));
  const k = p?.sequenceNo ?? 0;
  return (
    <CDFCard title={t("caseStructure.snapshotTitle", { committee })} testId={`committee-snapshot-${k}`}>
      <p className="mb-1 text-sm">
        {t("caseStructure.now.referred", {
          date: formatDate(t.locale, cp.referredAt),
          number: p ? proceedingDisplayNumber(p.sequenceNo) : "—",
        })}
      </p>
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("caseStructure.snapshotIntro")}</p>
      <h3 className="mb-2 font-semibold">{t("caseStructure.seatsTitle")}</h3>
      <div className="mb-4" data-testid={`committee-snapshot-${k}-seats`}>
        <CDFDescriptionList
          items={[
            ...cp.seats.map((x) => ({
              term: t.code("committeeSeat", x.seat, "common.none"),
              value: String(x.count),
            })),
            { term: t("caseStructure.voting"), value: String(cp.voting) },
            ...(cp.firewallRestricted > 0
              ? [{ term: t("caseStructure.firewall"), value: String(cp.firewallRestricted) }]
              : []),
            {
              term: t("caseStructure.notCleared"),
              value: <span data-testid={`committee-snapshot-${k}-not-cleared`}>{cp.notCleared}</span>,
            },
          ]}
        />
      </div>
      <h3 className="mb-2 font-semibold">
        <CDFConfiguredValue
          value={t("caseStructure.rulesTitle")}
          source={RULE_SOURCE[r.sourceStatus]}
          sourceLabel={t(`caseStructure.ruleSource.${r.sourceStatus}` as MessageKey)}
          testId={`committee-snapshot-${k}-rules`}
        />
      </h3>
      <CDFDescriptionList
        items={[
          {
            term: t("caseStructure.quorum"),
            value: t(`quorumType.${r.quorumType}` as MessageKey, { value: r.quorumValue ?? "—" }),
          },
          { term: t("caseStructure.castingVote"), value: yesNo(r.castingVoteEnabled) },
          {
            term: t("caseStructure.minutesReview"),
            value: t("caseStructure.minutesDays", { days: r.minutesReviewBusinessDays }),
          },
          { term: t("caseStructure.deemedApproval"), value: yesNo(r.deemedApprovalEnabled) },
        ]}
      />
    </CDFCard>
  );
}
