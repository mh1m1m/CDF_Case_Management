// Administration › Committees (UX redesign Phase 12 P12-8a and P12-8b; ADR-051's P12-8a amendment, ADR-063). The
// committee administrator's register: each committee's seats, corrections, rule-set versions, independent conflict
// authorities and changes of status, as recorded, and who decides each kind of recommendation
// (api.authority_rule_coverage). Read in the administrator's own context, after the database confirms COMMITTEE_ADMIN,
// from tables whose row-level security returns exactly this register; anyone else gets the uniform not-found, recorded
// as ACCESS_DENIED. Two controls, each shown only where the database says its command would accept the caller now
// (api.admin_committee_capabilities, 2127 and 2128). A new version of a committee's rules from a later date, always
// provisional: an option that follows a decision is shown read-only with the decision it follows and never sent
// (coordinator rulings of 2026-10-18 23:20 and 23:50), and a safeguard is offered only as it is or stricter, never
// looser (rulings of 23:50 and 2026-10-19 02:10). And the end of a seat not yet ended, now or from a date, with the
// decree or source reference an end dated before now requires (2128; the owner's decision F7 = B), shown on the
// register once recorded. Appointment forms wait for migration 2160 (the owner's F5 decision), and conflict authorities
// change only with dual control (DEC-12).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  BALLOT_SECRECY,
  COMMITTEE_SEATS,
  type AdminCommittee,
  type AdminCommitteesPage,
  type AdminPeriodState,
  type AdminRuleSet,
  type CommitteeRules,
  type PackageAuthorityRule,
} from "@cdf/contracts";
import { formatDays, formatList, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFCommandForm,
  CDFConfiguredValue,
  CDFDescriptionList,
  CDFField,
  CDFFieldError,
  CDFIdentifier,
  CDFTable,
  inputClass,
  textareaClass,
  type CDFValueSource,
} from "@cdf/ui";
import {
  DECIDED_RULE_KEYS,
  EDITABLE_RULE_KEYS,
  GRIEVANCE_ONLY_RULE_KEYS,
  isTightenOnlyRuleKey,
  MAX_MINIMUM_NOTICE_DAYS,
  safeguardOffer,
  type DecidedRuleKey,
  type RuleSetRevisionKey,
  type TightenOnlyRuleKey,
} from "@cdf/validation";
import { administrationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { confirmation } from "../../confirmations";
import { RulesList } from "../../committees/rules-list";
import { AdminFrame } from "../admin-frame";
import {
  ADMIN_CODES,
  SOURCE,
  day,
  period,
  personName,
  plusDays,
  riyadhDate,
  sourceLabel,
  stateLabel,
  stateTone,
} from "../labels";
import { EndForm } from "../end-form";
import { endCommitteeMembershipAction, reviseCommitteeRuleSetAction } from "./actions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("admin.views.committees") };
}

const STATE_ORDER: Record<AdminPeriodState, number> = { IN_FORCE: 0, SCHEDULED: 1, ENDED: 2 };

/** The committee's name where the platform has one (the registry's codes), else its code. */
function committeeName(t: Translator, code: string): string {
  const key = `committeeName.${code}`;
  const name = t(key as MessageKey);
  return name === key ? code : name;
}

export default async function AdminCommitteesRegister() {
  const { actor, ctx } = await requireActor();
  const page = await administrationService().committees(ctx, actor);
  if (!page) notFound();
  const t = await getTranslator();
  return (
    <AdminFrame t={t} views={page.views} view="committees" intro={t("admin.committees.intro")}>
      {page.committees.length === 0 ? (
        <p className="mb-6 text-cdf-text-secondary">{t("admin.committees.none")}</p>
      ) : null}
      {page.committees.map((c) => (
        <CommitteeCard key={c.committeeId} t={t} page={page} committee={c} me={actor.userId} />
      ))}
      <CoverageCard t={t} rules={page.coverage} />
      <p className="text-sm text-cdf-text-secondary" data-testid="admin-committees-later">
        {t("admin.committees.later")}
      </p>
    </AdminFrame>
  );
}

function CommitteeCard({
  t,
  page,
  committee: c,
  me,
}: {
  t: Translator;
  page: AdminCommitteesPage;
  committee: AdminCommittee;
  me: string;
}) {
  const name = committeeName(t, c.code);
  const who = (id: string | null) => personName(t, page.people, id, me);
  const seats = page.seats
    .filter((s) => s.committeeId === c.committeeId)
    .sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        COMMITTEE_SEATS.indexOf(a.seat) - COMMITTEE_SEATS.indexOf(b.seat) ||
        a.effectiveFrom.localeCompare(b.effectiveFrom),
    );
  // The seats the database says may be ended now (2128): not yet ended, whatever their period.
  const endable = seats.filter((s) => s.mayEnd);
  const corrections = page.corrections.filter((x) => x.committeeId === c.committeeId);
  const versions = page.ruleSets.filter((r) => r.committeeId === c.committeeId);
  const current = versions.filter((r) => r.state !== "ENDED");
  const ended = versions.filter((r) => r.state === "ENDED").reverse();
  // The version a revision starts from: the one with no end, in force or starting later.
  const open = versions.find((r) => r.effectiveTo === null);
  const authorities = page.authorities.filter((a) => a.committeeId === c.committeeId);
  const changes = page.statusChanges.filter((x) => x.committeeId === c.committeeId);
  const testId = `admin-committee-${c.code}`;
  return (
    <CDFCard
      title={name}
      testId={testId}
      actions={
        <CDFBadge tone={c.isActive ? "success" : "neutral"} testId={`${testId}-status`}>
          {t(c.isActive ? "admin.active" : "admin.inactive")}
        </CDFBadge>
      }
    >
      <section className="mb-6" aria-labelledby={`${testId}-seats`}>
        <h3 id={`${testId}-seats`} className="mb-2 font-semibold">
          {t("admin.committees.seatsTitle")}
        </h3>
        <CDFTable
          caption={t("admin.committees.seatsCaption", { committee: isolate(name) })}
          testId={`${testId}-seat-list`}
          rows={seats}
          rowKey={(s) => s.membershipId}
          empty={t("admin.committees.noSeats")}
          columns={[
            { header: t("admin.columns.holder"), cell: (s) => <bdi>{who(s.userId)}</bdi> },
            { header: t("admin.committees.seat"), cell: (s) => t(`committeeSeat.${s.seat}` as MessageKey) },
            { header: t("admin.columns.period"), cell: (s) => period(t, s.effectiveFrom, s.effectiveTo) },
            {
              header: t("admin.columns.state"),
              cell: (s) => <CDFBadge tone={stateTone(s.state)}>{stateLabel(t, s.state)}</CDFBadge>,
            },
            {
              header: t("admin.columns.reference"),
              cell: (s) => <bdi className="break-words">{s.appointmentReference}</bdi>,
            },
            {
              header: t("admin.columns.recorded"),
              cell: (s) => (
                <>
                  {t("admin.recordedBy", { name: isolate(who(s.appointedBy)), date: day(t, s.appointedAt) })}
                  {s.endedAt ? (
                    <p className="text-cdf-text-secondary">
                      {t("admin.committees.ended", {
                        name: isolate(who(s.endedBy)),
                        date: day(t, s.endedAt),
                      })}
                      {s.endReason ? (
                        <>
                          {" "}
                          <bdi>{s.endReason}</bdi>
                        </>
                      ) : null}
                      {s.endReference ? (
                        <>
                          {" "}
                          {t("admin.endReference")} <bdi className="break-words">{s.endReference}</bdi>
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
            id={`admin-end-seat-form-${c.code}`}
            title={t("admin.committees.endTitle")}
            intro={t("admin.committees.endIntro")}
            rowLabel={t("admin.committees.endSeat")}
            rows={endable.map((s) => ({
              membershipId: s.membershipId,
              label: t("admin.committees.endOption", {
                holder: isolate(who(s.userId)),
                seat: t(`committeeSeat.${s.seat}` as MessageKey),
                period: period(t, s.effectiveFrom, s.effectiveTo),
              }),
            }))}
            action={endCommitteeMembershipAction}
            act="endCommitteeMembership"
            submitLabel={t("admin.committees.end")}
            submitName={t("admin.committees.endIn", { committee: isolate(name) })}
            done={t("admin.committees.endDone")}
          />
        ) : null}
      </section>

      <section className="mb-6" aria-labelledby={`${testId}-corrections`}>
        <h3 id={`${testId}-corrections`} className="mb-2 font-semibold">
          {t("admin.committees.correctionsTitle")}
        </h3>
        {corrections.length === 0 ? (
          <p className="text-cdf-text-secondary">{t("admin.committees.noCorrections")}</p>
        ) : (
          <ul className="grid gap-2" data-testid={`${testId}-corrections-list`}>
            {corrections.map((x) => {
              const seat = page.seats.find((s) => s.membershipId === x.membershipId);
              return (
                <li key={x.correctionId} className="rounded-cdf-md border border-cdf-border p-3">
                  <p className="font-semibold">
                    {t(`admin.committees.correctionKind.${x.kind}` as MessageKey)}
                    {seat ? (
                      <>
                        {" · "}
                        <bdi>{who(seat.userId)}</bdi>
                        {" · "}
                        {t(`committeeSeat.${seat.seat}` as MessageKey)}
                      </>
                    ) : null}
                  </p>
                  <p className="text-sm text-cdf-text-secondary">
                    {t("admin.recordedBy", {
                      name: isolate(who(x.correctedBy)),
                      date: day(t, x.correctedAt),
                    })}
                  </p>
                  <p className="whitespace-pre-wrap break-words">
                    <bdi>{x.reason}</bdi>
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mb-6" aria-labelledby={`${testId}-rules`}>
        <h3 id={`${testId}-rules`} className="mb-2 font-semibold">
          {t("admin.committees.rulesTitle")}
        </h3>
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.committees.rulesIntro")}</p>
        {current.length === 0 ? (
          <p className="text-cdf-text-secondary">{t("admin.committees.noRules")}</p>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-2">
          {current.map((r) => (
            <div
              key={r.ruleSetId}
              className="rounded-cdf-md border border-cdf-border p-3"
              data-testid={`${testId}-rules-${r.state === "IN_FORCE" ? "in-force" : r.ruleSetId}`}
              data-state={r.state}
            >
              <p className="mb-2 font-semibold">
                <CDFBadge tone={stateTone(r.state)}>{stateLabel(t, r.state)}</CDFBadge>
              </p>
              <RulesList
                t={t}
                rules={asRules(r)}
                missing={t("admin.notSet")}
                testId={`${testId}-rules-${r.ruleSetId}-list`}
                since={
                  r.state === "SCHEDULED"
                    ? t("admin.committees.startsOn", { date: day(t, r.effectiveFrom) })
                    : undefined
                }
                extra={extraRules(t, r, c.kind === "GRIEVANCE")}
              />
              {r.reason ? (
                <p className="mt-2 text-sm whitespace-pre-wrap break-words">
                  <span className="font-semibold">{t("admin.committees.versionReason")}</span>{" "}
                  <bdi>{r.reason}</bdi>
                </p>
              ) : null}
            </div>
          ))}
        </div>
        {open && page.ruleControls.find((x) => x.committeeId === c.committeeId)?.mayReviseRuleSet ? (
          <ReviseForm t={t} committee={c} name={name} version={open} versions={current} today={page.today} />
        ) : null}
        {ended.length > 0 ? (
          <details className="mt-3" data-testid={`${testId}-rules-ended`}>
            <summary className="cursor-pointer font-semibold">
              {t("admin.committees.endedVersions", { count: ended.length })}
            </summary>
            <ul className="mt-2 grid gap-2 text-sm">
              {ended.map((r) => (
                <li key={r.ruleSetId}>
                  {period(t, r.effectiveFrom, r.effectiveTo)} · {sourceLabel(t, r.sourceStatus)}
                  {r.reason ? (
                    <p className="text-cdf-text-secondary whitespace-pre-wrap break-words">
                      <bdi>{r.reason}</bdi>
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section className="mb-6" aria-labelledby={`${testId}-authorities`}>
        <h3 id={`${testId}-authorities`} className="mb-2 font-semibold">
          {t("admin.committees.authoritiesTitle")}
        </h3>
        <p className="mb-2 text-sm text-cdf-text-secondary">{t("admin.committees.authoritiesIntro")}</p>
        <CDFTable
          caption={t("admin.committees.authoritiesCaption", { committee: isolate(name) })}
          testId={`${testId}-authority-list`}
          rows={authorities}
          rowKey={(a) => a.authorityId}
          empty={t("admin.committees.noAuthorities")}
          columns={[
            { header: t("admin.columns.holder"), cell: (a) => <bdi>{who(a.userId)}</bdi> },
            { header: t("admin.columns.period"), cell: (a) => period(t, a.effectiveFrom, a.effectiveTo) },
            {
              header: t("admin.columns.state"),
              cell: (a) => <CDFBadge tone={stateTone(a.state)}>{stateLabel(t, a.state)}</CDFBadge>,
            },
            {
              header: t("admin.columns.reference"),
              cell: (a) => <bdi className="break-words">{a.appointmentReference}</bdi>,
            },
            {
              header: t("admin.columns.source"),
              cell: (a) => (
                <CDFConfiguredValue
                  value=""
                  source={SOURCE[a.sourceStatus]}
                  sourceLabel={sourceLabel(t, a.sourceStatus)}
                />
              ),
            },
            {
              header: t("admin.columns.recorded"),
              cell: (a) =>
                t("admin.recordedBy", { name: isolate(who(a.appointedBy)), date: day(t, a.appointedAt) }),
            },
          ]}
        />
      </section>

      <section aria-labelledby={`${testId}-status-changes`}>
        <h3 id={`${testId}-status-changes`} className="mb-2 font-semibold">
          {t("admin.committees.statusTitle")}
        </h3>
        {changes.length === 0 ? (
          <p className="text-cdf-text-secondary">{t("admin.committees.noStatusChanges")}</p>
        ) : (
          <ul className="grid gap-2" data-testid={`${testId}-status-list`}>
            {changes.map((x) => (
              <li key={x.changeId} className="rounded-cdf-md border border-cdf-border p-3">
                <p className="font-semibold">
                  {t(x.isActive ? "admin.committees.reactivated" : "admin.committees.deactivated", {
                    name: isolate(who(x.changedBy)),
                    date: day(t, x.changedAt),
                  })}
                </p>
                <p className="text-sm">
                  {t("admin.committees.decisionReference")}{" "}
                  <CDFIdentifier>{x.decisionReference}</CDFIdentifier>
                </p>
                <p className="whitespace-pre-wrap break-words">
                  <bdi>{x.reason}</bdi>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </CDFCard>
  );
}

/** A registry version in the committee page's terms (every option is recorded in a version of the registry). */
function asRules(r: AdminRuleSet): CommitteeRules {
  return {
    quorumType: r.quorumType,
    quorumValue: r.quorumValue,
    castingVoteEnabled: r.castingVoteEnabled,
    actingChairCastingVote: r.actingChairCastingVote,
    ballotSecrecy: r.ballotSecrecy,
    voteRevisionAllowed: r.voteRevisionAllowed,
    dissentNoteAllowed: r.dissentNoteAllowed,
    minutesReviewBusinessDays: r.minutesReviewBusinessDays,
    deemedApprovalEnabled: r.deemedApprovalEnabled,
    minutesObjectionBlocksDeemed: r.minutesObjectionBlocksDeemed,
    minimumNoticeDays: r.minimumNoticeDays,
    conflictDecider: r.conflictDecider,
    sourceStatus: r.sourceStatus,
    effectiveFrom: r.effectiveFrom,
  };
}

/** The options only the registry shows: what an item no one votes on records, defence notices, and grievances. */
function extraRules(t: Translator, r: AdminRuleSet, grievance: boolean) {
  const notSet = t("admin.notSet");
  const days = (n: number | null) => (n === null ? notSet : formatDays(t.locale, n));
  const decider = (d: string | null) => (d ? t(`admin.committees.decider.${d}` as MessageKey) : notSet);
  const items = [
    {
      term: t("admin.committees.noSubstantiveVote"),
      value: t(`admin.committees.noSubstantiveVoteValue.${r.noSubstantiveVoteOutcome}` as MessageKey),
    },
    {
      term: t("admin.committees.defenceNoticeFirst"),
      value: t(r.sanctionRequiresDefenceNotice ? "common.yes" : "common.no"),
    },
  ];
  if (!grievance) return items;
  return [
    ...items,
    {
      term: t("admin.committees.grievanceWindow"),
      value:
        r.grievanceWindowDays !== null && r.grievanceWindowStartBasis
          ? t("admin.committees.windowFrom", {
              days: formatDays(t.locale, r.grievanceWindowDays),
              basis: t(`admin.committees.windowBasis.${r.grievanceWindowStartBasis}` as MessageKey),
            })
          : days(r.grievanceWindowDays),
    },
    { term: t("admin.committees.admissibilityDecider"), value: decider(r.admissibilityDecider) },
    { term: t("admin.committees.nonAdmissionDecider"), value: decider(r.nonAdmissionDecider) },
    { term: t("admin.committees.grievanceCompletion"), value: days(r.grievanceCompletionDays) },
  ];
}

const COVERAGE_SOURCE: Record<PackageAuthorityRule["coverage"], CDFValueSource> = {
  OWNER_DEFAULT: "OWNER_DEFAULT",
  SOURCE_REQUIRED: "SOURCE_REQUIRED",
  APPROVED: "CONFIGURED",
  NO_RULE: "UNSET",
};

/** Who decides each kind of recommendation (2030), and where no rule is in force: the package then cannot go. */
function CoverageCard({ t, rules }: { t: Translator; rules: PackageAuthorityRule[] }) {
  return (
    <CDFCard title={t("admin.committees.coverageTitle")} testId="admin-coverage">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.committees.coverageIntro")}</p>
      <ul className="grid gap-1 text-sm">
        {rules.map((r) => {
          const type = t(`committeeProceedings.itemType.${r.itemType}` as MessageKey);
          return (
            <li key={r.itemType} data-testid={`admin-coverage-${r.itemType}`} data-coverage={r.coverage}>
              {r.coverage === "NO_RULE" ? (
                t("legalReviews.noRule", { type })
              ) : (
                <CDFConfiguredValue
                  value={t("legalReviews.ruleLine", {
                    type,
                    authorities: formatList(
                      t.locale,
                      r.authorityTypes.map((x) => t(`legalReviews.authorityType.${x}` as MessageKey)),
                    ),
                  })}
                  source={COVERAGE_SOURCE[r.coverage]}
                  sourceLabel={t(`legalReviews.ruleSource.${r.coverage}` as MessageKey)}
                />
              )}
              {r.settingDisagreement ? (
                <p className="text-cdf-text-secondary">{t("legalReviews.settingDisagreement")}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </CDFCard>
  );
}

/** A radio button, checked as the version open now has it; a group's first control carries its server error. */
function Choice({
  id,
  name,
  value,
  label,
  checked,
}: {
  id: string;
  name: string;
  value: string;
  label: string;
  checked: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        id={`${id}-${name}-${value}`}
        type="radio"
        name={name}
        value={value}
        defaultChecked={checked}
        className="size-5 shrink-0"
        data-testid={`${id}-${name}-${value}`}
      />
      <label htmlFor={`${id}-${name}-${value}`}>{label}</label>
    </div>
  );
}

/** One option chosen from a list, as radio buttons, with a hint under the legend where there is one. */
function Choices({
  id,
  name,
  legend,
  hint,
  options,
  value,
  inline = false,
}: {
  id: string;
  name: RuleSetRevisionKey;
  legend: string;
  hint?: string;
  options: readonly { value: string; label: string }[];
  value: string | null;
  inline?: boolean;
}) {
  const hintId = `${id}-${name}-hint`;
  return (
    <fieldset className="mb-4" aria-describedby={hint ? hintId : undefined}>
      <legend className="mb-1 font-semibold">{legend}</legend>
      {hint ? (
        <p id={hintId} className="mb-2 text-sm text-cdf-text-secondary">
          {hint}
        </p>
      ) : null}
      <div className={inline ? "flex flex-wrap gap-x-6 gap-y-2" : "grid gap-2"}>
        {options.map((o) => (
          <Choice
            key={o.value}
            id={id}
            name={name}
            value={o.value}
            label={o.label}
            checked={o.value === value}
          />
        ))}
      </div>
      {options[0] ? <CDFFieldError id={`${id}-${name}-${options[0].value}`} /> : null}
    </fieldset>
  );
}

/** An option that is on or off, as "Yes" and "No". */
function YesNo({
  t,
  id,
  name,
  legend,
  hint,
  value,
}: {
  t: Translator;
  id: string;
  name: RuleSetRevisionKey;
  legend: string;
  hint?: string;
  value: boolean;
}) {
  return (
    <Choices
      id={id}
      name={name}
      legend={legend}
      {...(hint ? { hint } : {})}
      inline
      value={value ? "on" : "off"}
      options={[
        { value: "on", label: t("common.yes") },
        { value: "off", label: t("common.no") },
      ]}
    />
  );
}

/**
 * A safeguard already at its strictest (coordinator rulings of 2026-10-18 23:50 and 2026-10-19 02:10): no control, only
 * its value and why it stays. `send` is the value sent whatever the administrator does, where the version open now is
 * looser than it.
 */
function KeptSafeguard({
  id,
  name,
  label,
  value,
  note,
  send,
}: {
  id: string;
  name: TightenOnlyRuleKey;
  label: string;
  value: string;
  note: string;
  send?: string;
}) {
  return (
    <div className="mb-4" data-testid={`${id}-kept-${name}`}>
      <p className="mb-1 font-semibold">{label}</p>
      <p>{value}</p>
      <p className="text-sm text-cdf-text-secondary">{note}</p>
      {send !== undefined ? <input type="hidden" name={name} value={send} /> : null}
    </div>
  );
}

/** A number of days (or a quorum value), prefilled as the version open now has it. */
function NumberField({
  t,
  id,
  name,
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  clearable,
}: {
  t: Translator;
  id: string;
  name: RuleSetRevisionKey;
  label: string;
  hint: string;
  value: number | null;
  min: number;
  max: number;
  step?: number | "any";
  /** An empty field clears the option ("not set"); otherwise emptying it is refused. */
  clearable: boolean;
}) {
  const control = `${id}-${name}`;
  return (
    <CDFField
      id={control}
      label={label}
      hint={hint}
      {...(clearable ? { optionalLabel: t("common.optional") } : { requiredLabel: t("common.required") })}
    >
      <input
        id={control}
        name={name}
        type="number"
        inputMode={step === 1 ? "numeric" : "decimal"}
        className={inputClass}
        defaultValue={value === null ? "" : String(value)}
        aria-describedby={`${control}-hint`}
        min={min}
        max={max}
        step={step}
        required={!clearable}
      />
    </CDFField>
  );
}

/**
 * A new version of the committee's rules from a later date (`api.revise_committee_rule_set`), starting from the version
 * open now: every option shows its value there, and only the options the administrator changed are sent
 * (`changedOnly`), so the rest carry over. The command checks every value of the new version, the unchanged ones
 * included, and refuses a start on or before a version's own (RULE_SET_SCHEDULED). The version is recorded as
 * provisional, awaiting the CDF source; a proceeding keeps the rules it was referred with.
 *
 * An option that follows a decision (`DECIDED_RULE_KEYS`: DEC-F03, F04, F14, F15 and F17, and DEC-F01, DEC-F17, Q51,
 * Q98 and AMB-076, confirmed by the coordinator's ruling of 2026-10-18 23:50) has no control: it is shown read-only with
 * its value and the decision it follows, so the new version keeps it (ruling of 23:20). The service refuses a revision
 * that names one.
 *
 * A safeguard (`TIGHTEN_ONLY_RULE_KEYS`, rulings of 23:50 and 2026-10-19 02:10) is offered only at its floor, the
 * strictest value among the versions in force or scheduled (`versions`), or stricter, with a note next to it saying
 * why; one already at its strictest has no control. The service refuses a looser value under a lock on the committee's
 * revisions.
 */
function ReviseForm({
  t,
  committee: c,
  name,
  version: r,
  versions,
  today,
}: {
  t: Translator;
  committee: AdminCommittee;
  name: string;
  version: AdminRuleSet;
  /** The committee's versions in force or scheduled, the open one included. */
  versions: readonly AdminRuleSet[];
  today: string;
}) {
  const id = `admin-rules-form-${c.code}`;
  const grievance = c.kind === "GRIEVANCE";
  const applies = (k: RuleSetRevisionKey) => grievance || !GRIEVANCE_ONLY_RULE_KEYS.includes(k);
  // The options the form may change; every other option follows a decision and is shown read-only.
  const options = EDITABLE_RULE_KEYS.filter(applies);
  // Each safeguard as far as the page may take it: never below its floor (coordinator rulings of 23:50 and 02:10).
  const offer = {
    minimumNoticeDays: safeguardOffer("minimumNoticeDays", r, versions),
    ballotSecrecy: safeguardOffer("ballotSecrecy", r, versions),
    dissentNoteAllowed: safeguardOffer("dissentNoteAllowed", r, versions),
    minutesObjectionBlocksDeemed: safeguardOffer("minutesObjectionBlocksDeemed", r, versions),
    sanctionRequiresDefenceNotice: safeguardOffer("sanctionRequiresDefenceNotice", r, versions),
  };
  // A safeguard whose floor is sent whatever the administrator does is never left out as unchanged.
  const changedOnly = options.filter((k) => !(isTightenOnlyRuleKey(k) && offer[k].sendFloor));
  const noticeFloor = offer.minimumNoticeDays.floor;
  const safeguardNote = t("admin.committees.safeguard");
  const keptNote = t("admin.committees.safeguardKept");
  // After today and after the open version's own start: a start on or before it is refused.
  const earliest = [plusDays(today, 1), plusDays(riyadhDate(r.effectiveFrom), 1)].sort().at(-1)!;
  const label = (key: MessageKey) => t(key);
  const fieldLabels: Record<RuleSetRevisionKey, string> = {
    quorumType: label("caseStructure.quorum"),
    quorumValue: label("admin.committees.quorumValue"),
    castingVoteEnabled: label("caseStructure.castingVote"),
    minutesReviewBusinessDays: label("caseStructure.minutesReview"),
    deemedApprovalEnabled: label("caseStructure.deemedApproval"),
    noSubstantiveVoteOutcome: label("admin.committees.noSubstantiveVote"),
    conflictDecider: label("committees.conflictDecider"),
    actingChairCastingVote: label("committees.actingChairCastingVote"),
    voteRevisionAllowed: label("committees.voteRevision"),
    ballotSecrecy: label("committees.ballot"),
    minimumNoticeDays: label("committees.minimumNotice"),
    minutesObjectionBlocksDeemed: label("committees.objectionBlocksDeemed"),
    sanctionRequiresDefenceNotice: label("admin.committees.defenceNoticeFirst"),
    dissentNoteAllowed: label("committees.dissentNote"),
    grievanceWindowDays: label("admin.committees.grievanceWindow"),
    admissibilityDecider: label("admin.committees.admissibilityDecider"),
    grievanceWindowStartBasis: label("admin.committees.windowStartLabel"),
    nonAdmissionDecider: label("admin.committees.nonAdmissionDecider"),
    grievanceCompletionDays: label("admin.committees.grievanceCompletion"),
  };
  const yesNo = (v: boolean) => t(v ? "common.yes" : "common.no");
  const notSet = t("admin.notSet");
  // Each decided option as the version open now has it. The quorum's value is said with its kind.
  const decidedValue: Record<Exclude<DecidedRuleKey, "quorumValue">, string> = {
    quorumType: t(`quorumType.${r.quorumType}` as MessageKey, { value: r.quorumValue ?? "—" }),
    castingVoteEnabled: yesNo(r.castingVoteEnabled),
    actingChairCastingVote: yesNo(r.actingChairCastingVote),
    noSubstantiveVoteOutcome: t(
      `admin.committees.noSubstantiveVoteValue.${r.noSubstantiveVoteOutcome}` as MessageKey,
    ),
    conflictDecider: t(`committees.conflictDeciderValue.${r.conflictDecider}` as MessageKey),
    minutesReviewBusinessDays: t("caseStructure.minutesDays", { days: r.minutesReviewBusinessDays }),
    deemedApprovalEnabled: yesNo(r.deemedApprovalEnabled),
    grievanceWindowDays:
      r.grievanceWindowDays === null ? notSet : formatDays(t.locale, r.grievanceWindowDays),
    grievanceWindowStartBasis: r.grievanceWindowStartBasis
      ? t(`admin.committees.windowBasisOption.${r.grievanceWindowStartBasis}` as MessageKey)
      : notSet,
    admissibilityDecider: r.admissibilityDecider
      ? t(`admin.committees.decider.${r.admissibilityDecider}` as MessageKey)
      : notSet,
    nonAdmissionDecider: r.nonAdmissionDecider
      ? t(`admin.committees.decider.${r.nonAdmissionDecider}` as MessageKey)
      : notSet,
  };
  const decided = (Object.keys(decidedValue) as (keyof typeof decidedValue)[]).filter(applies).map((k) => ({
    term: fieldLabels[k],
    value: (
      <span data-testid={`${id}-decided-${k}`}>
        {decidedValue[k]}{" "}
        <span className="text-sm text-cdf-text-secondary">
          (
          {t(`admin.committees.decidedBy.${DECIDED_RULE_KEYS[k].by}` as MessageKey, {
            ref: isolate(DECIDED_RULE_KEYS[k].ref),
          })}
          )
        </span>
      </span>
    ),
  }));
  return (
    <details className="mt-4 rounded-cdf-md border border-cdf-border p-3" data-testid={`${id}-details`}>
      <summary className="cursor-pointer font-semibold">
        {t("admin.committees.reviseSummary", { committee: isolate(name) })}
      </summary>
      <div className="mt-3">
        <p className="mb-3 text-sm text-cdf-text-secondary">
          {t("admin.committees.reviseIntro", { date: day(t, r.effectiveFrom) })}
        </p>
        <CDFCommandForm
          action={reviseCommitteeRuleSetAction}
          locale={t.locale}
          submitLabel={t("admin.committees.revise")}
          submitName={t("admin.committees.reviseFor", { committee: isolate(name) })}
          variant="primary"
          testId={id}
          successMessage={t("admin.committees.revised")}
          leaveWarning={t("common.leaveWarning")}
          codeSections={ADMIN_CODES}
          changedOnly={changedOnly}
          fieldLabels={{
            ...Object.fromEntries(options.map((k) => [k, fieldLabels[k]])),
            effectiveFrom: t("admin.startsOn"),
            reason: t("admin.calendar.reason"),
          }}
          confirm={confirmation(t, "reviseCommitteeRuleSet")}
        >
          <input type="hidden" name="committeeId" value={c.committeeId} />
          <input type="hidden" name="committeeKind" value={c.kind} />

          <section
            className="mb-4 rounded-cdf-md border border-cdf-border p-3"
            aria-labelledby={`${id}-decided-title`}
            data-testid={`${id}-decided`}
          >
            <h4 id={`${id}-decided-title`} className="mb-1 font-semibold">
              {t("admin.committees.decidedTitle")}
            </h4>
            <p className="mb-2 text-sm text-cdf-text-secondary">{t("admin.committees.decidedIntro")}</p>
            <CDFDescriptionList stacked items={decided} />
          </section>

          <h4 className="mb-2 font-semibold">{t("admin.committees.meetingsGroup")}</h4>
          {offer.minimumNoticeDays.keptOnly ? (
            <KeptSafeguard
              id={id}
              name="minimumNoticeDays"
              label={fieldLabels.minimumNoticeDays}
              value={formatDays(t.locale, MAX_MINIMUM_NOTICE_DAYS)}
              note={keptNote}
              {...(offer.minimumNoticeDays.sendFloor ? { send: String(MAX_MINIMUM_NOTICE_DAYS) } : {})}
            />
          ) : (
            // No shorter than the floor; emptied (no minimum) only while no version in force or scheduled has one.
            <NumberField
              t={t}
              id={id}
              name="minimumNoticeDays"
              label={fieldLabels.minimumNoticeDays}
              hint={`${
                noticeFloor === null
                  ? t("admin.committees.noticeHint")
                  : t("admin.committees.noticeHintFrom", { min: noticeFloor })
              } ${safeguardNote}`}
              value={offer.minimumNoticeDays.sendFloor ? noticeFloor : r.minimumNoticeDays}
              min={noticeFloor ?? 0}
              max={MAX_MINIMUM_NOTICE_DAYS}
              clearable={noticeFloor === null}
            />
          )}
          {offer.ballotSecrecy.keptOnly ? (
            <KeptSafeguard
              id={id}
              name="ballotSecrecy"
              label={fieldLabels.ballotSecrecy}
              value={t("committees.ballotValue.SECRET_BALLOT")}
              note={keptNote}
              {...(offer.ballotSecrecy.sendFloor ? { send: "SECRET_BALLOT" } : {})}
            />
          ) : (
            <Choices
              id={id}
              name="ballotSecrecy"
              legend={fieldLabels.ballotSecrecy}
              hint={safeguardNote}
              value={r.ballotSecrecy}
              options={BALLOT_SECRECY.map((b) => ({
                value: b,
                label: t(`committees.ballotValue.${b}` as MessageKey),
              }))}
            />
          )}
          <YesNo
            t={t}
            id={id}
            name="voteRevisionAllowed"
            legend={fieldLabels.voteRevisionAllowed}
            value={r.voteRevisionAllowed}
          />
          {offer.dissentNoteAllowed.keptOnly ? (
            <KeptSafeguard
              id={id}
              name="dissentNoteAllowed"
              label={fieldLabels.dissentNoteAllowed}
              value={yesNo(true)}
              note={keptNote}
              {...(offer.dissentNoteAllowed.sendFloor ? { send: "on" } : {})}
            />
          ) : (
            <YesNo
              t={t}
              id={id}
              name="dissentNoteAllowed"
              legend={fieldLabels.dissentNoteAllowed}
              hint={safeguardNote}
              value={r.dissentNoteAllowed}
            />
          )}

          <h4 className="mb-2 font-semibold">{t("admin.committees.minutesGroup")}</h4>
          {offer.minutesObjectionBlocksDeemed.keptOnly ? (
            <KeptSafeguard
              id={id}
              name="minutesObjectionBlocksDeemed"
              label={fieldLabels.minutesObjectionBlocksDeemed}
              value={yesNo(true)}
              note={keptNote}
              {...(offer.minutesObjectionBlocksDeemed.sendFloor ? { send: "on" } : {})}
            />
          ) : (
            <YesNo
              t={t}
              id={id}
              name="minutesObjectionBlocksDeemed"
              legend={fieldLabels.minutesObjectionBlocksDeemed}
              hint={safeguardNote}
              value={r.minutesObjectionBlocksDeemed}
            />
          )}

          <h4 className="mb-2 font-semibold">{t("admin.committees.decisionsGroup")}</h4>
          {offer.sanctionRequiresDefenceNotice.keptOnly ? (
            <KeptSafeguard
              id={id}
              name="sanctionRequiresDefenceNotice"
              label={fieldLabels.sanctionRequiresDefenceNotice}
              value={yesNo(true)}
              note={keptNote}
              {...(offer.sanctionRequiresDefenceNotice.sendFloor ? { send: "on" } : {})}
            />
          ) : (
            <YesNo
              t={t}
              id={id}
              name="sanctionRequiresDefenceNotice"
              legend={fieldLabels.sanctionRequiresDefenceNotice}
              hint={safeguardNote}
              value={r.sanctionRequiresDefenceNotice}
            />
          )}

          {grievance ? (
            <>
              <h4 className="mb-2 font-semibold">{t("admin.committees.grievancesGroup")}</h4>
              <NumberField
                t={t}
                id={id}
                name="grievanceCompletionDays"
                label={fieldLabels.grievanceCompletionDays}
                hint={t("admin.committees.completionHint")}
                value={r.grievanceCompletionDays}
                min={1}
                max={90}
                clearable
              />
            </>
          ) : null}

          <CDFField
            id={`${id}-from`}
            label={t("admin.startsOn")}
            hint={t("admin.committees.fromHint")}
            requiredLabel={t("common.required")}
          >
            <input
              id={`${id}-from`}
              name="effectiveFrom"
              type="date"
              className={inputClass}
              min={earliest}
              aria-describedby={`${id}-from-hint`}
              required
            />
          </CDFField>
          <CDFField
            id={`${id}-reason`}
            label={t("admin.calendar.reason")}
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
      </div>
    </details>
  );
}
