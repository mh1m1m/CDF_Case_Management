// CDF-71 records screens through the browser, in English and Arabic (ADR-013, ADR-014): the records officer's
// queue, a record with retention and a legal hold, dual-controlled disposition with its certificate, the
// controlled legal-hold lookup, and the negatives (no navigation or access without records capabilities, no
// case discovery outside the catalogue, no write controls on archived or disposed cases).
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./support";
import {
  archivedCase,
  closeFixtureConnections,
  eligibleCase,
  restrictedArchivedCase,
  TEST_CLASS,
} from "./records-fixture";

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

test("an archived case waits in the shared retention queue for every records officer and leaves it when classified (ADR-016 D8)", async ({
  browser,
}) => {
  const c = await archivedCase("queue");

  // Records officer Xi, in Arabic: the queue on Records and the item in My Work, with no named assignee.
  const xi = await signIn(browser, "records.b@example.test", "ar");
  await xi.goto("/records");
  const queue = xi.getByTestId("retention-queue");
  await expect(queue.getByRole("heading", { level: 2 })).toHaveText("بانتظار تصنيف مدة الحفظ");
  const row = queue.locator("tr", { hasText: c.caseNumber });
  await expect(row).toContainText("لم تُصنَّف بعد");
  await expect(row).toContainText("أقل من يوم");
  await expect(xi.getByTestId(`queue-hold-${c.caseNumber}`)).toHaveText("لا يوجد حجز قانوني");
  await expect(xi.getByTestId(`queue-review-${c.caseNumber}`)).toHaveText("مراجعة تصنيف مدة الحفظ");
  // Lifecycle metadata only: the case title never appears.
  await expect(xi.locator("main")).not.toContainText("Records e2e case");
  await xi.goto("/my-work");
  const item = xi.getByTestId("work-item-RETENTION_CLASSIFICATION").filter({ hasText: c.caseNumber });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("مراجعة تصنيف مدة الحفظ");

  // Records officer Nu, in English, picks it up from the same queue and classifies it.
  const nu = await signIn(browser, "records@example.test", "en");
  await nu.goto("/records");
  await nu.getByTestId(`queue-review-${c.caseNumber}`).click();
  await expect(nu).toHaveURL(new RegExp(`/records/${c.caseId}#retention$`));
  const retention = nu.getByTestId("retention-form");
  await retention.locator("#retentionClass").selectOption("WB_CASE_NOT_INVESTIGATED");
  await submit(nu, "retention-form");
  await expect(nu.getByTestId("record-state")).toHaveText("In retention");

  // Classified: gone from the queue and from My Work, for both officers.
  await nu.goto("/records");
  await expect(nu.getByTestId(`queue-review-${c.caseNumber}`)).toHaveCount(0);
  await nu.context().close();
  await xi.goto("/records");
  await expect(xi.getByTestId(`queue-review-${c.caseNumber}`)).toHaveCount(0);
  await xi.goto("/my-work");
  await expect(
    xi.getByTestId("work-item-RETENTION_CLASSIFICATION").filter({ hasText: c.caseNumber }),
  ).toHaveCount(0);
  await xi.context().close();

  // The case manager who archived it has no Records queue (their Records page is their own hold requests).
  const manager = await signIn(browser, "casemanager@example.test", "en");
  await manager.goto("/records");
  await expect(manager.getByTestId("my-work-card")).toBeVisible();
  await expect(manager.getByTestId("retention-queue")).toHaveCount(0);
  await manager.goto("/my-work");
  await expect(manager.getByTestId("work-item-RETENTION_CLASSIFICATION")).toHaveCount(0);
  await manager.context().close();
});

test("a restricted archived case is routed by its authority to one records officer, whose task ends with the class (ADR-016 D8)", async ({
  browser,
}) => {
  const c = await restrictedArchivedCase("route");

  // The shared queue never takes a restricted case.
  const nu = await signIn(browser, "records@example.test", "en");
  await nu.goto("/records");
  await expect(nu.getByTestId("retention-queue")).toBeVisible();
  await expect(nu.getByTestId(`queue-review-${c.caseNumber}`)).toHaveCount(0);
  await nu.context().close();

  // The case manager, its accountable authority, routes it from My Work, in English.
  const manager = await signIn(browser, "casemanager@example.test", "en");
  await manager.goto("/my-work");
  const item = manager.getByTestId("work-item-RETENTION_TO_ROUTE").filter({ hasText: c.caseNumber });
  await expect(item).toContainText("Route a retention review");
  await item.getByRole("link").first().click();
  await expect(manager).toHaveURL(new RegExp(`/records/${c.caseId}#route-retention$`));
  const form = manager.getByTestId("route-retention-form");
  await expect(form.locator("#route-purpose")).toHaveValue(
    "Confirm the retention class of this archived case.",
  );
  await expect(form.locator("#route-reviewer option")).toHaveText([
    "—",
    "Records Officer Nu",
    "Records Officer Xi",
  ]);
  await form.locator("#route-reviewer").selectOption({ label: "Records Officer Xi" });
  await submit(manager, "route-retention-form");
  await expect(manager).toHaveURL(new RegExp(`/records/${c.caseId}\\?routed=1$`));
  await expect(manager.getByTestId("retention-routed")).toContainText("Retention review routed.");
  await expect(manager.getByTestId("route-retention-card")).toHaveCount(0);
  await manager.goto("/my-work");
  await expect(
    manager.getByTestId("work-item-RETENTION_TO_ROUTE").filter({ hasText: c.caseNumber }),
  ).toHaveCount(0);
  await manager.context().close();

  // Officer Xi, in Arabic: a task of their own (not a queue item), classified from the record.
  const xi = await signIn(browser, "records.b@example.test", "ar");
  await xi.goto("/my-work");
  await expect(
    xi.getByTestId("work-item-TASK_RETENTION_REVIEW").filter({ hasText: c.caseNumber }),
  ).toHaveCount(1);
  await xi.goto(`/records/${c.caseId}`);
  await expect(xi.getByTestId("route-retention-card")).toHaveCount(0);
  await expect(xi.locator("main")).not.toContainText("Records e2e restricted case");
  await xi.getByTestId("retention-form").locator("#retentionClass").selectOption("WB_CASE_NOT_INVESTIGATED");
  await submit(xi, "retention-form");
  // The class completes the task and its access ends: back on Records, told so, and the record is gone.
  await expect(xi).toHaveURL(/\/records\?reviewed=1$/);
  await expect(xi.getByTestId("retention-reviewed")).toContainText("اكتملت مهمة مراجعة مدة الحفظ");
  await xi.goto("/my-work");
  await expect(
    xi.getByTestId("work-item-TASK_RETENTION_REVIEW").filter({ hasText: c.caseNumber }),
  ).toHaveCount(0);
  const gone = await xi.goto(`/records/${c.caseId}`);
  expect(gone?.status()).toBe(404);
  await xi.context().close();
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
  // The Records area opens on the legal-hold queue for a legal reviewer (their default view, S1).
  await legal.getByTestId("nav-records").click();
  await expect(legal).toHaveURL(/\/records\/legal-holds$/);
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
  // A refused submit keeps what was typed (UX-001): only the wrong value needs correcting.
  await expect(form.locator("#caseReference")).toHaveValue("CDF-DEMO-%");
  await expect(form.locator("#lookup-justification")).toHaveValue(JUSTIFICATION);
  await form.locator("#caseReference").fill("CDF-DEMO-2026-0001");
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
  await manager.getByTestId("case-tab-people").click();
  await expect(manager.getByTestId("case-read-only")).toBeVisible();
  await expect(manager.locator("#assignee, [data-testid='assign-form']")).toHaveCount(0);
  await manager.getByTestId("case-overflow").locator("summary").click();
  await manager.getByTestId("case-overflow-openRecord").click();
  await expect(manager.getByTestId("record-state")).toHaveText("Archived");
  await manager.context().close();
});
