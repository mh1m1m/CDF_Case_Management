// CDF-53: the case page reflows at 320 CSS px (WCAG 1.4.10) and repeated evidence controls have distinct names.
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "../e2e/support";

async function openCaseWithEvidence(page: Page) {
  await page.goto("/cases");
  await page.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
  await expect(page.getByTestId("evidence-card")).toBeVisible();
  // The table only renders once an item exists; add one synthetic file so its width is part of the check.
  if ((await page.getByTestId("evidence-table").count()) === 0) {
    const form = page.getByTestId("evidence-form");
    await form.locator("#file").setInputFiles({
      name: "synthetic-reflow-check.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\n% synthetic reflow check\n"),
    });
    await form.locator("#evidenceTitle").fill("Synthetic reflow check");
    await form.locator('button[type="submit"]').click();
    await expect(form.getByRole("status")).toBeVisible();
    await page.reload();
  }
  await expect(page.getByTestId("evidence-table")).toBeVisible();
}

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: case page has no horizontal scroll at 320 px`, async ({ browser }) => {
    const page = await signIn(browser, "casemanager@example.test", locale);
    await openCaseWithEvidence(page);
    await page.setViewportSize({ width: 320, height: 640 });
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(320);
    await page.context().close();
  });

  test(`${locale}: evidence links and buttons have distinct accessible names`, async ({ browser }) => {
    const page = await signIn(browser, "casemanager@example.test", locale);
    await openCaseWithEvidence(page);
    await page
      .locator('[data-testid^="evidence-versions-"]')
      .evaluateAll((ds) => ds.forEach((d) => ((d as HTMLDetailsElement).open = true)));
    const card = page.getByTestId("evidence-card");
    const names = async (selector: "a[href]" | "button") =>
      Promise.all(
        (await card.locator(selector).all()).map(async (l) =>
          (await l.evaluate((e) => e.getAttribute("aria-label") || e.textContent || "")).trim(),
        ),
      );
    const links = await names("a[href]");
    expect(links.length).toBeGreaterThan(0);
    expect(new Set(links).size).toBe(links.length);
    const buttons = await names("button");
    expect(new Set(buttons).size).toBe(buttons.length);
    // Each file input has its own label (file inputs expose a role of button, so they are checked by label).
    const fileLabels = await card
      .locator('input[type="file"]')
      .evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).labels?.[0]?.textContent ?? ""));
    expect(new Set(fileLabels).size).toBe(fileLabels.length);
    await page.context().close();
  });
}
