// First secure vertical slice through the browser (§95):
// Anonymous Report → Triage → Create Case → Assign Investigator → Open Investigation.
import { expect, test } from "@playwright/test";
import { publicStatus, signIn, submitAnonymousReport, transition } from "./support";

test("anonymous report becomes an open investigation", async ({ browser }) => {
  // 1. Reporter submits anonymously and receives a Report ID + secret once.
  const { reportRef, secret } = await submitAnonymousReport(
    browser,
    "SYNTHETIC: Employee Alpha allegedly shared tender prices with Vendor Omega before bid closing.",
  );
  expect(reportRef).toMatch(/^WB-[0-9A-HJKMNP-TV-Z]{12}$/);
  expect(secret).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
  expect(await publicStatus(browser, reportRef, secret)).toBe("Received");

  // 2. Triage officer accepts the report and opens a case.
  const triage = await signIn(browser, "triage@example.test");
  await triage.goto("/intake");
  await triage.getByTestId(`report-${reportRef}`).click();
  await triage.locator("#outcome").selectOption("OPEN_CASE");
  await triage.locator("#reason").fill("Synthetic: specific, credible and within mandate.");
  await triage.getByTestId("triage-form").getByRole("button").click();
  await expect(triage.getByTestId("create-case-form")).toBeVisible();
  await triage.locator("#title").fill("Tender price leak (synthetic)");
  await triage.locator("#summary").fill("Synthetic case created by the end-to-end test.");
  await triage.locator("#classification").selectOption("CONFIDENTIAL");
  await triage.getByTestId("create-case-form").getByRole("button").click();
  await expect(triage).toHaveURL(/\/cases\/[0-9a-f-]{36}$/);
  const caseUrl = triage.url();
  const caseNumber = ((await triage.locator("h1").textContent()) ?? "").split(" · ")[0]!;
  expect(caseNumber).toMatch(/^CDF-DEMO-\d{4}-\d{4,5}$/);
  await transition(triage, "START_SCREENING");
  await transition(triage, "COMPLETE_SCREENING");
  await triage.context().close();
  expect(await publicStatus(browser, reportRef, secret)).toBe("In progress");

  // 3. Case manager: priority, conflict declaration, triage, jurisdiction, assignment.
  const manager = await signIn(browser, "casemanager@example.test");
  await manager.goto(caseUrl);
  await manager.getByText("Update details").click();
  await manager.locator("#priority").selectOption("HIGH");
  await manager.getByTestId("details-form").getByRole("button").click();
  await expect(manager.getByTestId("details-form").getByRole("status")).toBeVisible();
  await manager
    .getByTestId("conflict-form")
    .locator("#declaration")
    .fill("Synthetic: no relationship with the parties.");
  await manager.getByTestId("conflict-form").getByRole("button").click();
  await expect(manager.getByTestId("my-conflict-status")).toContainText("No conflict declared");
  await transition(manager, "CLEAR_CONFLICT_CHECK");
  await transition(manager, "COMPLETE_TRIAGE");
  await transition(manager, "CONFIRM_JURISDICTION", "Synthetic: procurement misconduct is within mandate.");
  await expect(manager.getByTestId("blocked-APPROVE_INVESTIGATION")).toContainText(
    "Assign an investigator first.",
  );
  await manager.locator("#userId").selectOption({ label: "Investigator Beta" });
  await manager.locator("#assignReason").fill("Synthetic: procurement experience");
  await manager.getByTestId("assign-form").getByRole("button").click();
  await expect(manager.getByTestId("team-list")).toContainText("Investigator Beta");
  await manager.context().close();

  // 4. The assigned investigator sees the case and declares no conflict; they cannot approve it.
  const investigator = await signIn(browser, "investigator.b@example.test");
  await investigator.goto("/cases");
  await expect(investigator.getByTestId(`case-${caseNumber}`)).toBeVisible();
  await investigator.goto(caseUrl);
  await investigator
    .getByTestId("conflict-form")
    .locator("#declaration")
    .fill("Synthetic: no relationship with the parties.");
  await investigator.getByTestId("conflict-form").getByRole("button").click();
  await expect(investigator.getByTestId("my-conflict-status")).toContainText("No conflict declared");
  await expect(investigator.getByTestId("assign-form")).toHaveCount(0);
  await investigator.context().close();

  // 5. An unassigned investigator can neither list nor open it.
  const outsider = await signIn(browser, "investigator.a@example.test");
  await outsider.goto("/cases");
  await expect(outsider.getByTestId(`case-${caseNumber}`)).toHaveCount(0);
  const response = await outsider.goto(caseUrl);
  expect(response?.status()).toBe(404);
  await outsider.context().close();

  // 6. GRC director approves; the investigation is open and the timeline shows the history.
  const grc = await signIn(browser, "grc.director@example.test");
  await grc.goto(caseUrl);
  await transition(grc, "APPROVE_INVESTIGATION", "Synthetic: approved for full investigation.");
  await expect(grc.getByTestId("case-state")).toHaveText("Investigation");
  await expect(grc.getByTestId("audit-timeline")).toContainText("Case created");
  await expect(grc.getByTestId("audit-timeline")).toContainText("Person assigned");
  await grc.context().close();

  expect(await publicStatus(browser, reportRef, secret)).toBe("In progress");
});

test("the portal gives one answer for wrong secrets and unknown reports", async ({ browser }) => {
  const { reportRef } = await submitAnonymousReport(
    browser,
    "SYNTHETIC: a second report used to test credential handling.",
  );
  for (const ref of [reportRef, "WB-ZZZZZZZZZZZZ"]) {
    const ctx = await browser.newContext({ baseURL: "http://127.0.0.1:3001" });
    const page = await ctx.newPage();
    await page.goto("/follow-up");
    await page.locator("#reportRef").fill(ref);
    await page.locator("#secret").fill("AAAA-BBBB-CCCC-DDDD-EEEE");
    await page.getByTestId("open-report").click();
    await expect(page.getByTestId("follow-up-error")).toBeVisible();
    await ctx.close();
  }
});

test("revoked users cannot sign in and administrators see no cases", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: "http://127.0.0.1:3000" });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.locator("#email").fill("revoked@example.test");
  await page.locator("#password").fill(process.env.CDF_DEV_PASSWORD!);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("login-error")).toBeVisible();
  await ctx.close();

  const admin = await signIn(browser, "admin@example.test");
  await admin.goto("/cases");
  await expect(admin.getByTestId("cases-table")).toHaveCount(0);
  await admin.goto("/intake");
  await expect(admin.locator("h1")).not.toHaveText("Intake & Triage");
  await admin.context().close();
});

test("security headers are present on both apps", async ({ request }) => {
  for (const url of ["http://127.0.0.1:3001/", "http://127.0.0.1:3000/login"]) {
    const res = await request.get(url);
    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(res.headers()["x-frame-options"]).toBe("DENY");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(res.headers()["x-powered-by"]).toBeUndefined();
  }
});
