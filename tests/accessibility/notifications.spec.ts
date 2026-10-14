// WCAG 2.2 AA on the S4 notification screens (ADR-025) in Arabic and English, on a desktop and a phone width: the
// header bell, the notifications list in both views, and the notification settings.
import { expect, test } from "@playwright/test";
import { audit } from "./axe";
import { signIn } from "../e2e/support";
import { closeFixtureConnections, seatNotice } from "../e2e/records-fixture";

test.afterAll(closeFixtureConnections);

const WIDTHS = [1280, 390] as const;

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: notifications and notification settings`, async ({ browser }) => {
    await seatNotice("committee");
    const page = await signIn(browser, "committee@example.test", locale);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ["/notifications", "/notifications?view=unread", "/settings/notifications"]) {
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        await expect(page.getByTestId("notification-bell")).toBeVisible();
        await audit(page);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(overflow, `horizontal overflow at ${width}px on ${path}`).toBe(false);
      }
    }
    await page.context().close();
  });
}
