// CDF-77: the case page links to the case's forms (CDF-50) and interviews (CDF-60) from a labelled navigation block.
import { expect, test } from "@playwright/test";
import { signIn } from "../e2e/support";

const text = {
  en: { nav: "Case work", forms: "Forms", interviews: "Interviews" },
  ar: { nav: "أعمال القضية", forms: "النماذج", interviews: "المقابلات" },
} as const;

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: case page links to the case's forms and interviews`, async ({ browser }) => {
    const page = await signIn(browser, "casemanager@example.test", locale);
    await page.goto("/cases");
    await page.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
    await page.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
    const caseId = new URL(page.url()).pathname.split("/").pop()!;

    const nav = page.getByRole("navigation", { name: text[locale].nav, exact: true });
    await expect(nav).toHaveCount(1);
    await expect(nav.getByRole("link", { name: text[locale].forms, exact: true })).toHaveAttribute(
      "href",
      `/cases/${caseId}/forms`,
    );
    await expect(nav.getByRole("link", { name: text[locale].interviews, exact: true })).toHaveAttribute(
      "href",
      `/cases/${caseId}/interviews`,
    );
    await page.context().close();
  });
}
