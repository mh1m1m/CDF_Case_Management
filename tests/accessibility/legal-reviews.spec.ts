// WCAG 2.2 AA on the Phase 12 P12-3a pages (ADR-057) in Arabic and English, at a desktop and a phone width and at
// 320 px, acted by the seed's demo Investigation Committee and Legal Reviewer Pi: the secretary's page asking for a
// legal review, with its confirmation; the proceeding's page with the request and its packet; the reviewer's page and
// packet, with the opinion's confirmation; the proceeding's page with the package before the authority, the page
// recording the CEO's decision, with its confirmation, and the case's Proceedings tab and packet as the case team reads
// them; and, on a restricted case, its authority's approval page, with that confirmation, and the secretary's page
// once the approval is given. Every disclosure is open. Each meeting made here is settled afterwards, and Investigator
// Alpha leaves each case again, so the seed's "my cases" stay as they were. Synthetic cases only.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { audit } from "./axe";
import {
  IC_DEMO,
  REVIEW_REASON,
  closeFixtureConnections,
  endInvestigatorAssignment,
  latestRequest,
  legalReviewApproved,
  legalReviewAsked,
  opinionGiven,
  packageForReview,
  restrictedPackageForReview,
  settleMeeting,
  submittedToAuthority,
} from "../e2e/records-fixture";
import { signIn } from "../e2e/support";

const made: { meetingId: string; caseId: string; owner: "caseManager" | "grcDirector" }[] = [];
test.afterEach(async () => {
  for (const f of made.splice(0)) {
    await settleMeeting(f.meetingId);
    await endInvestigatorAssignment(f.caseId, f.owner);
  }
});
test.afterAll(closeFixtureConnections);

const WIDTHS = [1280, 390, 320] as const;
const REVIEWER = { ar: "المراجع القانوني باي", en: "Legal Reviewer Pi" } as const;

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
  return page.getByTestId(form);
}

/** Submits the form, checks its confirmation with axe, and cancels it. */
async function confirmationChecked(page: Page, form: string) {
  await page.getByTestId(form).locator('button[type="submit"]').click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await audit(page);
  await dialog.getByTestId("confirm-cancel").click();
  await expect(dialog).toBeHidden();
}

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: asking for a legal review, the request and its packet, and the reviewer's pages pass axe and reflow`, async ({
    browser,
  }) => {
    const f = await packageForReview(`legal-review-a11y-${locale}-${randomUUID().slice(0, 8)}`);
    made.push({ meetingId: f.meetingId, caseId: f.caseId, owner: "caseManager" });
    const proceeding = `/committee-proceedings/${f.committeeProceedingId}`;
    const ask = `${proceeding}/packages/${f.packageId}/legal-review`;

    // The ask page, then its confirmation; cancelled, nothing is asked.
    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await check(secretary, proceeding, "package-1-legal-ask", locale);
    await check(secretary, ask, "ask-form", locale);
    const form = await opened(secretary, ask, "ask-form");
    await form.getByLabel(REVIEWER[locale]).check();
    await form.getByTestId("ask-finding-0").check();
    await form.getByTestId("ask-reason").fill(REVIEW_REASON);
    await confirmationChecked(secretary, "ask-form");
    await expect(secretary.getByTestId("ask-form")).toBeVisible();

    // Asked: the request on the proceeding's page, with its cancel form, and the packet sent with it.
    const requestId = await legalReviewAsked(f, f.packageId);
    const { packetId } = await latestRequest(f, f.packageId);
    await check(secretary, proceeding, "package-1-legal-request-1-cancel", locale);
    await check(secretary, `${proceeding}/packets/${packetId}`, "packet-items", locale);
    await secretary.context().close();

    // The reviewer's page and packet, then the opinion's confirmation.
    const reviewer = await signIn(browser, "legal.b@example.test", locale);
    await check(reviewer, `/legal-reviews/${requestId}`, "give-opinion-form", locale);
    await check(reviewer, `/legal-reviews/${requestId}/packet`, "packet-items", locale);
    const give = await opened(reviewer, `/legal-reviews/${requestId}`, "give-opinion-form");
    await give.getByTestId("give-opinion-CONCURS_WITH_COMMENTS").check();
    await give
      .getByTestId("give-opinion-text")
      .fill("Synthetic: proportionate, for the accessibility check.");
    await confirmationChecked(reviewer, "give-opinion-form");
    await expect(reviewer.getByTestId("legal-review-status")).toHaveAttribute("data-status", "ASSIGNED");
    // Given: the opinion as recorded, and the form for a later one.
    await opinionGiven(requestId);
    await check(reviewer, `/legal-reviews/${requestId}`, "supersede-opinion-form", locale);
    await reviewer.context().close();
  });

  test(`${locale}: the package before the authority, recording the CEO's decision, and the case's read pass axe and reflow`, async ({
    browser,
  }) => {
    const f = await packageForReview(`authority-a11y-${locale}-${randomUUID().slice(0, 8)}`);
    made.push({ meetingId: f.meetingId, caseId: f.caseId, owner: "caseManager" });
    await opinionGiven(await legalReviewAsked(f, f.packageId));
    const proceeding = `/committee-proceedings/${f.committeeProceedingId}`;
    const record = `${proceeding}/packages/${f.packageId}/decision/CEO`;

    // Ready for the authority: the rule in force and the submit form; submitted: the authority still to decide.
    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await check(secretary, proceeding, "package-1-authority-submit-form", locale);
    await submittedToAuthority(f.packageId);
    await check(secretary, proceeding, "package-1-authority-record-CEO", locale);

    // The record page, then its confirmation; cancelled, nothing is recorded.
    await check(secretary, record, "record-form", locale);
    const form = await opened(secretary, record, "record-form");
    await form.getByTestId("record-outcome-APPROVE_AS_RECOMMENDED").check();
    await form
      .getByTestId("record-decided-at")
      .fill(new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16));
    await form.getByTestId("record-decided-by").fill("Chief Executive (synthetic)");
    await form.getByTestId("record-source").fill("MEMO-DEMO-A11Y-2095");
    await form.getByTestId("record-signature-SIGNED").check();
    await form.getByTestId("record-reason").fill("Synthetic: the CEO approved as recommended.");
    await confirmationChecked(secretary, "record-form");
    await expect(secretary.getByTestId("record-form")).toBeVisible();
    await secretary.context().close();

    // The case team, on the case's Proceedings tab and the package as submitted.
    const { packetId } = await latestRequest(f, f.packageId);
    const team = await signIn(browser, "casemanager@example.test", locale);
    await check(team, `/cases/${f.caseId}/proceedings`, "package-1-legal-request-1-status", locale);
    await check(team, `/cases/${f.caseId}/proceedings/packets/${packetId}`, "packet-items", locale);
    await team.context().close();
  });

  test(`${locale}: on a restricted case, the authority's approval page and the secretary's page after it pass axe and reflow`, async ({
    browser,
  }) => {
    const r = await restrictedPackageForReview(`restricted-a11y-${locale}-${randomUUID().slice(0, 8)}`);
    made.push({ meetingId: r.meetingId, caseId: r.caseId, owner: "grcDirector" });
    const proceeding = `/committee-proceedings/${r.committeeProceedingId}`;
    const approval = `/cases/${r.caseId}/proceedings/legal-review-approval/${r.packageId}`;

    // The secretary waits, and the page says why.
    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await check(secretary, proceeding, "package-1-legal-ask-blocked", locale);

    // The case's authority: the case's Proceedings tab with the approve link, the approval page, its confirmation.
    const owner = await signIn(browser, "grc.director@example.test", locale);
    await check(owner, `/cases/${r.caseId}/proceedings`, "package-1-approve-link", locale);
    await check(owner, approval, "approve-form", locale);
    const form = await opened(owner, approval, "approve-form");
    await form.getByLabel(REVIEWER[locale]).check();
    await form
      .getByTestId("approve-reason")
      .fill("Synthetic: a legal review is needed, for the accessibility check.");
    await confirmationChecked(owner, "approve-form");
    await expect(owner.getByTestId("approve-form")).toBeVisible();
    // Approved: one approval waits at a time, and the page says so.
    await legalReviewApproved(r.packageId);
    await check(owner, approval, "approve-pending", locale);
    await owner.context().close();

    // The secretary's ask page: exactly the approved reviewer.
    await check(secretary, `${proceeding}/packages/${r.packageId}/legal-review`, "ask-restricted", locale);
    await secretary.context().close();
  });
}
