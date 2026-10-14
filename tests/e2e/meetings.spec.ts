// Phase 12 P12-2a (ADR-054, migration 2065; Linear CDF-158): the meeting and minutes pages in Arabic (RTL) and English
// (LTR), acted by the seed's demo Investigation Committee. A member declares on their part of the meeting; the
// secretary opens it and records them present; the secretary opens a vote, a member votes on a phone and the secretary
// closes it; the meeting closes, its minutes are written and a member reviews them. Whoever is outside the meeting gets
// the same 404 as a meeting that does not exist; the case team reads the meeting, and its minutes once they are final,
// without a single form. Every meeting made here is settled afterwards, so nothing stays waiting on the demo committee.
// Synthetic data only.
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  IC_DEMO,
  IC_VOTERS,
  approvedVote,
  castVotes,
  closeFixtureConnections,
  declareNoConflict,
  minutedMeeting,
  openWithVoters,
  scheduledMeeting,
  settleMeeting,
  voteItemId,
} from "./records-fixture";
import { signIn } from "./support";

const made: string[] = [];
test.afterEach(async () => {
  for (const id of made.splice(0)) await settleMeeting(id);
});
test.afterAll(closeFixtureConnections);

const REASON = "Synthetic: the next step for the e2e check.";
const NARRATIVE = "Synthetic minutes: the committee approved the recommendation unanimously.";

const TEXT = {
  en: {
    memberA: "Investigation Committee Member Beta (demo)",
    noConflict: "No conflict",
    present: "Present",
    approved: "Approved",
    voted: "You have voted.",
    progress: (voted: number, total: number) => `${voted} of ${total} members have voted.`,
    manage: "You run this meeting as its secretary.",
    voting: "You take part as a member with a vote.",
    reader: "You can read this meeting. Its steps belong to the committee.",
    minutes: (n: number) => `Minutes, version ${n}`,
    review: "You can review this version.",
    reviewed: "You have reviewed this version.",
  },
  ar: {
    memberA: "عضو لجنة التحقيق بيتا (تجريبي)",
    noConflict: "لا تعارض",
    present: "حاضر",
    approved: "معتمد",
    voted: "أدليت بصوتك.",
    progress: (voted: number, total: number) => `صوّت ${voted} من ${total} من الأعضاء.`,
    manage: "تدير هذا الاجتماع بصفتك أمين السر.",
    voting: "تشارك عضواً له حق التصويت.",
    reader: "يمكنك الاطلاع على هذا الاجتماع. أما خطواته فتعود إلى اللجنة.",
    minutes: (n: number) => `المحضر، النسخة ${n}`,
    review: "يمكنك مراجعة هذه النسخة.",
    reviewed: "راجعت هذه النسخة.",
  },
} as const;

async function meeting(what: string) {
  const m = await scheduledMeeting(`${what}-${randomUUID().slice(0, 8)}`);
  made.push(m.meetingId);
  return m;
}

/** Opens a disclosure unless it already is (a server re-render keeps one that stayed in place open). */
async function open(details: Locator) {
  await expect(details).toBeVisible();
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open)))
    await details.locator("summary").first().click();
}

/** Submits a command form and accepts its confirmation (UX-031). */
async function submitConfirmed(page: Page, form: Locator) {
  await form.locator('button[type="submit"]').click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("confirm-submit").click();
  await expect(dialog).toBeHidden();
}

const row = (page: Page, name: string) => page.getByTestId(/^participant-\d+$/).filter({ hasText: name });

for (const locale of ["ar", "en"] as const) {
  const text = TEXT[locale];

  test(`${locale}: a member declares on their part; the secretary opens the meeting and records them present`, async ({
    browser,
  }) => {
    const m = await meeting(`meeting-open-${locale}`);
    await declareNoConflict(m, ["icChair", "icDeputy", "icMemberB"]);

    const member = await signIn(browser, IC_DEMO.icMemberA, locale);
    await member.goto(`/meetings/${m.meetingId}`);
    await expect(member.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(member.getByTestId("meeting-status")).toHaveAttribute("data-status", "SCHEDULED");
    await expect(member.getByTestId("meeting-guide")).toContainText(text.voting);
    // The committee works from the meeting: the case is not named to it here, and nothing leads to the case.
    await expect(member.getByTestId("meeting-purpose-banner")).toBeVisible();
    await expect(member.locator("main")).not.toContainText(m.caseNumber);
    await expect(member.locator('main a[href^="/cases"]')).toHaveCount(0);
    // Running the meeting is the secretary's.
    await expect(member.getByTestId("open-meeting-form")).toHaveCount(0);
    await expect(member.getByTestId("cancel-meeting")).toHaveCount(0);
    await expect(member.getByTestId(/^participant-\d+-actions$/)).toHaveCount(0);
    // No conflict needs no confirmation (a declared conflict asks first, UX-031).
    const declare = member.getByTestId("declare-form");
    await declare.getByTestId("declare-NO_CONFLICT").check();
    await declare.locator('button[type="submit"]').click();
    await expect(member.getByTestId("my-part-facts")).toContainText(text.noConflict);
    await member.context().close();

    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await secretary.goto(`/meetings/${m.meetingId}`);
    await expect(secretary.getByTestId("meeting-guide")).toContainText(text.manage);
    await secretary.locator("#open-meeting-reason").fill(REASON);
    await submitConfirmed(secretary, secretary.getByTestId("open-meeting-form"));
    await expect(secretary.getByTestId("meeting-status")).toHaveAttribute("data-status", "OPEN");
    // The member's row: what the secretary may record for them now, present first.
    const memberRow = row(secretary, text.memberA);
    await open(memberRow.getByTestId(/^participant-\d+-actions$/));
    await expect(memberRow.locator('select[name="attendance"]')).toHaveValue("PRESENT");
    await memberRow
      .getByTestId(/^participant-\d+-attendance-form$/)
      .locator('button[type="submit"]')
      .click();
    await expect(memberRow.getByTestId(/^participant-\d+-state$/)).toContainText(text.present);
    await secretary.context().close();
  });

  test(`${locale}: the secretary opens a vote, a member votes on a phone, the secretary closes it`, async ({
    browser,
  }) => {
    const m = await meeting(`meeting-vote-${locale}`);
    await openWithVoters(m);

    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await secretary.goto(`/meetings/${m.meetingId}`);
    await expect(secretary.getByTestId("no-votes")).toBeVisible();
    await open(secretary.getByTestId("open-vote"));
    await secretary.locator("#vote-title").fill("Recommendation (synthetic)");
    await submitConfirmed(secretary, secretary.getByTestId("open-vote-form"));
    await expect(secretary.getByTestId("vote-1-status")).toHaveAttribute("data-status", "OPEN");
    await expect(secretary.getByTestId("vote-1-progress")).toHaveText(text.progress(0, 4));
    // While a vote is open, nobody's attendance changes (VOTE_IN_PROGRESS): no row offers it.
    await expect(secretary.getByTestId(/^participant-\d+-attendance-form$/)).toHaveCount(0);
    const item = await voteItemId(m, 1);
    await castVotes(item, [
      ["icChair", "APPROVE"],
      ["icDeputy", "APPROVE"],
      ["icMemberB", "REJECT"],
    ]);
    // The secretary, who closes the vote, sees who has not voted yet; never how anyone voted.
    await secretary.reload();
    await expect(secretary.getByTestId("vote-1-progress")).toHaveText(text.progress(3, 4));
    await expect(secretary.getByTestId("vote-1-outstanding")).toContainText(text.memberA);

    const member = await signIn(browser, IC_DEMO.icMemberA, locale);
    await member.setViewportSize({ width: 390, height: 844 });
    await member.goto(`/meetings/${m.meetingId}`);
    await expect(member.getByTestId("vote-1-progress")).toHaveText(text.progress(3, 4));
    await expect(member.getByTestId("vote-1-outstanding")).toHaveCount(0);
    await expect(member.getByTestId("vote-1-close")).toHaveCount(0);
    await member.locator("#vote-1-choice").selectOption("APPROVE");
    await submitConfirmed(member, member.getByTestId("vote-1-cast-form"));
    await expect(member.getByTestId("vote-1-voted")).toHaveText(text.voted);
    // A vote may be changed while the item is open; it is never cast twice.
    await expect(member.getByTestId("vote-1-revise")).toBeVisible();
    await expect(member.getByTestId("vote-1-cast")).toHaveCount(0);
    const overflow = await member.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, "horizontal overflow at 390px").toBe(false);
    await member.context().close();

    await secretary.reload();
    await expect(secretary.getByTestId("vote-1-progress")).toHaveText(text.progress(4, 4));
    await submitConfirmed(secretary, secretary.getByTestId("vote-1-close-form"));
    await expect(secretary.getByTestId("vote-1-status")).toHaveAttribute("data-status", "CLOSED");
    await expect(secretary.getByTestId("vote-1-result")).toContainText(text.approved);
    await secretary.context().close();
  });

  test(`${locale}: the secretary closes the meeting and writes the minutes; a member reviews them`, async ({
    browser,
  }) => {
    const m = await meeting(`meeting-minutes-${locale}`);
    await openWithVoters(m);
    await approvedVote(m);

    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await secretary.goto(`/meetings/${m.meetingId}`);
    await secretary.locator("#close-meeting-reason").fill(REASON);
    await submitConfirmed(secretary, secretary.getByTestId("close-meeting-form"));
    await expect(secretary.getByTestId("meeting-status")).toHaveAttribute("data-status", "CLOSED");
    await secretary.locator("#minutes-narrative").fill(NARRATIVE);
    await submitConfirmed(secretary, secretary.getByTestId("generate-minutes-form"));
    const link = secretary.getByTestId("minutes-v1");
    await expect(link).toHaveText(text.minutes(1));
    await expect(secretary.getByTestId("minutes-v1-status")).toHaveAttribute("data-status", "IN_REVIEW");
    await link.click();
    await secretary.waitForURL(/\/minutes\/[0-9a-f-]{36}$/);
    const minutesPath = new URL(secretary.url()).pathname;
    await expect(secretary.getByTestId("minutes-status")).toHaveAttribute("data-status", "IN_REVIEW");
    await expect(secretary.getByTestId("minutes-narrative")).toContainText(NARRATIVE);
    await expect(secretary.getByTestId("minutes-vote-1")).toContainText(text.approved);
    // The secretary wrote them: the members who sat review them.
    await expect(secretary.getByTestId("minutes-review-form")).toHaveCount(0);
    await secretary.context().close();

    const member = await signIn(browser, IC_DEMO.icMemberA, locale);
    await member.goto(minutesPath);
    await expect(member.getByTestId("minutes-guide")).toContainText(text.review);
    await member.getByTestId("review-APPROVE").check();
    await submitConfirmed(member, member.getByTestId("minutes-review-form"));
    await expect(member.getByTestId("minutes-guide")).toContainText(text.reviewed);
    await expect(member.getByTestId("minutes-review-form")).toHaveCount(0);
    // The way back is the meeting, never the case.
    await member.getByTestId("to-meeting").click();
    await member.waitForURL(new RegExp(`/meetings/${m.meetingId}$`));
    await expect(member.getByTestId("minutes-v1")).toBeVisible();
    await member.context().close();
  });
}

test("outside the meeting it is the same 404 as a meeting that does not exist; the case team only reads it", async ({
  browser,
}) => {
  const m = await meeting("meeting-outside");
  await openWithVoters(m, IC_VOTERS);
  await approvedVote(m);
  const minutes = await minutedMeeting(m);
  const paths = [`/meetings/${m.meetingId}`, `/minutes/${minutes}`];
  const missing = [`/meetings/${randomUUID()}`, `/minutes/${randomUUID()}`, "/meetings/not-a-meeting"];

  // PLATFORM_ADMIN never implies case content (§21); an investigator off the case is outside it too.
  for (const email of ["admin@example.test", "investigator.b@example.test"]) {
    const page = await signIn(browser, email);
    for (const path of [...paths, ...missing])
      expect((await page.goto(path))?.status(), `${email} ${path}`).toBe(404);
    await page.context().close();
  }

  // The case team reads the meeting and its minutes, with the case named, and acts on neither.
  const manager = await signIn(browser, "casemanager@example.test");
  await manager.goto(paths[0]!);
  await expect(manager.getByTestId("meeting-guide")).toContainText(TEXT.en.reader);
  await expect(manager.getByTestId("meeting-case")).toContainText(m.caseNumber);
  await expect(manager.locator("main form")).toHaveCount(0);
  // Minutes in review are the committee's: the case team gets the same 404 until they are final (2030).
  expect((await manager.goto(paths[1]!))?.status()).toBe(404);
  await settleMeeting(m.meetingId);
  await manager.goto(paths[1]!);
  await expect(manager.getByTestId("minutes-status")).toHaveAttribute("data-status", "APPROVED");
  await expect(manager.locator("main form")).toHaveCount(0);
  await manager.context().close();
});
