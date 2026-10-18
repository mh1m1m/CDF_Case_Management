// A continuity import's page (UX redesign Phase 12 P12-6b-1; ADR-034; migration 2110's api.bcp_import_batch_view), in
// Arabic (RTL) and English (LTR).
//
// The case manager, the seed's continuity operator (DEC-F30), staged a workbook for a fresh case that the GRC Deputy
// prepared and recorded offline: one subject row the platform imports and one row of a sheet it only records. The page
// lists the rows by sheet, metadata only, and says what still holds the submission. The importer skips the row that
// cannot be imported, runs the dry run and submits the batch as that dry run left it. The GRC Director finds it in My
// Work and approves it; the importer imports the rows, and the subject is on the case.
//
// A staged batch is its importer's alone: an approver gets the same 404 as an investigator, an id that names nothing and
// a malformed one. Once it is submitted, the approvers who see its case read it, but the workbook's preparer never
// decides on it and finds nothing of it in My Work. Every batch left open is cancelled afterwards, so no approver
// keeps it in My Work. Synthetic data only.
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { IMPORTED_SUBJECT, cancelOpenImport, closeFixtureConnections, stagedImport } from "./records-fixture";
import { signIn } from "./support";

/** Batches to cancel afterwards (their importer, the case manager, cancels each one still open). */
const open: string[] = [];
test.afterEach(async () => {
  for (const batchId of open.splice(0)) await cancelOpenImport(batchId);
});
test.afterAll(closeFixtureConnections);

const IMPORTER = "casemanager@example.test";
const APPROVER = "grc.director@example.test";
const PREPARER = "grc.deputy@example.test";
const TEXT = {
  en: { title: "Continuity import", preparer: "GRC Deputy Mu" },
  ar: { title: "استيراد استمرارية الأعمال", preparer: "نائب مدير الحوكمة مو" },
} as const;
const SKIPPED = "Synthetic: the case master row is recorded only; the case is already on the platform.";
const APPROVED = "Synthetic: the subject row matches the paper record, for the e2e check.";

/** Submits a command form and accepts its confirmation (UX-031). */
async function submitConfirmed(page: Page, form: Locator) {
  await form.locator('button[type="submit"]').click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("confirm-submit").click();
  await expect(dialog).toBeHidden();
}

async function expectNoOverflow(page: Page, what: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow, `horizontal overflow on ${what}`).toBe(false);
}

/** The page title's own part, before the app's name (WCAG 2.4.2). */
const titled = (text: string) => new RegExp(`^${text} · `);

/** The reader's My Work row for the batch, found by its link; it names the kind of work, never the rows. */
const workRow = (page: Page, batchId: string) =>
  page
    .getByTestId("work-item-IMPORT_TO_APPROVE")
    .filter({ has: page.locator(`a[href="/continuity/imports/${batchId}"]`) });

for (const locale of ["ar", "en"] as const) {
  const text = TEXT[locale];
  // Arabic at a phone width, English at a desktop one.
  const width = locale === "ar" ? 390 : 1280;

  test(`${locale}: the importer skips the row that cannot be imported, runs the dry run and submits; the GRC Director approves from My Work; the importer imports the rows`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const f = await stagedImport(`bcp-${locale}-${randomUUID().slice(0, 8)}`);
    open.push(f.batchId);
    const path = `/continuity/imports/${f.batchId}`;
    const subjectRow = "bcp-row-05_SUBJECTS-3";
    const masterRow = "bcp-row-02_CASE_MASTER-3";

    const importer = await signIn(browser, IMPORTER, locale);
    await importer.setViewportSize({ width, height: 900 });
    await importer.goto(path);
    await expect(importer).toHaveTitle(titled(text.title));
    await expect(importer.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(importer.getByTestId("bcp-status")).toHaveAttribute("data-status", "STAGED");
    await expect(importer.getByTestId("bcp-purpose-banner")).toBeVisible();
    await expect(importer.getByTestId("bcp-case")).toHaveText(f.caseNumber);
    // Who prepared the workbook, by the directory's name in the reader's language; the importer is the reader.
    await expect(importer.getByTestId("bcp-prepared-by")).toHaveText(text.preparer);

    // The rows, sheet by sheet, metadata only: the subject the platform imports, and a row of a sheet it only records,
    // which needs a decision. Until it has one and a dry run is clean, the import cannot be submitted.
    await expect(importer.getByTestId(subjectRow)).toHaveAttribute("data-state", "NEW");
    await expect(importer.getByTestId(subjectRow)).toHaveAttribute("data-resolution", "IMPORT");
    await expect(importer.getByTestId(masterRow)).toHaveAttribute("data-state", "UNSUPPORTED");
    await expect(importer.getByTestId(masterRow)).toHaveAttribute("data-resolution", "NONE");
    await expect(importer.getByTestId("bcp-count-rows")).toHaveText("2");
    await expect(importer.getByTestId("bcp-count-unresolved")).toHaveText("1");
    await expect(importer.getByTestId("bcp-needs-rows")).toBeVisible();
    await expect(importer.getByTestId("bcp-needs-dryRun")).toBeVisible();
    await expect(importer.getByTestId("bcp-submit")).toHaveCount(0);
    await expect(importer.getByTestId("bcp-decide")).toHaveCount(0);
    await expectNoOverflow(importer, `the staged import at ${width}px`);

    // The importer skips the row, with a reason; it keeps its place, skipped.
    const skip = importer.getByTestId("bcp-skip-form");
    await skip.getByTestId("bcp-skip-row").selectOption(f.unsupportedRowId);
    await skip.getByTestId("bcp-skip-reason").fill(SKIPPED);
    await skip.locator('button[type="submit"]').click();
    await expect(importer.getByTestId(masterRow)).toHaveAttribute("data-resolution", "SKIP");
    await expect(importer.getByTestId(masterRow)).toContainText(SKIPPED);
    await expect(importer.getByTestId("bcp-count-unresolved")).toHaveText("0");
    await expect(importer.getByTestId("bcp-needs-rows")).toHaveCount(0);

    // The dry run runs each row's command and undoes it: the subject row would be imported.
    await importer.getByTestId("bcp-dry-run-form").locator('button[type="submit"]').click();
    await expect(importer.getByTestId(`${subjectRow}-outcome`)).toHaveAttribute("data-outcome", "OK");
    await expect(importer.getByTestId("bcp-submit-needs")).toHaveCount(0);

    // Submitted as that dry run left it.
    await submitConfirmed(importer, importer.getByTestId("bcp-submit-form"));
    await importer.waitForURL(new RegExp(`${path}\\?done=submitted$`));
    await expect(importer.getByTestId("bcp-done")).toBeVisible();
    await expect(importer.getByTestId("bcp-status")).toHaveAttribute("data-status", "SUBMITTED");
    for (const id of ["bcp-skip", "bcp-dry-run", "bcp-submit", "bcp-decide", "bcp-apply"])
      await expect(importer.getByTestId(id), id).toHaveCount(0);
    // Its importer never decides on it, and may still cancel it.
    await expect(importer.getByTestId("bcp-cancel")).toBeVisible();

    // The GRC Director finds it in My Work, by its kind only, and approves it with a reason.
    const approver = await signIn(browser, APPROVER, locale);
    await approver.setViewportSize({ width, height: 900 });
    await approver.goto("/my-work");
    const row = workRow(approver, f.batchId);
    await expect(row).toHaveCount(1);
    await expect(row).not.toContainText(IMPORTED_SUBJECT);
    await row.locator(`a[href="${path}"]`).click();
    await approver.waitForURL(new RegExp(`${path}$`));
    await expect(approver.getByTestId(subjectRow)).toHaveAttribute("data-resolution", "IMPORT");
    for (const id of ["bcp-skip", "bcp-dry-run", "bcp-apply", "bcp-cancel"])
      await expect(approver.getByTestId(id), id).toHaveCount(0);
    const decide = approver.getByTestId("bcp-approve-form");
    await decide.getByTestId("bcp-approve-reason").fill(APPROVED);
    await submitConfirmed(approver, decide);
    await approver.waitForURL(new RegExp(`${path}\\?done=approved$`));
    await expect(approver.getByTestId("bcp-status")).toHaveAttribute("data-status", "APPROVED");
    await expect(approver.getByTestId("bcp-decision")).toContainText(APPROVED);
    await expect(approver.getByTestId("bcp-decide")).toHaveCount(0);
    await approver.goto("/my-work");
    await expect(workRow(approver, f.batchId)).toHaveCount(0);
    await approver.context().close();

    // The importer imports the rows, all at once; the subject is on the case.
    await importer.goto(path);
    await expect(importer.getByTestId("bcp-status")).toHaveAttribute("data-status", "APPROVED");
    await submitConfirmed(importer, importer.getByTestId("bcp-apply-form"));
    await importer.waitForURL(new RegExp(`${path}\\?done=imported$`));
    await expect(importer.getByTestId("bcp-status")).toHaveAttribute("data-status", "IMPORTED");
    for (const id of ["bcp-apply", "bcp-cancel"]) await expect(importer.getByTestId(id), id).toHaveCount(0);
    await expectNoOverflow(importer, `the imported batch at ${width}px`);
    await importer.setViewportSize({ width: 320, height: 900 });
    await expectNoOverflow(importer, "the imported batch at 320px");
    await importer.goto(`/cases/${f.caseId}/allegations`);
    await expect(importer.getByTestId("subjects")).toContainText(IMPORTED_SUBJECT);
  });
}

test("a staged batch is its importer's alone; once submitted, its approvers read it and the workbook's preparer never decides; anyone else, an id that names nothing and a malformed one get the same 404", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const label = randomUUID().slice(0, 8);
  const staged = await stagedImport(`bcp-404-staged-${label}`);
  const submitted = await stagedImport(`bcp-404-submitted-${label}`, true);
  open.push(staged.batchId, submitted.batchId);
  const stagedPath = `/continuity/imports/${staged.batchId}`;
  const submittedPath = `/continuity/imports/${submitted.batchId}`;

  // The GRC Director approves imports: never a staged one, the submitted one with its decision.
  const approver = await signIn(browser, APPROVER);
  expect((await approver.goto(stagedPath))?.status(), "approver, staged").toBe(404);
  expect((await approver.goto(submittedPath))?.status(), "approver, submitted").toBe(200);
  await expect(approver.getByTestId("bcp-decide")).toBeVisible();
  await approver.context().close();

  // The GRC Deputy prepared both workbooks and recorded their rows: they may read the submitted batch as an approver
  // who sees its case, never decide on it, and nothing of it waits for them in My Work.
  const preparer = await signIn(browser, PREPARER);
  expect((await preparer.goto(stagedPath))?.status(), "preparer, staged").toBe(404);
  expect((await preparer.goto(submittedPath))?.status(), "preparer, submitted").toBe(200);
  await expect(preparer.getByTestId("bcp-status")).toHaveAttribute("data-status", "SUBMITTED");
  for (const id of ["bcp-decide", "bcp-apply", "bcp-cancel", "bcp-skip", "bcp-guide-act"])
    await expect(preparer.getByTestId(id), id).toHaveCount(0);
  await preparer.goto("/my-work");
  await expect(workRow(preparer, submitted.batchId)).toHaveCount(0);
  await preparer.context().close();

  // Investigator Alpha neither imports nor approves, and is not on either case: the same 404.
  const investigator = await signIn(browser, "investigator.a@example.test");
  for (const path of [stagedPath, submittedPath])
    expect((await investigator.goto(path))?.status(), `investigator ${path}`).toBe(404);
  await investigator.context().close();

  // The importer: an id that names nothing, a malformed one, and a path under the root that is not a batch.
  const importer = await signIn(browser, IMPORTER);
  for (const path of [
    `/continuity/imports/${randomUUID()}`,
    "/continuity/imports/not-a-batch",
    `/continuity/${staged.batchId}`,
  ])
    expect((await importer.goto(path))?.status(), path).toBe(404);
});
