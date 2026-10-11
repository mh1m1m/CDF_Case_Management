// RC-01 command-form contract in the browser, in Arabic (RTL) and English (LTR):
// - UX-001: a refused submit keeps every typed value and every choice (text, textarea, select, radio);
// - UX-030: the case-details form sends only what the user changed.
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./support";
import { closeFixtureConnections, receivedReport, reportStatus, screeningCase } from "./records-fixture";

test.afterAll(closeFixtureConnections);

async function openSeedCase(page: Page, suffix: string) {
  await page.goto("/cases");
  await page.locator(`[data-testid^="case-CDF-DEMO-"][data-testid$="-${suffix}"]`).click();
  await page.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
}

const submit = (page: Page, testId: string) =>
  page.getByTestId(testId).locator('button[type="submit"]').click();

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: a refused submit keeps every value and every choice`, async ({ browser }) => {
    // 1. Select, textarea and text (triage): a referral without a destination is refused by the shared schema.
    const report = await receivedReport(`keep-values-${locale}`);
    const triage = await signIn(browser, "triage@example.test", locale);
    await triage.goto(`/intake/${report.reportId}`);
    await expect(triage.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    const triageForm = triage.getByTestId("triage-form");
    const reason = `Synthetic: refer to the internal audit unit (${locale}).`;
    await triageForm.locator("#outcome").selectOption("REFER_OUT");
    await triageForm.locator("#reason").fill(reason);
    await triageForm.locator("#duplicateOf").fill("not-a-uuid");
    await submit(triage, "triage-form");
    await expect(triageForm.getByTestId("error-summary")).toBeVisible();
    await expect(triageForm.locator("#outcome")).toHaveValue("REFER_OUT");
    await expect(triageForm.locator("#reason")).toHaveValue(reason);
    await expect(triageForm.locator("#duplicateOf")).toHaveValue("not-a-uuid");
    expect(await reportStatus(report.reportId)).toBe("RECEIVED");
    await triage.context().close();

    // 2. Text, textarea and select (case details): a too-short title is refused; every edit stays.
    const manager = await signIn(browser, "casemanager@example.test", locale);
    await openSeedCase(manager, "0001");
    await manager.locator('details:has([data-testid="details-form"]) > summary').click();
    const details = manager.getByTestId("details-form");
    const summary = `Synthetic summary that must survive a refusal (${locale}).`;
    await details.locator("#title").fill("ab");
    await details.locator("#summary").fill(summary);
    await details.locator("#priority").selectOption("LOW");
    await submit(manager, "details-form");
    await expect(details.getByTestId("error-summary")).toBeVisible();
    await expect(details.locator("#title")).toHaveValue("ab");
    await expect(details.locator("#title")).toHaveAttribute("aria-invalid", "true");
    await expect(details.locator("#summary")).toHaveValue(summary);
    await expect(details.locator("#priority")).toHaveValue("LOW");

    // 3. Two selects and a text field (assignment): a too-short reason is refused; both choices stay.
    const assign = manager.getByTestId("assign-form");
    await assign.locator("#userId").selectOption({ index: 1 });
    const person = await assign.locator("#userId").inputValue();
    await assign.locator("#assignmentRole").selectOption("REVIEWER");
    await assign.locator("#assignReason").fill("abc");
    await submit(manager, "assign-form");
    await expect(assign.getByTestId("error-summary")).toBeVisible();
    await expect(assign.locator("#userId")).toHaveValue(person);
    await expect(assign.locator("#assignmentRole")).toHaveValue("REVIEWER");
    await expect(assign.locator("#assignReason")).toHaveValue("abc");

    // 4. A refusal by the database, not the schema (the closing reason is too short): the reason stays.
    const fresh = await screeningCase(`keep-reason-${locale}`);
    await manager.goto(`/cases/${fresh.caseId}`);
    const close = manager.getByTestId("transition-SCREEN_OUT");
    await close.locator("textarea").fill("short");
    await close.getByRole("button").click();
    await expect(close.getByRole("alert")).toBeVisible();
    await expect(close.locator("textarea")).toHaveValue("short");
    await expect(manager.getByTestId("case-state")).toHaveText(
      locale === "ar" ? "الفحص الأولي" : "Screening",
    );
    await manager.context().close();
  });
}

test("the details form sends only the fields the user changed (UX-030)", async ({ browser }) => {
  const fresh = await screeningCase("changed-only");
  const manager = await signIn(browser, "casemanager@example.test", "en");
  await manager.goto(`/cases/${fresh.caseId}`);
  const heading = manager.locator("h1");
  await expect(heading).toContainText("changed-only");
  const openDetails = () => manager.locator('details:has([data-testid="details-form"]) > summary').click();
  await openDetails();
  const details = manager.getByTestId("details-form");
  // The server action's body names each submitted field (React prefixes each name with a reference such as "_1_").
  const sent: string[][] = [];
  manager.on("request", (r) => {
    if (r.method() !== "POST" || !r.url().includes(`/cases/${fresh.caseId}`)) return;
    const fields = [...(r.postData() ?? "").matchAll(/name="(?:_?\d+_)?(title|summary|priority)"/g)];
    sent.push(fields.map((m) => m[1]!));
  });

  // Only the priority travels; the title and summary keep the values the page rendered.
  await details.locator("#priority").selectOption("MEDIUM");
  await submit(manager, "details-form");
  await expect(details.getByRole("status")).toBeVisible();
  expect(sent.at(-1)).toEqual(["priority"]);
  await expect(heading).toContainText("changed-only");

  // The form starts again from the stored values, so a second save sends only its own change.
  await details.locator("#title").fill("Synthetic title edited by the UX-030 check");
  await submit(manager, "details-form");
  await expect(heading).toContainText("Synthetic title edited by the UX-030 check");
  expect(sent.at(-1)).toEqual(["title"]);
  await manager.reload();
  await openDetails();
  await expect(details.locator("#priority")).toHaveValue("MEDIUM");
  await manager.context().close();
});
