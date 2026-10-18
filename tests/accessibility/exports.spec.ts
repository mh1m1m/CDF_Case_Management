// WCAG 2.2 AA on an export request's pages (UX redesign Phase 12 P12-6b-1; ADR-026) in Arabic and English, at a desktop
// and a phone width and at 320 px: the request page from the case; a draft with its forms, and the refused address
// with its error summary; the preview with the submission and its confirmation; an approver's page and preview with
// the approval's confirmation; and, on a restricted case, the authority's consent and its confirmation. Every
// disclosure is open, and each confirmation is cancelled, so nothing is recorded. Every export left open is
// cancelled afterwards, so no approver keeps it in My Work. Synthetic cases only.
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { audit } from "./axe";
import {
  EXPORT_TO,
  cancelOpenExport,
  closeFixtureConnections,
  preparedExport,
  restrictedExport,
  screeningCase,
} from "../e2e/records-fixture";
import { signIn } from "../e2e/support";

const open: { requestId: string; by: "caseManager" | "grcDeputy" }[] = [];
test.afterEach(async () => {
  for (const e of open.splice(0)) await cancelOpenExport(e.requestId, e.by);
});
test.afterAll(closeFixtureConnections);

const WIDTHS = [1280, 390, 320] as const;
const MANAGER = "casemanager@example.test";
const DIRECTOR = "grc.director@example.test";
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
  test(`${locale}: the request page, a draft with its forms and a refused address, and the preview with the submission's confirmation pass axe and reflow`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const label = `export-a11y-${locale}-${randomUUID().slice(0, 8)}`;
    const c = await screeningCase(`${label}-request`);
    const manager = await signIn(browser, MANAGER, locale);
    await check(manager, `/cases/${c.caseId}/export`, "request-export-form", locale);

    // An email for internal recipients is refused before anything is created: the error summary takes the focus.
    await opened(manager, `/cases/${c.caseId}/export`, "request-export-form");
    const request = manager.getByTestId("request-export-form");
    await request.getByTestId("request-export-format-EMAIL").check();
    await request.getByTestId("request-export-audience-INTERNAL").check();
    await request.locator('button[type="submit"]').click();
    await expect(request.getByTestId("error-summary")).toBeFocused();
    await audit(manager);

    // A draft with an item and an address: the forms that add more.
    const f = await preparedExport(label);
    open.push({ requestId: f.requestId, by: "caseManager" });
    const page = `/exports/${f.requestId}`;
    await check(manager, page, "export-add-recipient", locale);

    // Two addresses that differ: confirmed, then refused, and the error summary takes the focus.
    await opened(manager, page, "export-add-recipient");
    const recipient = manager.getByTestId("export-add-recipient");
    await recipient.getByTestId("export-recipient-email").fill("officer.gamma@example.test");
    await recipient.getByTestId("export-recipient-email-confirmation").fill(EXPORT_TO.address);
    await recipient.locator('button[type="submit"]').click();
    const dialog = manager.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await audit(manager);
    await dialog.getByTestId("confirm-submit").click();
    await expect(recipient.getByTestId("error-summary")).toBeFocused();
    await audit(manager);

    // The preview with the submission; its confirmation, cancelled.
    await check(manager, `${page}/preview`, "export-submit-form", locale);
    await opened(manager, `${page}/preview`, "export-submit-form");
    const submit = manager.getByTestId("export-submit-form");
    await submit.getByTestId("export-submit-confirm").check();
    await confirmationPasses(manager, submit);
    await manager.goto(page);
    await expect(manager.getByTestId("export-status")).toHaveAttribute("data-status", "DRAFT");
    await manager.context().close();
  });

  test(`${locale}: an approver's page and preview with the approval's confirmation, and the restricted case's consent with its confirmation, pass axe and reflow`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const label = `export-a11y-decide-${locale}-${randomUUID().slice(0, 8)}`;
    const f = await preparedExport(label, true);
    open.push({ requestId: f.requestId, by: "caseManager" });
    const director = await signIn(browser, DIRECTOR, locale);
    await check(director, `/exports/${f.requestId}`, "export-guide-preview", locale);
    await check(director, `/exports/${f.requestId}/preview`, "export-approve-form", locale);
    await opened(director, `/exports/${f.requestId}/preview`, "export-approve-form");
    const approve = director.getByTestId("export-approve-form");
    await approve.getByTestId("export-approve-reason").fill(REASON);
    await confirmationPasses(director, approve);

    // The GRC Director owns the restricted case: its authority's consent, apart from the stage.
    const r = await restrictedExport(`${label}-rca`);
    open.push({ requestId: r.requestId, by: "grcDeputy" });
    await check(director, `/exports/${r.requestId}`, "export-authority-decision", locale);
    await check(director, `/exports/${r.requestId}/preview`, "export-consent-form", locale);
    await opened(director, `/exports/${r.requestId}/preview`, "export-consent-form");
    const consent = director.getByTestId("export-consent-form");
    await consent.getByTestId("export-consent-reason").fill(REASON);
    await confirmationPasses(director, consent);
    await director.goto(`/exports/${r.requestId}`);
    await expect(director.getByTestId("export-authority-decision")).toHaveAttribute("data-decision", "NONE");
    await director.context().close();
  });
}
