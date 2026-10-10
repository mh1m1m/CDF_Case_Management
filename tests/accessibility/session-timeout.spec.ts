// CDF-57: before the 30-minute idle limit signs a user out, a dialog warns them and lets them stay signed in
// (WCAG 2.2.1 Timing Adjustable). The browser clock is fast-forwarded; the server session stays real.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { signIn } from "../e2e/support";

const text = {
  en: { warning: "Are you still there?", ended: "You have been signed out", stay: "Stay signed in" },
  ar: { warning: "هل ما زلت هنا؟", ended: "تم تسجيل خروجك", stay: "البقاء متصلاً" },
} as const;

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: idle warning offers to stay signed in, then explains the sign-out`, async ({
    browser,
  }) => {
    const page = await signIn(browser, "casemanager@example.test", locale);
    await page.clock.install();
    await page.goto("/cases");
    const dialog = page.getByTestId("session-dialog");
    await expect(dialog).toBeHidden();

    // Two minutes before the idle limit the warning opens as a modal dialog with focus on "Stay signed in".
    await page.clock.fastForward("28:01");
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("dialog", { name: text[locale].warning })).toBeVisible();
    await expect(page.getByTestId("session-stay")).toBeFocused();
    const axe = await new AxeBuilder({ page }).include('[data-testid="session-dialog"]').analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);

    // Staying signed in reaches the server, closes the dialog and restarts the idle timer.
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await page.clock.fastForward("27:00");
    await expect(dialog).toBeHidden();
    await page.clock.fastForward("01:05");
    await expect(page.getByRole("dialog", { name: text[locale].warning })).toBeVisible();

    // Without a response the session ends: the page stays in place and the dialog links to sign-in.
    await page.clock.fastForward("02:00");
    await expect(page.getByRole("dialog", { name: text[locale].ended })).toBeVisible();
    await expect(page.getByTestId("session-sign-in")).toHaveAttribute("href", "/login");
    await expect(page.getByTestId("signed-in-as")).toBeAttached();
    await page.context().close();
  });
}
