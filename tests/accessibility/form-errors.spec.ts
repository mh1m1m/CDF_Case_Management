// CDF-58: forms say which fields are required (WCAG 3.3.2), and server-side errors are tied to their fields
// with focus moved to a linked summary (WCAG 3.3.1, 3.3.3).
import { expect, test } from "@playwright/test";
import { PORTAL, contextIn, signIn } from "../e2e/support";

const words = {
  en: { required: "(Required)", optional: "(Optional)" },
  ar: { required: "(مطلوب)", optional: "(اختياري)" },
} as const;

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: internal form fields are marked required or optional`, async ({ browser }) => {
    const page = await signIn(browser, "casemanager@example.test", locale);
    await page.goto("/cases");
    await page.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
    const form = page.getByTestId("evidence-form");
    await expect(form.locator('label[for="evidenceTitle"]')).toContainText(words[locale].required);
    await expect(form.locator('label[for="file"]')).toContainText(words[locale].required);
    for (const id of ["sourceDescription", "collectedAt", "evidenceDescription"]) {
      await expect(form.locator(`label[for="${id}"]`)).toContainText(words[locale].optional);
    }
    // Date fields explain how to enter a date, since the native picker follows the browser's locale.
    await expect(form.locator("#collectedAt")).toHaveAttribute("aria-describedby", /\bcollectedAt-hint\b/);
    await expect(form.locator("#collectedAt-hint")).not.toBeEmpty();
    const assign = page.getByTestId("assign-form");
    await expect(assign.locator('label[for="userId"]')).toContainText(words[locale].required);
    await expect(assign.locator('label[for="assignReason"]')).toContainText(words[locale].required);
    await page.context().close();
  });

  test(`${locale}: an invalid submit focuses a linked summary and marks each field`, async ({ browser }) => {
    const page = await signIn(browser, "casemanager@example.test", locale);
    await page.goto("/cases");
    await page.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
    const assign = page.getByTestId("assign-form");
    await assign.locator('button[type="submit"]').click();

    const summary = assign.getByTestId("error-summary");
    await expect(summary).toBeVisible();
    await expect.poll(() => summary.evaluate((el) => el === document.activeElement)).toBe(true);

    // Each summary item links to its field and names it by its visible label, never by a form key.
    for (const id of ["userId", "assignReason"]) {
      const link = summary.locator(`a[href="#${id}"]`);
      await expect(link).toHaveCount(1);
      const label = (
        await assign.locator(`label[for="${id}"]`).evaluate((l) => l.firstChild?.textContent ?? "")
      ).trim();
      await expect(link).toContainText(label);

      const control = assign.locator(`#${id}`);
      await expect(control).toHaveAttribute("aria-invalid", "true");
      await expect(control).toHaveAttribute("aria-describedby", new RegExp(`\\b${id}-error\\b`));
      await expect(assign.locator(`#${id}-error`)).not.toBeEmpty();
    }
    await expect(summary).not.toContainText("reason:");

    // Following a summary link lands on the field.
    await summary.locator('a[href="#assignReason"]').click();
    await expect(assign.locator("#assignReason")).toBeFocused();
    await page.context().close();
  });

  test(`${locale}: portal required fields are announced as required`, async ({ browser }) => {
    const page = await (await contextIn(browser, locale, PORTAL)).newPage();
    await page.goto("/report");
    for (const id of ["category", "description"]) {
      await expect(page.locator(`#${id}`)).toHaveAttribute("aria-required", "true");
    }
    await expect(page.locator('input[name="acknowledgement"]')).toHaveAttribute("aria-required", "true");
    await expect(page.locator("#incidentDate")).toHaveAttribute("aria-describedby", /\bincidentDate-hint\b/);
    await expect(page.locator("#incidentDate-hint")).not.toBeEmpty();
    await page.context().close();
  });
}
