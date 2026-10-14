// WCAG 2.2 AA (§43) on a formal record's dual dates (DEC-51, CDF-209): the disposition certificate in Arabic (RTL)
// and English (LTR) at desktop and phone widths. The page reflows without horizontal scroll (1.4.10) and each date
// keeps to one line, breaking only between the Gregorian date, the Hijri date and the time.
import { expect, test } from "@playwright/test";
import { audit } from "./axe";
import { signIn } from "../e2e/support";
import { closeFixtureConnections, disposedCase } from "../e2e/records-fixture";

test.afterAll(closeFixtureConnections);

for (const locale of ["ar", "en"] as const) {
  test(`certificate dates at 1280, 390 and 320 px (${locale})`, async ({ browser }) => {
    const c = await disposedCase(`a11y-dates-${locale}`);
    const page = await signIn(browser, "records@example.test", locale);
    await page.goto(`/records/certificates/${c.certificateId}`);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(page.getByTestId("certificate-issued-at")).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        `${width}px`,
      ).toBeLessThanOrEqual(width);
      const parts = await page.locator('[data-testid^="certificate-"] [data-part]').all();
      expect(parts.length).toBe(15); // five dates, each Gregorian, Hijri and time
      // One line per part. Arabic text with digits is laid out in several bidi runs, so count lines, not boxes.
      for (const part of parts) {
        const lines = await part.evaluate(
          (e) => new Set(Array.from(e.getClientRects(), (r) => Math.round(r.top))).size,
        );
        expect(lines, (await part.textContent()) ?? "").toBe(1);
      }
      await audit(page);
    }
    await page.context().close();
  });
}
