// CDF-56: every page has a title that says what it is, followed by the app name (WCAG 2.4.2).
// Portal titles never carry a Report ID or secret; internal titles carry no case content.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { APP, PORTAL, contextIn, openEvidenceItem, sharedAnonymousReport, signIn } from "../e2e/support";

const appNames = {
  en: { app: "CDF Case Management & Investigation Platform", portal: "CDF Whistleblowing Portal" },
  ar: {
    app: "منصة إدارة القضايا والتحقيقات بصندوق التنمية الثقافي",
    portal: "بوابة الإبلاغ عن المخالفات - الصندوق الثقافي",
  },
} as const;

/** Returns the page-specific part of the title and checks the app name follows it. */
async function pagePart(page: Page, appName: string) {
  await page.waitForLoadState("load");
  const suffix = ` · ${appName}`;
  // A client navigation sets the title just after the URL changes, so wait for it instead of reading it once.
  await expect(page, "the title should end with the app name").toHaveTitle(
    new RegExp(`.+${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  );
  const title = await page.title();
  return title.slice(0, -suffix.length);
}

async function anonymousPage(browser: Browser, locale: "ar" | "en", baseURL: string) {
  return (await contextIn(browser, locale, baseURL)).newPage();
}

for (const locale of ["ar", "en"] as const) {
  const names = appNames[locale];

  test(`${locale}: internal pages have distinct titles`, async ({ browser }) => {
    const titles: string[] = [];
    const login = await anonymousPage(browser, locale, APP);
    await login.goto("/login");
    titles.push(await pagePart(login, names.app));
    await login.context().close();

    const manager = await signIn(browser, "casemanager@example.test", locale);
    await manager.goto("/cases");
    titles.push(await pagePart(manager, names.app));
    await manager.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
    await manager.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
    const caseTitle = await pagePart(manager, names.app);
    expect(caseTitle).not.toMatch(/CDF-DEMO-/);
    titles.push(caseTitle);
    await manager.context().close();

    const triage = await signIn(browser, "triage@example.test", locale);
    await triage.goto("/intake");
    titles.push(await pagePart(triage, names.app));
    await triage.locator('[data-testid^="report-WB-"]').first().click();
    await triage.waitForURL(/\/intake\/[0-9a-f-]{36}$/);
    const reportTitle = await pagePart(triage, names.app);
    expect(reportTitle).not.toMatch(/WB-/);
    titles.push(reportTitle);
    await triage.context().close();

    const admin = await signIn(browser, "admin@example.test", locale);
    await admin.goto("/");
    titles.push(await pagePart(admin, names.app));
    await admin.context().close();

    expect(new Set(titles).size).toBe(titles.length);
  });

  test(`${locale}: case tabs and sub-pages have their own titles (UX-082)`, async ({ browser }) => {
    const expected = {
      en: [
        "Case",
        "Case forms",
        "Form details",
        "Case interviews",
        "Interview details",
        "Case allegations",
        "Case evidence",
        "Case people and access",
        "Case history",
        "Evidence item details",
      ],
      ar: [
        "قضية",
        "نماذج القضية",
        "تفاصيل النموذج",
        "مقابلات القضية",
        "تفاصيل المقابلة",
        "ادعاءات القضية",
        "أدلة القضية",
        "فريق القضية وصلاحياتها",
        "مجريات القضية",
        "تفاصيل الدليل",
      ],
    }[locale];
    const lead = await signIn(browser, "lead@example.test", locale);
    await lead.goto("/cases");
    await lead.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
    await lead.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
    const caseUrl = lead.url();
    const titles = [await pagePart(lead, names.app)];
    await lead.getByTestId("case-tab-forms").click();
    await lead.waitForURL(/\/forms$/);
    titles.push(await pagePart(lead, names.app));
    // The first started form by its address: after the e2e suite every form on this case can sit in the closed
    // "Completed" group (S2g), where its link is not visible until the group is opened.
    const formHref = await lead.locator('[data-testid^="form-instance-"]').first().getAttribute("href");
    await lead.goto(formHref!);
    await lead.waitForURL(/\/forms\/[0-9a-f-]{36}$/);
    titles.push(await pagePart(lead, names.app));
    await lead.goto(caseUrl);
    await lead.getByTestId("case-tab-interviews").click();
    await lead.waitForURL(/\/interviews$/);
    titles.push(await pagePart(lead, names.app));
    await lead.locator('[data-testid^="interview-"]').first().click();
    await lead.waitForURL(/\/interviews\/[0-9a-f-]{36}$/);
    titles.push(await pagePart(lead, names.app));
    for (const tab of ["allegations", "evidence", "people", "history"]) {
      await lead.goto(`${caseUrl}/${tab}`);
      titles.push(await pagePart(lead, names.app));
    }
    // An evidence item's own page (UX-075): neither its number nor its title is in the page title.
    await openEvidenceItem(lead, caseUrl);
    titles.push(await pagePart(lead, names.app));
    expect(titles).toEqual(expected);
    // No case number or case content in any of them.
    for (const title of titles) expect(title).not.toMatch(/CDF-DEMO-|WB-|EV-|Synthetic/);
    await lead.context().close();
  });

  test(`${locale}: portal pages have distinct titles that never carry credentials`, async ({ browser }) => {
    const { reportRef, secret } = await sharedAnonymousReport(browser);
    const page = await anonymousPage(browser, locale, PORTAL);
    const titles: string[] = [];
    for (const path of ["/", "/report", "/follow-up"]) {
      await page.goto(path);
      titles.push(await pagePart(page, names.portal));
    }
    expect(new Set(titles).size).toBe(titles.length);

    await page.locator("#reportRef").fill(reportRef);
    await page.locator("#secret").fill(secret);
    await page.getByTestId("open-report").click();
    await expect(page.getByTestId("report-status")).toBeVisible();
    const title = await page.title();
    expect(title).not.toContain(reportRef);
    expect(title).not.toContain(secret);
    await page.context().close();
  });
}
