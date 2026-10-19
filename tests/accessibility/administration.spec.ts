// WCAG 2.2 AA on the Administration pages (UX redesign Phase 12 P12-8a; ADR-051's P12-8a amendment) in Arabic and
// English, at a desktop and a phone width and at 320 px: every register Platform Admin Eta keeps, with the list of
// their pages and every disclosure open, and the GRC Director's corrective-action policy; and the business calendar's
// two forms: a day with nothing chosen and a week with no working day, each confirmed and then refused with its error
// summary, and the new week's confirmation, cancelled. Nothing is recorded.
//
// Phase 12 P12-8b (ADR-063): every other form the registers offer, each submitted with nothing chosen (or a required
// value cleared), confirmed, and refused with its error summary, which takes the focus; each confirmation and each
// summary passes axe. A day and a delegation are added first, so the withdrawal and the revocation are offered, and
// are withdrawn and revoked afterwards; the forms record nothing. Each form has a page of its own, so a refused form
// left with its entries never stands in the way of the next page.
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { audit } from "./axe";
import {
  calendarDates,
  calendarDayAdded,
  closeFixtureConnections,
  delegationInForce,
  revokeDelegation,
  withdrawCalendarDay,
} from "../e2e/records-fixture";
import { signIn } from "../e2e/support";

test.afterAll(closeFixtureConnections);

const WIDTHS = [1280, 390, 320] as const;
const ADMIN = "admin@example.test";
const DIRECTOR = "grc.director@example.test";
const REASON = "Synthetic: a reason for the accessibility check.";

/** Each page, and what it shows once its register is read. */
const PAGES = [
  ["/admin/users", "user-register"],
  ["/admin/committees", "admin-committee-IC"],
  ["/admin/sectors", "admin-delegation-limit"],
  ["/admin/notification-rules", "admin-notices"],
  ["/admin/export-policy", "admin-export-rules"],
  ["/admin/calendar", "admin-calendar-week"],
] as const;

/** At each width: the page with its disclosures open passes axe (not at 320) and never scrolls sideways. */
async function check(page: Page, path: string, ready: string, locale: "ar" | "en") {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(path);
    await expect(page.getByTestId(ready).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await page.locator("main details").evaluateAll((all) => {
      for (const d of all) (d as HTMLDetailsElement).open = true;
    });
    if (width !== 320) await audit(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, `horizontal overflow on ${path} at ${width}px`).toBe(false);
  }
}

/** Submits the form and checks its confirmation with axe; then confirms it, or cancels it. */
async function confirmation(page: Page, form: Locator, then: "confirm-submit" | "confirm-cancel") {
  await form.locator('button[type="submit"]').click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await audit(page);
  await dialog.getByTestId(then).click();
  await expect(dialog).toBeHidden();
}

/** A page of its own at a desktop width, open at `path`. */
async function opened(context: BrowserContext, path: string): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(path);
  return page;
}

/** Confirmed, then refused: the error summary takes the focus, and the page with it passes axe. */
async function refused(page: Page, form: Locator) {
  await confirmation(page, form, "confirm-submit");
  await expect(form.getByTestId("error-summary")).toBeFocused();
  await audit(page);
}

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: every Administration register passes axe and reflows`, async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await signIn(browser, ADMIN, locale);
    for (const [path, ready] of PAGES) await check(admin, path, ready, locale);
    await admin.context().close();

    const director = await signIn(browser, DIRECTOR, locale);
    await check(director, "/admin/corrective-action-policy", "admin-evidence-types", locale);
    await director.context().close();
  });

  test(`${locale}: the calendar's forms, refused with their error summaries and with each confirmation, pass axe`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const admin = await signIn(browser, ADMIN, locale);
    await admin.setViewportSize({ width: 1280, height: 900 });
    await admin.goto("/admin/calendar");
    const dayForm = admin.getByTestId("admin-day-form");
    const weekForm = admin.getByTestId("admin-week-form");
    await expect(dayForm).toBeVisible();

    // A day with no date and no kind: confirmed, then refused, and the error summary takes the focus.
    await dayForm.locator("#admin-day-form-reason").fill(REASON);
    await confirmation(admin, dayForm, "confirm-submit");
    await expect(dayForm.getByTestId("error-summary")).toBeFocused();
    await audit(admin);

    // A week with no working day: confirmed, then refused, and the error summary takes the focus.
    for (const d of [1, 2, 3, 4, 5, 6, 7]) await weekForm.getByTestId(`admin-week-form-day-${d}`).check();
    await weekForm.locator("#admin-week-form-from").fill("2099-01-01");
    await weekForm.locator("#admin-week-form-reason").fill(REASON);
    await confirmation(admin, weekForm, "confirm-submit");
    await expect(weekForm.getByTestId("error-summary")).toBeFocused();
    await audit(admin);

    // The new week's confirmation, cancelled: nothing is recorded.
    for (const d of [1, 2, 3, 4, 7]) await weekForm.getByTestId(`admin-week-form-day-${d}`).uncheck();
    await confirmation(admin, weekForm, "confirm-cancel");
    await admin.context().close();
  });

  test(`${locale}: a day's withdrawal, a sector, a delegation's revocation and a notice rule, refused with their error summaries, pass axe`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    // Far enough ahead that the e2e journeys never reach for the same date.
    const { day } = await calendarDates(locale === "ar" ? 180 : 240);
    await calendarDayAdded(day);
    const delegation = await delegationInForce();
    try {
      const context = (await signIn(browser, ADMIN, locale)).context();

      // A withdrawal with no entry chosen.
      let page = await opened(context, "/admin/calendar");
      const withdraw = page.getByTestId("admin-withdraw-form");
      await withdraw.locator("#admin-withdraw-form-reason").fill(REASON);
      await refused(page, withdraw);

      // A sector with no code and no names; a revocation with no delegation chosen.
      page = await opened(context, "/admin/sectors");
      await refused(page, page.getByTestId("admin-sector-form"));
      const revoke = page.getByTestId("admin-revoke-form-OPS");
      await revoke.locator("#admin-revoke-form-OPS-reason").fill(REASON);
      await refused(page, revoke);

      // A notice rule with no notice, channel, setting or date.
      page = await opened(context, "/admin/notification-rules");
      const rule = page.getByTestId("admin-notice-form");
      await rule.locator("#admin-notice-form-reason").fill(REASON);
      await refused(page, rule);
      await context.close();
    } finally {
      await withdrawCalendarDay(day);
      await revokeDelegation(delegation);
    }
  });

  test(`${locale}: an export rule, an export purpose, a corrective-action policy version and a committee's rules, refused with their error summaries, pass axe`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const context = (await signIn(browser, ADMIN, locale)).context();

    // A rule with no code, audience or effect; a purpose with no code or names; a purpose's English name cleared.
    let page = await opened(context, "/admin/export-policy");
    const rule = page.getByTestId("admin-export-rule-form");
    await rule.locator("#admin-export-rule-form-reason").fill(REASON);
    await refused(page, rule);
    const purpose = page.getByTestId("admin-export-purpose-form");
    await purpose.locator("#admin-export-purpose-form-reason").fill(REASON);
    await refused(page, purpose);
    const edit = "admin-export-purpose-form-OTHER";
    await page.getByTestId(`${edit}-details`).locator("summary").click();
    const editForm = page.getByTestId(edit);
    await editForm.locator(`#${edit}-name-en`).fill("");
    await editForm.locator(`#${edit}-reason`).fill(REASON);
    await refused(page, editForm);

    // A version of the committee's rules with no start date.
    page = await opened(context, "/admin/committees");
    const rules = "admin-rules-form-IC";
    await page.getByTestId(`${rules}-details`).locator("summary").click();
    await page.getByTestId(rules).locator(`#${rules}-reason`).fill(REASON);
    await refused(page, page.getByTestId(rules));
    await context.close();

    // A version of a corrective-action policy with no start date: the GRC Director's.
    const director = (await signIn(browser, DIRECTOR, locale)).context();
    page = await opened(director, "/admin/corrective-action-policy");
    const policy = "admin-action-policy-form-CORRECTIVE_ACTION";
    await page.getByTestId(`${policy}-details`).locator("summary").click();
    await page.getByTestId(policy).locator(`#${policy}-reason`).fill(REASON);
    await refused(page, page.getByTestId(policy));
    await director.close();
  });
}
