// Phase 8 forms engine through the browser (ADR-011), on the case's Forms tab (UX redesign S2g): an assigned
// investigator starts an Evidence Register from "Start another form" (it asks first), saves and prepares it; the
// lead finds it waiting for review and returns it with a reason; the investigator sees it returned to them,
// with the reason, and prepares it again; the lead reviews it. A viewer without a working relationship sees it
// read-only and an unassigned investigator gets nothing.
import { expect, test } from "@playwright/test";
import { signIn } from "./support";

test("a form is started, saved, prepared, reviewed and kept from outsiders", async ({ browser }) => {
  const stamp = Date.now();
  const investigator = await signIn(browser, "investigator.a@example.test");
  await investigator.goto("/cases");
  await investigator.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
  await expect(investigator.getByTestId("stage-panel")).toBeVisible();
  const caseUrl = investigator.url();

  // 1. Only forms this role may start are offered, one disclosure away; the whole register is there on demand.
  await investigator.goto(`${caseUrl}/forms`);
  await expect(investigator.getByTestId("form-registry-table")).toBeHidden();
  await investigator.getByTestId("form-registry").locator("summary").click();
  await expect(investigator.getByTestId("form-def-WB-FRM-01")).toBeVisible();
  await expect(investigator.getByTestId("form-def-WB-FRM-19")).toBeVisible();
  const start = investigator.getByTestId("start-another-form");
  await expect(start.getByTestId("start-WB-FRM-11")).toBeHidden();
  await start.locator("summary").click();
  await expect(start.getByTestId("start-WB-FRM-11")).toBeVisible();
  await expect(start.getByTestId("start-WB-FRM-13")).toHaveCount(0);
  await start.getByRole("button", { name: "Start: Evidence Register" }).click();
  await investigator.getByRole("dialog").getByTestId("confirm-submit").click();
  await expect(investigator).toHaveURL(/\/cases\/[0-9a-f-]{36}\/forms\/[0-9a-f-]{36}$/);
  const instanceUrl = investigator.url();
  const instancePath = new URL(instanceUrl).pathname;
  await expect(investigator.getByTestId("form-status")).toHaveText("Draft");

  // 2. Draft saved with a version and hash; preparing locks it and the fields become read-only.
  const draft = investigator.getByTestId("draft-form");
  await draft.getByTestId("field-evidence_count").fill("3");
  await draft.getByTestId("field-evidence_scope").fill(`Synthetic e2e evidence scope ${stamp}`);
  await draft.getByTestId("field-chain_of_custody_status").selectOption({ index: 1 });
  await draft.getByTestId("field-storage_confirmation").selectOption("true");
  await draft.locator('button[type="submit"]').click();
  await expect(draft.getByRole("status")).toContainText("Draft saved");
  await expect(draft.getByRole("status")).toContainText("Version 1");
  // The hash is kept one step away, under Integrity details (UX-123).
  await expect(investigator.getByTestId("form-hash-1")).toBeHidden();
  await investigator.getByTestId("integrity-details").locator("summary").click();
  await expect(investigator.getByTestId("form-hash-1")).toContainText(/[0-9a-f]{64}/);
  await expect(investigator.getByTestId("field-evidence_scope")).toHaveAttribute("aria-required", "true");
  await investigator.getByTestId("prepare-form").locator('button[type="submit"]').click();
  await expect(investigator.getByTestId("form-status")).toHaveText("Prepared");
  await expect(investigator.getByTestId("form-read-only")).toBeVisible();
  await expect(investigator.getByTestId("value-evidence_scope")).toContainText(`${stamp}`);
  await expect(investigator.getByTestId("decision-card")).toHaveCount(0);
  await expect(investigator.getByTestId("form-events")).toContainText("Prepared");
  // On the tab it is in progress, waiting for a reviewer who did not prepare it.
  await investigator.goto(`${caseUrl}/forms`);
  const mine = investigator.getByTestId("forms-in-progress").locator("li", {
    has: investigator.locator(`a[href="${instancePath}"]`),
  });
  await expect(mine.getByTestId("form-next")).toContainText("Next: review, by ");
  await expect(mine.getByTestId("form-next")).toContainText("(not the person who prepared it)");
  await investigator.context().close();

  // 3. An unassigned investigator cannot reach the instance or the case's forms page.
  const outsider = await signIn(browser, "investigator.b@example.test");
  expect((await outsider.goto(instanceUrl))?.status()).toBe(404);
  expect((await outsider.goto(`${caseUrl}/forms`))?.status()).toBe(404);
  await outsider.context().close();

  // 4. The lead finds it waiting for review, named by the act, and returns it with a reason.
  const lead = await signIn(browser, "lead@example.test");
  await lead.goto(`${caseUrl}/forms`);
  const toReview = lead.getByTestId("forms-waiting").locator(`a[href="${instancePath}"]`);
  await expect(toReview).toHaveText("Review: Evidence Register");
  await toReview.click();
  await expect(lead.getByTestId("form-status")).toHaveText("Prepared");
  await expect(lead.getByTestId("draft-form")).toHaveCount(0);
  const decision = lead.getByTestId("decision-form");
  // Nothing is pre-selected (UX-019): a submit without a choice is refused with a field error, and the form
  // stays where it was.
  await expect(decision.getByTestId("outcome-accept")).not.toBeChecked();
  await expect(decision.getByTestId("outcome-return")).not.toBeChecked();
  await decision.locator('button[type="submit"]').click();
  await expect(decision.getByTestId("error-summary")).toContainText("Choose one option.");
  await expect(decision.locator("#outcome-accept-error")).toHaveText("Choose one option.");
  await expect(lead.getByTestId("form-status")).toHaveText("Prepared");
  await decision.getByTestId("outcome-return").check();
  await decision.locator("#decision-reason").fill(`Synthetic: add the custody exception ${stamp}`);
  await decision.locator('button[type="submit"]').click();
  await expect(lead.getByTestId("form-status")).toHaveText("Draft");
  await expect(lead.getByTestId("form-returned-banner")).toContainText("Returned for changes");
  await lead.context().close();

  // 5. It came back to the investigator, reason first, on the tab and on the form; they prepare it again.
  const again = await signIn(browser, "investigator.a@example.test");
  await again.goto(`${caseUrl}/forms`);
  const toRevise = again.getByTestId("forms-waiting").locator("li", {
    has: again.locator(`a[href="${instancePath}"]`),
  });
  await expect(toRevise.locator(`a[href="${instancePath}"]`)).toHaveText("Revise: Evidence Register");
  await expect(toRevise.getByTestId("form-returned")).toContainText("Returned to you for changes");
  await expect(toRevise.getByTestId("form-returned")).toContainText(`custody exception ${stamp}`);
  await toRevise.locator(`a[href="${instancePath}"]`).click();
  await expect(again.getByTestId("form-returned-banner")).toContainText("Returned to you for changes");
  await expect(again.getByTestId("form-returned-banner")).toContainText(`custody exception ${stamp}`);
  await again.getByTestId("prepare-form").locator('button[type="submit"]').click();
  await expect(again.getByTestId("form-status")).toHaveText("Prepared");
  await expect(again.getByTestId("form-returned-banner")).toHaveCount(0);
  await again.context().close();

  // 6. The lead reviews; the form is final, completed on the tab, and the case history records the steps.
  const lead2 = await signIn(browser, "lead@example.test");
  await lead2.goto(instanceUrl);
  const review = lead2.getByTestId("decision-form");
  await review.getByTestId("outcome-accept").check();
  await review.locator('button[type="submit"]').click();
  await expect(lead2.getByTestId("form-status")).toHaveText("Reviewed");
  await expect(lead2.getByTestId("decision-card")).toHaveCount(0);
  await expect(lead2.getByTestId("withdraw-card")).toHaveCount(0);
  await expect(lead2.getByTestId("form-events")).toContainText("Returned");
  await expect(lead2.getByTestId("form-events")).toContainText("Reviewed");
  await lead2.goto(`${caseUrl}/forms`);
  const completed = lead2.getByTestId("forms-completed");
  await completed.locator("summary").click();
  await expect(completed.locator(`a[href="${instancePath}"]`)).toHaveText("Evidence Register");
  await lead2.goto(`${caseUrl}/history`);
  await expect(lead2.getByTestId("audit-timeline")).toContainText("Form started");
  await expect(lead2.getByTestId("audit-timeline")).toContainText("Form reviewed");
  await lead2.context().close();

  // 7. The triage officer sees the final form read-only, with no decision or withdrawal controls.
  const triage = await signIn(browser, "triage@example.test");
  await triage.goto(instanceUrl);
  await expect(triage.getByTestId("form-status")).toHaveText("Reviewed");
  await expect(triage.getByTestId("form-read-only")).toBeVisible();
  await expect(triage.getByTestId("draft-form")).toHaveCount(0);
  await expect(triage.getByTestId("decision-card")).toHaveCount(0);
  await expect(triage.getByTestId("withdraw-card")).toHaveCount(0);
  await triage.context().close();
});

test("the Arabic forms page renders right-to-left with Arabic labels", async ({ browser }) => {
  const page = await signIn(browser, "committee.secretary@example.test", "ar");
  await page.goto("/cases");
  await page.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
  await page.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
  const caseUrl = page.url();
  await page.goto(`${caseUrl}/forms`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByTestId("form-registry").locator("summary").click();
  await expect(page.getByTestId("form-registry")).toContainText("قرار تشكيل لجنة");
  await page.getByTestId("start-another-form").locator("summary").click();
  await expect(page.getByTestId("start-WB-FRM-13")).toBeVisible();
  await expect(page.getByRole("button", { name: "بدء: قرار تشكيل لجنة تحقيق" })).toBeVisible();
  await expect(page.getByTestId("start-WB-FRM-11")).toHaveCount(0);
  await page.context().close();
});
