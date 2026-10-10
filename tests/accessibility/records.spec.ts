// WCAG 2.1 AA checks (§43, REC-T51) on the records screens (CDF-71) in Arabic (RTL) and English (LTR): the
// queue, a record with a hold and every records form open, the legal-hold requests page with a validation
// error, and a disposition certificate.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "../e2e/support";
import { archivedCase, closeFixtureConnections, eligibleCase } from "../e2e/records-fixture";

test.afterAll(closeFixtureConnections);

async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

for (const locale of ["ar", "en"] as const) {
  test(`records pages (${locale})`, async ({ browser }) => {
    const archived = await archivedCase(`a11y-${locale}`);
    const eligible = await eligibleCase(`a11y-cert-${locale}`);

    const records = await signIn(browser, "records@example.test", locale);
    await records.goto("/records");
    await expect(records.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(records.getByTestId("catalogue-table")).toBeVisible();
    await audit(records);

    // A record with the retention and hold forms, then the same record with an active hold.
    await records.goto(`/records/${archived.caseId}`);
    await expect(records.getByTestId("retention-form")).toBeVisible();
    await audit(records);
    const place = records.getByTestId("place-hold-form");
    await place.locator('button[type="submit"]').click();
    await expect(place.getByTestId("error-summary")).toBeVisible();
    await audit(records);
    await place
      .locator("#place-justification")
      .fill("Synthetic: preservation required for a pending synthetic inquiry.");
    await place.locator('button[type="submit"]').click();
    await expect(records.getByTestId("holds-list")).toBeVisible();
    await audit(records);

    // Disposition: request (officer), approve (director), execute, certificate.
    await records.goto(`/records/${eligible.caseId}`);
    await records.getByTestId("request-disposition-form").locator('button[type="submit"]').click();
    await expect(records.getByTestId("disposition-status-PENDING")).toBeVisible();
    await audit(records);
    const director = await signIn(browser, "grc.director@example.test", locale);
    await director.goto(`/records/${eligible.caseId}`);
    await expect(director.getByTestId("decide-disposition-form")).toBeVisible();
    await audit(director);
    const decide = director.getByTestId("decide-disposition-form");
    await decide.locator("textarea").fill("Synthetic decision reason.");
    await decide.locator('button[type="submit"]').click();
    await expect(director.getByTestId("disposition-status-APPROVED")).toBeVisible();
    await director.context().close();
    await records.reload();
    await expect(records.getByTestId("execute-disposition-form")).toBeVisible();
    await audit(records);
    await records.locator("#confirm-disposition").check();
    await records.getByTestId("execute-disposition-form").locator('button[type="submit"]').click();
    await records.getByTestId("certificate-link").click();
    await expect(records.getByTestId("certificate-verified")).toBeVisible();
    await audit(records);
    await records.context().close();

    // Legal hold requests with a validation error.
    const legal = await signIn(browser, "legal@example.test", locale);
    await legal.goto("/records/legal-holds");
    await expect(legal.getByTestId("lookup-form")).toBeVisible();
    await audit(legal);
    await legal.getByTestId("lookup-form").locator('button[type="submit"]').click();
    await expect(legal.getByTestId("lookup-form").getByTestId("error-summary")).toBeVisible();
    await audit(legal);
    await legal.context().close();
  });
}
