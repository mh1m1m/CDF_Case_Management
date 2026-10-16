// Phase 12 P12-2c (ADR-056, migration 2086; Linear CDF-222): the proceeding before the committee, the meeting's invite
// and a vote on a finding, in Arabic (RTL) and English (LTR), acted by the seed's demo Investigation Committee on a case
// referred from its investigation. The secretary opens the proceeding from the committee's page and builds a package
// from what the page offers (the case's person and allegation by number and category, never a name, and the sanction
// catalogue in force), puts it to the committee, opens its vote in the open meeting and, once the members have voted,
// records the adoption; a member reads it with no form. From the meeting, the secretary invites the case's person and
// opens a vote on the finding the case was referred with; a member reads that vote on the proceeding's page. A conflict
// upheld after the vote taints the item, and the secretary confirms the committee's result. Whoever holds no seat that
// gives the proceeding, or does not run the meeting, gets the same 404 as an id that names nothing. Every meeting made
// here is settled afterwards, and Investigator Alpha, who records the finding, leaves the case again, so the seed's "my
// cases" stay as they were for the specs that count them (shell). Synthetic data only.
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  IC_DEMO,
  IC_VOTERS,
  PROCEEDING_SUBJECT,
  adoptedPackage,
  castVotes,
  closeFixtureConnections,
  closeVote,
  decidedConcern,
  demoCommitteeId,
  draftPackage,
  endInvestigatorAssignment,
  proceedingMeeting,
  settleMeeting,
  voteItemId,
  type ProceedingFixture,
} from "./records-fixture";
import { signIn } from "./support";

const made: ProceedingFixture[] = [];
test.afterEach(async () => {
  for (const f of made.splice(0)) {
    await settleMeeting(f.meetingId);
    await endInvestigatorAssignment(f.caseId);
  }
});
test.afterAll(closeFixtureConnections);

const TEXT = {
  en: {
    created: "Package created.",
    itemAdded: "Item added.",
    sanctionFlag: "Sanction provisional: awaiting the CDF source",
    subject: "Person concerned 1 · Employee",
    approved: "Approved by the committee",
    person: "Case person 1",
    invited: "Invited. They are on the meeting's roster.",
    personConcerned: "Person concerned",
    substantiated: "Substantiated",
    allegation: "Passing irregular transactions",
  },
  ar: {
    created: "أُنشئت الحزمة.",
    itemAdded: "أُضيف البند.",
    sanctionFlag: "جزاء مؤقت: بانتظار مصدر الصندوق",
    subject: "المشكو في حقه 1 · موظف",
    approved: "وافقت عليه اللجنة",
    person: "شخص القضية 1",
    invited: "وُجّهت الدعوة، وأصبح ضمن المشاركين في الاجتماع.",
    personConcerned: "الشخص المعني",
    substantiated: "مثبتة",
    allegation: "تمرير عمليات غير نظامية",
  },
} as const;

/** The fixture's person concerned, by name: never on a committee page while labels are ordinal (DEC-02). */
const NAME = PROCEEDING_SUBJECT.replace(" (synthetic)", "");

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

/** The page shows nothing of the case beyond the committee's purpose: no case number, no name, no way to the case. */
async function nothingOfTheCase(page: Page, caseNumber: string) {
  const main = page.locator("main");
  await expect(main).not.toContainText(caseNumber);
  await expect(main).not.toContainText(NAME);
  await expect(page.locator('main a[href^="/cases"]')).toHaveCount(0);
}

for (const locale of ["ar", "en"] as const) {
  const text = TEXT[locale];

  test(`${locale}: the secretary builds a package, puts it to the vote and records the adoption; a member only reads`, async ({
    browser,
  }) => {
    const f = await proceedingMeeting(`package-${locale}-${randomUUID().slice(0, 8)}`);
    made.push(f);
    const ic = await demoCommitteeId();
    const cp = f.committeeProceedingId;
    // As a whole in Arabic, item by item in English: either way its one item makes one vote.
    const granularity = locale === "ar" ? "PACKAGE" : "ITEM";

    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await secretary.goto(`/committees/${ic}`);
    await secretary.getByTestId(`proceeding-${cp}-open`).click();
    await secretary.waitForURL(new RegExp(`/committee-proceedings/${cp}$`));
    await expect(secretary.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(secretary.getByTestId("nav-committee")).toHaveAttribute("aria-current", "page");
    await expect(secretary.getByTestId("breadcrumbs").locator(`a[href="/committees/${ic}"]`)).toBeVisible();
    await expect(secretary.getByTestId("proceeding-purpose-banner")).toBeVisible();
    await expect(secretary.getByTestId("proceeding-status")).toHaveAttribute("data-status", "OPEN");
    await expect(secretary.getByTestId("proceeding-ordinal-note")).toBeVisible();
    await expect(secretary.getByTestId("proceeding-no-packages")).toBeVisible();
    await expect(secretary.getByTestId("proceeding-no-finding-votes")).toBeVisible();

    // A package, voted as chosen once.
    const create = secretary.getByTestId("create-package");
    await open(create);
    await create.getByTestId(`create-package-${granularity}`).check();
    await submitConfirmed(secretary, create.getByTestId("create-package-form"));
    await expect(secretary.getByTestId("create-package-form")).toContainText(text.created);
    const pkg = secretary.getByTestId("package-1");
    await expect(pkg.getByTestId("package-1-status")).toHaveAttribute("data-status", "DRAFT");
    await expect(pkg.getByTestId("package-1-no-items")).toBeVisible();
    // Nothing to put to the vote yet: an empty package is refused, so the form is not offered.
    await expect(pkg.getByTestId("package-1-submit")).toHaveCount(0);

    // Its item: a sanction from the catalogue, about the case's person and allegation, offered by number and category.
    const add = pkg.getByTestId("package-1-add");
    await open(add);
    const form = add.getByTestId("package-1-add-form");
    await form.getByTestId("package-1-add-type").selectOption("DISCIPLINARY_SANCTION");
    await form.getByTestId("package-1-add-code").selectOption("WARNING");
    await expect(form.getByTestId("package-1-add-subject")).toContainText(text.subject);
    await form.getByTestId("package-1-add-subject-0").check();
    await form.getByTestId("package-1-add-allegation-0").check();
    await form.locator("#package-1-add-description").fill("Synthetic: a written warning, for the e2e check.");
    await form.locator('button[type="submit"]').click();
    await expect(form).toContainText(text.itemAdded);
    const item = pkg.getByTestId("package-1-item-1");
    await expect(item.getByTestId("package-1-item-1-description")).toContainText("a written warning");
    await expect(item).toContainText(text.subject);
    // The catalogue's codes still wait for their CDF source: the item says so.
    await expect(item.getByTestId("package-1-item-1-flag-SANCTION_SOURCE_REQUIRED")).toHaveText(
      text.sanctionFlag,
    );
    await nothingOfTheCase(secretary, f.caseNumber);

    // Before the committee: the items are fixed and the vote opens in the open meeting, meeting 1 of the proceeding.
    await submitConfirmed(secretary, pkg.getByTestId("package-1-submit-form"));
    await expect(pkg.getByTestId("package-1-status")).toHaveAttribute("data-status", "VOTING");
    await expect(pkg.getByTestId("package-1-add")).toHaveCount(0);
    await submitConfirmed(secretary, pkg.getByTestId("package-1-open-vote-form-1"));
    await expect(pkg.getByTestId("package-1-open-vote")).toHaveCount(0);
    // The adoption waits until every vote of the round is closed.
    await expect(pkg.getByTestId("package-1-adopt")).toHaveCount(0);

    // The members vote on the meeting's page (P12-2a's own tests); here they approve and the secretary closes the vote.
    const vote = await voteItemId(f, 1);
    await castVotes(
      vote,
      IC_VOTERS.map((u) => [u, "APPROVE"]),
    );
    expect(await closeVote(vote)).toBe("APPROVED");
    await secretary.reload();
    await submitConfirmed(secretary, pkg.getByTestId("package-1-adopt-form"));
    await expect(pkg.getByTestId("package-1-status")).toHaveAttribute("data-status", "ADOPTED");
    await expect(pkg.getByTestId("package-1-item-1-result")).toHaveText(text.approved);
    await expect(pkg.getByTestId("package-1-adopt")).toHaveCount(0);
    await expect(pkg.getByTestId("package-1-return")).toBeVisible();
    await secretary.context().close();

    // A member reaches the proceeding from the meeting and reads the package, on a phone, with no form.
    const member = await signIn(browser, IC_DEMO.icMemberA, locale);
    await member.setViewportSize({ width: 390, height: 844 });
    await member.goto(`/meetings/${f.meetingId}`);
    await member.getByTestId("meeting-proceeding-link").click();
    await member.waitForURL(new RegExp(`/committee-proceedings/${cp}$`));
    const theirs = member.getByTestId("package-1");
    await expect(theirs.getByTestId("package-1-status")).toHaveAttribute("data-status", "ADOPTED");
    await expect(theirs.getByTestId("package-1-item-1-result")).toHaveText(text.approved);
    await expect(theirs.getByTestId("package-1-item-1")).toContainText(text.subject);
    await expect(member.getByTestId("create-package")).toHaveCount(0);
    await expect(member.locator("main form")).toHaveCount(0);
    await nothingOfTheCase(member, f.caseNumber);
    const overflow = await member.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, "horizontal overflow at 390px").toBe(false);
    await member.context().close();
  });

  test(`${locale}: from the meeting the secretary invites the case's person and opens a vote on the finding; a member reads it`, async ({
    browser,
  }) => {
    const f = await proceedingMeeting(`finding-vote-${locale}-${randomUUID().slice(0, 8)}`);
    made.push(f);
    const meeting = `/meetings/${f.meetingId}`;

    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await secretary.goto(meeting);
    await secretary.getByTestId("meeting-invite-link").click();
    await secretary.waitForURL(new RegExp(`${meeting}/invite$`));
    await expect(secretary.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(secretary.getByTestId("invite-purpose-banner")).toBeVisible();
    // The case team as accounts and the case's people by number, never a directory and never a name.
    await expect(secretary.getByTestId("invite-accounts")).toBeVisible();
    const person = secretary.getByTestId("invite-person-0");
    await expect(person).toContainText(text.person);
    await expect(person).toContainText(text.personConcerned);
    await expect(secretary.getByTestId(/^invite-person-\d+$/)).toHaveCount(1);
    await nothingOfTheCase(secretary, f.caseNumber);

    await open(person.getByTestId("invite-person-0-invite"));
    const invite = person.getByTestId("invite-person-0-form");
    await invite.getByTestId("invite-person-0-role").selectOption("SUBJECT");
    await invite
      .locator("#invite-person-0-reason")
      .fill("Synthetic: to hear the person concerned, for the e2e check.");
    await submitConfirmed(secretary, invite);
    // Invited once: the person leaves the list, and the meeting's roster lists them by their role.
    await expect(secretary.getByTestId(/^invite-person-\d+$/)).toHaveCount(0);
    await secretary.goto(meeting);
    await expect(
      secretary.getByTestId(/^participant-\d+$/).filter({ hasText: text.personConcerned }),
    ).toHaveCount(1);

    // A vote on the finding the case was referred with, from its own page.
    await open(secretary.getByTestId("open-vote"));
    await secretary.getByTestId("open-finding-vote-link").click();
    await secretary.waitForURL(new RegExp(`${meeting}/finding-vote$`));
    await expect(secretary.getByTestId("finding-vote-purpose-banner")).toBeVisible();
    const choice = secretary.getByTestId("finding-vote-finding");
    await expect(choice.locator("option:not([disabled])")).toHaveCount(1);
    const label = (await choice.locator(`option[value="${f.findingId}"]`).textContent()) ?? "";
    expect(label).toContain(text.substantiated);
    expect(label).toContain(text.subject);
    expect(label).not.toContain(NAME);
    await choice.selectOption(f.findingId);
    await secretary.getByTestId("finding-vote-title").fill("Synthetic: is the allegation substantiated?");
    await submitConfirmed(secretary, secretary.getByTestId("finding-vote-form"));
    // Back on the meeting, where the members vote.
    await secretary.waitForURL(new RegExp(`${meeting}$`));
    await expect(secretary.getByTestId("vote-1-status")).toHaveAttribute("data-status", "OPEN");
    await expect(secretary.getByTestId("vote-1")).toContainText("is the allegation substantiated?");
    await secretary.context().close();

    // A member reads the vote on the proceeding's page: the result, the allegation's category and the person by
    // number, never the finding's reasons. The invite and finding-vote pages are the runner's only.
    const member = await signIn(browser, IC_DEMO.icMemberB, locale);
    await member.goto(`/committee-proceedings/${f.committeeProceedingId}`);
    const row = member.getByTestId("finding-vote-1-1");
    await expect(row.getByTestId("finding-vote-1-1-status")).toHaveAttribute("data-status", "OPEN");
    await expect(row).toContainText(text.substantiated);
    await expect(row).toContainText(text.allegation);
    await expect(row).toContainText(text.subject);
    await expect(member.locator("main")).not.toContainText("the records support the allegation");
    await nothingOfTheCase(member, f.caseNumber);
    for (const path of [`${meeting}/invite`, `${meeting}/finding-vote`])
      expect((await member.goto(path))?.status(), path).toBe(404);
    await member.context().close();
  });
}

test("en: a conflict upheld after the vote taints the item, and the secretary confirms the committee's result", async ({
  browser,
}) => {
  const f = await proceedingMeeting(`taint-${randomUUID().slice(0, 8)}`);
  made.push(f);
  await adoptedPackage(f, await draftPackage(f));
  // A member raises a conflict about another who voted, and the chair upholds it: that vote no longer counts.
  await decidedConcern(f, "icMemberA", "icMemberB", "UPHELD");

  const secretary = await signIn(browser, IC_DEMO.icSecretary);
  await secretary.goto(`/committee-proceedings/${f.committeeProceedingId}`);
  const item = secretary.getByTestId("package-1-item-1");
  await expect(item.getByTestId("package-1-item-1-flag-TAINTED_BY_CONFLICT")).toBeVisible();
  // The committee's choices are those its command accepts now: vote again, or, as the counted votes still approve,
  // confirm the result. Here it confirms.
  const form = item.getByTestId("package-1-item-1-taint-form");
  await expect(form.getByTestId("package-1-item-1-taint-RE_VOTE")).toBeVisible();
  await form.getByTestId("package-1-item-1-taint-CONFIRM").check();
  await form
    .locator("#package-1-item-1-taint-reason")
    .fill("Synthetic: the counted votes still approve, for the e2e check.");
  await submitConfirmed(secretary, form);
  await expect(item.getByTestId("package-1-item-1-taint")).toHaveCount(0);
  await expect(item.getByTestId("package-1-item-1-flag-TAINTED_BY_CONFLICT")).toHaveCount(0);
  await expect(secretary.getByTestId("package-1-status")).toHaveAttribute("data-status", "ADOPTED");
  await secretary.context().close();
});

test("without a seat that gives the proceeding its page is a 404, and only the runner opens the invite and finding-vote pages", async ({
  browser,
}) => {
  const f = await proceedingMeeting(`proceeding-404-${randomUUID().slice(0, 8)}`);
  made.push(f);
  const proceeding = `/committee-proceedings/${f.committeeProceedingId}`;
  const runnerOnly = [`/meetings/${f.meetingId}/invite`, `/meetings/${f.meetingId}/finding-vote`];
  const nothing = [
    `/committee-proceedings/${randomUUID()}`,
    "/committee-proceedings/not-a-proceeding",
    `/meetings/${randomUUID()}/invite`,
    `/meetings/${randomUUID()}/finding-vote`,
  ];

  // The runner opens all three; an id that names nothing is the same 404 for them too.
  const secretary = await signIn(browser, IC_DEMO.icSecretary);
  for (const path of [proceeding, ...runnerOnly])
    expect((await secretary.goto(path))?.status(), path).toBe(200);
  for (const path of nothing) expect((await secretary.goto(path))?.status(), path).toBe(404);
  await secretary.context().close();

  // PLATFORM_ADMIN implies no seat (§21); the case team, who see the case, never see its committee's pages; a
  // committee role without a seat on this committee sees nothing of it (AMB-047).
  for (const email of [
    "admin@example.test",
    "casemanager@example.test",
    "investigator.a@example.test",
    "committee.secretary@example.test",
  ]) {
    const page = await signIn(browser, email);
    for (const path of [proceeding, ...runnerOnly, ...nothing.slice(0, 2)])
      expect((await page.goto(path))?.status(), `${email} ${path}`).toBe(404);
    await page.context().close();
  }

  // A member reads the proceeding, but neither invites nor opens a vote.
  const member = await signIn(browser, IC_DEMO.icMemberA);
  expect((await member.goto(proceeding))?.status()).toBe(200);
  for (const path of runnerOnly) expect((await member.goto(path))?.status(), path).toBe(404);
  await member.context().close();
});
