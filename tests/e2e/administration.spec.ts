// Administration (UX redesign Phase 12 P12-8a; ADR-051's P12-8a amendment), in Arabic (RTL) and English (LTR).
//
// Each business administrator's Administration opens on the first page their permissions open, in the order
// api.my_areas picks the area's default view (2045), and lists only their own pages: GRC Directors Zeta and Mu keep the
// committees and the corrective-action policy, Compliance Section Manager Tau the committees, and Platform Admin Eta
// the users and every other register. Every other page, and the whole area for anyone without an administrator's
// permission, is the same 404 as a page that does not exist; the export policy never opens to an export approver, even
// one who holds EXPORT_POLICY_ADMIN (DEC-F24). No register shows case content.
//
// The calendar administrator adds a holiday and changes the working week from a later date, each after its
// confirmation; a date that already has an entry, and a week that does not start after the last one, are refused in
// the calendar's own words. The new week keeps Friday and Saturday off, so no count of business days changes, and it
// is recorded as provisional, awaiting the CDF source (coordinator ruling F4). The dates are chosen so the journey can
// run again on the same database, and the holiday is withdrawn afterwards. Synthetic data only.
//
// Phase 12 P12-8b (ADR-063): each form is offered where the database says its command would accept the caller now
// (2127's reads), and a refusal is said in the register's own words. The calendar administrator withdraws an entry from
// today on, and an entry withdrawn meanwhile is refused. The sector administrator creates a sector once per code and
// revokes a delegation in force. The notification administrator records a rule from a later date; a mandatory notice is
// never offered, and a start on or before a later rule of the same kind is refused (F8). The export-policy
// administrator adds a rule for a new code only, with an effect that only adds a requirement or a refusal, recorded as
// provisional; adds a purpose (not offered to requesters, so the purposes offered stay the seeded ones) and changes it
// at the version the page read, so a purpose changed meanwhile is refused (F13); no control changes a purpose's source,
// and a legacy purpose has no form (coordinator ruling of 2026-10-18 21:17). The GRC Director records a new version of
// a corrective-action policy from a later date, never looser than the versions in force or scheduled: a note alone is
// not offered while they need an evidence reference. The committee administrator records a new version of a committee's
// rules with only the options changed; no change, and a start on or before a later version, are refused. The options
// that follow a decision (DEC-F03, F04, F14, F15 and F17, and DEC-F01, DEC-F17, Q51, Q98 and AMB-076, confirmed by the
// coordinator's ruling of 23:50) are shown with their decision and have no control, and a form altered to carry one is
// refused with nothing recorded. A safeguard is offered only as it is or stricter (rulings of 23:50 and of 2026-10-19
// 02:10): dissent notes and both guards, on in every version, are shown as kept with no control, and a form altered to
// switch one off is refused with nothing recorded. Codes carry a random suffix and every version starts after the last
// one recorded, so each journey can run again on the same database (it changes only options the page may change either
// way); every version starts at least 60 days ahead, so nothing in force today changes.
//
// Since 2128 (ADR-064; the owner's decision F7 = B): the committee and sector administrator ends a seat and a position
// from a past date. Without its decree or source reference the end is refused in the register's own words, with
// nothing recorded; with it, the end is recorded, the register shows the reference, and the row is no longer offered.
// The seat and the position are the DPO's, each held for three days long ago, so nothing in force changes.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { EXPORT_RULE_ADD_ACTIONS } from "@cdf/contracts";
import {
  DECIDED_RULE_KEYS,
  EDITABLE_RULE_KEYS,
  GRIEVANCE_ONLY_RULE_KEYS,
  type RuleSetRevisionKey,
} from "@cdf/validation";
import {
  actionPolicyFrom,
  calendarDates,
  calendarDayId,
  closeFixtureConnections,
  codeSuffix,
  delegationInForce,
  exportPurposeChanged,
  lapsedPosition,
  lapsedSeat,
  notificationRuleFrom,
  revokeDelegation,
  ruleSetFrom,
  withdrawCalendarDay,
} from "./records-fixture";
import { signIn } from "./support";

/** Days the journey added, withdrawn afterwards; delegations it made, revoked afterwards. */
const added: string[] = [];
const delegations: string[] = [];
test.afterEach(async () => {
  for (const date of added.splice(0)) await withdrawCalendarDay(date);
  for (const id of delegations.splice(0)) await revokeDelegation(id);
});
test.afterAll(closeFixtureConnections);

/** The seed's notices that are not mandatory: the only ones a rule may change. */
const OPTIONAL_NOTICES = [
  "COMMITTEE_SEAT_ASSIGNED",
  "COMMITTEE_SEAT_ENDED",
  "CORRECTIVE_ACTION_CHANGED",
  "CORRECTIVE_ACTION_DUE",
  "CORRECTIVE_ACTION_OVERDUE",
  "CORRECTIVE_ACTION_SUBMITTED",
  "GRIEVANCE_RECEIVED",
  "MEETING_CANCELLED",
];

/** The seed's legacy export purposes: listed on the exports that used them, never changed. */
const LEGACY_PURPOSES = [
  "AUTHORITY_SUBMISSION",
  "REGULATOR_REQUEST",
  "LEGAL_COUNSEL",
  "INTERNAL_REPORTING",
  "AUDIT",
];

/** A date `n` days ahead; from two days on it is after today in Riyadh at any hour. */
const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
/** The calendar date after `date`. */
const dayAfter = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const PAGES = [
  "users",
  "committees",
  "sectors",
  "notification-rules",
  "export-policy",
  "corrective-action-policy",
  "calendar",
] as const;
type AdminPage = (typeof PAGES)[number];

/** Each administrator and the pages their permissions open, in the order the area lists them. */
const ADMINISTRATORS: [string, AdminPage[]][] = [
  [
    "admin@example.test",
    ["users", "committees", "sectors", "notification-rules", "export-policy", "calendar"],
  ],
  // GRC_DIRECTOR holds EXPORT_POLICY_ADMIN beside its export approval: the export policy stays closed (DEC-F24).
  ["grc.director@example.test", ["committees", "corrective-action-policy"]],
  ["grc.deputy@example.test", ["committees", "corrective-action-policy"]],
  ["compliance.mgr@example.test", ["committees"]],
];

const ADMIN = "admin@example.test";
const TEXT = {
  en: {
    title: {
      users: "Users",
      committees: "Committees",
      sectors: "Sectors",
      "notification-rules": "Notification rules",
      "export-policy": "Export policy",
      "corrective-action-policy": "Corrective-action policy",
      calendar: "Business calendar",
    },
    dayAdded: "The day is recorded.",
    dayExists: "This date already has an entry. Each date has one entry.",
    weekChanged: "The new working week is recorded.",
    weekScheduled: "A working week already starts on or after this date.",
    oneWorkingDay: "Leave at least one working day: tick at most six days.",
    startsLater: "Starts later",
    provisional: "Provisional: awaiting the CDF source",
    dayAlreadyWithdrawn: "This entry is already withdrawn.",
    sectorCreated: "The sector is created.",
    sectorTaken: "A sector already has this code. Choose another.",
    revokedOn: "Revoked on",
    ruleRecorded: "The rule is recorded.",
    laterRule: "A rule of this kind already starts on or after this date.",
    ruleAdded: "The rule is added.",
    ruleCodeExists: "A rule with this code is already recorded.",
    purposeAdded: "The purpose is added.",
    purposeTaken: "A purpose with this code is already in the catalogue.",
    purposeSaved: "The purpose is saved.",
    purposeName: "Synthetic e2e purpose",
    purposeRenamed: "Synthetic e2e purpose (renamed)",
    staleVersion: "Someone changed this since you opened the page, so your change was not saved.",
    approved: "Approved",
    inactive: "Inactive",
    versionRecorded: "The new version is recorded.",
    laterPolicy: "A version for this type already starts on or after this date.",
    rulesRevised: "The new version of the rules is recorded.",
    noChange: "Change at least one option: a new version needs a change.",
    rulesScheduled: "A version of these rules already starts on or after this date.",
    decidedOption:
      "An option that follows a decision cannot be changed on this page, so nothing was recorded.",
    safeguard: "it can be kept or made stricter, never loosened",
    kept: "A safeguard, already at its strictest: the new version keeps it.",
    looserOption:
      "A safeguard can be kept or made stricter on this page, never loosened, so nothing was recorded.",
    endReference: "is recorded only with its decree or source reference",
    seatEnded: "The seat is ended.",
    positionEnded: "The position is ended.",
  },
  ar: {
    title: {
      users: "المستخدمون",
      committees: "اللجان",
      sectors: "القطاعات",
      "notification-rules": "قواعد الإشعارات",
      "export-policy": "سياسة التصدير",
      "corrective-action-policy": "سياسة الإجراءات التصحيحية",
      calendar: "تقويم العمل",
    },
    dayAdded: "سُجّل اليوم.",
    dayExists: "لهذا التاريخ قيد من قبل. ولكل تاريخ قيد واحد.",
    weekChanged: "سُجّل أسبوع العمل الجديد.",
    weekScheduled: "يوجد أسبوع عمل يبدأ في هذا التاريخ أو بعده.",
    oneWorkingDay: "اترك يوم عمل واحداً على الأقل: اختر ستة أيام على الأكثر.",
    startsLater: "يبدأ لاحقاً",
    provisional: "مؤقت: بانتظار مصدر الصندوق",
    dayAlreadyWithdrawn: "سُحب هذا القيد من قبل.",
    sectorCreated: "أُنشئ القطاع.",
    sectorTaken: "هذا الرمز لقطاع آخر. اختر رمزاً آخر.",
    revokedOn: "أُلغي في",
    ruleRecorded: "سُجّلت القاعدة.",
    laterRule: "توجد قاعدة من هذا النوع تبدأ في هذا التاريخ أو بعده.",
    ruleAdded: "أُضيفت القاعدة.",
    ruleCodeExists: "توجد قاعدة مسجلة بهذا الرمز.",
    purposeAdded: "أُضيف الغرض.",
    purposeTaken: "يوجد في القائمة غرض بهذا الرمز.",
    purposeSaved: "حُفظ الغرض.",
    purposeName: "غرض اصطناعي للاختبار",
    purposeRenamed: "غرض اصطناعي للاختبار (بعد تغيير الاسم)",
    staleVersion: "غيّر أحدٌ هذا منذ فتحت الصفحة، فلم يُحفظ تغييرك.",
    approved: "معتمد",
    inactive: "غير نشط",
    versionRecorded: "سُجّلت النسخة الجديدة.",
    laterPolicy: "توجد نسخة لهذا النوع تبدأ في هذا التاريخ أو بعده.",
    rulesRevised: "سُجّلت النسخة الجديدة من القواعد.",
    noChange: "غيّر خياراً واحداً على الأقل: تحتاج النسخة الجديدة إلى تغيير.",
    rulesScheduled: "توجد نسخة من هذه القواعد تبدأ في هذا التاريخ أو بعده.",
    decidedOption: "لا يمكن تغيير خيار يتبع قراراً من هذه الصفحة، لذا لم يُسجَّل شيء.",
    safeguard: "يمكن في هذه الصفحة إبقاؤها أو تشديدها، دون تخفيفها",
    kept: "ضمانة في أشد حالاتها: تحتفظ بها النسخة الجديدة.",
    looserOption: "يمكن في هذه الصفحة إبقاء الضمانة أو تشديدها، دون تخفيفها، لذا لم يُسجَّل شيء.",
    endReference: "إلا مع مرجع القرار أو المصدر",
    seatEnded: "أُنهي المقعد.",
    positionEnded: "أُنهي المنصب.",
  },
} as const;

/** What each page shows once its register is read. */
const READY: Record<AdminPage, string> = {
  users: "user-register",
  committees: "admin-committee-IC",
  sectors: "admin-delegation-limit",
  "notification-rules": "admin-notices",
  "export-policy": "admin-export-rules",
  "corrective-action-policy": "admin-evidence-types",
  calendar: "admin-calendar-week",
};

/** The page title's own part, before the app's name (WCAG 2.4.2). */
const titled = (text: string) => new RegExp(`^${text} · `);

async function expectNoOverflow(page: Page, what: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow, `horizontal overflow on ${what}`).toBe(false);
}

/** Submits a command form and accepts its confirmation (UX-031). */
async function submitConfirmed(page: Page, form: Locator) {
  await form.locator('button[type="submit"]').click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("confirm-submit").click();
  await expect(dialog).toBeHidden();
}

test("each administrator's Administration opens on their first page and lists only their own pages; every other page is the uniform 404", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  for (const [email, views] of ADMINISTRATORS) {
    const page = await signIn(browser, email);
    await page.goto("/");
    const nav = page.getByTestId("nav-admin");
    await expect(nav, email).toHaveAttribute("href", `/admin/${views[0]}`);
    await nav.click();
    await page.waitForURL(new RegExp(`/admin/${views[0]}$`));
    await expect(page.getByTestId("nav-admin")).toHaveAttribute("aria-current", "page");

    // The pages listed are the caller's own, the current one marked; a single page needs no list.
    const tabs = page.getByTestId("admin-views");
    if (views.length > 1) {
      const listed = await tabs
        .getByRole("link")
        .evaluateAll((links) =>
          links.map((l) => (l.getAttribute("data-testid") ?? "").replace(/^admin-view-/, "")),
        );
      expect(listed, email).toEqual(views);
      await expect(page.getByTestId(`admin-view-${views[0]}`)).toHaveAttribute("aria-current", "page");
    } else await expect(tabs, email).toHaveCount(0);

    // The area's own address opens the same first page.
    await page.goto("/admin");
    await page.waitForURL(new RegExp(`/admin/${views[0]}$`));

    for (const view of PAGES) {
      const status = (await page.request.get(`/admin/${view}`)).status();
      expect(status, `${email} /admin/${view}`).toBe(views.includes(view) ? 200 : 404);
    }
    expect((await page.request.get("/admin/nothing-here")).status(), email).toBe(404);

    // Each page the caller opens says it holds no case content, and holds none.
    for (const view of views) {
      await page.goto(`/admin/${view}`);
      await expect(page.getByTestId(READY[view]).first(), `${email} ${view}`).toBeVisible();
      await expect(page.getByTestId("no-case-content")).toBeVisible();
      await expect(page.getByText("CDF-DEMO-")).toHaveCount(0);
    }
    await page.context().close();
  }

  // Without an administrator's permission the area does not exist: no link, and every page is the same 404.
  const investigator = await signIn(browser, "investigator.a@example.test");
  await investigator.goto("/");
  await expect(investigator.getByTestId("nav-admin")).toHaveCount(0);
  for (const path of ["/admin", ...PAGES.map((v) => `/admin/${v}`)])
    expect((await investigator.request.get(path)).status(), path).toBe(404);
  await investigator.context().close();
});

for (const locale of ["ar", "en"] as const) {
  const text = TEXT[locale];
  // Arabic at a phone width, English at a desktop one; the accessibility spec reflows every page at 320 px too.
  const width = locale === "ar" ? 390 : 1280;

  test(`${locale}: Platform Admin Eta reads each register in the reader's language, without scrolling sideways`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const admin = await signIn(browser, ADMIN, locale);
    await admin.setViewportSize({ width, height: 900 });
    for (const view of ADMINISTRATORS[0]![1]) {
      await admin.goto(`/admin/${view}`);
      await expect(admin.getByTestId(READY[view]).first()).toBeVisible();
      await expect(admin).toHaveTitle(titled(text.title[view]));
      await expect(admin.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      await expect(admin.getByTestId(`admin-view-${view}`)).toHaveAttribute("aria-current", "page");
      await expectNoOverflow(admin, `/admin/${view} at ${width}px`);
    }
    await admin.context().close();

    // The corrective-action policy is the GRC Director's.
    const director = await signIn(browser, "grc.director@example.test", locale);
    await director.setViewportSize({ width, height: 900 });
    await director.goto("/admin/corrective-action-policy");
    await expect(director.getByTestId(READY["corrective-action-policy"])).toBeVisible();
    await expect(director).toHaveTitle(titled(text.title["corrective-action-policy"]));
    await expectNoOverflow(director, `/admin/corrective-action-policy at ${width}px`);
    await director.context().close();
  });

  test(`${locale}: the calendar administrator adds a holiday and changes the working week; a date already taken and a week that does not start after the last one are refused`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    // Arabic from 60 days ahead, English from 120, so the two never reach for the same date.
    const dates = await calendarDates(locale === "ar" ? 60 : 120);
    const admin = await signIn(browser, ADMIN, locale);
    await admin.setViewportSize({ width, height: 900 });
    await admin.goto("/admin/calendar");
    await expect(admin.getByTestId("admin-calendar-source-value")).toBeVisible();

    // A holiday, after its confirmation.
    const dayForm = admin.getByTestId("admin-day-form");
    const fillDay = async () => {
      await dayForm.locator("#admin-day-form-date").fill(dates.day);
      await dayForm.locator("#admin-day-form-type").selectOption("HOLIDAY");
      await dayForm.locator("#admin-day-form-reference").fill("CIRC-DEMO-2026-0001");
      await dayForm
        .locator("#admin-day-form-reason")
        .fill("Synthetic: a demo public holiday for the e2e journey.");
    };
    await fillDay();
    await submitConfirmed(admin, dayForm);
    added.push(dates.day);
    await expect(dayForm.getByRole("status")).toContainText(text.dayAdded);
    const day = admin.getByTestId("admin-day-list").getByTestId(`admin-day-${dates.day}`);
    await expect(day).toHaveAttribute("data-type", "HOLIDAY");

    // The same date again: refused in the calendar's own words, and nothing more is recorded.
    await fillDay();
    await submitConfirmed(admin, dayForm);
    await expect(dayForm.getByTestId("action-error")).toContainText(text.dayExists);
    const live = admin.getByTestId("admin-day-list").getByTestId(`admin-day-${dates.day}`);
    await expect(live).toHaveCount(1);

    // P12-8b: an entry from today on is offered for withdrawal. Withdrawn elsewhere while the page is open, it is
    // refused in the calendar's own words. (An earlier run on the same database may have withdrawn this date too.)
    const withdrawn = admin.getByTestId("admin-day-withdrawn").getByTestId(`admin-day-${dates.day}`);
    const withdrawnBefore = await withdrawn.count();
    const withdrawForm = admin.getByTestId("admin-withdraw-form");
    const withdrawDay = async (id: string, reason: string) => {
      await withdrawForm.locator("#admin-withdraw-form-day").selectOption(id);
      await withdrawForm.locator("#admin-withdraw-form-reason").fill(reason);
    };
    await withdrawDay(
      (await calendarDayId(dates.day))!,
      "Synthetic: withdrawn while it was withdrawn elsewhere.",
    );
    const alone =
      (await withdrawForm.locator('#admin-withdraw-form-day option:not([value=""])').count()) === 1;
    await withdrawCalendarDay(dates.day);
    await submitConfirmed(admin, withdrawForm);
    if (alone) {
      // On a fresh database it was the only entry on offer: the page read again offers none, so the form leaves with
      // its refusal, and the top of the page says why nothing was recorded (CDF-232), taking the focus.
      const notice = admin.getByTestId("refusal-notice");
      await expect(notice).toHaveAttribute("data-kind", "CONFLICT");
      await expect(notice).toContainText(text.dayAlreadyWithdrawn);
      await expect(notice).toBeFocused();
      await expect(withdrawForm).toHaveCount(0);
    } else {
      // Another entry (an earlier run's) is still on offer: the form stays and says so itself.
      await expect(withdrawForm.getByTestId("action-error")).toContainText(text.dayAlreadyWithdrawn);
      await expect(admin.getByTestId("refusal-notice")).toHaveCount(0);
    }

    // The date is free again: added once more, then withdrawn from the page after its confirmation. It leaves the
    // days in force and stays on record among the withdrawn entries.
    await fillDay();
    await submitConfirmed(admin, dayForm);
    await expect(dayForm.getByRole("status")).toContainText(text.dayAdded);
    const again = (await calendarDayId(dates.day))!;
    await withdrawDay(again, "Synthetic: the demo holiday is withdrawn from the page.");
    await submitConfirmed(admin, withdrawForm);
    await expect(live).toHaveCount(0);
    await expect(admin.locator(`#admin-withdraw-form-day option[value="${again}"]`)).toHaveCount(0);
    await expect(withdrawn).toHaveCount(withdrawnBefore + 2);

    // A new week from a later date: the days off start as the last version's, Friday and Saturday.
    const weekForm = admin.getByTestId("admin-week-form");
    for (const d of [1, 2, 3, 4, 5, 6, 7])
      if (d >= 5 && d <= 6) await expect(weekForm.getByTestId(`admin-week-form-day-${d}`)).toBeChecked();
      else await expect(weekForm.getByTestId(`admin-week-form-day-${d}`)).not.toBeChecked();
    const scheduled = admin.locator('[data-testid^="admin-week-"][data-state="SCHEDULED"]');
    const before = await scheduled.count();
    const fillWeek = async () => {
      await weekForm.locator("#admin-week-form-from").fill(dates.weekFrom);
      await weekForm
        .locator("#admin-week-form-reason")
        .fill("Synthetic: the same days off, recorded by the e2e journey.");
    };
    await fillWeek();

    // Every day off leaves no working day: refused before anything is recorded, and the entries are kept.
    const others = [1, 2, 3, 4, 7].map((d) => weekForm.getByTestId(`admin-week-form-day-${d}`));
    for (const box of others) await box.check();
    await submitConfirmed(admin, weekForm);
    await expect(weekForm.getByTestId("error-summary")).toContainText(text.oneWorkingDay);
    await expect(scheduled).toHaveCount(before);

    // Friday and Saturday off again, from the later date.
    for (const box of others) await box.uncheck();
    await submitConfirmed(admin, weekForm);
    await expect(weekForm.getByRole("status")).toContainText(text.weekChanged);
    await expect(scheduled).toHaveCount(before + 1);
    // The latest version comes first: it starts later and is provisional, awaiting the CDF source.
    const latest = admin.getByTestId("admin-week-list").locator("tbody tr").first();
    await expect(latest).toContainText(text.startsLater);
    await expect(latest).toContainText(text.provisional);

    // A week from that same date again: refused, and nothing more is recorded.
    await fillWeek();
    await submitConfirmed(admin, weekForm);
    await expect(weekForm.getByTestId("action-error")).toContainText(text.weekScheduled);
    await expect(scheduled).toHaveCount(before + 1);
    await expectNoOverflow(admin, `/admin/calendar at ${width}px`);
    await admin.context().close();
  });

  // Arabic from 60 days ahead, English from 120, as the calendar's journey.
  const ahead = locale === "ar" ? 60 : 120;

  test(`${locale}: the sector administrator creates a sector once per code and revokes a delegation in force`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const delegation = await delegationInForce();
    delegations.push(delegation);
    const code = `E2E${codeSuffix()}`;
    const admin = await signIn(browser, ADMIN, locale);
    await admin.setViewportSize({ width, height: 900 });
    await admin.goto("/admin/sectors");

    // A sector, after its confirmation: active, with no one appointed yet.
    const form = admin.getByTestId("admin-sector-form");
    const fill = async (nameEn: string) => {
      await form.locator("#admin-sector-form-code").fill(code);
      await form.locator("#admin-sector-form-name-en").fill(nameEn);
      await form.locator("#admin-sector-form-name-ar").fill("قطاع اصطناعي للاختبار");
    };
    await fill("Synthetic e2e sector");
    await submitConfirmed(admin, form);
    await expect(form.getByRole("status")).toContainText(text.sectorCreated);
    await expect(admin.getByTestId(`admin-sector-${code}`)).toBeVisible();

    // The same code again: refused, and there is still one sector with it.
    await fill("Another synthetic sector");
    await submitConfirmed(admin, form);
    await expect(form.getByTestId("action-error")).toContainText(text.sectorTaken);
    await expect(admin.getByTestId(`admin-sector-${code}`)).toHaveCount(1);

    // The delegation in force in OPS, revoked with a reason: it is no longer offered, and stays on record as revoked.
    const list = admin.getByTestId("admin-sector-OPS-delegation-list").locator("tbody tr");
    const revoked = list.filter({ hasText: text.revokedOn });
    const before = await revoked.count();
    const revoke = admin.getByTestId("admin-revoke-form-OPS");
    await revoke.locator("#admin-revoke-form-OPS-delegation").selectOption(delegation);
    await revoke
      .locator("#admin-revoke-form-OPS-reason")
      .fill("Synthetic: the delegation is no longer needed.");
    await submitConfirmed(admin, revoke);
    await expect(revoked).toHaveCount(before + 1);
    await expect(
      admin.locator(`#admin-revoke-form-OPS-delegation option[value="${delegation}"]`),
    ).toHaveCount(0);
    await expectNoOverflow(admin, `/admin/sectors at ${width}px`);
    await admin.context().close();
  });

  test(`${locale}: the notification administrator records a rule from a later date; a mandatory notice is never offered, and a start before a later rule is refused`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    // Not the cancelled-meeting notice by email, which the notification specs read.
    const notice = locale === "ar" ? "CORRECTIVE_ACTION_SUBMITTED" : "GRIEVANCE_RECEIVED";
    const from = await notificationRuleFrom(notice, "EMAIL", ahead);
    const admin = await signIn(browser, ADMIN, locale);
    await admin.setViewportSize({ width, height: 900 });
    await admin.goto("/admin/notification-rules");
    const form = admin.getByTestId("admin-notice-form");

    // Only a notice that is not mandatory is offered: a mandatory one is always sent, and no rule changes it.
    const offered = await form
      .locator("#admin-notice-form-template option")
      .evaluateAll((all) => all.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
    expect(offered.sort()).toEqual(OPTIONAL_NOTICES);

    const later = admin.getByTestId("admin-notice-changes").locator("tbody tr");
    const before = await later.count();
    const fill = async () => {
      await form.getByTestId("admin-notice-form-layer-EVENT_RULE").check();
      await form.locator("#admin-notice-form-template").selectOption(notice);
      await form.getByTestId("admin-notice-form-channel-EMAIL").check();
      await form.getByTestId("admin-notice-form-enabled-on").check();
      await form.locator("#admin-notice-form-from").fill(from);
      await form
        .locator("#admin-notice-form-reason")
        .fill("Synthetic: the notice is sent by email from a later date.");
    };
    await fill();
    await submitConfirmed(admin, form);
    await expect(form.getByRole("status")).toContainText(text.ruleRecorded);
    await expect(later).toHaveCount(before + 1);

    // The same notice and channel from the same date: a rule of that kind starts then, so it is refused (F8), and
    // nothing more is recorded.
    await fill();
    await submitConfirmed(admin, form);
    await expect(form.getByTestId("action-error")).toContainText(text.laterRule);
    await expect(later).toHaveCount(before + 1);
    await expectNoOverflow(admin, `/admin/notification-rules at ${width}px`);
    await admin.context().close();
  });

  test(`${locale}: the export-policy administrator adds a rule for a new code and a purpose, and changes the purpose at the version read`, async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const suffix = codeSuffix();
    const ruleCode = `E2E_RULE_${suffix}`;
    const purposeCode = `E2E_PURPOSE_${suffix}`;
    const admin = await signIn(browser, ADMIN, locale);
    await admin.setViewportSize({ width, height: 900 });
    await admin.goto("/admin/export-policy");

    // A rule for a new code. Only the effects that add a requirement or a refusal are offered, never "No effect".
    const ruleForm = admin.getByTestId("admin-export-rule-form");
    const effects = await ruleForm
      .locator('input[name="action"]')
      .evaluateAll((all) => all.map((i) => (i as HTMLInputElement).value));
    expect(effects).toEqual([...EXPORT_RULE_ADD_ACTIONS]);
    const fillRule = async () => {
      await ruleForm.locator("#admin-export-rule-form-code").fill(ruleCode);
      await ruleForm.getByTestId("admin-export-rule-form-audience-EXTERNAL").check();
      await ruleForm.locator("#admin-export-rule-form-classification").selectOption("CONFIDENTIAL");
      await ruleForm.getByTestId("admin-export-rule-form-action-REQUIRE_SECOND_APPROVAL").check();
      await ruleForm.locator("#admin-export-rule-form-from").fill(daysAhead(ahead));
      await ruleForm
        .locator("#admin-export-rule-form-reason")
        .fill("Synthetic: a second approval for confidential cases from a later date.");
    };
    await fillRule();
    await submitConfirmed(admin, ruleForm);
    await expect(ruleForm.getByRole("status")).toContainText(text.ruleAdded);
    // It starts later and is provisional, awaiting the CDF source.
    const ruleRow = admin
      .getByTestId("admin-export-rule-list")
      .locator("tbody tr", { has: admin.getByTestId(`admin-export-rule-${ruleCode}`) });
    await expect(ruleRow).toContainText(text.startsLater);
    await expect(ruleRow).toContainText(text.provisional);
    // The same code again: a new version of a rule is not offered here, so it is refused, and nothing more is recorded.
    await fillRule();
    await submitConfirmed(admin, ruleForm);
    await expect(ruleForm.getByTestId("action-error")).toContainText(text.ruleCodeExists);
    await expect(admin.getByTestId(`admin-export-rule-${ruleCode}`)).toHaveCount(1);

    // A purpose saved here is the administrator's own entry in the catalogue (DEC-F21), and the page says so. No
    // control changes a purpose's source, and a legacy purpose is listed with no form.
    await expect(admin.getByTestId("admin-export-purpose-own-entry")).toBeVisible();
    await expect(admin.locator('[name="sourceStatus"], [name="isLegacy"]')).toHaveCount(0);
    for (const legacy of LEGACY_PURPOSES) {
      await expect(admin.getByTestId(`admin-export-purpose-${legacy}`)).toBeVisible();
      await expect(admin.getByTestId(`admin-export-purpose-form-${legacy}-details`)).toHaveCount(0);
    }

    // A purpose for a new code, not offered to requesters: recorded as approved, and inactive.
    const addForm = admin.getByTestId("admin-export-purpose-form");
    const fillPurpose = async () => {
      await addForm.locator("#admin-export-purpose-form-code").fill(purposeCode);
      await addForm.locator("#admin-export-purpose-form-name-en").fill(TEXT.en.purposeName);
      await addForm.locator("#admin-export-purpose-form-name-ar").fill(TEXT.ar.purposeName);
      await addForm.getByTestId("admin-export-purpose-form-active").uncheck();
      await addForm
        .locator("#admin-export-purpose-form-reason")
        .fill("Synthetic: a purpose for the e2e journey.");
    };
    await fillPurpose();
    await submitConfirmed(admin, addForm);
    await expect(addForm.getByRole("status")).toContainText(text.purposeAdded);
    const purposeRow = admin
      .getByTestId("admin-export-purpose-list")
      .locator("tbody tr", { has: admin.getByTestId(`admin-export-purpose-${purposeCode}`) });
    await expect(purposeRow).toContainText(text.purposeName);
    await expect(purposeRow).toContainText(text.inactive);
    await expect(purposeRow).toContainText(text.approved);
    // The same code again: refused, with where to change it instead.
    await fillPurpose();
    await submitConfirmed(admin, addForm);
    await expect(addForm.getByTestId("action-error")).toContainText(text.purposeTaken);

    // Changed from its own entry, at the version this page read.
    const edit = `admin-export-purpose-form-${purposeCode}`;
    await admin.getByTestId(`${edit}-details`).locator("summary").click();
    const editForm = admin.getByTestId(edit);
    await editForm.locator(`#${edit}-name-en`).fill(TEXT.en.purposeRenamed);
    await editForm.locator(`#${edit}-name-ar`).fill(TEXT.ar.purposeRenamed);
    await editForm.locator(`#${edit}-reason`).fill("Synthetic: the purpose is renamed.");
    await submitConfirmed(admin, editForm);
    await expect(editForm.getByRole("status")).toContainText(text.purposeSaved);
    await expect(purposeRow).toContainText(text.purposeRenamed);

    // Changed elsewhere while the page is open: the version this page read is no longer the purpose's, so the change
    // is refused (F13), and the purpose keeps what the other administrator saved.
    await editForm.locator(`#${edit}-sort`).fill("880");
    await editForm
      .locator(`#${edit}-reason`)
      .fill("Synthetic: a change made on a page read before another change.");
    await exportPurposeChanged(purposeCode, 2);
    await submitConfirmed(admin, editForm);
    await expect(editForm.getByTestId("action-error")).toContainText(text.staleVersion);
    await expectNoOverflow(admin, `/admin/export-policy at ${width}px`);
    await admin.context().close();
  });

  test(`${locale}: the GRC Director records a new version of a corrective-action policy from a later date, never looser; a start before a later version is refused`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const type = "CORRECTIVE_ACTION";
    const from = await actionPolicyFrom(type, ahead);
    const director = await signIn(browser, "grc.director@example.test", locale);
    await director.setViewportSize({ width, height: 900 });
    await director.goto("/admin/corrective-action-policy");
    const id = `admin-action-policy-form-${type}`;
    await director.getByTestId(`${id}-details`).locator("summary").click();
    const form = director.getByTestId(id);

    // Never looser: the versions in force or scheduled need an evidence reference, so a note alone is not offered.
    await expect(form.getByTestId(`${id}-completion-REFERENCE_REQUIRED`)).toBeChecked();
    await expect(form.getByTestId(`${id}-completion-NOTE_ONLY`)).toHaveCount(0);

    // The versions that start later, provisional, awaiting the CDF source.
    const later = director
      .locator(`section[data-testid^="admin-action-policy-${type}-"]`)
      .filter({ hasText: text.provisional });
    const before = await later.count();
    const fill = async () => {
      await form.locator(`#${id}-defaultDueDays`).fill("45");
      await form.locator(`#${id}-from`).fill(from);
      await form.locator(`#${id}-reason`).fill("Synthetic: a longer default time from a later date.");
    };
    await fill();
    await submitConfirmed(director, form);
    await expect(form.getByRole("status")).toContainText(text.versionRecorded);
    await expect(later).toHaveCount(before + 1);
    await expect(later.filter({ hasText: text.startsLater })).toHaveCount(before + 1);

    // From the same date again: a version of the type starts then, so it is refused, and nothing more is recorded.
    await fill();
    await submitConfirmed(director, form);
    await expect(form.getByTestId("action-error")).toContainText(text.laterPolicy);
    await expect(later).toHaveCount(before + 1);
    await expectNoOverflow(director, `/admin/corrective-action-policy at ${width}px`);
    await director.context().close();
  });

  test(`${locale}: the committee administrator records a new version of a committee's rules with only the options changed; the options that follow a decision are shown, never offered; a safeguard is offered only as it is or stricter; no change, a start before a later version, and an altered form are refused`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    // Arabic revises the grievance committee, with its own options; English the investigation committee.
    const code = locale === "ar" ? "GC" : "IC";
    const applies = (k: RuleSetRevisionKey) => code === "GC" || !GRIEVANCE_ONLY_RULE_KEYS.includes(k);
    const from = await ruleSetFrom(code, ahead);
    const admin = await signIn(browser, ADMIN, locale);
    await admin.setViewportSize({ width, height: 900 });
    await admin.goto("/admin/committees");
    const id = `admin-rules-form-${code}`;
    await admin.getByTestId(`${id}-details`).locator("summary").click();
    const form = admin.getByTestId(id);
    const later = admin
      .locator(`[data-testid^="admin-committee-${code}-rules-"][data-state="SCHEDULED"]`)
      .filter({ hasText: text.provisional });
    const before = await later.count();
    const when = async (date = from) => {
      await form.locator(`#${id}-from`).fill(date);
      await form.locator(`#${id}-reason`).fill("Synthetic: a new version of the rules from a later date.");
    };
    /** A number field moved to the next value in its range, so it differs from the version it starts from. */
    const bump = async (field: string, max: number) => {
      const input = form.locator(`#${id}-${field}`);
      await input.fill(String((Number(await input.inputValue()) % max) + 1));
    };
    /** A yes-or-no option set to the answer the version shown does not have, so it is sent as a change. */
    const change = async (field: string) => {
      const yes = form.getByTestId(`${id}-${field}-on`);
      const shown = await yes.evaluate((e) => (e as HTMLInputElement).defaultChecked);
      await (shown ? form.getByTestId(`${id}-${field}-off`) : yes).check();
    };
    /** The form altered in the browser: a field it does not offer, sent as a change (any earlier one removed). */
    const alter = (name: string, value: string) =>
      form.evaluate(
        (el, [n, v]) => {
          el.querySelector("[data-altered]")?.remove();
          const input = document.createElement("input");
          input.type = "text";
          input.hidden = true;
          input.name = n!;
          input.setAttribute("data-altered", "");
          el.appendChild(input);
          // Typed once it is in the form, so it differs from the field's default and is not left out as unchanged.
          input.value = v!;
        },
        [name, value],
      );

    // Coordinator ruling of 2026-10-18 23:20: each option that follows a decision is shown with the decision it
    // follows and has no control.
    const decided = form.getByTestId(`${id}-decided`);
    for (const [key, { ref }] of Object.entries(DECIDED_RULE_KEYS)) {
      await expect(form.locator(`[name="${key}"]`), key).toHaveCount(0);
      if (key === "quorumValue" || !applies(key as RuleSetRevisionKey)) continue;
      await expect(decided.getByTestId(`${id}-decided-${key}`), key).toContainText(ref);
    }
    // Rulings of 23:50 and of 2026-10-19 02:10: a safeguard is offered only as it is or stricter. Dissent notes and
    // both guards are on in every version, their strictest, so each is shown as kept and has no control; the ballot and
    // the minimum notice say next to them that they can only be kept or made stricter, and the notice is never offered
    // below the version it starts from.
    const KEPT = ["dissentNoteAllowed", "minutesObjectionBlocksDeemed", "sanctionRequiresDefenceNotice"];
    for (const key of KEPT) {
      await expect(form.getByTestId(`${id}-kept-${key}`), key).toContainText(text.kept);
      await expect(form.locator(`[name="${key}"]`), key).toHaveCount(0);
    }
    for (const key of ["ballotSecrecy", "minimumNoticeDays"])
      await expect(form.locator(`#${id}-${key}-hint`), key).toContainText(text.safeguard);
    const notice = form.locator(`#${id}-minimumNoticeDays`);
    const noticeShown = await notice.inputValue();
    await expect(notice).toHaveAttribute("min", noticeShown === "" ? "0" : noticeShown);
    // The form's controls are exactly the options the page may change, less the safeguards it can only keep.
    const named = await form
      .locator("input[name], select[name], textarea[name]")
      .evaluateAll((all) => [...new Set(all.map((e) => (e as HTMLInputElement).name))]);
    expect(
      named
        .filter(
          (n) =>
            !n.startsWith("$") && !["committeeId", "committeeKind", "effectiveFrom", "reason"].includes(n),
        )
        .sort(),
    ).toEqual(
      EDITABLE_RULE_KEYS.filter(applies)
        .filter((k) => !KEPT.includes(k))
        .sort(),
    );

    // Nothing changed: a new version needs a change, so it is refused, and nothing is recorded.
    await when();
    await submitConfirmed(admin, form);
    await expect(form.getByTestId("action-error")).toContainText(text.noChange);
    await expect(later).toHaveCount(before);

    // Vote revision changed (freely, either way), and for the grievance committee the time to complete a grievance.
    await change("voteRevisionAllowed");
    if (code === "GC") await bump("grievanceCompletionDays", 90);
    await when();
    await submitConfirmed(admin, form);
    await expect(form.getByRole("status")).toContainText(text.rulesRevised);
    await expect(later).toHaveCount(before + 1);

    // Another change from the same date: a version starts then, so it is refused, and nothing more is recorded.
    await change("voteRevisionAllowed");
    await when();
    await submitConfirmed(admin, form);
    await expect(form.getByTestId("action-error")).toContainText(text.rulesScheduled);
    await expect(later).toHaveCount(before + 1);

    // The form altered to switch a guard off, beside a change it may make, from a date the command would take:
    // refused before the command is asked (ruling of 23:50), and nothing more is recorded.
    await alter(code === "GC" ? "minutesObjectionBlocksDeemed" : "sanctionRequiresDefenceNotice", "off");
    await change("voteRevisionAllowed");
    await when(dayAfter(from));
    await submitConfirmed(admin, form);
    await expect(form.getByTestId("action-error")).toContainText(text.looserOption);
    await expect(later).toHaveCount(before + 1);

    // Altered to withdraw dissent notes (ruling of 2026-10-19 02:10): refused the same way, and nothing more is
    // recorded.
    await alter("dissentNoteAllowed", "off");
    await change("voteRevisionAllowed");
    await when(dayAfter(from));
    await submitConfirmed(admin, form);
    await expect(form.getByTestId("action-error")).toContainText(text.looserOption);
    await expect(later).toHaveCount(before + 1);

    // The form altered to carry a decided option, with a change it may make: refused before the command is asked,
    // whatever the date, and nothing more is recorded.
    const [key, value] = code === "GC" ? ["nonAdmissionDecider", "CHAIR"] : ["conflictDecider", "SECRETARY"];
    await alter(key, value);
    await change("voteRevisionAllowed");
    await when();
    await submitConfirmed(admin, form);
    await expect(form.getByTestId("action-error")).toContainText(text.decidedOption);
    await expect(later).toHaveCount(before + 1);
    await expectNoOverflow(admin, `/admin/committees at ${width}px`);
    await admin.context().close();
  });

  test(`${locale}: the committee and sector administrator ends a seat and a position from a past date only with its decree or source reference`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const [seat, position] = [await lapsedSeat(), await lapsedPosition()];
    const reference = `DEMO-DECREE-E2E-${codeSuffix()}`;
    const admin = await signIn(browser, ADMIN, locale);
    await admin.setViewportSize({ width, height: 900 });
    /** Ends the row from the date given, with the reference if one is given, after the confirmation. */
    const end = async (id: string, membershipId: string, date: string, withReference: boolean) => {
      const form = admin.getByTestId(id);
      await form.locator(`#${id}-row`).selectOption(membershipId);
      await form.locator(`#${id}-to`).fill(date);
      await form.locator(`#${id}-reference`).fill(withReference ? reference : "");
      await form.locator(`#${id}-reason`).fill("Synthetic: it ended earlier, by decree.");
      await submitConfirmed(admin, form);
      return form;
    };

    for (const [path, id, list, row, ended] of [
      ["/admin/committees", "admin-end-seat-form-GC", "admin-committee-GC-seat-list", seat, text.seatEnded],
      [
        "/admin/sectors",
        "admin-end-position-form-OPS",
        "admin-sector-OPS-position-list",
        position,
        text.positionEnded,
      ],
    ] as const) {
      await admin.goto(path);
      const recorded = admin.getByTestId(list).locator("tbody tr").filter({ hasText: reference });
      // From its second day, before now, with no reference: refused in the register's own words, nothing recorded.
      let form = await end(id, row.membershipId, row.endDate, false);
      await expect(form.getByTestId("action-error")).toContainText(text.endReference);
      await expect(recorded).toHaveCount(0);
      // With its reference: recorded and shown on the register, and the row is no longer offered.
      form = await end(id, row.membershipId, row.endDate, true);
      await expect(form.getByRole("status")).toContainText(ended);
      await expect(recorded).toHaveCount(1);
      await expect(admin.locator(`#${id}-row option[value="${row.membershipId}"]`)).toHaveCount(0);
      await expectNoOverflow(admin, `${path} at ${width}px`);
    }
    await admin.context().close();
  });
}
