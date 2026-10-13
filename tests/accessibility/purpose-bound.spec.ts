// S3 (ADR-016 D2): the one-form purpose view meets WCAG 2.2 AA and reflows at 320 CSS px (WCAG 1.4.10), in
// Arabic (RTL) and English (LTR). Synthetic cases only.
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { audit } from "./axe";
import { closeFixtureConnections, formOnlyCase } from "../e2e/records-fixture";
import { signIn } from "../e2e/support";

test.afterAll(closeFixtureConnections);

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: the one-form view is accessible and reflows`, async ({ browser }) => {
    const f = await formOnlyCase(`purpose-a11y-${locale}-${randomUUID().slice(0, 8)}`);
    const page = await signIn(browser, "committee.chair@example.test", locale);
    await page.goto(`/my-work/forms/${f.instanceId}`);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(page.getByTestId("form-purpose-banner")).toBeVisible();
    await audit(page);
    await page.setViewportSize({ width: 320, height: 640 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.context().close();
  });
}
