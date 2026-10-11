// UX-080 route boundaries (RC-05, G2): missing pages are translated, and a case that does not exist and a case
// the user may not see render the same page with the same status, so nothing confirms that a case exists.
import { expect, test, type Page } from "@playwright/test";
import { PORTAL, contextIn, signIn } from "./support";
import { closeFixtureConnections, screeningCase } from "./records-fixture";

test.afterAll(closeFixtureConnections);

const T = {
  en: {
    caseTitle: "Not available",
    caseBody: "This case, or the item in it, does not exist or is not available to you.",
    pageTitle: "Page not found",
    toCases: "Go to cases",
  },
  ar: {
    caseTitle: "غير متاح",
    caseBody: "هذه القضية، أو العنصر المطلوب فيها، غير موجود أو غير متاح لك.",
    pageTitle: "الصفحة غير موجودة",
    toCases: "العودة إلى القضايا",
  },
} as const;

const MISSING = "00000000-0000-4000-8000-000000000000";

async function visit(page: Page, path: string) {
  const response = await page.goto(path);
  return {
    status: response?.status(),
    main: (await page.locator("main").innerText()).trim(),
    title: await page.title(),
  };
}

for (const locale of ["ar", "en"] as const) {
  const t = T[locale];

  test(`${locale}: a missing case and an inaccessible case render the same translated 404`, async ({
    browser,
  }) => {
    // A real case the investigator has no relationship with.
    const hidden = await screeningCase(`hidden-404-${locale}`);
    const outsider = await signIn(browser, "investigator.a@example.test", locale);
    for (const suffix of ["", "/forms", "/interviews"]) {
      const missing = await visit(outsider, `/cases/${MISSING}${suffix}`);
      const inaccessible = await visit(outsider, `/cases/${hidden.caseId}${suffix}`);
      expect(missing.status, suffix).toBe(404);
      expect(inaccessible.status, suffix).toBe(404);
      expect(inaccessible.main, suffix).toBe(missing.main);
      expect(inaccessible.title, suffix).toBe(missing.title);
      await expect(outsider.getByTestId("not-found")).toBeVisible();
      await expect(outsider.locator("h1")).toHaveText(t.caseTitle);
      await expect(outsider.locator("main")).toContainText(t.caseBody);
      await expect(outsider.getByRole("link", { name: t.toCases })).toBeVisible();
      // Never the framework's English default page.
      expect(missing.main).not.toContain("This page could not be found");
    }
    // A malformed id is the same page too.
    const malformed = await visit(outsider, "/cases/not-a-case-id");
    expect(malformed.status).toBe(404);
    expect(malformed.main).toBe((await visit(outsider, `/cases/${MISSING}`)).main);
    await outsider.context().close();
  });

  test(`${locale}: unknown addresses get a translated 404 in both apps`, async ({ browser }) => {
    // Signed in: the internal app sends anyone else to the sign-in page first.
    const app = await signIn(browser, "casemanager@example.test", locale);
    const internal = await visit(app, "/no-such-page");
    expect(internal.status).toBe(404);
    await expect(app.locator("h1")).toHaveText(t.pageTitle);
    expect(internal.title.startsWith(t.pageTitle)).toBe(true);
    await expect(app.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await app.context().close();

    const portal = await (await contextIn(browser, locale, PORTAL)).newPage();
    const external = await visit(portal, "/no-such-page");
    expect(external.status).toBe(404);
    await expect(portal.locator("h1")).toHaveText(t.pageTitle);
    expect(external.main).not.toContain("This page could not be found");
    await portal.context().close();
  });
}
