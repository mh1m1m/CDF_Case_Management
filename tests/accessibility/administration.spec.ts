// WCAG 2.2 AA on the Administration pages (UX redesign Phase 12 P12-8a; ADR-051's P12-8a amendment) in Arabic and
// English, at a desktop and a phone width and at 320 px: every register Platform Admin Eta keeps, with the list of
// their pages and every disclosure open, and the GRC Director's corrective-action policy; and the business calendar's
// two forms: a day with nothing chosen and a week with no working day, each confirmed and then refused with its error
// summary, and the new week's confirmation, cancelled. Nothing is recorded.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { audit } from "./axe";
import { signIn } from "../e2e/support";

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
}
