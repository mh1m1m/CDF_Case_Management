// WCAG 2.2 AA on the Phase 12 P12-2a meeting and minutes pages (ADR-054) in Arabic and English, at a desktop and a
// phone width and at 320 px, acted by the seed's demo Investigation Committee: the secretary's page with every row's
// actions, a decided concern and the form to open a vote; the same page with a vote under way, as the secretary and as
// a member; the vote's confirmation; and the minutes as a reviewer. Every disclosure is open. Each meeting made here is
// settled afterwards. Synthetic cases only.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { audit } from "./axe";
import {
  IC_DEMO,
  approvedVote,
  castVotes,
  closeFixtureConnections,
  decidedConcern,
  minutedMeeting,
  openVote,
  openWithVoters,
  scheduledMeeting,
  settleMeeting,
} from "../e2e/records-fixture";
import { signIn } from "../e2e/support";

const made: string[] = [];
test.afterEach(async () => {
  for (const id of made.splice(0)) await settleMeeting(id);
});
test.afterAll(closeFixtureConnections);

const WIDTHS = [1280, 390, 320] as const;

async function meeting(what: string) {
  const m = await scheduledMeeting(`${what}-${randomUUID().slice(0, 8)}`);
  made.push(m.meetingId);
  return m;
}

/** At each width: the page with its disclosures open passes axe (not at 320) and never scrolls sideways. */
async function check(page: Page, path: string, ready: string, locale: "ar" | "en") {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(path);
    await expect(page.getByTestId(ready)).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await page.locator("main details").evaluateAll((all) => {
      for (const d of all) (d as HTMLDetailsElement).open = true;
    });
    if (width !== 320) await audit(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, `horizontal overflow on ${path} at ${width}px`).toBe(false);
  }
}

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: the meeting page passes axe and reflows, before and during a vote, for the secretary and a member`, async ({
    browser,
  }) => {
    const m = await meeting(`meeting-a11y-${locale}`);
    await openWithVoters(m);
    await decidedConcern(m, "icMemberB", "icDeputy", "DISMISSED");
    const path = `/meetings/${m.meetingId}`;

    // Before a vote: each row's actions (attendance, excuse, raise), the decided concern and the vote to open.
    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await check(secretary, path, "open-vote", locale);
    await expect(secretary.getByTestId(/^participant-\d+-actions$/)).not.toHaveCount(0);
    await expect(secretary.getByTestId("concern-1-status")).toHaveAttribute("data-status", "DISMISSED");

    // During a vote: its progress and, for the secretary, who has not voted yet.
    const item = await openVote(m);
    await castVotes(item, [
      ["icChair", "APPROVE"],
      ["icDeputy", "REJECT"],
    ]);
    await check(secretary, path, "vote-1-outstanding", locale);
    await expect(secretary.getByTestId("vote-1-progress")).toBeVisible();

    // The member's own vote forms, and the vote's confirmation, cancelled.
    const member = await signIn(browser, IC_DEMO.icMemberA, locale);
    await check(member, path, "vote-1-cast-form", locale);
    await expect(member.getByTestId("meeting-my-part")).toBeVisible();
    await member.setViewportSize({ width: 1280, height: 900 });
    await member.goto(path);
    await member.locator("#vote-1-choice").selectOption("ABSTAIN");
    await member.getByTestId("vote-1-cast-form").locator('button[type="submit"]').click();
    const dialog = member.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await audit(member);
    await dialog.getByTestId("confirm-cancel").click();
    await expect(dialog).toBeHidden();
    await expect(member.getByTestId("vote-1-voted")).toHaveCount(0);

    // Once every member present has voted: the member's revision, recusal and note; the secretary's close.
    await castVotes(item, [
      ["icMemberA", "ABSTAIN"],
      ["icMemberB", "APPROVE"],
    ]);
    await check(member, path, "vote-1-revise", locale);
    await member.context().close();
    await check(secretary, path, "vote-1-close-form", locale);
    await secretary.context().close();
  });

  test(`${locale}: the minutes pass axe and reflow for a reviewer and for the secretary`, async ({
    browser,
  }) => {
    const m = await meeting(`minutes-a11y-${locale}`);
    await openWithVoters(m);
    await approvedVote(m);
    const minutes = await minutedMeeting(m);
    const path = `/minutes/${minutes}`;

    const reviewer = await signIn(browser, IC_DEMO.icMemberB, locale);
    await check(reviewer, path, "minutes-review-form", locale);
    await expect(reviewer.getByTestId("minutes-record")).toBeVisible();
    await reviewer.context().close();

    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await check(secretary, path, "minutes-guide", locale);
    await secretary.context().close();
  });
}
