// CDF-71 records screens through the browser, in English and Arabic (ADR-013, ADR-014): the records officer's
// queue, a record with retention and a legal hold, dual-controlled disposition with its certificate, the
// controlled legal-hold lookup, and the negatives (no navigation or access without records capabilities, no
// case discovery outside the catalogue, no write controls on archived or disposed cases).
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./support";
import { archivedCase, closeFixtureConnections, eligibleCase, TEST_CLASS } from "./records-fixture";

test.afterAll(closeFixtureConnections);

const JUSTIFICATION = "Synthetic: preservation required for a pending synthetic inquiry.";
const REASON = "Synthetic decision reason.";

async function submit(page: Page, testId: string) {
  await page.getByTestId(testId).locator('button[type="submit"]').click();
}

test("a records officer classifies an archived case and places a legal hold (English)", async ({
  browser,
}) => {
  const c = await archivedCase("hold-en");
  const page = await signIn(browser, "records@example.test", "en");
  await page.getByTestId("nav-records").click();
  await expect(page).toHaveURL(/\/records$/);
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByTestId("my-work-card")).toBeVisible();

  // The catalogue lists post-closure records only; the search narrows by case-number prefix.
  await page.locator("#caseNumber").fill(c.caseNumber);
  await page.getByTestId("catalogue-search-submit").click();
  await expect(page.getByTestId("catalogue-total")).toHaveText("1 records");
  await expect(page.getByTestId(`record-hold-${c.caseNumber}`)).toHaveText("No legal hold");
  await page.getByTestId(`record-${c.caseNumber}`).click();
  await expect(page).toHaveURL(new RegExp(`/records/${c.caseId}$`));
  await expect(page.getByTestId("record-state")).toHaveText("Archived");
  await expect(page.getByTestId("record-read-only")).toBeVisible();
  // Lifecycle metadata only: the case title never appears on the records screens.
  await expect(page.locator("main")).not.toContainText("Records e2e case");

  const retention = page.getByTestId("retention-form");
  await retention.locator("#retentionClass").selectOption("WB_CASE_NOT_INVESTIGATED");
  await submit(page, "retention-form");
  await expect(page.getByTestId("record-state")).toHaveText("In retention");

  // Client-side "required" is off (noValidate): the server schema refuses a short justification.
  const place = page.getByTestId("place-hold-form");
  await place.locator("#place-justification").fill("too short");
  await submit(page, "place-hold-form");
  await expect(place.getByTestId("error-summary")).toBeVisible();
  await place.locator("#place-reason").selectOption("REGULATORY_INQUIRY");
  await place.locator("#place-justification").fill(JUSTIFICATION);
  await submit(page, "place-hold-form");
  // The badge states the hold in words, not only in colour (REC-T50).
  await expect(page.getByTestId("record-hold")).toHaveText("Legal hold active");
  await expect(page.getByTestId("holds-list")).toContainText("Regulatory inquiry");
  // The records officer may place but not release holds: no release form is offered.
  await expect(page.locator('[data-testid^="request-release-"]')).toHaveCount(0);
  await page.context().close();
});

test("disposition is requested, approved by someone else in Arabic, executed and certified", async ({
  browser,
}) => {
  const c = await eligibleCase("disposition");
  const records = await signIn(browser, "records@example.test", "en");
  await records.goto(`/records/${c.caseId}`);
  await expect(records.getByTestId("record-state")).toHaveText("Eligible for disposition");
  await submit(records, "request-disposition-form");
  await expect(records.getByTestId("own-disposition")).toHaveCount(0); // the officer cannot approve at all
  await expect(records.getByTestId("disposition-status-PENDING")).toBeVisible();
  await expect(records.getByTestId("decide-disposition-form")).toHaveCount(0);

  const director = await signIn(browser, "grc.director@example.test", "ar");
  await director.goto(`/records/${c.caseId}`);
  await expect(director.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(director.getByTestId("record-state")).toHaveText("الإتلاف قيد الاعتماد");
  const decide = director.getByTestId("decide-disposition-form");
  await decide.locator('input[value="APPROVE"]').check();
  await decide.locator("textarea").fill(REASON);
  await submit(director, "decide-disposition-form");
  await expect(director.getByTestId("disposition-status-APPROVED")).toBeVisible();
  await director.context().close();

  await records.reload();
  const execute = records.getByTestId("execute-disposition-form");
  // Execution needs the explicit confirmation.
  await submit(records, "execute-disposition-form");
  await expect(execute.getByTestId("error-summary")).toBeVisible();
  await execute.locator("#confirm-disposition").check();
  await submit(records, "execute-disposition-form");
  await expect(records.getByTestId("record-state")).toHaveText("Disposed");
  await expect(records.getByTestId("record-disposed")).toBeVisible();
  await expect(records.getByTestId("place-hold-form")).toHaveCount(0);

  await records.getByTestId("certificate-link").click();
  await expect(records.getByTestId("certificate-verified")).toHaveText("Hash verified");
  await expect(records.getByTestId("certificate-hash")).toHaveText(/^[0-9a-f]{64}$/);
  await expect(records.getByTestId("certificate-card")).toContainText(TEST_CLASS);
  await expect(records.getByTestId("certificate-card")).toContainText("Logical only (nothing deleted)");
  const certificateUrl = new URL(records.url()).pathname;
  await records.context().close();

  // Case roles no longer reach the disposed case or its certificate.
  const manager = await signIn(browser, "casemanager@example.test", "en");
  expect((await manager.goto(`/cases/${c.caseId}`))?.status()).toBe(404);
  expect((await manager.goto(certificateUrl))?.status()).toBe(404);
  await manager.context().close();
});

test("legal files a hold request by exact case number in Arabic; no justification is refused", async ({
  browser,
}) => {
  const legal = await signIn(browser, "legal@example.test", "ar");
  await legal.getByTestId("nav-records").click();
  await legal.getByTestId("legal-holds-link").click();
  await expect(legal.locator("html")).toHaveAttribute("dir", "rtl");
  const form = legal.getByTestId("lookup-form");
  await form.locator("#caseReference").fill("CDF-DEMO-2026-0001");
  await submit(legal, "lookup-form");
  // Justification missing: refused by the shared schema before any lookup is filed.
  await expect(form.getByTestId("error-summary")).toContainText("المبرر");
  // A wildcard is not a case number.
  await form.locator("#caseReference").fill("CDF-DEMO-%");
  await form.locator("#lookup-justification").fill(JUSTIFICATION);
  await submit(legal, "lookup-form");
  await expect(form.getByTestId("error-summary")).toContainText("رقم القضية الكامل");
  // React resets the form after each submit, so every attempt fills its fields again.
  await form.locator("#caseReference").fill("CDF-DEMO-2026-0001");
  await form.locator("#lookup-justification").fill(JUSTIFICATION);
  await submit(legal, "lookup-form");
  await expect(form.getByRole("status")).toContainText("قُدّم طلب حجز");
  // The filed request shows no case until a reviewer is assigned (CDF-79).
  await legal.reload();
  await expect(legal.getByTestId("my-requests")).toContainText("لا تظهر حتى يُعيَّن مراجع");
  await legal.context().close();
});

test("records access is refused without records capabilities and outside the catalogue", async ({
  browser,
}) => {
  const c = await archivedCase("negatives");

  // No records capability: no navigation entry, and direct URLs give the generic not-found page.
  const investigator = await signIn(browser, "investigator.a@example.test", "en");
  await expect(investigator.getByTestId("nav-records")).toHaveCount(0);
  for (const path of ["/records", `/records/${c.caseId}`, "/records/legal-holds"]) {
    expect((await investigator.goto(path))?.status(), path).toBe(404);
  }
  await investigator.context().close();

  // The records officer cannot discover an active case: not in the catalogue, and its URL is refused.
  const records = await signIn(browser, "records@example.test", "en");
  await records.goto("/records?caseNumber=CDF-DEMO-2026-0001");
  await expect(records.getByTestId("catalogue-card")).toContainText("No records match.");
  await records.context().close();

  // The case team sees the archived case read-only: notice, no details editing, no new assignment.
  const manager = await signIn(browser, "casemanager@example.test", "en");
  await manager.goto(`/cases/${c.caseId}`);
  await expect(manager.getByTestId("case-read-only")).toBeVisible();
  await expect(manager.getByTestId("details-form")).toHaveCount(0);
  await expect(manager.locator("#assignee, [data-testid='assign-form']")).toHaveCount(0);
  await manager.getByTestId("case-records-link").click();
  await expect(manager.getByTestId("record-state")).toHaveText("Archived");
  await manager.context().close();
});
