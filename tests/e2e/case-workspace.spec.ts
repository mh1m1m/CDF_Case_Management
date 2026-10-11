// The S2 case workspace (CDF-119; audit §22.2–§22.4): progress follows the case's own path, a branch ending is
// named, a blocked step says who can take it (roles, never people), and the header states the viewer's own
// relationship. History and the access roster keep their audiences (migration 1830; DEC-08, DEC-10). The
// reporter conversation belongs to the case's correspondents (migration 1840; DEC-06).
// Synthetic cases only.
import { randomUUID } from "node:crypto";
import { expect, test, type Browser } from "@playwright/test";
import {
  closeFixtureConnections,
  closedCase,
  endInvestigatorAssignment,
  heldCase,
  reporterCase,
  screeningCase,
} from "./records-fixture";
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

test("the reporter conversation is on the case for its correspondents, and a delegation opens and closes it", async ({
  browser,
}) => {
  const c = await reporterCase(`workspace-reporter-${randomUUID().slice(0, 8)}`);
  // The fixture puts Investigator Alpha on a new case; take it off again, so My Work keeps the seed's cases.
  try {
    await reporterJourney(browser, c);
  } finally {
    await endInvestigatorAssignment(c.caseId);
  }
});

async function reporterJourney(
  browser: Browser,
  c: { caseId: string; caseNumber: string; reportId: string; message: string },
) {
  const reporterUrl = `/cases/${c.caseId}/reporter`;
  const investigatorA = "a0000000-0000-4000-8000-000000000004";

  // The case manager holds the conversation: reads the reporter's message and answers it.
  const manager = await signIn(browser, "casemanager@example.test");
  await manager.goto(`/cases/${c.caseId}`);
  await manager.getByTestId("case-tab-reporter").click();
  await expect(manager).toHaveURL(new RegExp(`${reporterUrl}$`));
  await expect(manager.getByTestId("reporter-messages")).toContainText(c.message);
  const answer = "Thank you, we have received it (synthetic e2e).";
  await manager.getByTestId("reporter-reply-form").locator("textarea").fill(answer);
  await manager.getByTestId("reporter-reply-form").getByRole("button").click();
  await expect(manager.getByTestId("reporter-messages")).toContainText(answer);
  await expect(manager.getByTestId("reporter-no-delegations")).toBeVisible();

  // The assigned investigator sees the case but not the conversation: no tab, and the page is a 404.
  const investigator = await signIn(browser, "investigator.a@example.test");
  await investigator.goto(`/cases/${c.caseId}`);
  await expect(investigator.getByTestId("case-tabs")).toBeVisible();
  await expect(investigator.getByTestId("case-tab-reporter")).toHaveCount(0);
  const hidden = await investigator.goto(reporterUrl);
  expect(hidden?.status()).toBe(404);

  // The case manager delegates; the investigator can now write, and sees its own delegation.
  await manager.locator("#userId").selectOption(investigatorA);
  await manager.locator("#delegateReason").fill("Synthetic: the investigator follows up the dates.");
  await manager.getByTestId("reporter-delegate-form").getByRole("button").click();
  await expect(manager.getByTestId(`reporter-delegation-${investigatorA}`)).toContainText(
    "Investigator Alpha",
  );
  await investigator.goto(`/cases/${c.caseId}`);
  await investigator.getByTestId("case-tab-reporter").click();
  await expect(investigator.getByTestId("reporter-messages")).toContainText(answer);
  await expect(investigator.getByTestId("reporter-reply-form")).toBeVisible();
  await expect(investigator.getByTestId(`reporter-delegation-${investigatorA}`)).toContainText("(you)");
  await expect(investigator.getByTestId("reporter-delegate-form")).toHaveCount(0);

  // Ending the delegation closes the conversation to the investigator again.
  const end = manager.getByTestId(`reporter-end-${investigatorA}`);
  await end.locator("input").fill("Synthetic: the dates are now on file.");
  await end.getByRole("button").click();
  await expect(manager.getByTestId("reporter-no-delegations")).toBeVisible();
  expect((await investigator.goto(reporterUrl))?.status()).toBe(404);

  // History tells the team who was delegated and when it ended.
  await manager.goto(`/cases/${c.caseId}/history`);
  await expect(manager.getByTestId("history-REPORTER_COMMUNICATION_DELEGATED")).toContainText(
    "Investigator Alpha may write to the reporter",
  );
  await expect(manager.getByTestId("history-REPORTER_COMMUNICATION_ENDED")).toContainText(
    "Investigator Alpha no longer writes to the reporter",
  );
  await manager.context().close();
  await investigator.context().close();

  // The triage officer opened the case and keeps its grant, but the conversation moved to the case team.
  const triage = await signIn(browser, "triage@example.test");
  await triage.goto(`/intake/${c.reportId}`);
  await expect(triage.getByTestId("conversation-moved")).toContainText("moved to the case team");
  await expect(triage.getByTestId("reply-form")).toHaveCount(0);
  await triage.goto(`/cases/${c.caseId}`);
  await expect(triage.getByTestId("case-tab-reporter")).toHaveCount(0);
  await triage.context().close();
}
