// WCAG 2.1 AA checks (§43) on the interview screens (CDF-60), in Arabic (RTL) and English (LTR):
// the list with its planning form, an approved interview, and a planned one with every recording form open.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "../e2e/support";

async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

for (const locale of ["ar", "en"] as const) {
  test(`interview pages (${locale})`, async ({ browser }) => {
    const page = await signIn(browser, "lead@example.test", locale);
    await page.goto("/cases");
    await page.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
    await expect(page.getByTestId("case-state")).toBeVisible();
    const list = `${new URL(page.url()).pathname}/interviews`;

    await page.goto(list);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(page.getByTestId("interviews-table")).toBeVisible();
    await audit(page);
    // Validation state on the planning form: the shared command form (UX-099) focuses a linked summary and
    // marks each field, as every other form does.
    const plan = page.getByTestId("plan-interview-form");
    await plan.locator("#interviewPurpose").fill("abc");
    await plan.locator('button[type="submit"]').click();
    await expect(plan.getByRole("alert")).toBeVisible();
    const summary = plan.getByTestId("error-summary");
    await expect.poll(() => summary.evaluate((el) => el === document.activeElement)).toBe(true);
    await expect(summary.locator('a[href="#interviewTitle"]')).toHaveCount(1);
    await expect(plan.locator("#interviewTitle")).toHaveAttribute("aria-invalid", "true");
    await expect(plan.locator("#interviewPurpose")).toHaveValue("abc");
    await audit(page);

    // INT-001 (approved, read-only) and INT-002 (planned, forms open; the lead is on its panel).
    for (const n of [1, 2]) {
      await page.goto(list);
      await page.getByTestId(`interview-${n}`).click();
      await expect(page.getByTestId("interview-status")).toBeVisible();
      await audit(page);
    }
    await page.context().close();
  });
}
