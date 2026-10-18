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
import { expect, test, type Locator, type Page } from "@playwright/test";
import { calendarDates, closeFixtureConnections, withdrawCalendarDay } from "./records-fixture";
import { signIn } from "./support";

/** Days the journey added, withdrawn afterwards. */
const added: string[] = [];
test.afterEach(async () => {
  for (const date of added.splice(0)) await withdrawCalendarDay(date);
});
test.afterAll(closeFixtureConnections);

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
    await expect(admin.getByTestId(`admin-day-${dates.day}`)).toHaveCount(1);

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
}
