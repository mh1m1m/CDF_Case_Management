// WCAG 2.2 AA on the Phase 12 P12-2c pages (ADR-056) in Arabic and English, at a desktop and a phone width and at
// 320 px, acted by the seed's demo Investigation Committee: the proceeding's page as the secretary building a package
// (a draft with its item and the forms to add another, withdraw it and put the package to the vote, with that
// confirmation), then with the adoption to record, then with a conflict taint to resolve, and as a member reading the
// package and a vote on a finding; and the meeting's invite and finding-vote pages as the secretary, with the
// invitation's confirmation. Every disclosure is open. Each meeting made here is settled afterwards, and Investigator
// Alpha, who records the finding, leaves the case again, so the seed's "my cases" stay as they were. Synthetic cases
// only.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { audit } from "./axe";
import {
  IC_DEMO,
  adoptionRecorded,
  closeFixtureConnections,
  decidedConcern,
  draftPackage,
  endInvestigatorAssignment,
  findingVoteOpened,
  openVotesApproved,
  packageVoteOpened,
  proceedingMeeting,
  settleMeeting,
  type ProceedingFixture,
} from "../e2e/records-fixture";
import { signIn } from "../e2e/support";

const made: ProceedingFixture[] = [];
test.afterEach(async () => {
  for (const f of made.splice(0)) {
    await settleMeeting(f.meetingId);
    await endInvestigatorAssignment(f.caseId);
  }
});
test.afterAll(closeFixtureConnections);

const WIDTHS = [1280, 390, 320] as const;

async function meeting(what: string) {
  const f = await proceedingMeeting(`${what}-${randomUUID().slice(0, 8)}`);
  made.push(f);
  return f;
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
  test(`${locale}: the proceeding's page passes axe and reflows, for the secretary building a package and for a member`, async ({
    browser,
  }) => {
    const f = await meeting(`proceeding-a11y-${locale}`);
    const path = `/committee-proceedings/${f.committeeProceedingId}`;
    const pkg = await draftPackage(f, "ITEM");

    // A draft with its item: the forms to create another package, add an item, withdraw one and put it to the vote.
    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await check(secretary, path, "package-1", locale);
    for (const form of ["create-package-form", "package-1-add-form", "package-1-submit-form"])
      await expect(secretary.getByTestId(form)).toBeVisible();
    await expect(secretary.getByTestId("package-1-item-1-withdraw-form")).toBeVisible();
    await expect(secretary.getByTestId("package-1-item-1-flag-SANCTION_SOURCE_REQUIRED")).toBeVisible();
    // Putting it to the vote asks first.
    await secretary.setViewportSize({ width: 1280, height: 900 });
    await secretary.goto(path);
    await confirmationChecked(secretary, "package-1-submit-form");
    await expect(secretary.getByTestId("package-1-status")).toHaveAttribute("data-status", "DRAFT");

    // A vote on the finding, then the package's vote, approved and closed: the adoption is the secretary's to record.
    await findingVoteOpened(f);
    await packageVoteOpened(f, pkg);
    await openVotesApproved(f);
    await check(secretary, path, "package-1-adopt-form", locale);
    await expect(secretary.getByTestId("proceeding-finding-vote-list")).toBeVisible();
    // Adopted, then a conflict upheld against a member who voted: the item's taint is the committee's to resolve.
    await adoptionRecorded(pkg);
    await decidedConcern(f, "icMemberA", "icMemberB", "UPHELD");
    await check(secretary, path, "package-1-item-1-taint-form", locale);
    await expect(secretary.getByTestId("package-1-item-1-flag-TAINTED_BY_CONFLICT")).toBeVisible();
    await secretary.context().close();

    // A member: the package and the vote on the finding, with no form.
    const member = await signIn(browser, IC_DEMO.icMemberA, locale);
    await check(member, path, "proceeding-finding-vote-list", locale);
    await expect(member.getByTestId("package-1-items")).toBeVisible();
    await expect(member.locator("main form")).toHaveCount(0);
    await member.context().close();
  });

  test(`${locale}: the meeting's invite and finding-vote pages pass axe and reflow, with the invitation's confirmation`, async ({
    browser,
  }) => {
    const f = await meeting(`invite-a11y-${locale}`);
    const invite = `/meetings/${f.meetingId}/invite`;

    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await check(secretary, invite, "invite-persons", locale);
    await expect(secretary.getByTestId("invite-person-0-form")).toBeVisible();
    await expect(secretary.getByTestId("invite-accounts")).toBeVisible();
    await check(secretary, `/meetings/${f.meetingId}/finding-vote`, "finding-vote-form", locale);

    // The invitation asks first; cancelled, the person stays on the list.
    await secretary.setViewportSize({ width: 1280, height: 900 });
    await secretary.goto(invite);
    await secretary.getByTestId("invite-person-0-invite").locator("summary").click();
    const form = secretary.getByTestId("invite-person-0-form");
    await form.getByTestId("invite-person-0-role").selectOption("WITNESS");
    await form.locator("textarea").fill("Synthetic: to hear the person, for the accessibility check.");
    await confirmationChecked(secretary, "invite-person-0-form");
    await expect(secretary.getByTestId("invite-person-0")).toBeVisible();
    await secretary.context().close();
  });
}
