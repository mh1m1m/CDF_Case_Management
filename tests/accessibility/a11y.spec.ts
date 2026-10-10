// WCAG 2.1 AA checks (§43) on the first-slice screens, in Arabic (RTL) and English (LTR).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { APP, PORTAL, contextIn, fillReportFields, signIn, submitAndReadReceipt } from "../e2e/support";

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
      // Identified mode expands the Drive identity fields (CDF-63); audit them with their errors.
      await page.getByTestId("mode-identified").check();
      await page.getByTestId("submit-report").click();
      await expect(page.locator("#givenName")).toHaveAttribute("aria-invalid", "true");
      await audit(page);
      await ctx.close();
    });

    test("receipt with the attachment uploader (CDF-72)", async ({ browser }) => {
      const ctx = await contextIn(browser, locale, PORTAL);
      // Own synthetic client address (RFC 5737) so the portal's submit limit is not shared with other specs.
      await ctx.setExtraHTTPHeaders({
        "x-forwarded-for": locale === "ar" ? "198.51.100.75" : "198.51.100.76",
      });
      const page = await ctx.newPage();
      await page.goto("/report");
      await fillReportFields(page, "SYNTHETIC: accessibility check of the attachment uploader.");
      await page.getByTestId("mode-anonymous").check();
      await submitAndReadReceipt(page);
      await expect(page.getByTestId("attachment-uploader")).toBeVisible();
      await audit(page);
      // Error state, then a per-file outcome in the live region.
      await page.getByTestId("upload-attachments").click();
      await expect(page.locator("#attachments")).toHaveAttribute("aria-invalid", "true");
      await audit(page);
      await page.locator("#attachments").setInputFiles({
        name: "notes.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.7\n% SYNTHETIC\n%%EOF\n"),
      });
      await page.getByTestId("upload-attachments").click();
      await expect(page.getByTestId("attachment-result")).toHaveCount(1);
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
