// UX-003 (CRITICAL) · DEC-01 (ADR-016 D1): a restricted case opened at triage names its accountable authority,
// states the access consequence before submission, hands the case over, and is reachable by that authority only.
import { expect, test } from "@playwright/test";
import { PORTAL, contextIn, fillReportFields, signIn, submitAndReadReceipt } from "./support";

test("a restricted case is handed to the named authority and only they can reach it", async ({ browser }) => {
  // A fresh synthetic report under its own client fingerprint, so the portal's submit limit is untouched.
  const portal = await contextIn(browser, "en", PORTAL);
  await portal.setExtraHTTPHeaders({ "x-forwarded-for": "198.51.100.103" });
  const reporter = await portal.newPage();
  await reporter.goto("/report");
  await fillReportFields(reporter, "SYNTHETIC: Employee Alpha allegedly approved their own expense claims.");
  await reporter.getByTestId("mode-anonymous").check();
  const { reportRef } = await submitAndReadReceipt(reporter);
  await portal.close();

  // Triage accepts the report.
  const triage = await signIn(browser, "triage@example.test");
  await triage.goto("/intake");
  await triage.getByTestId(`report-${reportRef}`).click();
  await triage.locator("#outcome").selectOption("OPEN_CASE");
  await triage.locator("#reason").fill("Synthetic: credible, within mandate, needs restricted handling.");
  await triage.getByTestId("triage-form").getByRole("button").click();
  await expect(triage.getByTestId("create-case-form")).toBeVisible();
  const reportUrl = triage.url();

  await triage.locator("#title").fill("Self-approved expenses (synthetic)");
  await triage.locator("#summary").fill("Synthetic restricted case created by the end-to-end test.");
  await triage.locator("#classification").selectOption("CONFIDENTIAL");
  // Nothing is pre-selected; the consequence waits for an explicit choice.
  await triage.getByTestId("restricted-toggle").check();
  const authority = triage.getByTestId("restricted-authority");
  await expect(authority).toHaveValue("");
  await expect(triage.getByTestId("restricted-consequence")).toContainText(
    "Choose the accountable authority",
  );
  // Only eligible authorities are offered: the two synthetic GRC directors, nobody else.
  await expect(authority.locator("option:not([value=''])")).toHaveText([
    "GRC Deputy Mu",
    "GRC Director Zeta",
  ]);

  // Submitting without a choice is refused and keeps the typed values.
  await triage.getByTestId("create-case-form").getByRole("button").click();
  await expect(triage.getByTestId("error-summary")).toBeVisible();
  await expect(triage.locator("#title")).toHaveValue("Self-approved expenses (synthetic)");

  await authority.selectOption({ label: "GRC Director Zeta" });
  await expect(triage.getByTestId("restricted-consequence")).toContainText(
    "GRC Director Zeta becomes its accountable owner",
  );
  await triage.getByTestId("create-case-form").getByRole("button").click();

  // The initiator is handed back to the queue and can no longer open the report.
  await expect(triage).toHaveURL(/\/intake\?handedOver=1$/);
  await expect(triage.getByTestId("restricted-created")).toBeVisible();
  expect((await triage.request.get(reportUrl)).status()).toBe(404);
  await triage.context().close();

  // The named authority finds and opens the case.
  const zeta = await signIn(browser, "grc.director@example.test");
  await zeta.goto("/cases");
  const row = zeta.getByRole("row", { name: /Self-approved expenses \(synthetic\)/ });
  const caseHref = await row.locator('a[data-testid^="case-"]').getAttribute("href");
  expect(caseHref).toMatch(/^\/cases\/[0-9a-f-]{36}$/);
  await zeta.goto(caseHref!);
  await expect(zeta.getByRole("heading", { level: 1 })).toContainText("Self-approved expenses (synthetic)");
  await zeta.context().close();

  // CASE_VIEW_ALL and the other eligible authority do not reach it: the same 404 as a missing case.
  for (const email of ["casemanager@example.test", "grc.deputy@example.test"]) {
    const other = await signIn(browser, email);
    expect((await other.request.get(caseHref!)).status()).toBe(404);
    await other.goto("/cases");
    await expect(other.getByText("Self-approved expenses (synthetic)")).toHaveCount(0);
    await other.context().close();
  }
});
