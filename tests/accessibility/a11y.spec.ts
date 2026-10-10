// WCAG 2.1 AA checks (§43) on the first-slice screens, in Arabic (RTL) and English (LTR).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { APP, PORTAL, contextIn, signIn } from "../e2e/support";

async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

for (const locale of ["ar", "en"] as const) {
  test.describe(`${locale}`, () => {
    test("portal pages", async ({ browser }) => {
      const ctx = await contextIn(browser, locale, PORTAL);
      const page = await ctx.newPage();
      for (const path of ["/", "/report", "/follow-up"]) {
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        await audit(page);
      }
      // Validation state is accessible too.
      await page.goto("/report");
      await page.getByTestId("submit-report").click();
      await expect(page.locator("[aria-invalid=true]").first()).toBeVisible();
      await audit(page);
      await ctx.close();
    });

    test("investigation pages", async ({ browser }) => {
      const ctx = await contextIn(browser, locale, APP);
      const login = await ctx.newPage();
      await login.goto("/login");
      await audit(login);
      await ctx.close();

      const page = await signIn(browser, "casemanager@example.test", locale);
      await page.goto("/cases");
      await audit(page);
      await page.locator('[data-testid^="case-CDF-DEMO-"]').first().click();
      await expect(page.getByTestId("case-state")).toBeVisible();
      await audit(page);
      await page.context().close();

      const triage = await signIn(browser, "triage@example.test", locale);
      await triage.goto("/intake");
      await audit(triage);
      await triage.locator('[data-testid^="report-WB-"]').first().click();
      await audit(triage);
      await triage.context().close();
    });
  });
}
