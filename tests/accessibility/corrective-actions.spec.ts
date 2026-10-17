// WCAG 2.2 AA on a corrective action's pages (UX redesign Phase 12; ADR-058) in Arabic and English, at a desktop and a
// phone width and at 320 px. Every disclosure is open.
// - P12-3b: the case's Proceedings tab with a corrective action frozen by a superseded decision, the overview naming it
//   under the closure step it holds, the action's page with every disposition's form open and a disposition's
//   confirmation, the page once the action is modified (its earlier wording and the disposition as recorded), the
//   owner's card, and the refusal shown at the top of the page once its form has left it (CDF-232).
// - P12-6a: the owner's report with a refused percentage and the completion's confirmation, the line the owner reads
//   while someone else verifies, the verifier's card with what was submitted and the return's confirmation, and the
//   reopening of a completed action with its history.
// Each meeting made here is settled afterwards, and Investigator Alpha leaves each case again, so the seed's "my cases"
// stay as they were. Synthetic cases only.
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { audit } from "./axe";
import {
  ACTION_OWNER,
  REPLACEMENT_SOURCES,
  closeFixtureConnections,
  disposedAs,
  endInvestigatorAssignment,
  frozenAction,
  openedAction,
  settleMeeting,
  submittedAsComplete,
  verifiedAs,
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

/** Submits the form, checks its confirmation with axe and cancels it: nothing is recorded. */
async function confirmationPasses(page: Page, form: Locator) {
  await form.locator('button[type="submit"]').click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await audit(page);
  await dialog.getByTestId("confirm-cancel").click();
  await expect(dialog).toBeHidden();
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

  test(`${locale}: the refusal shown at the top of the page once its form has left passes axe and reflows`, async ({
    browser,
  }) => {
    const f = await frozenAction(`refused-a11y-${locale}-${randomUUID().slice(0, 8)}`);
    made.push({ meetingId: f.meetingId, caseId: f.caseId });
    const manager = await signIn(browser, MANAGER, locale);
    await manager.setViewportSize({ width: 1280, height: 900 });
    await manager.goto(`/actions/${f.actionId}`);
    await manager.getByTestId("dispose-RE_ADOPT").locator("summary").click();
    const form = manager.getByTestId("dispose-RE_ADOPT-form");
    await form.getByTestId("dispose-RE_ADOPT-document").selectOption(REPLACEMENT_SOURCES[0]);
    await form
      .getByTestId("dispose-RE_ADOPT-reason")
      .fill("Synthetic: re-adopted for the accessibility check.");
    // Meanwhile another manager waives it: the command refuses, and the page, read again, no longer offers the form.
    await disposedAs(
      "grcDirector",
      f.actionId,
      "WAIVE",
      "Synthetic: waived meanwhile for the accessibility check.",
    );
    await form.locator('button[type="submit"]').click();
    await manager.getByRole("dialog").getByTestId("confirm-submit").click();
    const notice = manager.getByTestId("refusal-notice");
    await expect(notice).toBeFocused();
    await expect(manager.getByTestId("action-dispose")).toHaveCount(0);
    // A width change is not a navigation, so the notice stays for each width.
    for (const width of WIDTHS) {
      await manager.setViewportSize({ width, height: 900 });
      await expect(notice).toBeVisible();
      if (width !== 320) await audit(manager);
      const overflow = await manager.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow, `horizontal overflow with the refusal notice at ${width}px`).toBe(false);
    }
    await manager.context().close();
  });
}

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: the owner's report, the verification with what was submitted, the reopening and their confirmations pass axe and reflow`, async ({
    browser,
  }) => {
    const f = await openedAction(`report-a11y-${locale}-${randomUUID().slice(0, 8)}`);
    made.push({ meetingId: f.meetingId, caseId: f.caseId });
    const path = `/actions/${f.actionId}`;

    // The owner's report, then a percentage the command refuses (its summary links to the field) and the completion's
    // confirmation, cancelled.
    const owner = await signIn(browser, ACTION_OWNER.email, locale);
    await check(owner, path, "action-report", locale);
    await owner.setViewportSize({ width: 1280, height: 900 });
    await owner.goto(path);
    const progress = owner.getByTestId("action-progress-form");
    await progress.getByTestId("action-progress-percent").fill("101");
    await progress
      .getByTestId("action-progress-note")
      .fill("Synthetic: progress for the accessibility check.");
    await progress.locator('button[type="submit"]').click();
    const summary = progress.getByTestId("error-summary");
    await expect(summary).toBeFocused();
    await expect(summary.locator('a[href="#action-progress-percent"]')).toHaveCount(1);
    await expect(progress.getByTestId("action-progress-percent")).toHaveAttribute("aria-invalid", "true");
    await audit(owner);
    const complete = owner.getByTestId("action-complete-form");
    await complete.getByTestId("action-complete-note").fill("Synthetic: done, for the accessibility check.");
    await complete.getByTestId("action-complete-reference").fill("DOC-DEMO-2026-A11Y-01");
    await confirmationPasses(owner, complete);
    await expect(owner.getByTestId("action-status")).toHaveAttribute("data-status", "OPEN");

    // Submitted: the line the owner reads while someone else verifies, and the history with the evidence named.
    await submittedAsComplete(f.actionId);
    await check(owner, path, "action-awaiting-verification", locale);
    await owner.context().close();

    // The verifier's card with what was submitted, and the return's confirmation, cancelled.
    const manager = await signIn(browser, MANAGER, locale);
    await check(manager, path, "action-submission", locale);
    await manager.setViewportSize({ width: 1280, height: 900 });
    await manager.goto(path);
    const returning = manager.getByTestId("action-return-form");
    await returning
      .getByTestId("action-return-note")
      .fill("Synthetic: returned for the accessibility check.");
    await confirmationPasses(manager, returning);
    await expect(manager.getByTestId("action-status")).toHaveAttribute("data-status", "PENDING_VERIFICATION");

    // Verified by another manager: the reopening, and its confirmation, cancelled.
    await verifiedAs("grcDirector", f.actionId);
    await check(manager, path, "action-reopen", locale);
    await manager.setViewportSize({ width: 1280, height: 900 });
    await manager.goto(path);
    const reopen = manager.getByTestId("action-reopen-form");
    await reopen.getByTestId("action-reopen-reason").fill("Synthetic: reopened for the accessibility check.");
    await confirmationPasses(manager, reopen);
    await expect(manager.getByTestId("action-status")).toHaveAttribute("data-status", "COMPLETED");
    await manager.context().close();
  });
}
