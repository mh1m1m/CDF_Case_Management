// WCAG 2.2 AA on a continuity import's page (UX redesign Phase 12 P12-6b-1; ADR-034) in Arabic and English, at a
// desktop and a phone width and at 320 px: the staged batch with its rows and the form that skips one, with the error
// summary of an empty submission; the batch once a row is skipped and the dry run is clean, with the submission's
// confirmation; and an approver's page with the approval's confirmation. Every disclosure is open, and each
// confirmation is cancelled, so nothing is recorded. Every batch left open is cancelled afterwards, so no approver
// keeps it in My Work. Synthetic cases only.
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { audit } from "./axe";
import { cancelOpenImport, closeFixtureConnections, stagedImport } from "../e2e/records-fixture";
import { signIn } from "../e2e/support";

const open: string[] = [];
test.afterEach(async () => {
  for (const batchId of open.splice(0)) await cancelOpenImport(batchId);
});
test.afterAll(closeFixtureConnections);

const WIDTHS = [1280, 390, 320] as const;
const IMPORTER = "casemanager@example.test";
const APPROVER = "grc.director@example.test";
const REASON = "Synthetic: a reason for the accessibility check.";

/** At each width: the page with its disclosures open passes axe (not at 320) and never scrolls sideways. */
async function check(page: Page, path: string, ready: string, locale: "ar" | "en") {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(path);
    await expect(page.getByTestId(ready).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await page.locator("main details").evaluateAll((all) => {
      for (const d of all) (d as HTMLDetailsElement).open = true;
    });
    if (width !== 320) await audit(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, `horizontal overflow on ${path} at ${width}px`).toBe(false);
  }
}

/** Opens the page at the desktop width, ready for a form to be filled. */
async function opened(page: Page, path: string, form: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(path);
  await expect(page.getByTestId(form)).toBeVisible();
}

/** Submits the form, checks its confirmation with axe and cancels it: nothing is recorded. */
async function confirmationPasses(page: Page, form: Locator) {
  await form.locator('button[type="submit"]').click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await audit(page);
  await dialog.getByTestId("confirm-cancel").click();
  await expect(dialog).toBeHidden();
}

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: the staged batch with its rows and the skip form, its error summary, and the submission's confirmation after a clean dry run pass axe and reflow`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const f = await stagedImport(`bcp-a11y-${locale}-${randomUUID().slice(0, 8)}`);
    open.push(f.batchId);
    const path = `/continuity/imports/${f.batchId}`;
    const importer = await signIn(browser, IMPORTER, locale);
    await check(importer, path, "bcp-skip-form", locale);

    // Skipping without a row or a reason is refused: the error summary takes the focus and links to each field.
    await opened(importer, path, "bcp-skip-form");
    const skip = importer.getByTestId("bcp-skip-form");
    await skip.locator('button[type="submit"]').click();
    const summary = skip.getByTestId("error-summary");
    await expect(summary).toBeFocused();
    await expect(summary.locator('a[href="#bcp-skip-row"]')).toHaveCount(1);
    await expect(skip.getByTestId("bcp-skip-row")).toHaveAttribute("aria-invalid", "true");
    await audit(importer);

    // The row skipped and a clean dry run: the submission, and its confirmation, cancelled.
    await skip.getByTestId("bcp-skip-row").selectOption(f.unsupportedRowId);
    await skip.getByTestId("bcp-skip-reason").fill(REASON);
    await skip.locator('button[type="submit"]').click();
    await expect(importer.getByTestId("bcp-row-02_CASE_MASTER-3")).toHaveAttribute("data-resolution", "SKIP");
    await importer.getByTestId("bcp-dry-run-form").locator('button[type="submit"]').click();
    await expect(importer.getByTestId("bcp-row-05_SUBJECTS-3-outcome")).toHaveAttribute("data-outcome", "OK");
    await check(importer, path, "bcp-submit-form", locale);
    await opened(importer, path, "bcp-submit-form");
    await confirmationPasses(importer, importer.getByTestId("bcp-submit-form"));
    await expect(importer.getByTestId("bcp-status")).toHaveAttribute("data-status", "STAGED");
    await importer.context().close();
  });

  test(`${locale}: an approver's page with the approval's confirmation passes axe and reflows`, async ({
    browser,
  }) => {
    const f = await stagedImport(`bcp-a11y-decide-${locale}-${randomUUID().slice(0, 8)}`, true);
    open.push(f.batchId);
    const path = `/continuity/imports/${f.batchId}`;
    const approver = await signIn(browser, APPROVER, locale);
    await check(approver, path, "bcp-approve-form", locale);
    await opened(approver, path, "bcp-approve-form");
    const approve = approver.getByTestId("bcp-approve-form");
    await approve.getByTestId("bcp-approve-reason").fill(REASON);
    await confirmationPasses(approver, approve);
    await expect(approver.getByTestId("bcp-status")).toHaveAttribute("data-status", "SUBMITTED");
    await approver.context().close();
  });
}
