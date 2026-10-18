// An export request's pages (UX redesign Phase 12 P12-6b-1; ADR-026; migration 2040's api.export_request_view), in
// Arabic (RTL) and English (LTR).
//
// The case manager asks for an email export of a fresh CONFIDENTIAL case from the case's own page (F1) and sends it to
// a synthetic external address. An email for internal recipients is refused before anything is created. The draft
// opens on its own page, where the case summary is added and the address typed twice (two that differ are refused,
// and nothing is added). The preview shows exactly what the export holds and binds the submission, which then waits
// for two approval stages (the external audience and the seeded EXTERNAL_CONFIDENTIAL rule, SOURCE_REQUIRED). The GRC
// Director finds the first stage in My Work and approves it on the preview, the GRC Deputy the second, and the
// requester generates the email and hands it to the mail relay (a stub; PRODUCTION_SUBSTITUTION_REQUIRED). Only the
// preview page records that the content was shown (EXPORT_PREVIEWED): the export's own page records nothing.
//
// On a restricted case the case's Restricted Case Authority, its owner, consents on the preview, apart from the approval
// stage (DEC-F23), and an approved PDF waits for its file (F6). A draft is its requester's alone: an approver gets the same
// 404 as an investigator who may not ask for an export, an id that names nothing and a malformed one. Every export left
// open is cancelled afterwards, so no approver keeps it in My Work. Synthetic data only.
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  EXPORT_TO,
  cancelOpenExport,
  closeFixtureConnections,
  endInvestigatorAssignment,
  preparedExport,
  previewsOf,
  restrictedExport,
  screeningCase,
  structureCase,
} from "./records-fixture";
import { signIn } from "./support";

/** Exports to cancel afterwards, by their requester; cases Investigator Alpha leaves again. */
const open: { requestId: string; by: "caseManager" | "grcDeputy" }[] = [];
const assigned: string[] = [];
test.afterEach(async () => {
  for (const e of open.splice(0)) await cancelOpenExport(e.requestId, e.by);
  for (const caseId of assigned.splice(0)) await endInvestigatorAssignment(caseId, "caseManager");
});
test.afterAll(closeFixtureConnections);

const MANAGER = "casemanager@example.test";
const DIRECTOR = "grc.director@example.test";
const DEPUTY = "grc.deputy@example.test";
const TEXT = {
  en: {
    purpose: "Regulatory or external authority",
    classification: "Confidential",
    mismatch: "The two addresses are not the same.",
    externalOnly: "An email export goes to external addresses: choose External, or another format.",
    title: { request: "Request an export", export: "Export request", preview: "Export preview" },
  },
  ar: {
    purpose: "جهة تنظيمية أو خارجية",
    classification: "سري",
    mismatch: "العنوانان غير متطابقين.",
    externalOnly: "تصدير البريد الإلكتروني يُرسَل إلى عناوين خارجية: اختر «خارجي»، أو صيغة أخرى.",
    title: { request: "تقديم طلب تصدير", export: "طلب التصدير", preview: "معاينة التصدير" },
  },
} as const;
/** Each approver's reason, shown with their stage on the export's page. */
const APPROVED = {
  first: "Synthetic: the summary holds nothing beyond what the regulator asked for.",
  second: "Synthetic: second approval for an external export of a confidential case.",
  authority: "Synthetic: the case's authority consents to this legal review copy.",
  stage: "Synthetic: approved for the legal review.",
} as const;

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

/** Opens the export from the reader's My Work row (an approval stage), which names it by its kind, never its content. */
async function fromMyWork(page: Page, requestId: string, caseTitle: string) {
  await page.goto("/my-work");
  const href = `/exports/${requestId}`;
  const row = page
    .getByTestId("work-item-EXPORT_TO_APPROVE")
    .filter({ has: page.locator(`a[href="${href}"]`) });
  await expect(row).toHaveCount(1);
  await expect(row).not.toContainText(caseTitle);
  await row.locator(`a[href="${href}"]`).click();
  await page.waitForURL(new RegExp(`/exports/${requestId}$`));
}

for (const locale of ["ar", "en"] as const) {
  const text = TEXT[locale];
  // Arabic at a phone width, English at a desktop one.
  const width = locale === "ar" ? 390 : 1280;

  test(`${locale}: the case manager asks for an export from the case, prepares, previews and submits it; two approvers each approve a stage on the preview; the requester sends it`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const label = `export-${locale}-${randomUUID().slice(0, 8)}`;
    const c = await screeningCase(label);
    const caseTitle = `Records e2e case ${label} (synthetic)`;
    const manager = await signIn(browser, MANAGER, locale);
    await manager.setViewportSize({ width, height: 900 });

    // The case's own page offers the request in its overflow menu (F1).
    await manager.goto(`/cases/${c.caseId}`);
    await manager.getByTestId("case-overflow").locator("summary").click();
    await manager.getByTestId("case-overflow-requestExport").click();
    await manager.waitForURL(new RegExp(`/cases/${c.caseId}/export$`));
    await expect(manager).toHaveTitle(titled(text.title.request));
    await expect(manager.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(manager.getByTestId("request-export-banner")).toBeVisible();
    await expectNoOverflow(manager, `the request page at ${width}px`);

    // An email goes outside only: for internal recipients it is refused, and nothing is created.
    const form = manager.getByTestId("request-export-form");
    await form.getByTestId("request-export-format-EMAIL").check();
    await form.getByTestId("request-export-audience-INTERNAL").check();
    await form.getByTestId("request-export-purpose").selectOption("REGULATORY_OR_EXTERNAL_AUTHORITY");
    await form.locator('button[type="submit"]').click();
    await expect(form.getByTestId("error-summary")).toContainText(text.externalOnly);
    await expect(manager).toHaveURL(new RegExp(`/cases/${c.caseId}/export$`));

    // The request: an email to an outside party, for a purpose of the governed catalogue, with its justification.
    await form.getByTestId("request-export-audience-EXTERNAL").check();
    await form.getByTestId("request-export-external-party").fill(EXPORT_TO.party);
    await form.getByTestId("request-export-justification").fill(EXPORT_TO.justification);
    await form.locator('button[type="submit"]').click();
    await manager.waitForURL(/\/exports\/[0-9a-f-]{36}\?done=created$/);
    const requestId = new URL(manager.url()).pathname.split("/").pop()!;
    open.push({ requestId, by: "caseManager" });

    // The draft's own page: what it is for, the purpose as the catalogue names it, and nothing in it yet.
    await expect(manager).toHaveTitle(titled(text.title.export));
    await expect(manager.getByTestId("export-done")).toBeVisible();
    await expect(manager.getByTestId("export-status")).toHaveAttribute("data-status", "DRAFT");
    await expect(manager.getByTestId("export-purpose")).toHaveText(text.purpose);
    await expect(manager.getByTestId("export-external-party")).toHaveText(EXPORT_TO.party);
    await expect(manager.getByTestId("export-case")).toHaveText(c.caseNumber);
    await expect(manager.getByTestId("export-no-items")).toBeVisible();
    await expect(manager.getByTestId("export-no-recipients")).toBeVisible();

    // The case summary, the one item this page adds (the other kinds wait for their choices, F9).
    await manager.getByTestId("export-add-summary").locator('button[type="submit"]').click();
    await expect(manager.getByTestId("export-item-1")).toHaveAttribute("data-included", "true");
    await expect(manager.getByTestId("export-add-summary")).toHaveCount(0);

    // The address, typed twice: two that differ are refused, and nothing is added.
    const recipient = manager.getByTestId("export-add-recipient");
    await recipient.getByTestId("export-recipient-email").fill(EXPORT_TO.address);
    await recipient.getByTestId("export-recipient-email-confirmation").fill("officer.beta@example.test");
    await submitConfirmed(manager, recipient);
    await expect(recipient.getByTestId("error-summary")).toContainText(text.mismatch);
    await expect(manager.getByTestId("export-no-recipients")).toBeVisible();
    await recipient.getByTestId("export-recipient-email-confirmation").fill(EXPORT_TO.address);
    await submitConfirmed(manager, recipient);
    await expect(manager.getByTestId("export-recipient-1")).toHaveAttribute("data-kind", "EXTERNAL");
    await expect(manager.getByTestId("export-recipient-1-address")).toHaveText(EXPORT_TO.address);
    // Nothing of the content was shown yet: the export's page never records a preview.
    expect(await previewsOf(requestId)).toBe(0);

    // The preview, on its own page: exactly what the export holds, what it needs now, and the submission.
    await manager.getByTestId("export-preview-link").click();
    await manager.waitForURL(new RegExp(`/exports/${requestId}/preview$`));
    await expect(manager).toHaveTitle(titled(text.title.preview));
    await expect(manager.getByTestId("export-document-case")).toHaveText(c.caseNumber);
    await expect(manager.getByTestId("export-document-classification")).toHaveText(text.classification);
    await expect(manager.getByTestId("export-document-item-1")).toContainText(caseTitle);
    await expect(manager.getByTestId("export-preview-withheld")).toHaveText("0");
    await expect(manager.getByTestId("export-preview-rule-EXTERNAL_CONFIDENTIAL")).toBeVisible();
    await expectNoOverflow(manager, `the preview at ${width}px`);
    expect(await previewsOf(requestId)).toBe(1);
    const submit = manager.getByTestId("export-submit-form");
    await submit.getByTestId("export-submit-confirm").check();
    await submitConfirmed(manager, submit);
    await manager.waitForURL(new RegExp(`/exports/${requestId}\\?done=submitted$`));

    // Submitted: two stages to give, the rule that asked for the second, the classification confirmed. Its requester
    // is never offered a decision (DEC-F24); they may still cancel it.
    await expect(manager.getByTestId("export-status")).toHaveAttribute("data-status", "SUBMITTED");
    await expect(manager.getByTestId("export-stage-1")).toHaveAttribute("data-decision", "NONE");
    await expect(manager.getByTestId("export-stage-2")).toHaveAttribute("data-decision", "NONE");
    await expect(manager.getByTestId("export-classification")).toHaveText(text.classification);
    await expect(manager.getByTestId("export-rule-EXTERNAL_CONFIDENTIAL")).toBeVisible();
    await expect(manager.getByTestId("export-guide-preview")).toHaveCount(0);
    await expect(manager.getByTestId("export-cancel")).toBeVisible();

    // The GRC Director gives the first stage, from My Work, on the preview.
    const director = await signIn(browser, DIRECTOR, locale);
    await director.setViewportSize({ width, height: 900 });
    await fromMyWork(director, requestId, caseTitle);
    await director.getByTestId("export-guide-preview").click();
    await director.waitForURL(new RegExp(`/exports/${requestId}/preview$`));
    await expect(director.getByTestId("export-document-item-1")).toContainText(caseTitle);
    await expect(director.getByTestId("export-submit")).toHaveCount(0);
    const first = director.getByTestId("export-approve-form");
    await first.getByTestId("export-approve-reason").fill(APPROVED.first);
    await submitConfirmed(director, first);
    await director.waitForURL(new RegExp(`/exports/${requestId}\\?done=approvedStage$`));
    await expect(director.getByTestId("export-status")).toHaveAttribute("data-status", "SUBMITTED");
    await expect(director.getByTestId("export-stage-1")).toHaveAttribute("data-decision", "APPROVED");
    await expect(director.getByTestId("export-stage-1")).toContainText(APPROVED.first);
    await expect(director.getByTestId("export-stage-2")).toHaveAttribute("data-decision", "NONE");
    // An approver who gave a stage gives no other.
    await expect(director.getByTestId("export-guide-preview")).toHaveCount(0);
    await director.context().close();

    // The GRC Deputy gives the second, the same way.
    const deputy = await signIn(browser, DEPUTY, locale);
    await deputy.setViewportSize({ width, height: 900 });
    await fromMyWork(deputy, requestId, caseTitle);
    await deputy.getByTestId("export-guide-preview").click();
    await deputy.waitForURL(new RegExp(`/exports/${requestId}/preview$`));
    const second = deputy.getByTestId("export-approve-form");
    await second.getByTestId("export-approve-reason").fill(APPROVED.second);
    await submitConfirmed(deputy, second);
    await deputy.waitForURL(new RegExp(`/exports/${requestId}\\?done=approved$`));
    await expect(deputy.getByTestId("export-status")).toHaveAttribute("data-status", "APPROVED");
    await expect(deputy.getByTestId("export-stage-2")).toHaveAttribute("data-decision", "APPROVED");
    await expect(deputy.getByTestId("export-generate")).toHaveCount(0);
    await deputy.context().close();

    // The requester generates the email and hands it to the mail relay; the stub relay takes it, so it is sent.
    await manager.goto(`/exports/${requestId}`);
    await expect(manager.getByTestId("export-status")).toHaveAttribute("data-status", "APPROVED");
    await submitConfirmed(manager, manager.getByTestId("export-generate-form"));
    await manager.waitForURL(new RegExp(`/exports/${requestId}\\?done=sent$`));
    await expect(manager.getByTestId("export-status")).toHaveAttribute("data-status", "SENT");
    for (const id of ["export-generate", "export-cancel", "export-guide-preview"])
      await expect(manager.getByTestId(id), id).toHaveCount(0);
    await expectNoOverflow(manager, `the sent export at ${width}px`);
    await manager.setViewportSize({ width: 320, height: 900 });
    await expectNoOverflow(manager, "the sent export at 320px");
    // Three people read the content, once each, on the preview; the export's page, read again and again, never.
    expect(await previewsOf(requestId)).toBe(3);
  });
}

test("ar: on a restricted case the case's authority consents on the preview, apart from the approval stage; the approved PDF waits for its file", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const f = await restrictedExport(`export-rca-${randomUUID().slice(0, 8)}`);
  open.push({ requestId: f.requestId, by: "grcDeputy" });

  // The GRC Director owns the case, so they are its Restricted Case Authority. The only other person who sees it, the
  // GRC Deputy, asked for the export and gives neither (DEC-F24, CDF-208), so the GRC Director also gives the stage.
  const authority = await signIn(browser, DIRECTOR, "ar");
  await authority.setViewportSize({ width: 320, height: 900 });
  await authority.goto(`/exports/${f.requestId}`);
  await expect(authority.getByTestId("export-authority-decision")).toHaveAttribute("data-decision", "NONE");
  await authority.getByTestId("export-guide-preview").click();
  await authority.waitForURL(new RegExp(`/exports/${f.requestId}/preview$`));
  await expect(authority.getByTestId("export-decide")).toBeVisible();
  const consent = authority.getByTestId("export-consent-form");
  await consent.getByTestId("export-consent-reason").fill(APPROVED.authority);
  await submitConfirmed(authority, consent);
  await authority.waitForURL(new RegExp(`/exports/${f.requestId}\\?done=consented$`));
  // Consent given; the stage still waits.
  await expect(authority.getByTestId("export-authority-decision")).toHaveAttribute(
    "data-decision",
    "APPROVED",
  );
  await expect(authority.getByTestId("export-stage-1")).toHaveAttribute("data-decision", "NONE");
  await expect(authority.getByTestId("export-status")).toHaveAttribute("data-status", "SUBMITTED");
  await expectNoOverflow(authority, "the consented export at 320px");

  await authority.getByTestId("export-guide-preview").click();
  await authority.waitForURL(new RegExp(`/exports/${f.requestId}/preview$`));
  // The authority decides once: only the stage is left.
  await expect(authority.getByTestId("export-authority-decide")).toHaveCount(0);
  const stage = authority.getByTestId("export-approve-form");
  await stage.getByTestId("export-approve-reason").fill(APPROVED.stage);
  await submitConfirmed(authority, stage);
  await authority.waitForURL(new RegExp(`/exports/${f.requestId}\\?done=approved$`));
  await expect(authority.getByTestId("export-status")).toHaveAttribute("data-status", "APPROVED");
  await authority.context().close();

  // The requester: approved, and the PDF's file waits for its renderer (F6); they may still cancel.
  const requester = await signIn(browser, DEPUTY, "ar");
  await requester.setViewportSize({ width: 320, height: 900 });
  await requester.goto(`/exports/${f.requestId}`);
  await expect(requester.getByTestId("export-generate-later")).toBeVisible();
  await expect(requester.getByTestId("export-generate")).toHaveCount(0);
  await expect(requester.getByTestId("export-cancel")).toBeVisible();
  await expectNoOverflow(requester, "the approved PDF at 320px");
});

test("a draft is its requester's alone; an investigator on the case may not ask for an export; anyone who may not see one, an id that names nothing and a malformed one get the same 404", async ({
  browser,
}) => {
  const f = await preparedExport(`export-404-${randomUUID().slice(0, 8)}`);
  open.push({ requestId: f.requestId, by: "caseManager" });
  const pages = [`/exports/${f.requestId}`, `/exports/${f.requestId}/preview`];

  // The GRC Director approves exports, but never sees a draft or its preview.
  const director = await signIn(browser, DIRECTOR);
  for (const path of pages) expect((await director.goto(path))?.status(), `director ${path}`).toBe(404);
  await director.context().close();

  // Investigator Alpha works a case but holds no EXPORT_REQUEST: no entry on the case, and the same 404 everywhere.
  const c = await structureCase(`export-inv-${randomUUID().slice(0, 8)}`);
  assigned.push(c.caseId);
  const investigator = await signIn(browser, "investigator.a@example.test");
  await investigator.goto(`/cases/${c.caseId}`);
  await investigator.getByTestId("case-overflow").locator("summary").click();
  await expect(investigator.getByTestId("case-overflow-myDeclaration")).toBeVisible();
  await expect(investigator.getByTestId("case-overflow-requestExport")).toHaveCount(0);
  for (const path of [`/cases/${c.caseId}/export`, ...pages])
    expect((await investigator.goto(path))?.status(), `investigator ${path}`).toBe(404);
  await investigator.context().close();

  // The requester: an id that names nothing and a malformed one.
  const manager = await signIn(browser, MANAGER);
  for (const path of [
    `/exports/${randomUUID()}`,
    `/exports/${randomUUID()}/preview`,
    "/exports/not-an-export",
    "/exports/not-an-export/preview",
  ])
    expect((await manager.goto(path))?.status(), path).toBe(404);
  // Nobody was shown the draft's content.
  expect(await previewsOf(f.requestId)).toBe(0);
});
