// The S2 case workspace (CDF-119; audit §22.2–§22.4): progress follows the case's own path, a branch ending is
// named, a blocked step says who can take it (roles, never people), and the header states the viewer's own
// relationship. Synthetic cases only.
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { closeFixtureConnections, closedCase, screeningCase } from "./records-fixture";
import { signIn } from "./support";

test.afterAll(closeFixtureConnections);

test("a case closed at screening shows the skipped steps and its ending, not a full path", async ({
  browser,
}) => {
  const c = await closedCase(`workspace-closed-${randomUUID().slice(0, 8)}`);
  const manager = await signIn(browser, "casemanager@example.test");
  await manager.goto(`/cases/${c.caseId}`);
  const progress = manager.getByTestId("case-progress");
  await expect(progress.locator('li[data-state="current"]')).toHaveText(/Closure/);
  // Ten states between screening and closure were never entered: one run, said in words, not ticked as done.
  await expect(progress.locator('li[data-state="skipped"]')).toHaveCount(1);
  await expect(progress.locator('li[data-state="skipped"]')).toContainText("Steps not taken: 10");
  await expect(progress.locator('li[data-state="done"]')).toHaveCount(3);
  await expect(manager.getByTestId("stage-ended")).toContainText("Closed at screening");
  await expect(manager.getByTestId("case-records-state")).toHaveText("Closed");
  // Archiving is a controlled act: offered in the stage panel behind its confirmation, never as the primary.
  await expect(manager.getByTestId("transition-ARCHIVE_CASE")).toBeVisible();
  await expect(manager.getByTestId("case-primary-action")).toHaveCount(0);
  await manager.context().close();
});

test("a blocked step names the roles that can take it, and the header states the viewer's access", async ({
  browser,
}) => {
  const c = await screeningCase(`workspace-blocked-${randomUUID().slice(0, 8)}`);
  // The triage officer created the case and holds its TRIAGE grant; closing at screening needs another role.
  const triage = await signIn(browser, "triage@example.test");
  await triage.goto(`/cases/${c.caseId}`);
  await expect(triage.getByTestId("blocked-SCREEN_OUT")).toContainText("Your role does not allow this step.");
  await expect(triage.getByTestId("who-can-SCREEN_OUT")).toHaveText(
    "Who can do this: Case Manager, Lead Investigator",
  );
  await expect(triage.getByTestId("case-you")).toContainText("Case access grant: Triage");
  await expect(triage.getByTestId("case-owner")).toBeVisible();
  // The same header is on every tab.
  await triage.getByTestId("case-tab-history").click();
  await expect(triage.getByTestId("case-number")).toHaveText(c.caseNumber);
  await expect(triage.getByTestId("case-you")).toContainText("Case access grant: Triage");
  await triage.context().close();
});
