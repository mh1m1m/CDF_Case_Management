// Phase 8 forms engine through the browser (ADR-011): an assigned investigator starts an Evidence Register,
// saves and prepares it, the lead reviews it, a viewer without a working relationship sees it read-only and
// an unassigned investigator gets nothing.
import { expect, test } from "@playwright/test";
import { signIn } from "./support";

test("a form is started, saved, prepared, reviewed and kept from outsiders", async ({ browser }) => {
  const stamp = Date.now();
  const investigator = await signIn(browser, "investigator.a@example.test");
  await investigator.goto("/cases");
  await investigator.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
  await expect(investigator.getByTestId("evidence-card")).toBeVisible();
  const caseUrl = investigator.url();

  // 1. The registry lists every form; only forms this role may prepare offer a start button.
  await investigator.goto(`${caseUrl}/forms`);
  await expect(investigator.getByTestId("form-registry")).toBeVisible();
  await expect(investigator.getByTestId("form-def-WB-FRM-01")).toBeVisible();
  await expect(investigator.getByTestId("form-def-WB-FRM-19")).toBeVisible();
  await expect(investigator.getByTestId("start-WB-FRM-11")).toBeVisible();
  await expect(investigator.getByTestId("start-WB-FRM-13")).toHaveCount(0);
  await investigator.getByTestId("start-WB-FRM-11").locator('button[type="submit"]').click();
  await expect(investigator).toHaveURL(/\/cases\/[0-9a-f-]{36}\/forms\/[0-9a-f-]{36}$/);
  const instanceUrl = investigator.url();
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
  await expect(investigator.getByTestId("form-version-1")).toContainText(/[0-9a-f]{64}/);
  await investigator.getByTestId("prepare-form").locator('button[type="submit"]').click();
  await expect(investigator.getByTestId("form-status")).toHaveText("Prepared");
  await expect(investigator.getByTestId("form-read-only")).toBeVisible();
  await expect(investigator.getByTestId("value-evidence_scope")).toContainText(`${stamp}`);
  await expect(investigator.getByTestId("decision-card")).toHaveCount(0);
  await expect(investigator.getByTestId("form-events")).toContainText("Prepared");
  await investigator.context().close();

  // 3. An unassigned investigator cannot reach the instance or the case's forms page.
  const outsider = await signIn(browser, "investigator.b@example.test");
  expect((await outsider.goto(instanceUrl))?.status()).toBe(404);
  expect((await outsider.goto(`${caseUrl}/forms`))?.status()).toBe(404);
  await outsider.context().close();

  // 4. The lead investigator reviews; the form is final and the case timeline records the steps.
  const lead = await signIn(browser, "lead@example.test");
  await lead.goto(instanceUrl);
  await expect(lead.getByTestId("form-status")).toHaveText("Prepared");
  await expect(lead.getByTestId("draft-form")).toHaveCount(0);
  const decision = lead.getByTestId("decision-form");
  await decision.getByTestId("outcome-accept").check();
  await decision.locator('button[type="submit"]').click();
  await expect(lead.getByTestId("form-status")).toHaveText("Reviewed");
  await expect(lead.getByTestId("decision-card")).toHaveCount(0);
  await expect(lead.getByTestId("withdraw-card")).toHaveCount(0);
  await expect(lead.getByTestId("form-events")).toContainText("Reviewed");
  await lead.goto(`${caseUrl}/forms`);
  await expect(lead.getByTestId("form-instances-table")).toContainText("Reviewed");
  await lead.goto(caseUrl);
  await expect(lead.getByTestId("audit-timeline")).toContainText("Form started");
  await expect(lead.getByTestId("audit-timeline")).toContainText("Form reviewed");
  await lead.context().close();

  // 5. The triage officer sees the final form read-only, with no decision or withdrawal controls.
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
  await expect(page.getByTestId("form-registry")).toContainText("قرار تشكيل لجنة");
  await expect(page.getByTestId("start-WB-FRM-13")).toBeVisible();
  await expect(page.getByTestId("start-WB-FRM-11")).toHaveCount(0);
  await page.context().close();
});
