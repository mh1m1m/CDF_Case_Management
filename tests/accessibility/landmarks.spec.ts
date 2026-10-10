// CDF-52: every section has its own name in both languages, headings do not skip levels, every page has an
// h1, all content sits in a landmark, and tables only add a tab stop when they scroll.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { APP, PORTAL, contextIn, signIn } from "../e2e/support";

const STRUCTURE_RULES = [
  "landmark-unique",
  "heading-order",
  "page-has-heading-one",
  "region",
  "duplicate-id-aria",
];

async function expectSoundStructure(page: Page) {
  const results = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
  // Each labelled section resolves to its own heading text.
  const names = await page
    .locator("section[aria-labelledby]")
    .evaluateAll((sections) =>
      sections.map(
        (s) => document.getElementById(s.getAttribute("aria-labelledby")!)?.textContent?.trim() ?? "",
      ),
    );
  expect(names.every((n) => n.length > 0)).toBe(true);
  expect(new Set(names).size).toBe(names.length);
}

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: case and intake pages have unique section names and a sound outline`, async ({
    browser,
  }) => {
    const manager = await signIn(browser, "casemanager@example.test", locale);
    await manager.goto("/cases");
    // Wide desktop: the cases table fits, so it is not an extra tab stop.
    await expect(manager.locator('[data-testid="cases-table"]')).toBeVisible();
    await expect(manager.locator('[data-scrollable="false"]').first()).toBeAttached();
    expect(await manager.locator('[data-scrollable="false"][tabindex]').count()).toBe(0);
    await expectSoundStructure(manager);
    await manager.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
    await expect(manager.getByTestId("case-state")).toBeVisible();
    await manager
      .locator("details")
      .evaluateAll((ds) => ds.forEach((d) => ((d as HTMLDetailsElement).open = true)));
    await expectSoundStructure(manager);
    // On a phone the same table scrolls, so it becomes a focusable, labelled region.
    await manager.goto("/cases");
    await manager.setViewportSize({ width: 390, height: 844 });
    await expect(manager.locator('[data-scrollable="true"][tabindex="0"][role="region"]')).toBeAttached();
    await manager.context().close();

    const triage = await signIn(browser, "triage@example.test", locale);
    await triage.goto("/intake");
    await triage.locator('[data-testid^="report-WB-"]').first().click();
    await expect(triage.getByTestId("report-status")).toBeVisible();
    await expectSoundStructure(triage);
    await triage.context().close();

    const admin = await signIn(browser, "admin@example.test", locale);
    await expectSoundStructure(admin);
    await admin.context().close();

    const portal = await contextIn(browser, locale, PORTAL);
    const home = await portal.newPage();
    await home.goto("/");
    await expectSoundStructure(home);
    await portal.close();

    const app = await contextIn(browser, locale, APP);
    const login = await app.newPage();
    await login.goto("/login");
    await expectSoundStructure(login);
    await app.close();
  });
}
