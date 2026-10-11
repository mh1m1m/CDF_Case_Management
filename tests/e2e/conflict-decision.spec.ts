// Deciding a declared conflict (RC-10, UX-016; CDF-177): My Work leads a CONFLICT_MANAGE holder to the case's
// decision panel; the decision is explicit, gives its consequence and needs a reason. Clearing the declaration
// gives the declarant their access back. The declarant never sees a decision panel for their own declaration.
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { closeFixtureConnections, screeningCase } from "./records-fixture";
import { signIn } from "./support";

test.afterAll(closeFixtureConnections);

test("a declared conflict is decided from My Work and clearing it restores access", async ({ browser }) => {
  const c = await screeningCase(`conflict-${randomUUID().slice(0, 8)}`);

  // The case manager declares a conflict and loses access at once.
  const manager = await signIn(browser, "casemanager@example.test");
  await manager.goto(`/cases/${c.caseId}`);
  const declare = manager.getByTestId("conflict-form");
  await declare.getByTestId("conflict-yes").check();
  await declare.locator("#declaration").fill("Synthetic: a relative works for a party to this case.");
  await declare.locator('button[type="submit"]').click();
  await manager.getByRole("dialog").getByTestId("confirm-submit").click();
  await expect(manager).toHaveURL(/\/cases$/);
  expect((await manager.request.get(`/cases/${c.caseId}`)).status()).toBe(404);

  // The GRC director finds it in My Work and opens the decision panel on the case.
  const director = await signIn(browser, "grc.director@example.test");
  await director.goto("/my-work");
  const item = director.getByTestId("work-item-CONFLICT_TO_DECIDE").filter({ hasText: c.caseNumber });
  await expect(item).toHaveCount(1);
  await item.getByRole("link").click();
  await expect(director).toHaveURL(new RegExp(`/cases/${c.caseId}#conflict-decisions$`));
  const panel = director.getByTestId("conflict-decisions");
  await expect(panel).toContainText("Case Manager Gamma");
  await expect(panel).toContainText("a relative works for a party");

  // Nothing is pre-selected; a missing reason is refused and keeps the choice.
  const form = panel.locator('form[data-testid^="conflict-decide-form-"]');
  await expect(form.getByTestId("conflict-clear")).not.toBeChecked();
  await expect(form.getByTestId("conflict-confirm")).not.toBeChecked();
  await form.getByTestId("conflict-clear").check();
  await form.locator('button[type="submit"]').click();
  await expect(form.getByTestId("conflict-clear")).toBeChecked();
  await form
    .locator("textarea[name=reason]")
    .fill("Synthetic: the relative left the party before the events.");
  await form.locator('button[type="submit"]').click();
  await expect(director.getByTestId("conflict-decided")).toHaveText("Decision recorded.");
  await expect(director.getByTestId("conflict-decisions")).toHaveCount(0);
  await director.context().close();

  // The declaration is cleared: the case manager can open the case again and sees the outcome.
  await manager.goto(`/cases/${c.caseId}`);
  await expect(manager.getByTestId("my-conflict-status")).toContainText("Conflict cleared");
  await expect(manager.getByTestId("conflict-decisions")).toHaveCount(0);
  await manager.context().close();
});
