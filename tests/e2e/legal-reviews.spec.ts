// Phase 12 P12-3a (ADR-057, migration 2095; Linear CDF-229): legal review and the authority's decision, in Arabic (RTL)
// and English (LTR), acted by the seed's demo Investigation Committee and Legal Reviewer Pi on a case referred from
// its investigation. The secretary asks for a review of the adopted package from the package's card, choosing the
// reviewer and the finding the page offers; the reviewer finds the request in My Work, reads the secretary's reason and
// the packet, and gives an opinion on a phone. The secretary then submits the package to the authority and records the
// CEO's decision from its source document; the case team read the package, the decision and the package as submitted
// from the case. On a restricted case the secretary waits for the case's authority, who approves the review from the
// case; the request then takes exactly the approved reviewer. Whoever the database refuses gets the same 404 as an id
// that names nothing. Every meeting made here is settled afterwards, and Investigator Alpha leaves each case again, so
// the seed's "my cases" stay as they were for the specs that count them (shell). Synthetic data only.
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  IC_DEMO,
  PROCEEDING_SUBJECT,
  REVIEW_REASON,
  closeFixtureConnections,
  endInvestigatorAssignment,
  latestRequest,
  legalReviewAsked,
  opinionGiven,
  packageForReview,
  restrictedPackageForReview,
  settleMeeting,
} from "./records-fixture";
import { signIn } from "./support";

const made: { meetingId: string; caseId: string; owner: "caseManager" | "grcDirector" }[] = [];
test.afterEach(async () => {
  for (const f of made.splice(0)) {
    await settleMeeting(f.meetingId);
    await endInvestigatorAssignment(f.caseId, f.owner);
  }
});
test.afterAll(closeFixtureConnections);

const REVIEWER = "legal.b@example.test";
const TEXT = {
  en: {
    reviewer: "Legal Reviewer Pi",
    opinion: "Synthetic: the warning is proportionate; note the response period, for the e2e check.",
    approvalRequired: "Restricted Case Authority",
  },
  ar: {
    reviewer: "المراجع القانوني باي",
    opinion: "Synthetic: the warning is proportionate; note the response period, for the e2e check.",
  },
} as const;

/** The fixture's person concerned, by name: on a committee page only inside a packet, as stored (ruling 4). */
const NAME = PROCEEDING_SUBJECT.replace(" (synthetic)", "");

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

/** The current minute in Riyadh (UTC+3, no daylight saving), as a datetime-local value: never in the future. */
const riyadhNow = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16);

for (const locale of ["ar", "en"] as const) {
  const text = TEXT[locale];

  test(`${locale}: the secretary asks for a legal review; the reviewer opens it from My Work, reads the packet and gives an opinion`, async ({
    browser,
  }) => {
    const f = await packageForReview(`legal-review-${locale}-${randomUUID().slice(0, 8)}`);
    made.push({ meetingId: f.meetingId, caseId: f.caseId, owner: "caseManager" });
    const proceeding = `/committee-proceedings/${f.committeeProceedingId}`;

    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await secretary.goto(proceeding);
    const legal = secretary.getByTestId("package-1-legal");
    await expect(legal.getByTestId("package-1-legal-required")).toBeVisible();
    await legal.getByTestId("package-1-legal-ask").click();
    await secretary.waitForURL(new RegExp(`/packages/${f.packageId}/legal-review$`));
    await expect(secretary.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(secretary.getByTestId("nav-committee")).toHaveAttribute("aria-current", "page");
    await expect(secretary.getByTestId("ask-purpose-banner")).toBeVisible();
    // What the packet carries besides: the adopted item, by number; the finding by allegation and person number.
    await expect(secretary.getByTestId("ask-carries")).toBeVisible();
    const form = secretary.getByTestId("ask-form");
    await form.getByLabel(text.reviewer).check();
    await expect(form.getByTestId("ask-finding-0")).toBeVisible();
    await expect(form.getByTestId("ask-finding")).not.toContainText(NAME);
    await form.getByTestId("ask-finding-0").check();
    await form.getByTestId("ask-reason").fill(REVIEW_REASON);
    await submitConfirmed(secretary, form);
    // Back on the proceeding: the package is with the reviewer, and the request may be cancelled.
    await secretary.waitForURL(new RegExp(`${proceeding}$`));
    await expect(secretary.getByTestId("package-1-status")).toHaveAttribute("data-status", "IN_LEGAL_REVIEW");
    const request = secretary.getByTestId("package-1-legal-request-1");
    await expect(request.getByTestId("package-1-legal-request-1-status")).toHaveAttribute(
      "data-status",
      "ASSIGNED",
    );
    await expect(request).toContainText(text.reviewer);
    await expect(request.getByTestId("package-1-legal-request-1-cancel")).toBeVisible();
    await expect(secretary.locator("main")).not.toContainText(NAME);
    await expect(secretary.locator("main")).not.toContainText(f.caseNumber);

    // The packet as sent, from the request: the item and the finding as stored, the person by the name stored then.
    await request.getByTestId("package-1-legal-request-1-packet").click();
    await secretary.waitForURL(/\/packets\/[0-9a-f-]{36}$/);
    await expect(secretary.getByTestId("packet-purpose-banner")).toBeVisible();
    await expect(secretary.getByTestId("packet-items")).toContainText(NAME);
    await expect(secretary.getByTestId("packet-finding-1")).toBeVisible();
    await secretary.getByTestId("packet-back").click();
    await secretary.waitForURL(new RegExp(`${proceeding}$`));
    await secretary.context().close();

    // The reviewer, on a phone: the request from My Work (a row that names neither the case's person nor the
    // secretary's reason), the reason on the request's page, the packet, then the opinion.
    const { requestId } = await latestRequest(f, f.packageId);
    const reviewer = await signIn(browser, REVIEWER, locale);
    await reviewer.setViewportSize({ width: 390, height: 844 });
    await reviewer.goto("/my-work");
    const row = reviewer
      .getByTestId("work-item-LEGAL_REVIEW_ASSIGNED")
      .filter({ has: reviewer.locator(`a[href="/legal-reviews/${requestId}"]`) });
    await expect(row).toHaveCount(1);
    await expect(row).not.toContainText(NAME);
    await expect(row).not.toContainText(REVIEW_REASON);
    await expectNoOverflow(reviewer, "My Work at 390px");
    await row.locator(`a[href="/legal-reviews/${requestId}"]`).click();
    await reviewer.waitForURL(new RegExp(`/legal-reviews/${requestId}$`));
    await expect(reviewer.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    // The request is the reviewer's own work: My Work stays the current area.
    await expect(reviewer.getByTestId("nav-my-work")).toHaveAttribute("aria-current", "page");
    await expect(reviewer.getByTestId("legal-review-status")).toHaveAttribute("data-status", "ASSIGNED");
    await expect(reviewer.getByTestId("legal-review-reason")).toContainText(REVIEW_REASON);
    await expect(reviewer.getByTestId("legal-review-purpose-banner")).toBeVisible();
    await expect(reviewer.getByTestId("legal-review-no-opinion")).toBeVisible();
    await expectNoOverflow(reviewer, "the reviewer's page at 390px");
    await reviewer.getByTestId("legal-review-packet-link").click();
    await reviewer.waitForURL(/\/legal-reviews\/[0-9a-f-]{36}\/packet$/);
    await expect(reviewer.getByTestId("packet-items")).toContainText(NAME);
    await expectNoOverflow(reviewer, "the reviewer's packet at 390px");
    await reviewer.getByTestId("packet-back").click();
    await reviewer.waitForURL(/\/legal-reviews\/[0-9a-f-]{36}$/);

    const give = reviewer.getByTestId("give-opinion-form");
    await give.getByTestId("give-opinion-CONCURS_WITH_COMMENTS").check();
    await give.getByTestId("give-opinion-text").fill(text.opinion);
    await submitConfirmed(reviewer, give);
    await expect(reviewer.getByTestId("legal-review-status")).toHaveAttribute("data-status", "OPINION_GIVEN");
    await expect(reviewer.getByTestId("legal-review-opinion-1")).toContainText(text.opinion);
    // A later opinion stays possible; the first is never edited.
    await expect(reviewer.getByTestId("supersede-opinion-form")).toBeVisible();
    await expect(reviewer.getByTestId("give-opinion-form")).toHaveCount(0);
    await expectNoOverflow(reviewer, "the reviewer's page after the opinion");
    await reviewer.context().close();

    // The committee's page: adopted again, with the opinion, and ready for the authority.
    const back = await signIn(browser, IC_DEMO.icSecretary, locale);
    await back.goto(proceeding);
    await expect(back.getByTestId("package-1-status")).toHaveAttribute("data-status", "ADOPTED");
    await expect(back.getByTestId("package-1-legal-request-1-status")).toHaveAttribute(
      "data-status",
      "OPINION_GIVEN",
    );
    await expect(back.getByTestId("package-1-legal-request-1-opinion")).toBeVisible();
    await expect(back.getByTestId("package-1-legal-request-1-cancel")).toHaveCount(0);
    await expect(back.getByTestId("package-1-authority-submit-form")).toBeVisible();
    await back.context().close();
  });

  test(`${locale}: the secretary submits to the authority and records the CEO's decision; the case team read both from the case`, async ({
    browser,
  }) => {
    const f = await packageForReview(`authority-${locale}-${randomUUID().slice(0, 8)}`);
    made.push({ meetingId: f.meetingId, caseId: f.caseId, owner: "caseManager" });
    await opinionGiven(await legalReviewAsked(f, f.packageId));
    const proceeding = `/committee-proceedings/${f.committeeProceedingId}`;

    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await secretary.goto(proceeding);
    const authority = secretary.getByTestId("package-1-authority");
    // The rule in force for the sanction, with its basis, before anything is submitted.
    await expect(authority.getByTestId("package-1-authority-rule-DISCIPLINARY_SANCTION")).toBeVisible();
    await submitConfirmed(secretary, authority.getByTestId("package-1-authority-submit-form"));
    await expect(secretary.getByTestId("package-1-status")).toHaveAttribute(
      "data-status",
      "AWAITING_AUTHORITY",
    );
    await expect(authority.getByTestId("package-1-authority-submission-1")).toBeVisible();
    await expect(authority.getByTestId("package-1-authority-to-decide-CEO")).toBeVisible();

    // The record form, from the CEO's source document.
    await authority.getByTestId("package-1-authority-record-CEO").click();
    await secretary.waitForURL(new RegExp(`/packages/${f.packageId}/decision/CEO$`));
    await expect(secretary.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(secretary.getByTestId("record-purpose-banner")).toBeVisible();
    await expect(secretary.getByTestId("record-scope")).toBeVisible();
    await expect(secretary.getByTestId("record-supersedes")).toHaveCount(0);
    const form = secretary.getByTestId("record-form");
    await form.getByTestId("record-outcome-APPROVE_AS_RECOMMENDED").check();
    await form.getByTestId("record-decided-at").fill(riyadhNow());
    await form.getByTestId("record-decided-by").fill("Chief Executive (synthetic)");
    await form.getByTestId("record-source").fill("MEMO-DEMO-E2E-2095");
    await form.getByTestId("record-signature-SIGNED").check();
    await form.locator("#record-more-sources").fill("MEMO-DEMO-E2E-2095-A\n\nMEMO-DEMO-E2E-2095-B");
    await form.getByTestId("record-condition-0-kind").selectOption("FOLLOW_UP_TASK");
    await form.getByTestId("record-condition-0-text").fill("Synthetic: confirm the warning was delivered.");
    await form.getByTestId("record-condition-0-due").fill("2026-12-31");
    await form.getByTestId("record-reason").fill("Synthetic: the CEO approved as recommended.");
    await expectNoOverflow(secretary, "the record page");
    await submitConfirmed(secretary, form);

    // Back on the proceeding: decided, with the decision as recorded.
    await secretary.waitForURL(new RegExp(`${proceeding}$`));
    await expect(secretary.getByTestId("package-1-status")).toHaveAttribute("data-status", "DECIDED");
    const decision = secretary.getByTestId("package-1-authority-decision-1");
    await expect(decision).toHaveAttribute("data-superseded", "false");
    await expect(decision.getByTestId("package-1-authority-decision-1-decided-at")).toBeVisible();
    await expect(decision).toContainText("MEMO-DEMO-E2E-2095-B");
    await expect(decision.getByTestId("package-1-authority-decision-1-conditions")).toContainText(
      "confirm the warning was delivered",
    );
    await expect(secretary.getByTestId("package-1-authority-record-CEO")).toHaveCount(0);
    await expect(secretary.locator("main")).not.toContainText(NAME);
    await secretary.context().close();

    // The case team, on the case's Proceedings tab: the same package, read only, and the package as submitted.
    const team = await signIn(browser, "casemanager@example.test", locale);
    await team.goto(`/cases/${f.caseId}/proceedings`);
    const section = team.getByTestId(/^committee-recommendations-\d+$/);
    await expect(section.getByTestId("package-1-status")).toHaveAttribute("data-status", "DECIDED");
    await expect(section.getByTestId("package-1-authority-decision-1")).toBeVisible();
    await expect(section.getByTestId("package-1-legal-request-1-status")).toHaveAttribute(
      "data-status",
      "OPINION_GIVEN",
    );
    await expect(section.locator("form")).toHaveCount(0);
    await section.getByTestId("package-1-authority-submission-1-packet").click();
    await team.waitForURL(new RegExp(`/cases/${f.caseId}/proceedings/packets/[0-9a-f-]{36}$`));
    await expect(team.getByTestId("packet-items")).toBeVisible();
    await expect(team.getByTestId("packet-opinion-1")).toBeVisible();
    await team.setViewportSize({ width: 390, height: 844 });
    await expectNoOverflow(team, "the case's packet at 390px");
    await team.context().close();
  });
}

test("en: on a restricted case the case's authority approves the review from the case, and the request takes exactly that reviewer", async ({
  browser,
}) => {
  const r = await restrictedPackageForReview(`restricted-review-${randomUUID().slice(0, 8)}`);
  made.push({ meetingId: r.meetingId, caseId: r.caseId, owner: "grcDirector" });
  const proceeding = `/committee-proceedings/${r.committeeProceedingId}`;

  // The secretary may not ask yet, and the page says why.
  const secretary = await signIn(browser, IC_DEMO.icSecretary);
  await secretary.goto(proceeding);
  await expect(secretary.getByTestId("package-1-legal-ask-blocked")).toContainText(TEXT.en.approvalRequired);
  await expect(secretary.getByTestId("package-1-legal-ask")).toHaveCount(0);
  expect((await secretary.goto(`${proceeding}/packages/${r.packageId}/legal-review`))?.status()).toBe(404);

  // The case owner, its Restricted Case Authority, approves from the case's Proceedings tab.
  const owner = await signIn(browser, "grc.director@example.test");
  await owner.goto(`/cases/${r.caseId}/proceedings`);
  await owner.getByTestId("package-1-approve-link").click();
  await owner.waitForURL(new RegExp(`/cases/${r.caseId}/proceedings/legal-review-approval/${r.packageId}$`));
  await expect(owner.getByTestId("approve-purpose-banner")).toBeVisible();
  const approve = owner.getByTestId("approve-form");
  await approve.getByLabel(TEXT.en.reviewer).check();
  await approve
    .getByTestId("approve-reason")
    .fill("Synthetic: a legal review is needed on this restricted case.");
  await submitConfirmed(owner, approve);
  // One approval waits at a time: the page now says so instead of offering another.
  await expect(owner.getByTestId("approve-pending")).toBeVisible();
  await expect(owner.getByTestId("approve-form")).toHaveCount(0);
  await owner.context().close();

  // The secretary's choices are now exactly the approval's reviewer, and never the approval's reason.
  await secretary.goto(proceeding);
  await secretary.getByTestId("package-1-legal-ask").click();
  await secretary.waitForURL(new RegExp(`/packages/${r.packageId}/legal-review$`));
  await expect(secretary.getByTestId("ask-restricted")).toBeVisible();
  const form = secretary.getByTestId("ask-form");
  await expect(form.locator('input[name="assignedTo"]')).toHaveCount(1);
  await expect(form).toContainText(TEXT.en.reviewer);
  await expect(secretary.locator("main")).not.toContainText(
    "a legal review is needed on this restricted case",
  );
  await form.getByTestId("ask-reviewer-0").check();
  await form.getByTestId("ask-reason").fill(REVIEW_REASON);
  await submitConfirmed(secretary, form);
  await secretary.waitForURL(new RegExp(`${proceeding}$`));
  await expect(secretary.getByTestId("package-1-legal-request-1-status")).toHaveAttribute(
    "data-status",
    "ASSIGNED",
  );
  await secretary.context().close();
});

test("whoever the database refuses gets the same 404 as an id that names nothing", async ({ browser }) => {
  const f = await packageForReview(`legal-review-404-${randomUUID().slice(0, 8)}`);
  made.push({ meetingId: f.meetingId, caseId: f.caseId, owner: "caseManager" });
  const proceeding = `/committee-proceedings/${f.committeeProceedingId}`;
  const ask = `${proceeding}/packages/${f.packageId}/legal-review`;
  const approval = `/cases/${f.caseId}/proceedings/legal-review-approval/${f.packageId}`;
  const nothing = [
    `/legal-reviews/${randomUUID()}`,
    "/legal-reviews/not-a-request",
    `/legal-reviews/${randomUUID()}/packet`,
    `${proceeding}/packets/${randomUUID()}`,
    `${proceeding}/packages/${randomUUID()}/legal-review`,
    `${proceeding}/packages/${f.packageId}/decision/CEO`,
    `${proceeding}/packages/${f.packageId}/decision/NOT_AN_AUTHORITY`,
  ];

  // Before the request: only the secretary asks; nobody approves on a case that is not restricted.
  const secretary = await signIn(browser, IC_DEMO.icSecretary);
  expect((await secretary.goto(ask))?.status()).toBe(200);
  for (const path of nothing) expect((await secretary.goto(path))?.status(), path).toBe(404);
  for (const email of [IC_DEMO.icMemberA, "admin@example.test", "casemanager@example.test", REVIEWER]) {
    const page = await signIn(browser, email);
    expect((await page.goto(ask))?.status(), `${email} ${ask}`).toBe(404);
    await page.context().close();
  }
  // The case team may open the approval page of a case that is not restricted, which says so and offers nothing.
  const team = await signIn(browser, "casemanager@example.test");
  expect((await team.goto(approval))?.status()).toBe(200);
  await expect(team.getByTestId("approve-refused")).toBeVisible();
  await expect(team.getByTestId("approve-form")).toHaveCount(0);
  await team.context().close();
  expect((await secretary.goto(approval))?.status()).toBe(404);

  // After it: the reviewer's page and packet are the assignee's alone; the committee's packet page is for the
  // proceeding's seats, the case's for the case team.
  const requestId = await legalReviewAsked(f, f.packageId);
  const { packetId } = await latestRequest(f, f.packageId);
  const review = [`/legal-reviews/${requestId}`, `/legal-reviews/${requestId}/packet`];
  const committeePacket = `${proceeding}/packets/${packetId}`;
  const casePacket = `/cases/${f.caseId}/proceedings/packets/${packetId}`;

  const reviewer = await signIn(browser, REVIEWER);
  for (const path of review) expect((await reviewer.goto(path))?.status(), path).toBe(200);
  for (const path of [committeePacket, casePacket, ...nothing.slice(0, 3)])
    expect((await reviewer.goto(path))?.status(), `reviewer ${path}`).toBe(404);
  await reviewer.context().close();

  for (const path of review) expect((await secretary.goto(path))?.status(), `secretary ${path}`).toBe(404);
  expect((await secretary.goto(committeePacket))?.status()).toBe(200);
  // Asked once, the package is with the reviewer: the ask page is gone for the secretary too.
  expect((await secretary.goto(ask))?.status()).toBe(404);
  await secretary.context().close();

  const member = await signIn(browser, IC_DEMO.icMemberA);
  for (const path of [...review, casePacket])
    expect((await member.goto(path))?.status(), `member ${path}`).toBe(404);
  expect((await member.goto(committeePacket))?.status()).toBe(200);
  await member.context().close();

  const caseTeam = await signIn(browser, "casemanager@example.test");
  for (const path of [...review, committeePacket])
    expect((await caseTeam.goto(path))?.status(), `case team ${path}`).toBe(404);
  expect((await caseTeam.goto(casePacket))?.status()).toBe(200);
  await caseTeam.context().close();

  // PLATFORM_ADMIN implies no case content and no seat (§21); another holder of the opinion permission is not the
  // assignee.
  for (const email of ["admin@example.test", "legal@example.test"]) {
    const page = await signIn(browser, email);
    for (const path of [...review, committeePacket, casePacket])
      expect((await page.goto(path))?.status(), `${email} ${path}`).toBe(404);
    await page.context().close();
  }
});
