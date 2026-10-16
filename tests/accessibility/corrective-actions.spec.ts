// WCAG 2.2 AA on the Phase 12 P12-3b pages (ADR-058) in Arabic and English, at a desktop and a phone width and at
// 320 px: the case's Proceedings tab with a corrective action frozen by a superseded decision, the overview naming it
// under the closure step it holds, the action's page with every disposition's form open and a disposition's
// confirmation, the page once the action is modified (its earlier wording and the disposition as recorded), and the
// owner's card. Every disclosure is open. Each meeting made here is settled afterwards, and Investigator Alpha leaves
// each case again, so the seed's "my cases" stay as they were. Synthetic cases only.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { audit } from "./axe";
import {
  ACTION_OWNER,
  REPLACEMENT_SOURCES,
  closeFixtureConnections,
  disposedAs,
  endInvestigatorAssignment,
  frozenAction,
  settleMeeting,
} from "../e2e/records-fixture";
import { signIn } from "../e2e/support";

const made: { meetingId: string; caseId: string }[] = [];
test.afterEach(async () => {
  for (const f of made.splice(0)) {
    await settleMeeting(f.meetingId);
    await endInvestigatorAssignment(f.caseId, "caseManager");
  }
});
test.afterAll(closeFixtureConnections);

const WIDTHS = [1280, 390, 320] as const;
const MANAGER = "casemanager@example.test";

/**
 * At each width: the page (ready once `ready`, a test id or a CSS selector, shows) with its disclosures open passes axe
 * (not at 320) and never scrolls sideways.
 */
async function check(page: Page, path: string, ready: string, locale: "ar" | "en") {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(path);
    await expect(
      (ready.startsWith("[") ? page.locator(ready) : page.getByTestId(ready)).first(),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await page.locator("main details").evaluateAll((all) => {
      for (const d of all) (d as HTMLDetailsElement).open = true;
    });
    if (width !== 320) await audit(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, `horizontal overflow on ${path} at ${width}px`).toBe(false);
  }
}

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: a frozen action on the case and its page with the disposition forms pass axe and reflow`, async ({
    browser,
  }) => {
    const f = await frozenAction(`frozen-a11y-${locale}-${randomUUID().slice(0, 8)}`);
    made.push({ meetingId: f.meetingId, caseId: f.caseId });
    const manager = await signIn(browser, MANAGER, locale);
    await check(manager, `/cases/${f.caseId}/proceedings`, "case-action-1-dispose", locale);
    await check(manager, `/cases/${f.caseId}`, `[data-testid^="frozen-"]`, locale);
    await check(manager, `/actions/${f.actionId}`, "action-dispose", locale);

    // A disposition's confirmation; cancelled, nothing is recorded.
    await manager.setViewportSize({ width: 1280, height: 900 });
    await manager.goto(`/actions/${f.actionId}`);
    await manager.getByTestId("dispose-WAIVE").locator("summary").click();
    const form = manager.getByTestId("dispose-WAIVE-form");
    await form.getByTestId("dispose-WAIVE-document").selectOption(REPLACEMENT_SOURCES[0]);
    await form.getByTestId("dispose-WAIVE-reason").fill("Synthetic: waived for the accessibility check.");
    await form.locator('button[type="submit"]').click();
    const dialog = manager.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await audit(manager);
    await dialog.getByTestId("confirm-cancel").click();
    await expect(dialog).toBeHidden();
    await expect(manager.getByTestId("action-block")).toHaveAttribute(
      "data-block",
      "FROZEN_BY_SUPERSEDED_DECISION",
    );
    await manager.context().close();
  });

  test(`${locale}: a modified action, with its earlier wording and the disposition as recorded, and the owner's card pass axe and reflow`, async ({
    browser,
  }) => {
    const f = await frozenAction(`modified-a11y-${locale}-${randomUUID().slice(0, 8)}`);
    made.push({ meetingId: f.meetingId, caseId: f.caseId });
    await disposedAs("caseManager", f.actionId, "MODIFY", "Synthetic: modified for the accessibility check.");
    const manager = await signIn(browser, MANAGER, locale);
    await check(manager, `/actions/${f.actionId}`, "action-dispositions", locale);
    await expect(manager.getByTestId("action-earlier")).toBeVisible();
    await manager.context().close();

    const owner = await signIn(browser, ACTION_OWNER.email, locale);
    await check(owner, `/actions/${f.actionId}`, "action-card", locale);
    await owner.context().close();
  });
}
