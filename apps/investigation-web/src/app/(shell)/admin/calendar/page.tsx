// Administration › Business calendar (UX redesign Phase 12 P12-8a and P12-8b; ADR-051's P12-8a amendment, ADR-063;
// DEC-F02). The calendar administrator's register and its three forms: the working week, version by version, and the
// dated days (holidays, closures and working days on a weekend), withdrawn ones included. Every business-day count
// reads them; a due date already computed never moves. Read in the administrator's own context after the database
// confirms BUSINESS_CALENDAR_ADMIN; anyone else gets the uniform not-found, recorded as ACCESS_DENIED. Each form shows
// only where its command's own caller check, asked of the database, passes (coordinator ruling F1;
// api.admin_calendar_capabilities, 2127), and a day can be withdrawn only where the database says that day's
// withdrawal would be accepted now; the command decides every input again. A new week is always provisional, awaiting
// the CDF source (F4).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BUSINESS_CALENDAR_DAY_TYPES, type AdminCalendarDay, type AdminCalendarPage } from "@cdf/contracts";
import { formatList, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFCommandForm,
  CDFConfiguredValue,
  CDFField,
  CDFFieldError,
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
import { setCalendarDayAction, setWeekPatternAction, withdrawCalendarDayAction } from "./actions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("admin.views.calendar") };
}

const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** The days of a week that are not working days, in words; none is a seven-day working week. */
function daysOff(t: Translator, days: readonly number[]): string {
  return days.length === 0
    ? t("admin.calendar.noDaysOff")
    : formatList(
        t.locale,
        days.map((d) => t(`admin.calendar.isoDay.${d}` as MessageKey)),
      );
}

export default async function AdminCalendarRegister() {
  const { actor, ctx } = await requireActor();
  const page = await administrationService().calendar(ctx, actor);
  if (!page) notFound();
  const t = await getTranslator();
  const me = actor.userId;
  const who = (id: string | null) => personName(t, page.people, id, me);
  return (
    <AdminFrame t={t} views={page.views} view="calendar" intro={t("admin.calendar.intro")}>
      <CDFCard title={t("admin.calendar.sourceTitle")} testId="admin-calendar-source">
        <p className="text-sm">
          <CDFConfiguredValue
            value={page.source === "CONFIGURED" ? t("admin.calendar.connected") : t("admin.notConfigured")}
            source={page.source === "CONFIGURED" ? "CONFIGURED" : "SOURCE_REQUIRED"}
            sourceLabel={t(`admin.settingStatus.${page.source}` as MessageKey)}
            testId="admin-calendar-source-value"
          />
        </p>
        <p className="mt-2 text-sm text-cdf-text-secondary">{t("admin.calendar.sourceIntro")}</p>
      </CDFCard>

      <CDFCard title={t("admin.calendar.weekTitle")} testId="admin-calendar-week">
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.calendar.weekIntro")}</p>
        <CDFTable
          caption={t("admin.calendar.weekTitle")}
          testId="admin-week-list"
          rows={[...page.patterns].reverse()}
          rowKey={(w) => w.patternId}
          empty={t("admin.calendar.noWeek")}
          columns={[
            { header: t("admin.calendar.daysOff"), cell: (w) => daysOff(t, w.nonWorkingIsoDays) },
            { header: t("admin.columns.period"), cell: (w) => period(t, w.effectiveFrom, w.effectiveTo) },
            {
              header: t("admin.columns.state"),
              cell: (w) => (
                <span data-testid={`admin-week-${w.patternId}`} data-state={w.state}>
                  <CDFBadge tone={stateTone(w.state)}>{stateLabel(t, w.state)}</CDFBadge>
                </span>
              ),
            },
            {
              header: t("admin.columns.source"),
              cell: (w) => (
                <CDFConfiguredValue
                  value=""
                  source={SOURCE[w.sourceStatus]}
                  sourceLabel={sourceLabel(t, w.sourceStatus)}
                />
              ),
            },
            {
              header: t("admin.columns.recorded"),
              cell: (w) => (
                <>
                  {w.createdBy
                    ? t("admin.recordedByOnly", { name: isolate(who(w.createdBy)) })
                    : t("admin.calendar.fromMigrations")}
                  {w.reason ? (
                    <p className="text-cdf-text-secondary whitespace-pre-wrap break-words">
                      <bdi>{w.reason}</bdi>
                    </p>
                  ) : null}
                </>
              ),
            },
          ]}
        />
        {page.capabilities.maySetWeekPattern ? <WeekForm t={t} page={page} /> : null}
      </CDFCard>

      <CDFCard title={t("admin.calendar.daysTitle")} testId="admin-calendar-days">
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.calendar.daysIntro")}</p>
        <DayTable t={t} page={page} who={who} />
        {page.capabilities.maySetDay ? <DayForm t={t} page={page} /> : null}
        {page.days.some((d) => d.mayWithdraw) ? <WithdrawForm t={t} page={page} /> : null}
      </CDFCard>
    </AdminFrame>
  );
}

/** Days from today first, then the past, then withdrawn entries (kept, with who withdrew them). */
function DayTable({
  t,
  page,
  who,
}: {
  t: Translator;
  page: AdminCalendarPage;
  who: (id: string | null) => string;
}) {
  const live = page.days.filter((d) => d.withdrawnAt === null);
  const upcoming = live.filter((d) => d.calendarDate >= page.today);
  const past = live.filter((d) => d.calendarDate < page.today).reverse();
  const withdrawn = page.days.filter((d) => d.withdrawnAt !== null);
  const columns = [
    {
      header: t("admin.calendar.date"),
      cell: (d: AdminCalendarDay) => (
        <span data-testid={`admin-day-${d.calendarDate}`} data-type={d.dayType}>
          {day(t, d.calendarDate)}
        </span>
      ),
    },
    {
      header: t("admin.calendar.dayType"),
      cell: (d: AdminCalendarDay) => t(`admin.calendar.type.${d.dayType}` as MessageKey),
    },
    {
      header: t("admin.calendar.sourceReference"),
      cell: (d: AdminCalendarDay) =>
        d.sourceReference ? <bdi className="break-words">{d.sourceReference}</bdi> : "—",
    },
    {
      header: t("admin.columns.recorded"),
      cell: (d: AdminCalendarDay) => (
        <>
          {t("admin.recordedBy", { name: isolate(who(d.recordedBy)), date: day(t, d.recordedAt) })}
          <p className="text-cdf-text-secondary whitespace-pre-wrap break-words">
            <bdi>{d.reason}</bdi>
          </p>
          {d.withdrawnAt ? (
            <p>
              {t("admin.calendar.withdrawn", {
                name: isolate(who(d.withdrawnBy)),
                date: day(t, d.withdrawnAt),
              })}
              {d.withdrawReason ? (
                <>
                  {" "}
                  <bdi>{d.withdrawReason}</bdi>
                </>
              ) : null}
            </p>
          ) : null}
        </>
      ),
    },
  ];
  return (
    <>
      <h3 className="mb-2 font-semibold">{t("admin.calendar.upcoming")}</h3>
      <CDFTable
        caption={t("admin.calendar.upcoming")}
        testId="admin-day-list"
        rows={upcoming}
        rowKey={(d) => d.dayId}
        empty={t("admin.calendar.noUpcoming")}
        columns={columns}
      />
      {past.length > 0 ? (
        <details className="mt-3" data-testid="admin-day-past">
          <summary className="cursor-pointer font-semibold">
            {t("admin.calendar.past", { count: past.length })}
          </summary>
          <div className="mt-2">
            <CDFTable
              caption={t("admin.calendar.pastCaption")}
              rows={past}
              rowKey={(d) => d.dayId}
              empty=""
              columns={columns}
            />
          </div>
        </details>
      ) : null}
      {withdrawn.length > 0 ? (
        <details className="mt-3" data-testid="admin-day-withdrawn">
          <summary className="cursor-pointer font-semibold">
            {t("admin.calendar.withdrawnList", { count: withdrawn.length })}
          </summary>
          <div className="mt-2">
            <CDFTable
              caption={t("admin.calendar.withdrawnCaption")}
              rows={withdrawn}
              rowKey={(d) => d.dayId}
              empty=""
              columns={columns}
            />
          </div>
        </details>
      ) : null}
    </>
  );
}

/** Add a day from today (Riyadh); one entry per date. */
function DayForm({ t, page }: { t: Translator; page: AdminCalendarPage }) {
  const id = "admin-day-form";
  return (
    <section className="mt-6 border-t border-cdf-border pt-4" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="mb-2 font-semibold">
        {t("admin.calendar.addDayTitle")}
      </h3>
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.calendar.addDayIntro")}</p>
      <CDFCommandForm
        action={setCalendarDayAction}
        locale={t.locale}
        submitLabel={t("admin.calendar.addDay")}
        variant="primary"
        testId={id}
        successMessage={t("admin.calendar.dayAdded")}
        leaveWarning={t("common.leaveWarning")}
        codeSections={ADMIN_CODES}
        fieldLabels={{
          calendarDate: t("admin.calendar.date"),
          dayType: t("admin.calendar.dayType"),
          sourceReference: t("admin.calendar.sourceReference"),
          reason: t("admin.calendar.reason"),
        }}
        confirm={confirmation(t, "setBusinessCalendarDay")}
      >
        <CDFField
          id={`${id}-date`}
          label={t("admin.calendar.date")}
          hint={t("admin.calendar.dateHint")}
          requiredLabel={t("common.required")}
        >
          <input
            id={`${id}-date`}
            name="calendarDate"
            type="date"
            className={inputClass}
            min={page.today}
            aria-describedby={`${id}-date-hint`}
            required
          />
        </CDFField>
        <CDFField id={`${id}-type`} label={t("admin.calendar.dayType")} requiredLabel={t("common.required")}>
          <select id={`${id}-type`} name="dayType" className={inputClass} defaultValue="" required>
            <option value="" disabled>
              {t("common.choose")}
            </option>
            {BUSINESS_CALENDAR_DAY_TYPES.map((v) => (
              <option key={v} value={v}>
                {t(`admin.calendar.type.${v}` as MessageKey)}
              </option>
            ))}
          </select>
        </CDFField>
        <CDFField
          id={`${id}-reference`}
          label={t("admin.calendar.sourceReference")}
          hint={t("admin.calendar.sourceReferenceHint")}
          optionalLabel={t("common.optional")}
        >
          <input
            id={`${id}-reference`}
            name="sourceReference"
            type="text"
            className={inputClass}
            aria-describedby={`${id}-reference-hint`}
            minLength={3}
            maxLength={200}
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
    </section>
  );
}

/** Change the working week from a later date; the days ticked start as the week in force or scheduled last. */
function WeekForm({ t, page }: { t: Translator; page: AdminCalendarPage }) {
  const id = "admin-week-form";
  const latest = page.patterns.at(-1);
  const ticked = new Set(latest?.nonWorkingIsoDays ?? []);
  return (
    <section className="mt-6 border-t border-cdf-border pt-4" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="mb-2 font-semibold">
        {t("admin.calendar.changeWeekTitle")}
      </h3>
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.calendar.changeWeekIntro")}</p>
      <CDFCommandForm
        action={setWeekPatternAction}
        locale={t.locale}
        submitLabel={t("admin.calendar.changeWeek")}
        variant="secondary"
        testId={id}
        successMessage={t("admin.calendar.weekChanged")}
        leaveWarning={t("common.leaveWarning")}
        codeSections={ADMIN_CODES}
        fieldLabels={{
          nonWorkingDays: t("admin.calendar.daysOffLabel"),
          effectiveFrom: t("admin.calendar.from"),
          reason: t("admin.calendar.reason"),
        }}
        confirm={confirmation(t, "setBusinessWeekPattern")}
      >
        <fieldset className="mb-4" aria-describedby={`${id}-days-hint`}>
          <legend className="mb-1 font-semibold">{t("admin.calendar.daysOffLabel")}</legend>
          <p id={`${id}-days-hint`} className="mb-2 text-sm text-cdf-text-secondary">
            {t("admin.calendar.daysOffHint")}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {ISO_DAYS.map((d) => (
              <div key={d} className="flex items-center gap-2">
                <input
                  id={`${id}-day-${d}`}
                  type="checkbox"
                  name="nonWorkingDays"
                  value={String(d)}
                  defaultChecked={ticked.has(d)}
                  className="size-5 shrink-0"
                  data-testid={`${id}-day-${d}`}
                />
                <label htmlFor={`${id}-day-${d}`}>{t(`admin.calendar.isoDay.${d}` as MessageKey)}</label>
              </div>
            ))}
          </div>
          <CDFFieldError id={`${id}-day-1`} />
        </fieldset>
        <CDFField
          id={`${id}-from`}
          label={t("admin.calendar.from")}
          hint={t("admin.calendar.fromHint")}
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
    </section>
  );
}

/**
 * Withdraw a day's entry, today's or a later one: only the entries the database says may be withdrawn now are offered
 * (`may_withdraw`). The entry stays on record with who withdrew it and why; the date may then be added again.
 */
function WithdrawForm({ t, page }: { t: Translator; page: AdminCalendarPage }) {
  const id = "admin-withdraw-form";
  const days = page.days.filter((d) => d.mayWithdraw);
  return (
    <section className="mt-6 border-t border-cdf-border pt-4" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="mb-2 font-semibold">
        {t("admin.calendar.withdrawTitle")}
      </h3>
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.calendar.withdrawIntro")}</p>
      <CDFCommandForm
        action={withdrawCalendarDayAction}
        locale={t.locale}
        submitLabel={t("admin.calendar.withdraw")}
        variant="danger"
        testId={id}
        successMessage={t("admin.calendar.dayWithdrawn")}
        leaveWarning={t("common.leaveWarning")}
        codeSections={ADMIN_CODES}
        fieldLabels={{
          dayId: t("admin.calendar.withdrawDay"),
          reason: t("admin.calendar.withdrawReason"),
        }}
        confirm={confirmation(t, "withdrawBusinessCalendarDay")}
      >
        <CDFField
          id={`${id}-day`}
          label={t("admin.calendar.withdrawDay")}
          requiredLabel={t("common.required")}
        >
          <select id={`${id}-day`} name="dayId" className={inputClass} defaultValue="" required>
            <option value="" disabled>
              {t("common.choose")}
            </option>
            {days.map((d) => (
              <option key={d.dayId} value={d.dayId}>
                {t("admin.calendar.withdrawOption", {
                  date: day(t, d.calendarDate),
                  type: t(`admin.calendar.type.${d.dayType}` as MessageKey),
                })}
              </option>
            ))}
          </select>
        </CDFField>
        <CDFField
          id={`${id}-reason`}
          label={t("admin.calendar.withdrawReason")}
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
