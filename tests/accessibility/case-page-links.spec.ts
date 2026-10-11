// CDF-77, UX redesign S2 (audit §22.6): every case page carries one labelled navigation of the case's sections,
// each a URL, with the current section marked. The forms and interviews sections keep their routes. The case
// manager holds the reporter conversation (DEC-06), so the Reporter section is among them.
import { expect, test } from "@playwright/test";
import { signIn } from "../e2e/support";

const text = {
  en: {
    nav: "Case sections",
    tabs: [
      "Overview",
      "Allegations",
      "Evidence",
      "Interviews",
      "Forms",
      "Reporter",
      "People & access",
      "History",
    ],
  },
  ar: {
    nav: "أقسام القضية",
    tabs: [
      "نظرة عامة",
      "الادعاءات",
      "الأدلة",
      "المقابلات",
      "النماذج",
      "المبلّغ",
      "الفريق والصلاحيات",
      "مجريات القضية",
    ],
  },
} as const;
const PATHS = ["", "/allegations", "/evidence", "/interviews", "/forms", "/reporter", "/people", "/history"];

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: every case section is a link in one labelled navigation`, async ({ browser }) => {
    const page = await signIn(browser, "casemanager@example.test", locale);
    await page.goto("/cases");
    await page.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
    await page.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
    const caseId = new URL(page.url()).pathname.split("/").pop()!;

    for (const [i, path] of PATHS.entries()) {
      await page.goto(`/cases/${caseId}${path}`);
      const nav = page.getByRole("navigation", { name: text[locale].nav, exact: true });
      await expect(nav).toHaveCount(1);
      const links = nav.getByRole("link");
      await expect(links).toHaveText([...text[locale].tabs]);
      for (const [j, p] of PATHS.entries())
        await expect(links.nth(j)).toHaveAttribute("href", `/cases/${caseId}${p}`);
      // Exactly the open section is marked current.
      await expect(nav.locator('[aria-current="page"]')).toHaveText(text[locale].tabs[i]!);
      // The case header is the same on every section.
      await expect(page.getByTestId("case-number")).toHaveText(/^CDF-DEMO-\d{4}-0001$/);
    }
    await page.context().close();
  });
}
