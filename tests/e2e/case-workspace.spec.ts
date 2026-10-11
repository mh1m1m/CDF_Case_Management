// The S2 case workspace (CDF-119; audit §22.2–§22.4): progress follows the case's own path, a branch ending is
// named, a blocked step says who can take it (roles, never people), and the header states the viewer's own
// relationship. History and the access roster keep their audiences (migration 1830; DEC-08, DEC-10).
// Synthetic cases only.
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { closeFixtureConnections, closedCase, heldCase, screeningCase } from "./records-fixture";
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

test("the access roster is full for the lead and limited for an investigator", async ({ browser }) => {
  const lead = await signIn(browser, "lead@example.test");
  await lead.goto("/cases");
  await lead.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
  await lead.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
  const caseUrl = new URL(lead.url()).pathname;
  await lead.goto(`${caseUrl}/people`);
  const full = lead.getByTestId("access-roster");
  await expect(full).toContainText("Everyone with access to this case");
  await expect(full.getByTestId("roster-GRANT-TRIAGE")).toContainText("Case access grant: Triage");
  await expect(full.getByTestId("roster-GRANT-COMMITTEE").first()).toContainText("Committee");
  await expect(full.getByTestId("roster-ASSIGNMENT-LEAD_INVESTIGATOR")).toContainText("(you)");
  // History: the lead manages the team, so access grants are part of the story.
  await lead.goto(`${caseUrl}/history`);
  await expect(lead.getByTestId("history-CASE_ACCESS_GRANTED").first()).toContainText("given access");
  await lead.context().close();

  const investigator = await signIn(browser, "investigator.a@example.test");
  await investigator.goto(`${caseUrl}/people`);
  const own = investigator.getByTestId("access-roster");
  await expect(own).toContainText("The case team and your own access.");
  await expect(own.getByTestId("roster-ASSIGNMENT-INVESTIGATOR")).toContainText("(you)");
  await expect(own.locator('[data-testid^="roster-GRANT-"]')).toHaveCount(0);
  await investigator.goto(`${caseUrl}/history`);
  await expect(investigator.getByTestId("history-CASE_ACCESS_GRANTED")).toHaveCount(0);
  // Never a page view, although every visit above recorded one.
  await expect(investigator.getByTestId("history-CASE_VIEWED")).toHaveCount(0);
  await investigator.context().close();
});

test("a legal hold shows to the case team as status only, and in full to the hold audience", async ({
  browser,
}) => {
  const c = await heldCase(`workspace-hold-${randomUUID().slice(0, 8)}`);
  // The triage officer is on the case team through its TRIAGE grant.
  const triage = await signIn(browser, "triage@example.test");
  await triage.goto(`/cases/${c.caseId}`);
  await expect(triage.getByTestId("case-legal-hold")).toBeVisible();
  await triage.getByTestId("case-tab-history").click();
  const placed = triage.getByTestId("history-LEGAL_HOLD_PLACED");
  await expect(placed).toContainText("Legal hold placed");
  await expect(placed).toContainText("Who acted and why is kept by the legal and records team.");
  await expect(placed).not.toContainText("GRC Director");
  await expect(placed).not.toContainText("LITIGATION");
  await triage.context().close();

  const director = await signIn(browser, "grc.director@example.test");
  await director.goto(`/cases/${c.caseId}/history`);
  const full = director.getByTestId("history-LEGAL_HOLD_PLACED");
  await expect(full).toContainText("GRC Director Zeta");
  await expect(full).toContainText("LITIGATION");
  await director.context().close();
});
