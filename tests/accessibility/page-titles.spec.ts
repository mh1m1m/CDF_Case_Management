// CDF-56: every page has a title that says what it is, followed by the app name (WCAG 2.4.2).
// Portal titles never carry a Report ID or secret; internal titles carry no case content.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { APP, PORTAL, contextIn, sharedAnonymousReport, signIn } from "../e2e/support";

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
  const title = await page.title();
  const suffix = ` · ${appName}`;
  expect(title, `title "${title}" should end with the app name`).toMatch(
    new RegExp(`.+${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  );
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
