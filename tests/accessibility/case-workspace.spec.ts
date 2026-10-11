// WCAG 2.2 AA on the S2 case workspace (CDF-125; audit §22) in Arabic and English, at a desktop and a phone width
// and at 320 px: the header on every tab and on an evidence item's page, the overflow menu open, the stage panel
// and each tab's content. Also checks what the overview must answer on first paint: where the case is, since
// when, by when, and what next.
import { expect, test } from "@playwright/test";
import { audit } from "./axe";
import { openEvidenceItem, signIn } from "../e2e/support";

const TABS = ["", "/allegations", "/evidence", "/interviews", "/forms", "/reporter", "/people", "/history"];
const WIDTHS = [1280, 390, 320] as const;

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
      await page.getByTestId("case-overflow").locator("summary").click();
      await expect(page.getByTestId("case-overflow-myDeclaration")).toBeVisible();
      if (width !== 320) await audit(page);
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
}
