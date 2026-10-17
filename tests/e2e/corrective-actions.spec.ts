// A corrective action's page (UX redesign Phase 12; ADR-058, migration 2096), in Arabic (RTL) and English (LTR).
//
// P12-6a (Linear CDF-250): the owner opens the action from My Work and records its progress, then submits it as
// complete with the evidence the policy asks for; the case manager opens it from My Work, reads what was submitted and
// returns it saying what is missing; the owner reads why in the action's history and submits again; the manager
// verifies it and reopens it. The owner never gets the verifier's form, and the manager never gets the owner's. A
// return left open while another manager verifies records nothing, and the page says why at its top (CDF-232). An
// owner's report left open while the decision it carries out is superseded records nothing either: the answer says the
// action can't move for now, never what holds it, which only the case team reads.
//
// P12-3b (Linear CDF-230): a corrective action frozen because the decision it carries out was superseded
// (DEC-AMB-014). The demo Investigation Committee's decision is superseded after a member's upheld conflict; the case
// manager finds the frozen action on the case's Proceedings tab, under the closure step it holds on the overview and in
// My Work, and records on the action's page what the replacement decision decides of it, citing one of that decision's
// own source documents: a modification in English (the action carries its new wording and keeps the earlier one), a
// replacement by a new action in Arabic. A form left open while another manager records the disposition records
// nothing, and the page then shows the disposition recorded first, with the command's refusal at its top until the
// user navigates away (CDF-232). The action's owner reads its card and its history alone, and that reporting is
// paused, never why; an investigator on the case reads why it is frozen but gets no form; anyone else, the committee's
// secretary included, and an id that names nothing get the same 404. No page shows a disposition's reason (R3).
//
// Every meeting made here is settled afterwards, and Investigator Alpha leaves each case again, so the seed's "my
// cases" stay as they were for the specs that count them (shell). Synthetic data only.
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ACTION_OWNER,
  IC_DEMO,
  OPENED_ACTION,
  REPLACEMENT_SOURCES,
  SUBMITTED_COMPLETION,
  closeFixtureConnections,
  disposedAs,
  endInvestigatorAssignment,
  frozenAction,
  openedAction,
  settleMeeting,
  submittedAsComplete,
  supersededDecision,
  verifiedAs,
} from "./records-fixture";
import { signIn } from "./support";

const made: { meetingId: string; caseId: string }[] = [];
test.afterEach(async () => {
  for (const f of made.splice(0)) {
    await settleMeeting(f.meetingId);
    await endInvestigatorAssignment(f.caseId, "caseManager");
  }
});
test.afterAll(closeFixtureConnections);

const MANAGER = "casemanager@example.test";
/** The manager's reason for a disposition: recorded with it, never shown back (R3). */
const REASON = "Synthetic: the replacement decision changes what the action requires, for the e2e check.";
/** The wording the English modification gives the action. */
const MODIFIED_TITLE = "Synthetic: add a second approver above the threshold";
/** The action the Arabic replacement opens instead. */
const NEW_ACTION = {
  title: "Synthetic: review the approval limits every quarter",
  description: "Synthetic: Finance reviews the approval limits every quarter and reports the result.",
} as const;
const TEXT = {
  en: {
    owner: "Employee Chi",
    original: "The decision it was opened under",
    replacement: "The replacement decision, which re-adopted or modified it",
    version: "Revised: version 2",
  },
  ar: {
    owner: "الموظف كاي",
    original: "القرار الذي فُتح بموجبه",
    replacement: "القرار البديل الذي أعاد اعتماده أو عدّله",
  },
} as const;
const DISPOSITIONS = ["RE_ADOPT", "MODIFY", "WAIVE", "REPLACE_WITH_NEW_ACTION"] as const;

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

/** Opens a disposition's disclosure on the action's page; returns its form. */
async function dispositionForm(page: Page, d: (typeof DISPOSITIONS)[number]): Promise<Locator> {
  await page.getByTestId(`dispose-${d}`).locator("summary").click();
  const form = page.getByTestId(`dispose-${d}-form`);
  await expect(form).toBeVisible();
  return form;
}

/** The day this many days from today in Riyadh (UTC+3, no daylight saving), as a date input's value. */
const riyadhDay = (days: number) =>
  new Date(Date.now() + 3 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);

for (const locale of ["ar", "en"] as const) {
  const text = TEXT[locale];
  const disposition = locale === "en" ? "modification" : "replacement by a new action";

  test(`${locale}: the case manager finds the frozen action on the case, under the closure step and in My Work, and records the replacement decision's ${disposition}`, async ({
    browser,
  }) => {
    const f = await frozenAction(`frozen-${locale}-${randomUUID().slice(0, 8)}`);
    made.push({ meetingId: f.meetingId, caseId: f.caseId });
    const manager = await signIn(browser, MANAGER, locale);

    // The case's Proceedings tab: the action, why it may not move, when its decision was superseded, and the way to
    // the disposition.
    await manager.goto(`/cases/${f.caseId}/proceedings`);
    await expect(manager.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    const row = manager.getByTestId("case-action-1");
    await expect(row).toHaveAttribute("data-block", "FROZEN_BY_SUPERSEDED_DECISION");
    await expect(row.getByTestId("case-action-1-block")).toBeVisible();
    await expect(row.getByTestId("case-action-1-superseded-on")).toBeVisible();
    await expect(row).toContainText(text.owner);
    await expect(row.getByTestId("case-action-1-dispose")).toHaveAttribute(
      "href",
      `/actions/${f.actionId}#dispose`,
    );

    // The overview: the step out of the case's stage that the frozen action holds names it.
    await manager.goto(`/cases/${f.caseId}`);
    await expect(manager.locator(`[data-testid^="frozen-"] a[href="/actions/${f.actionId}"]`)).toHaveCount(1);

    // My Work: the action to dispose of, by its kind and case, never its wording; it opens the disposition.
    await manager.goto("/my-work");
    const work = manager
      .getByTestId("work-item-ACTION_TO_DISPOSE")
      .filter({ has: manager.locator(`a[href="/actions/${f.actionId}#dispose"]`) });
    await expect(work).toHaveCount(1);
    await expect(work).not.toContainText(OPENED_ACTION.title);
    await work.locator(`a[href="/actions/${f.actionId}#dispose"]`).click();
    await manager.waitForURL(new RegExp(`/actions/${f.actionId}#dispose$`));

    // The action's page: its card, the decision it carries out, why it is frozen, and one form for each disposition
    // the replacement decision allows.
    await expect(manager.getByTestId("action-title")).toHaveText(OPENED_ACTION.title);
    await expect(manager.getByTestId("action-owner")).toContainText(text.owner);
    await expect(manager.getByTestId("action-block")).toHaveAttribute(
      "data-block",
      "FROZEN_BY_SUPERSEDED_DECISION",
    );
    await expect(manager.getByTestId("action-superseded-on")).toBeVisible();
    await expect(manager.getByTestId("action-governing")).toHaveText(text.original);
    for (const d of DISPOSITIONS) await expect(manager.getByTestId(`dispose-${d}`), d).toBeVisible();
    await manager.setViewportSize({ width: 390, height: 844 });
    await expectNoOverflow(manager, "the action's page at 390px");
    await manager.setViewportSize({ width: 1280, height: 900 });

    if (locale === "en") {
      const form = await dispositionForm(manager, "MODIFY");
      // The replacement decision's two documents to cite, and the action's wording to change.
      const documents = form.getByTestId("dispose-MODIFY-document");
      await expect(documents.locator("option:not([disabled])")).toHaveCount(REPLACEMENT_SOURCES.length);
      await documents.selectOption(REPLACEMENT_SOURCES[1]);
      await expect(form.getByTestId("dispose-MODIFY-title")).toHaveValue(OPENED_ACTION.title);
      await form.getByTestId("dispose-MODIFY-title").fill(MODIFIED_TITLE);
      await form.getByTestId("dispose-MODIFY-reason").fill(REASON);
      await submitConfirmed(manager, form);

      // Modified: the new wording, the earlier one kept, the disposition as recorded, nothing left to dispose of.
      const recorded = manager.getByTestId("action-disposition-1");
      await expect(recorded).toHaveAttribute("data-disposition", "MODIFY");
      await expect(recorded).toContainText(REPLACEMENT_SOURCES[1]);
      await expect(manager.getByTestId("action-title")).toHaveText(MODIFIED_TITLE);
      await expect(manager.getByTestId("action-version")).toHaveText(TEXT.en.version);
      await expect(manager.getByTestId("action-version-1")).toContainText(OPENED_ACTION.title);
      await expect(manager.getByTestId("action-governing")).toHaveText(text.replacement);
      await expect(manager.getByTestId("action-block")).toHaveCount(0);
      await expect(manager.getByTestId("action-dispose")).toHaveCount(0);
    } else {
      const form = await dispositionForm(manager, "REPLACE_WITH_NEW_ACTION");
      const id = "dispose-REPLACE_WITH_NEW_ACTION";
      await form.getByTestId(`${id}-document`).selectOption(REPLACEMENT_SOURCES[0]);
      await form.getByTestId(`${id}-title`).fill(NEW_ACTION.title);
      await form.getByTestId(`${id}-description`).fill(NEW_ACTION.description);
      // The implementation owners the manager may name.
      await expect(form.getByTestId(`${id}-owner`).locator("option:not([disabled])")).toHaveCount(1);
      await form.getByTestId(`${id}-owner`).selectOption(ACTION_OWNER.id);
      await form.getByTestId(`${id}-due`).fill(riyadhDay(20));
      await form.getByTestId(`${id}-reason`).fill(REASON);
      await submitConfirmed(manager, form);

      // Replaced: the action ends, saying so, and links to the new action, which links back.
      const recorded = manager.getByTestId("action-disposition-1");
      await expect(recorded).toHaveAttribute("data-disposition", "REPLACE_WITH_NEW_ACTION");
      await expect(manager.getByTestId("action-block")).toHaveAttribute(
        "data-block",
        "REPLACED_BY_NEW_ACTION",
      );
      await expect(manager.getByTestId("action-dispose")).toHaveCount(0);
      await expect(manager.locator("main")).not.toContainText(REASON);
      await recorded.getByTestId("action-disposition-1-new-action").click();
      await manager.waitForURL(
        (url) => /\/actions\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.includes(f.actionId),
      );
      await expect(manager.getByTestId("action-title")).toHaveText(NEW_ACTION.title);
      await expect(manager.getByTestId("action-owner")).toContainText(text.owner);
      await expect(manager.getByTestId("action-replaces")).toHaveAttribute("href", `/actions/${f.actionId}`);
      await expect(manager.getByTestId("action-block")).toHaveCount(0);
    }
    await expect(manager.locator("main")).not.toContainText(REASON);

    // Back on the case: nothing frozen holds the closure step, and the list names no reason.
    await manager.goto(`/cases/${f.caseId}/proceedings`);
    await expect(manager.getByTestId("case-action-1")).not.toHaveAttribute(
      "data-block",
      "FROZEN_BY_SUPERSEDED_DECISION",
    );
    await expect(manager.getByTestId("case-action-1-dispose")).toHaveCount(0);
    if (locale === "ar") {
      await expect(manager.getByTestId("case-action-1-replaced-by")).toBeVisible();
      await expect(manager.getByTestId("case-action-2-replaces")).toHaveAttribute(
        "href",
        `/actions/${f.actionId}`,
      );
    }
    await expect(manager.locator("main")).not.toContainText(REASON);
    await manager.goto(`/cases/${f.caseId}`);
    await expect(manager.locator('[data-testid^="frozen-"]')).toHaveCount(0);
  });

  test(`${locale}: the action's owner reads its card and its history alone, and that reporting is paused`, async ({
    browser,
  }) => {
    const f = await frozenAction(`frozen-owner-${locale}-${randomUUID().slice(0, 8)}`);
    made.push({ meetingId: f.meetingId, caseId: f.caseId });
    const owner = await signIn(browser, ACTION_OWNER.email, locale);
    await owner.setViewportSize({ width: 390, height: 844 });
    await owner.goto(`/actions/${f.actionId}`);
    await expect(owner.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(owner.getByTestId("action-title")).toHaveText(OPENED_ACTION.title);
    await expect(owner.getByTestId("action-description")).toHaveText(OPENED_ACTION.description);
    await expect(owner.getByTestId("action-owner")).toContainText(text.owner);
    // Their own work: My Work stays the current area, and nothing of the case shows. While the action is frozen they
    // read that reporting is paused, never why, and its history (P12-6a).
    await expect(owner.getByTestId("nav-my-work")).toHaveAttribute("aria-current", "page");
    for (const id of [
      "action-origin",
      "action-block",
      "action-dispositions",
      "action-dispose",
      "action-dispose-not-yours",
      "action-report",
    ])
      await expect(owner.getByTestId(id), id).toHaveCount(0);
    await expect(owner.getByTestId("action-report-paused")).toBeVisible();
    await expect(owner.getByTestId("action-event-1")).toHaveAttribute("data-event", "OPENED");
    await expect(owner.locator("main")).not.toContainText(f.caseNumber);
    await expectNoOverflow(owner, "the owner's card at 390px");
  });
}

test("ar: a form left open while another manager records the disposition records nothing; the page then shows the disposition recorded first", async ({
  browser,
}) => {
  const f = await frozenAction(`frozen-stale-${randomUUID().slice(0, 8)}`);
  made.push({ meetingId: f.meetingId, caseId: f.caseId });
  const manager = await signIn(browser, MANAGER, "ar");
  await manager.goto(`/actions/${f.actionId}`);
  const form = await dispositionForm(manager, "RE_ADOPT");
  await form.getByTestId("dispose-RE_ADOPT-document").selectOption(REPLACEMENT_SOURCES[0]);
  await form.getByTestId("dispose-RE_ADOPT-reason").fill(REASON);
  // Meanwhile the GRC Director, who also manages the case's actions, waives it.
  const waiver = "Synthetic: waived by another manager meanwhile, for the e2e check.";
  await disposedAs("grcDirector", f.actionId, "WAIVE", waiver);
  await submitConfirmed(manager, form);
  // The command refuses (the replacement decision has already decided), and the page, read again, shows what was
  // decided in place of the forms: the waiver alone, never the reason given.
  await expect(manager.getByTestId("action-dispose")).toHaveCount(0);
  await expect(manager.getByTestId("action-block")).toHaveAttribute(
    "data-block",
    "WAIVED_BY_SUPERSEDING_DECISION",
  );
  await expect(manager.getByTestId("action-disposition-1")).toHaveAttribute("data-disposition", "WAIVE");
  await expect(manager.getByTestId("action-disposition-2")).toHaveCount(0);
  await expect(manager.locator("main")).not.toContainText(waiver);
  await expect(manager.locator("main")).not.toContainText(REASON);
  // CDF-232: the form left the page with its refusal, so the top of the page says why nothing was recorded: the
  // class of refusal, the command's own words and the reference, nothing about the other manager or their decision.
  // Focus, which the form's button held, moves to the notice; the refusal shows once.
  const notice = manager.getByTestId("refusal-notice");
  await expect(notice).toHaveAttribute("data-kind", "CONFLICT");
  await expect(notice).toHaveText(
    /^غير ممكن الآن\s*قرّر القرار البديل مصير هذا الإجراء بالفعل\. المرجع: [0-9a-f-]{36}$/,
  );
  await expect(notice).toBeFocused();
  await expect(manager.locator("main").getByText("غير ممكن الآن")).toHaveCount(1);
  await expect(manager.getByTestId("action-error")).toHaveCount(0);
  // It clears on navigation: the breadcrumb back to the case's Proceedings tab shows no notice.
  await manager.getByTestId("breadcrumbs").getByRole("link").last().click();
  await expect(manager).toHaveURL(/\/proceedings$/);
  await expect(manager.getByTestId("case-action-1")).toBeVisible();
  await expect(manager.getByTestId("refusal-notice")).toHaveCount(0);
});

test("an investigator on the case reads why the action is frozen but gets no form; anyone else, and an id that names nothing, get the same 404", async ({
  browser,
}) => {
  const f = await frozenAction(`frozen-404-${randomUUID().slice(0, 8)}`);
  made.push({ meetingId: f.meetingId, caseId: f.caseId });

  // Investigator Alpha is on the case's team but does not manage its actions.
  const investigator = await signIn(browser, "investigator.a@example.test");
  await investigator.goto(`/actions/${f.actionId}`);
  await expect(investigator.getByTestId("action-block")).toHaveAttribute(
    "data-block",
    "FROZEN_BY_SUPERSEDED_DECISION",
  );
  await expect(investigator.getByTestId("action-dispose-not-yours")).toBeVisible();
  await expect(investigator.getByTestId("action-dispose")).toHaveCount(0);
  await investigator.goto(`/cases/${f.caseId}/proceedings`);
  await expect(investigator.getByTestId("case-action-1")).toBeVisible();
  await expect(investigator.getByTestId("case-action-1-dispose")).toHaveCount(0);
  await investigator.context().close();

  // The committee's secretary recorded both decisions but is not on the case; the records officer has nothing to do
  // with it. Each gets the same 404 as an id that names nothing.
  for (const email of [IC_DEMO.icSecretary, "records@example.test"]) {
    const page = await signIn(browser, email);
    expect((await page.goto(`/actions/${f.actionId}`))?.status(), email).toBe(404);
    expect(
      (await page.goto(`/actions/${randomUUID()}`))?.status(),
      `${email}: an id that names nothing`,
    ).toBe(404);
    await page.context().close();
  }
  const manager = await signIn(browser, MANAGER);
  for (const path of [`/actions/${randomUUID()}`, "/actions/not-an-action"])
    expect((await manager.goto(path))?.status(), path).toBe(404);
});

// ---- The owner's report, the verification and a reopening (P12-6a) --------------------------------------------------

/** What the owner and the case manager write in the P12-6a journey: each goes in the action's history. */
const JOURNEY = {
  progress: "Synthetic: the second approver has been named.",
  first: "Synthetic: the procedure now names a second approver.",
  firstReference: "DOC-DEMO-2026-E2E-11",
  returned: "Synthetic: the procedure is not yet signed by Finance.",
  second: "Synthetic: Finance signed the procedure.",
  secondReference: "DOC-DEMO-2026-E2E-12",
  verified: "Synthetic: checked against the signed procedure.",
  reopened: "Synthetic: the control failed again at the next review.",
} as const;
/** The reader's own entries in the history say so; the case manager's name never shows to the owner. */
const HISTORY_TEXT = {
  en: { byYou: "· by you", manager: "Case Manager Gamma" },
  ar: { byYou: "· بواسطتك", manager: "مدير القضايا جاما" },
} as const;

/**
 * Opens the action from the reader's My Work row of this category, which links to the step the reader takes on the
 * action's page; the row names the action by its kind and case, never its wording.
 */
async function fromMyWork(page: Page, category: string, actionId: string, step: "report" | "verify") {
  await page.goto("/my-work");
  const href = `/actions/${actionId}#${step}`;
  const row = page.getByTestId(`work-item-${category}`).filter({ has: page.locator(`a[href="${href}"]`) });
  await expect(row, category).toHaveCount(1);
  await expect(row).not.toContainText(OPENED_ACTION.title);
  await row.locator(`a[href="${href}"]`).click();
  await page.waitForURL(new RegExp(`/actions/${actionId}#${step}$`));
}

/** The kinds of the entries in the action's history, as the page lists them: the latest first. */
const historyOf = (page: Page) =>
  page
    .locator('[data-testid^="action-event-"][data-event]')
    .evaluateAll((all) => all.map((e) => e.getAttribute("data-event")));

for (const locale of ["ar", "en"] as const) {
  // Arabic at a phone width, English at a desktop one.
  const width = locale === "ar" ? 390 : 1280;
  const words = HISTORY_TEXT[locale];

  test(`${locale}: the owner reports from My Work and submits the action as complete; the case manager returns it, the owner submits again, and the manager verifies and reopens it`, async ({
    browser,
  }) => {
    const f = await openedAction(`report-${locale}-${randomUUID().slice(0, 8)}`);
    made.push({ meetingId: f.meetingId, caseId: f.caseId });
    const owner = await signIn(browser, ACTION_OWNER.email, locale);
    await owner.setViewportSize({ width, height: 844 });
    const manager = await signIn(browser, MANAGER, locale);
    await manager.setViewportSize({ width, height: 844 });

    // The owner, from My Work to their report: progress first, then the completion with the evidence the policy asks
    // for (a reference, with any kind of evidence or none). Nothing of the case's or the verifier's shows.
    await fromMyWork(owner, "ACTION_ASSIGNED", f.actionId, "report");
    await expect(owner.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(owner.getByTestId("action-status")).toHaveAttribute("data-status", "OPEN");
    for (const id of ["action-origin", "action-verify", "action-reopen", "action-dispose"])
      await expect(owner.getByTestId(id), id).toHaveCount(0);
    const progress = owner.getByTestId("action-progress-form");
    await progress.getByTestId("action-progress-percent").fill("40");
    await progress.getByTestId("action-progress-note").fill(JOURNEY.progress);
    await progress.locator('button[type="submit"]').click();
    await expect(owner.getByTestId("action-status")).toHaveAttribute("data-status", "IN_PROGRESS");
    await expect(owner.getByTestId("action-event-1")).toHaveAttribute("data-event", "PROGRESS");
    await expect(owner.getByTestId("action-event-1")).toContainText(words.byYou);
    await expect(owner.getByTestId("action-event-1-note")).toHaveText(JOURNEY.progress);
    await expectNoOverflow(owner, `the owner's report at ${width}px`);

    const complete = owner.getByTestId("action-complete-form");
    await complete.getByTestId("action-complete-note").fill(JOURNEY.first);
    await complete.getByTestId("action-complete-reference").fill(JOURNEY.firstReference);
    await complete.getByTestId("action-complete-type").selectOption("REVISED_PROCEDURE");
    await submitConfirmed(owner, complete);
    // Submitted: someone other than its owner verifies it, so the owner reads a line saying so and no form.
    await expect(owner.getByTestId("action-status")).toHaveAttribute("data-status", "PENDING_VERIFICATION");
    await expect(owner.getByTestId("action-awaiting-verification")).toBeVisible();
    await expect(owner.getByTestId("action-reached")).toBeVisible();
    for (const id of ["action-report", "action-verify"])
      await expect(owner.getByTestId(id), id).toHaveCount(0);
    await expect(owner.getByTestId("action-event-1")).toHaveAttribute("data-event", "COMPLETION_SUBMITTED");
    await expect(owner.getByTestId("action-event-1-evidence")).toContainText(JOURNEY.firstReference);

    // The case manager, from My Work to the verification: what was submitted, then a return saying what is missing.
    // They manage the action, so they get no report of their own.
    await fromMyWork(manager, "ACTION_TO_VERIFY", f.actionId, "verify");
    await expect(manager.getByTestId("action-submission-note")).toHaveText(JOURNEY.first);
    await expect(manager.getByTestId("action-submission-evidence")).toContainText(JOURNEY.firstReference);
    await expect(manager.getByTestId("action-report")).toHaveCount(0);
    await expectNoOverflow(manager, `the verification at ${width}px`);
    const returning = manager.getByTestId("action-return-form");
    await returning.getByTestId("action-return-note").fill(JOURNEY.returned);
    await submitConfirmed(manager, returning);
    await expect(manager.getByTestId("action-status")).toHaveAttribute("data-status", "IN_PROGRESS");
    await expect(manager.getByTestId("action-verify")).toHaveCount(0);
    await expect(manager.getByTestId("action-event-1")).toHaveAttribute("data-event", "RETURNED");

    // The owner: My Work says it came back, and the history says what is missing but not who returned it. They
    // submit again, with a reference and no kind of evidence.
    await fromMyWork(owner, "ACTION_RETURNED", f.actionId, "report");
    await expect(owner.getByTestId("action-event-1")).toHaveAttribute("data-event", "RETURNED");
    await expect(owner.getByTestId("action-event-1-note")).toHaveText(JOURNEY.returned);
    await expect(owner.getByTestId("action-history")).not.toContainText(words.manager);
    const again = owner.getByTestId("action-complete-form");
    await again.getByTestId("action-complete-note").fill(JOURNEY.second);
    await again.getByTestId("action-complete-reference").fill(JOURNEY.secondReference);
    await submitConfirmed(owner, again);
    await expect(owner.getByTestId("action-awaiting-verification")).toBeVisible();

    // The manager, from My Work again, verifies the latest completion, then reopens the action, which goes back to
    // its owner.
    await fromMyWork(manager, "ACTION_TO_VERIFY", f.actionId, "verify");
    await expect(manager.getByTestId("action-submission-note")).toHaveText(JOURNEY.second);
    await expect(manager.getByTestId("action-submission-evidence")).toContainText(JOURNEY.secondReference);
    const verify = manager.getByTestId("action-verify-form");
    await verify.getByTestId("action-verify-note").fill(JOURNEY.verified);
    await submitConfirmed(manager, verify);
    await expect(manager.getByTestId("action-status")).toHaveAttribute("data-status", "COMPLETED");
    await expect(manager.getByTestId("action-reached")).toBeVisible();
    await expect(manager.getByTestId("action-verify")).toHaveCount(0);
    const reopen = manager.getByTestId("action-reopen-form");
    await reopen.getByTestId("action-reopen-reason").fill(JOURNEY.reopened);
    await submitConfirmed(manager, reopen);
    await expect(manager.getByTestId("action-status")).toHaveAttribute("data-status", "IN_PROGRESS");
    await expect(manager.getByTestId("action-reopen")).toHaveCount(0);
    await expect(manager.getByTestId("action-event-1-note")).toHaveText(JOURNEY.reopened);
    expect(await historyOf(manager)).toEqual([
      "REOPENED",
      "VERIFIED",
      "COMPLETION_SUBMITTED",
      "RETURNED",
      "COMPLETION_SUBMITTED",
      "PROGRESS",
      "OPENED",
    ]);
    await expectNoOverflow(manager, `the reopened action at ${width}px`);

    // Reopened, it is the owner's work again.
    await fromMyWork(owner, "ACTION_RETURNED", f.actionId, "report");
    await expect(owner.getByTestId("action-report")).toBeVisible();
    await expect(owner.getByTestId("action-event-1-note")).toHaveText(JOURNEY.reopened);
    await owner.context().close();
    await manager.context().close();
  });
}

test("en: a return left open while another manager verifies the completion records nothing; the page says why at its top", async ({
  browser,
}) => {
  const f = await openedAction(`verify-stale-${randomUUID().slice(0, 8)}`);
  made.push({ meetingId: f.meetingId, caseId: f.caseId });
  await submittedAsComplete(f.actionId);
  const manager = await signIn(browser, MANAGER, "en");
  await manager.goto(`/actions/${f.actionId}#verify`);
  await expect(manager.getByTestId("action-submission-evidence")).toContainText(
    SUBMITTED_COMPLETION.reference,
  );
  const returning = manager.getByTestId("action-return-form");
  await returning.getByTestId("action-return-note").fill("Synthetic: returned too late, for the e2e check.");
  // Meanwhile the GRC Director, who also manages the case's actions, verifies it.
  await verifiedAs("grcDirector", f.actionId);
  await submitConfirmed(manager, returning);
  // The command refuses, and the page, read again, offers the reopening in place of the verification. The notice at
  // its top says nothing was recorded, in the command's own words, and nothing about the other manager.
  await expect(manager.getByTestId("action-verify")).toHaveCount(0);
  await expect(manager.getByTestId("action-status")).toHaveAttribute("data-status", "COMPLETED");
  await expect(manager.getByTestId("action-reopen")).toBeVisible();
  const notice = manager.getByTestId("refusal-notice");
  await expect(notice).toHaveAttribute("data-kind", "CONFLICT");
  await expect(notice).toHaveText(
    /^Not possible right now\s*The action is not waiting for verification any more, so nothing was recorded\. Reference: [0-9a-f-]{36}$/,
  );
  await expect(notice).toBeFocused();
  await expect(manager.getByTestId("action-error")).toHaveCount(0);
  expect(await historyOf(manager)).toEqual(["VERIFIED", "COMPLETION_SUBMITTED", "OPENED"]);
});

test("ar: an owner's report left open while the decision is superseded records nothing, and no answer names what holds the action", async ({
  browser,
}) => {
  const f = await openedAction(`report-frozen-${randomUUID().slice(0, 8)}`);
  made.push({ meetingId: f.meetingId, caseId: f.caseId });
  const owner = await signIn(browser, ACTION_OWNER.email, "ar");
  await owner.goto(`/actions/${f.actionId}#report`);
  const progress = owner.getByTestId("action-progress-form");
  await progress.getByTestId("action-progress-percent").fill("30");
  await progress.getByTestId("action-progress-note").fill("Synthetic: half of the approvers are named.");
  // Meanwhile the decision the action carries out is superseded, which freezes the action.
  await supersededDecision(f);
  const answers: Promise<string>[] = [];
  owner.on("response", (r) => {
    if (r.request().method() === "POST") answers.push(r.text().catch(() => ""));
  });
  await progress.locator('button[type="submit"]').click();
  // The page, read again, says reporting is paused; the notice at its top says nothing was recorded, in words that
  // never say why. Only the case team reads what holds the action.
  await expect(owner.getByTestId("action-report")).toHaveCount(0);
  await expect(owner.getByTestId("action-report-paused")).toBeVisible();
  const notice = owner.getByTestId("refusal-notice");
  await expect(notice).toHaveAttribute("data-kind", "CONFLICT");
  await expect(notice).toHaveText(
    /^غير ممكن الآن\s*يتعذّر المضي في الإجراء حالياً، فلم يُسجَّل شيء\. المرجع: [0-9a-f-]{36}$/,
  );
  await expect(notice).toBeFocused();
  // What the browser was sent carries ACTION_BLOCKED, never the block's own code.
  const sent = (await Promise.all(answers)).join("\n");
  expect(sent).toContain("ACTION_BLOCKED");
  expect(sent).not.toContain("FROZEN_BY_SUPERSEDED_DECISION");
  for (const id of ["action-block", "action-origin"]) await expect(owner.getByTestId(id), id).toHaveCount(0);
  await expect(owner.getByTestId("action-status")).toHaveAttribute("data-status", "OPEN");
  expect(await historyOf(owner)).toEqual(["OPENED"]);
});
