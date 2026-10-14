// WCAG 2.2 AA on the S2 case workspace (CDF-125; audit §22) in Arabic and English, at a desktop and a phone width
// and at 320 px: the header on every tab and on an evidence item's page, the overflow menu open (with and without a
// next step beside it), the stage panel, each tab's content, and the forms tab with its disclosures open. Also checks
// what the overview must answer on first paint: where the case is, since when, by when, and what next.
import { expect, test, type Page } from "@playwright/test";
import { audit } from "./axe";
import { openEvidenceItem, signIn } from "../e2e/support";

const TABS = [
  "",
  "/allegations",
  "/proceedings",
  "/evidence",
  "/interviews",
  "/forms",
  "/reporter",
  "/people",
  "/history",
];
const WIDTHS = [1280, 390, 320] as const;

// Opens "More actions" and checks the open list, whatever the fonts: its button stays where it was, and the list
// stays on the screen and above the tabs. A list laid over the tabs left part of one too small to hit (WCAG 2.5.8).
async function openOverflow(page: Page, width: number) {
  const toggle = page.getByTestId("case-overflow").locator("summary");
  const closed = await toggle.boundingBox();
  await toggle.click();
  const list = page.getByTestId("case-overflow").locator("ul");
  await expect(list).toBeVisible();
  expect(await toggle.boundingBox(), `the menu button moved when opened at ${width}px`).toEqual(closed);
  const box = await list.boundingBox();
  const tabs = await page.getByTestId("case-tabs").boundingBox();
  expect(
    box && box.x >= 0 && box.x + box.width <= width,
    `the open menu leaves the screen at ${width}px`,
  ).toBe(true);
  expect(box && tabs && box.y + box.height <= tabs.y, `the open menu covers the tabs at ${width}px`).toBe(
    true,
  );
}

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: every case tab passes axe and reflows down to 320 px`, async ({ browser }) => {
    const page = await signIn(browser, "lead@example.test", locale);
    await page.goto("/cases");
    await page.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
    await page.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
    const caseUrl = page.url();
    // An evidence item's own page (UX-075) is checked with the tabs.
    const itemPath = (await openEvidenceItem(page, caseUrl)).slice(caseUrl.length);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const tab of [...TABS, itemPath]) {
        await page.goto(`${caseUrl}${tab}`);
        await expect(page.getByTestId("case-header")).toBeVisible();
        if (width !== 320) await audit(page);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(overflow, `horizontal overflow on ${tab || "overview"} at ${width}px`).toBe(false);
      }
      // The overflow menu is a disclosure that works without JavaScript; audit it open.
      await page.goto(caseUrl);
      await openOverflow(page, width);
      await expect(page.getByTestId("case-overflow-myDeclaration")).toBeVisible();
      if (width !== 320) await audit(page);
      // The forms tab with its disclosures open: the forms this viewer may start, and the register (S2g).
      await page.goto(`${caseUrl}/forms`);
      for (const id of ["start-another-form", "form-registry"]) {
        await page.getByTestId(id).locator("summary").click();
      }
      await expect(page.getByTestId("form-registry-table")).toBeVisible();
      if (width !== 320) await audit(page);
      const formsOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(formsOverflow, `horizontal overflow on the open forms tab at ${width}px`).toBe(false);
    }
    await page.context().close();
  });

  test(`${locale}: the overview answers where the case is, since when, by when and what next`, async ({
    browser,
  }) => {
    const page = await signIn(browser, "lead@example.test", locale);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/cases");
    await page.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
    const words = {
      en: { since: "since", target: /No target set|Target/, later: "Later in this case", owner: "Owner" },
      ar: {
        since: "منذ",
        target: /لم يُحدَّد موعد مستهدف|الموعد المستهدف/,
        later: "لاحقًا في هذه القضية",
        owner: "المالك",
      },
    }[locale];
    // Header: stage with since, target (or that none is set), owner and the viewer's own relationship.
    await expect(page.getByTestId("case-since")).toContainText(words.since);
    await expect(page.getByTestId("case-target")).toHaveText(words.target);
    await expect(page.getByTestId("case-owner")).toContainText(words.owner);
    await expect(page.getByTestId("case-you")).not.toBeEmpty();
    // The case is at INVESTIGATION, where the next step belongs to a later phase: it is named, never hidden,
    // and the page never says "no steps" (UX-006).
    await expect(page.getByTestId("later-SUBMIT_FINDINGS")).toBeVisible();
    await expect(page.getByTestId("stage-panel")).toContainText(words.later);
    // The stage panel sits above the fold at 1280 × 800.
    const box = await page.getByTestId("stage-panel").boundingBox();
    expect(box && box.y).toBeLessThan(800);
    // Path-aware progress: each done step is one the case actually went through.
    const progress = page.getByTestId("case-progress");
    await expect(progress.locator('li[data-state="current"]')).toHaveCount(1);
    await expect(progress.locator('li[data-state="skipped"]')).toHaveCount(0);
    await page.context().close();
  });

  test(`${locale}: beside a next step, the open overflow menu stays on the screen and passes axe`, async ({
    browser,
  }) => {
    // The first case where the case manager has a next step. At 320 px the step and the menu take a line each.
    const page = await signIn(browser, "casemanager@example.test", locale);
    await page.goto("/cases");
    const cases = await page
      .locator('a[href^="/cases/"]')
      .evaluateAll((links) => [...new Set(links.map((a) => a.getAttribute("href") ?? ""))]);
    let caseUrl: string | undefined;
    for (const href of cases.filter((h) => /^\/cases\/[0-9a-f-]{36}$/.test(h))) {
      await page.goto(href);
      if ((await page.getByTestId("case-primary-action").count()) > 0) {
        caseUrl = href;
        break;
      }
    }
    expect(caseUrl, "a case where the case manager has a next step").toBeDefined();
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(caseUrl as string);
      await openOverflow(page, width);
      if (width !== 320) await audit(page);
    }
    await page.context().close();
  });
}
