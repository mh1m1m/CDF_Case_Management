// Phase 12 P12-2b (ADR-055, migration 2085; Linear CDF-220): My Committees «لجاني», the committee's page and the
// meeting's logistics in Arabic (RTL) and English (LTR), acted by the seed's demo Investigation Committee. The secretary
// finds the committee from My Committees and schedules a meeting on a proceeding, then one on the emergency path; a
// member reads the same page with no form. The secretary adds a member appointed after the referral. In a meeting,
// a member records their own accommodation; the secretary has the deputy act as chair, answers for a witness without an
// account, records an accommodation for them and excludes them. Whoever holds no seat gets the same 404 as a committee
// that does not exist. Every meeting made here is settled afterwards. Synthetic data only.
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  IC_DEMO,
  appointLateMember,
  closeFixtureConnections,
  demoCommitteeId,
  endLateMember,
  invitedWitness,
  openWithChairAbsent,
  referredCase,
  scheduledMeeting,
  settleMeeting,
} from "./records-fixture";
import { signIn } from "./support";

const made: string[] = [];
test.afterEach(async () => {
  for (const id of made.splice(0)) await settleMeeting(id);
});
test.afterAll(closeFixtureConnections);

const REASON = "Synthetic: the next step for the e2e check.";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** A datetime-local value in Riyadh time (UTC+3, no daylight saving), this far from now, to the minute. */
const riyadh = (fromNow: number) => new Date(Date.now() + fromNow + 3 * HOUR).toISOString().slice(0, 16);

const TEXT = {
  en: {
    secretarySeat: "Your seat: Secretary",
    memberSeat: "Your seat: Member",
    scheduled: "Meeting scheduled.",
    noPlaceOnline: "Leave the place empty for a meeting held only online.",
    addedAfterReferral: "Added after the referral",
    deputy: "Investigation Committee Deputy Chair Omega (demo)",
    memberA: "Investigation Committee Member Beta (demo)",
    witness: "Witness",
    noConflict: "No conflict",
    acknowledged: "Confidentiality acknowledged",
    bySelf: "Recorded by the participant",
    bySecretary: "Recorded by the secretary",
  },
  ar: {
    secretarySeat: "مقعدك: أمين السر",
    memberSeat: "مقعدك: عضو",
    scheduled: "جُدول الاجتماع.",
    noPlaceOnline: "اترك المكان فارغاً للاجتماع عن بُعد فقط.",
    addedAfterReferral: "أُضيفوا بعد الإحالة",
    deputy: "نائب رئيس لجنة التحقيق أوميغا (تجريبي)",
    memberA: "عضو لجنة التحقيق بيتا (تجريبي)",
    witness: "شاهد",
    noConflict: "لا تعارض",
    acknowledged: "أقرّ بالسرية",
    bySelf: "سجّله المشارك",
    bySecretary: "سجّله أمين السر",
  },
} as const;

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

/** The ids of the meetings a proceeding's card lists, in its order. */
async function meetingIds(card: Locator): Promise<string[]> {
  const rows = await card
    .getByTestId(/^meeting-row-[0-9a-f-]{36}$/)
    .evaluateAll((all) => all.map((r) => (r.getAttribute("data-testid") ?? "").replace("meeting-row-", "")));
  return rows;
}

/** The roster row that names `text`, and its number. */
async function rosterRow(page: Page, text: string): Promise<{ row: Locator; n: string }> {
  const row = page.getByTestId(/^participant-\d+$/).filter({ hasText: text });
  await expect(row).toHaveCount(1);
  const n = ((await row.getAttribute("data-testid")) ?? "").replace("participant-", "");
  return { row, n };
}

for (const locale of ["ar", "en"] as const) {
  const text = TEXT[locale];

  test(`${locale}: the secretary schedules from My Committees, on the emergency path too; a member only reads`, async ({
    browser,
  }) => {
    const p = await referredCase(`committee-schedule-${locale}-${randomUUID().slice(0, 8)}`);
    const ic = await demoCommitteeId();
    const cp = p.committeeProceedingId;

    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await secretary.goto("/committees");
    await expect(secretary.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(secretary.getByTestId("nav-committee")).toHaveAttribute("aria-current", "page");
    await expect(secretary.getByTestId("committee-IC-seat")).toHaveText(text.secretarySeat);
    await secretary.getByTestId("committee-IC").getByRole("link").click();
    await secretary.waitForURL(new RegExp(`/committees/${ic}$`));
    await expect(secretary.getByTestId("committee-my-seat")).toHaveText(text.secretarySeat);
    // The committee works from its proceedings: the case is not named to a seat, and nothing leads to the case.
    const card = secretary.getByTestId(`proceeding-${cp}`);
    await expect(card.getByTestId(`proceeding-${cp}-status`)).toHaveAttribute("data-status", "OPEN");
    await expect(card.getByTestId(`proceeding-${cp}-ref-note`)).toBeVisible();
    await expect(secretary.locator("main")).not.toContainText(p.caseNumber);
    await expect(secretary.locator('main a[href^="/cases"]')).toHaveCount(0);

    const schedule = card.getByTestId(`schedule-${cp}`);
    await open(schedule);
    const form = schedule.getByTestId(`schedule-${cp}-form`);
    await form.locator(`#schedule-${cp}-location`).fill("Meeting room 3 (synthetic)");
    await form.locator(`#schedule-${cp}-start`).fill(riyadh(3 * DAY));
    await form.locator(`#schedule-${cp}-end`).fill(riyadh(3 * DAY + HOUR));
    await form.locator(`#schedule-${cp}-reason`).fill(REASON);
    if (locale === "en") {
      // A place for a meeting held only online is refused field by field, before the database is asked.
      await form.locator(`#schedule-${cp}-mode`).selectOption("TEAMS");
      await submitConfirmed(secretary, form);
      await expect(form).toContainText(text.noPlaceOnline);
      await form.locator(`#schedule-${cp}-mode`).selectOption("IN_PERSON");
    }
    await submitConfirmed(secretary, form);
    await expect(form).toContainText(text.scheduled);
    await expect.poll(() => meetingIds(card)).toHaveLength(1);
    const [planned] = await meetingIds(card);
    made.push(planned!);
    await expect(card.getByTestId(`meeting-row-${planned}-emergency`)).toHaveCount(0);

    // Within hours: the emergency path, with its reason; the meeting is marked as one.
    await open(schedule);
    await form.locator(`#schedule-${cp}-location`).fill("Meeting room 3 (synthetic)");
    await form.locator(`#schedule-${cp}-start`).fill(riyadh(2 * HOUR));
    await form.locator(`#schedule-${cp}-end`).fill(riyadh(3 * HOUR));
    await form.locator(`#schedule-${cp}-reason`).fill(REASON);
    await form.getByTestId(`schedule-${cp}-emergency`).check();
    await form
      .locator(`#schedule-${cp}-emergency-reason`)
      .fill("Synthetic: a decision is needed before the case deadline.");
    await submitConfirmed(secretary, form);
    await expect.poll(() => meetingIds(card)).toHaveLength(2);
    const urgent = (await meetingIds(card)).find((id) => id !== planned)!;
    made.push(urgent);
    await expect(card.getByTestId(`meeting-row-${urgent}-emergency`)).toBeVisible();

    // From My Committees, the way back from the meeting is the committee, never My Work.
    await card.getByTestId(`meeting-link-${planned}`).click();
    await secretary.waitForURL(new RegExp(`/meetings/${planned}$`));
    const crumbs = secretary.getByTestId("breadcrumbs");
    await expect(crumbs.locator(`a[href="/committees/${ic}"]`)).toBeVisible();
    await expect(crumbs.locator('a[href="/my-work"]')).toHaveCount(0);
    await secretary.context().close();

    // A member reads the committee and its meetings, with no form, on a phone.
    const member = await signIn(browser, IC_DEMO.icMemberA, locale);
    await member.setViewportSize({ width: 390, height: 844 });
    await member.goto("/committees");
    await expect(member.getByTestId("committee-IC-seat")).toHaveText(text.memberSeat);
    await member.goto(`/committees/${ic}`);
    const theirs = member.getByTestId(`proceeding-${cp}`);
    await expect.poll(() => meetingIds(theirs)).toHaveLength(2);
    await expect(member.getByTestId(`schedule-${cp}`)).toHaveCount(0);
    await expect(member.getByTestId(`amend-${cp}`)).toHaveCount(0);
    await expect(member.getByTestId(/^committee-member-\d+$/)).toHaveCount(5);
    const overflow = await member.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, "horizontal overflow at 390px").toBe(false);
    await member.context().close();
  });

  test(`${locale}: in a meeting, a member records their accommodation; the secretary activates the acting chair and answers for a witness without an account`, async ({
    browser,
  }) => {
    const m = await scheduledMeeting(`meeting-logistics-${locale}-${randomUUID().slice(0, 8)}`);
    made.push(m.meetingId);
    await invitedWitness(m);
    await openWithChairAbsent(m);
    const mine = "Synthetic: a seat near the door, for the e2e check.";
    const theirs = "Synthetic: step-free access to the room, for the e2e check.";

    const member = await signIn(browser, IC_DEMO.icMemberA, locale);
    await member.goto(`/meetings/${m.meetingId}`);
    const part = member.getByTestId("my-accommodations");
    await expect(part.getByTestId("my-no-accommodations")).toBeVisible();
    await part.locator("#my-accommodation-details").fill(mine);
    await submitConfirmed(member, part.getByTestId("my-accommodation-form"));
    await expect(part.getByTestId("my-accommodation-list")).toContainText(mine);
    await expect(part.getByTestId("my-accommodation-list")).toContainText(text.bySelf);
    // A member records nothing for anyone else and activates no one.
    await expect(member.getByTestId(/^participant-\d+-actions$/)).toHaveCount(0);
    await expect(member.getByTestId("acting-chair")).toHaveCount(0);
    await member.context().close();

    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await secretary.goto(`/meetings/${m.meetingId}`);
    // The chair is absent: the deputy chair present acts as chair once the secretary says why.
    const acting = secretary.getByTestId("acting-chair");
    await acting.locator("#acting-chair-reason").fill("Synthetic: the chair is absent from this meeting.");
    await submitConfirmed(secretary, acting.getByTestId("acting-chair-form"));
    await expect(secretary.getByTestId("acting-roles")).toContainText(text.deputy);
    await expect(secretary.getByTestId("acting-chair")).toHaveCount(0);

    // The runner reads each participant's arrangements; the member's own came from the member.
    const { n: a } = await rosterRow(secretary, text.memberA);
    await expect(secretary.getByTestId(`participant-${a}-accommodations`)).toContainText(mine);

    // The witness has no account: the secretary records their declaration and undertaking, then an accommodation.
    const { row, n } = await rosterRow(secretary, text.witness);
    await open(row.getByTestId(`participant-${n}-actions`));
    await expect(row.getByTestId(`participant-${n}-on-behalf`)).toBeVisible();
    await row.getByTestId(`participant-${n}-declare-for-NO_CONFLICT`).check();
    await row.getByTestId(`participant-${n}-declare-for-form`).locator('button[type="submit"]').click();
    await expect(row.getByTestId(`participant-${n}-state`)).toContainText(text.noConflict);
    await open(row.getByTestId(`participant-${n}-actions`));
    await submitConfirmed(secretary, row.getByTestId(`participant-${n}-acknowledge-for-form`));
    await expect(row.getByTestId(`participant-${n}-state`)).toContainText(text.acknowledged);
    await open(row.getByTestId(`participant-${n}-actions`));
    await row.locator(`#participant-${n}-accommodation-details`).fill(theirs);
    await submitConfirmed(secretary, row.getByTestId(`participant-${n}-accommodation-form`));
    await expect(row.getByTestId(`participant-${n}-accommodations`)).toContainText(text.bySecretary);

    // Heard and released: the witness is excluded, with the reason on the meeting.
    await open(row.getByTestId(`participant-${n}-actions`));
    await row
      .locator(`#participant-${n}-exclude-reason`)
      .fill("Synthetic: heard and released by the committee.");
    await submitConfirmed(secretary, row.getByTestId(`participant-${n}-exclude-form`));
    await expect(secretary.getByTestId("meeting-exclusions")).toBeVisible();
    await expect(row.getByTestId(`participant-${n}-exclude-form`)).toHaveCount(0);
    await secretary.context().close();

    // The witness's accommodation may concern health: a member never reads it.
    const again = await signIn(browser, IC_DEMO.icMemberA, locale);
    await again.goto(`/meetings/${m.meetingId}`);
    await expect(again.getByTestId("acting-roles")).toContainText(text.deputy);
    await expect(again.locator("main")).not.toContainText(theirs);
    await expect(again.getByTestId(/^participant-\d+-accommodations$/)).toHaveCount(0);
    await again.context().close();
  });
}

test("the secretary adds a member appointed after the referral; the candidate leaves the list", async ({
  browser,
}) => {
  const p = await referredCase(`committee-amend-${randomUUID().slice(0, 8)}`);
  const ic = await demoCommitteeId();
  const cp = p.committeeProceedingId;
  await appointLateMember();
  try {
    const secretary = await signIn(browser, IC_DEMO.icSecretary, "en");
    await secretary.goto(`/committees/${ic}`);
    const card = secretary.getByTestId(`proceeding-${cp}`);
    const amend = card.getByTestId(`amend-${cp}`);
    await open(amend);
    const candidate = amend.locator("option").filter({ hasText: "Privacy Officer Kappa" });
    await amend.locator(`#amend-${cp}-member`).selectOption((await candidate.getAttribute("value"))!);
    await amend
      .locator(`#amend-${cp}-reason`)
      .fill("Synthetic: appointed after the referral, for the e2e check.");
    await submitConfirmed(secretary, amend.getByTestId(`amend-${cp}-form`));
    await expect(card.getByTestId(`amend-${cp}`)).toHaveCount(0);
    await open(card.getByTestId(`proceeding-${cp}-committee`));
    await expect(card.getByTestId(`proceeding-${cp}-committee`)).toContainText(TEXT.en.addedAfterReferral);
    await secretary.context().close();
  } finally {
    await endLateMember();
  }
});

test("without a current seat a committee is the same 404 as one that does not exist", async ({ browser }) => {
  const ic = await demoCommitteeId();
  const paths = [
    "/committees",
    `/committees/${ic}`,
    `/committees/${randomUUID()}`,
    "/committees/not-a-committee",
  ];
  // PLATFORM_ADMIN implies no seat (§21); the case team sees the case, never the committee's page; a role name alone
  // seats no one (AMB-047).
  for (const email of [
    "admin@example.test",
    "investigator.b@example.test",
    "casemanager@example.test",
    "committee.secretary@example.test",
  ]) {
    const page = await signIn(browser, email);
    for (const path of paths) expect((await page.goto(path))?.status(), `${email} ${path}`).toBe(404);
    await expect(page.getByTestId("nav-committee")).toHaveCount(0);
    await page.context().close();
  }
  // A seat holder gets the same 404 for an id that names no committee.
  const secretary = await signIn(browser, IC_DEMO.icSecretary);
  for (const path of paths.slice(2)) expect((await secretary.goto(path))?.status(), path).toBe(404);
  await secretary.context().close();
});
