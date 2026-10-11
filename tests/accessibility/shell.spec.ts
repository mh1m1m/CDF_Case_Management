// WCAG 2.2 AA on the S1 shell (CDF-117, CDF-121, CDF-171, CDF-172) in Arabic and English, on a desktop and a phone
// width: the sidebar, the account menu, My Work, My access, Oversight and the user register.
import { expect, test } from "@playwright/test";
import { audit } from "./axe";
import { signIn } from "../e2e/support";

const WIDTHS = [1280, 390] as const;

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: shell, My Work and My access`, async ({ browser }) => {
    const page = await signIn(browser, "triage@example.test", locale);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of [
        "/my-work",
        "/my-work?view=my-cases",
        "/my-work?view=due-soon",
        "/settings/access",
      ]) {
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        await expect(page.getByTestId("app-sidebar")).toBeVisible();
        await audit(page);
      }
      // The account menu is a disclosure that works without JavaScript; audit it open.
      await page.getByTestId("signed-in-as").click();
      await expect(page.getByTestId("sign-out")).toBeVisible();
      await audit(page);
      // No horizontal scroll at the phone width (WCAG 1.4.10).
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow, `horizontal overflow at ${width}px`).toBe(false);
    }
    await page.context().close();
  });

  test(`${locale}: Oversight and the user register`, async ({ browser }) => {
    for (const [email, path] of [
      ["audit@example.test", "/oversight?view=ledger"],
      ["soc@example.test", "/oversight?view=security-events"],
      ["admin@example.test", "/admin/users"],
    ] as const) {
      const page = await signIn(browser, email, locale);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await expect(page.getByTestId("no-case-content")).toBeVisible();
        await audit(page);
      }
      await page.context().close();
    }
  });
}
