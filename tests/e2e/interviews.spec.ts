// EPIC 09 through the browser, in Arabic (CDF-60, ADR-012): an investigator plans, schedules and records
// a witness interview with a hashed statement; the lead reviews; the case manager approves; outsiders get
// a 404 and the reporter is never named.
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./support";

/** datetime-local value in Riyadh time, `hours` from now. */
function riyadhLocal(hours: number): string {
  return new Date(Date.now() + (hours + 3) * 3_600_000).toISOString().slice(0, 16);
}

/** Submits a recording form; the caller then asserts the visible outcome (the form may close on success). */
async function submit(page: Page, testId: string) {
  await page.getByTestId(testId).locator('button[type="submit"]').click();
}

test("an interview is planned, recorded, reviewed and approved in Arabic", async ({ browser }) => {
  const stamp = Date.now();
  const investigator = await signIn(browser, "investigator.a@example.test", "ar");
  await investigator.goto("/cases");
  await investigator.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
  await expect(investigator.getByTestId("case-state")).toBeVisible();
  const caseUrl = new URL(investigator.url()).pathname;
  await investigator.goto(`${caseUrl}/interviews`);
  await expect(investigator.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(investigator.getByRole("heading", { level: 1 })).toContainText("المقابلات");

  // 1. Plan: a pseudonymous working label, never a real name.
  const plan = investigator.getByTestId("plan-interview-form");
  await plan.locator("#interviewTitle").fill(`مقابلة الشاهد كابا ${stamp}`);
  await plan.locator("#intervieweeKind").selectOption("WITNESS");
  await plan.locator("#intervieweeLabel").fill("الشاهد كابا (تجريبي)");
  await plan.locator("#interviewPurpose").fill("تجريبي: التحقق من تسلسل اعتماد الفواتير.");
  await plan.locator('button[type="submit"]').click();
  await expect(investigator.getByTestId("interview-status")).toHaveText("مخطط لها");
  const interviewUrl = new URL(investigator.url()).pathname;
  expect(interviewUrl).toMatch(/^\/cases\/[0-9a-f-]{36}\/interviews\/[0-9a-f-]{36}$/);
  await expect(investigator.getByTestId("interviewee")).toContainText("الشاهد كابا");

  // 2. Schedule, invite, record the rights acknowledgement and the conduct.
  const schedule = investigator.getByTestId("schedule-form");
  await schedule.locator("#scheduledStart").fill(riyadhLocal(-2));
  await schedule.locator("#durationMinutes").fill("60");
  await schedule.locator("#mode").selectOption("IN_PERSON");
  await submit(investigator, "schedule-form");
  await expect(investigator.getByTestId("interview-status")).toHaveText("مجدولة");

  // The conduct step stays blocked until the invitation and the rights are on record.
  await investigator.getByTestId("notice-form").locator("#channel").selectOption("INTERNAL_EMAIL");
  await submit(investigator, "notice-form");
  await expect(investigator.getByTestId("notice-list")).toContainText("دعوة");
  await investigator.getByTestId("rights-form").locator("#noticeVersion").fill("SYNTHETIC-RIGHTS-V1");
  await submit(investigator, "rights-form");
  await expect(investigator.getByTestId("rights-status")).toContainText("SYNTHETIC-RIGHTS-V1");
  const conduct = investigator.getByTestId("conduct-form");
  await conduct.locator("#startedAt").fill(riyadhLocal(-2));
  await conduct.locator("#endedAt").fill(riyadhLocal(-1));
  await submit(investigator, "conduct-form");
  await expect(investigator.getByTestId("interview-status")).toHaveText("عُقدت");

  // 3. Statement: the database computes the SHA-256; the acknowledgement attests that exact value.
  const statement = investigator.getByTestId("statement-form");
  await statement
    .locator("#statementContent")
    .fill(`إفادة تجريبية ${stamp}: يؤكد الشاهد كابا مراجعة الفواتير.`);
  await statement.locator("#statementLanguage").selectOption("ar");
  await submit(investigator, "statement-form");
  await expect(investigator.getByTestId("statement-sha-v1")).toHaveText(/[0-9a-f]{64}/);
  const sha = (await investigator.getByTestId("statement-sha-v1").textContent())!.match(/[0-9a-f]{64}/)![0];
  await expect(investigator.getByTestId("statement-v1")).toContainText(`إفادة تجريبية ${stamp}`);
  const ack = investigator.getByTestId("ack-form");
  await ack.locator("#ackMethod").selectOption("SIGNED_PAPER");
  await ack.locator("#attestedSha256").fill("0".repeat(64));
  await ack.locator('button[type="submit"]').click();
  await expect(ack.getByTestId("action-error")).toContainText("البصمة لا تطابق");
  await ack.locator("#attestedSha256").fill(sha);
  await submit(investigator, "ack-form");
  await expect(investigator.getByTestId("statement-ack-v1")).toContainText("توقيع ورقي");

  // 4. Investigator A prepares; the review step is not theirs.
  await investigator.getByTestId("interview-action-PREPARE").locator('button[type="submit"]').click();
  await expect(investigator.getByTestId("interview-status")).toHaveText("مُعدّة");
  await expect(investigator.getByTestId("interview-action-REVIEW")).toHaveCount(0);
  await investigator.context().close();

  // 5. The lead reviews; the approval is then closed to them (separation of duties).
  const lead = await signIn(browser, "lead@example.test", "ar");
  await lead.goto(interviewUrl);
  await lead.getByTestId("interview-action-REVIEW").locator('button[type="submit"]').click();
  await expect(lead.getByTestId("interview-status")).toHaveText("مُراجَعة");
  await expect(lead.getByTestId("blocked-APPROVE")).toContainText("لا يجوز للشخص نفسه");
  await lead.context().close();

  // 6. The case manager approves; the interview is then read-only.
  const manager = await signIn(browser, "casemanager@example.test", "ar");
  await manager.goto(interviewUrl);
  await manager.getByTestId("interview-action-APPROVE").locator('button[type="submit"]').click();
  await expect(manager.getByTestId("interview-status")).toHaveText("معتمدة");
  await expect(manager.getByTestId("statement-form")).toHaveCount(0);
  await expect(manager.getByTestId("lifecycle-card")).toContainText("لا توجد خطوة مراجعة متاحة لك الآن.");
  await manager.goto(`${caseUrl}/interviews`);
  await expect(manager.getByTestId("interviews-table")).toContainText(`مقابلة الشاهد كابا ${stamp}`);
  await manager.context().close();

  // 7. An unassigned investigator gets nothing: not the list, not the interview.
  const outsider = await signIn(browser, "investigator.b@example.test", "ar");
  expect((await outsider.goto(interviewUrl))?.status()).toBe(404);
  expect((await outsider.goto(`${caseUrl}/interviews`))?.status()).toBe(404);
  await outsider.context().close();
});

test("the reporter interview never shows the reporter's identity", async ({ browser }) => {
  const investigator = await signIn(browser, "investigator.b@example.test", "en");
  await investigator.goto("/cases");
  await investigator.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0002"]').click();
  await expect(investigator.getByTestId("case-state")).toBeVisible();
  await investigator.goto(`${new URL(investigator.url()).pathname}/interviews`);
  await expect(investigator.getByTestId("interviews-table")).toContainText("Reporter (identity protected)");
  await investigator.getByTestId("interview-1").click();
  await expect(investigator.getByTestId("interviewee")).toContainText("Reporter (identity protected)");
  const html = await investigator.content();
  expect(html).not.toContain("Reporter Gamma");
  expect(html).not.toContain("reporter.gamma@example.test");
  await investigator.context().close();
});
