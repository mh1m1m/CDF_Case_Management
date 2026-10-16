// WCAG 2.2 AA on the Phase 12 P12-2b pages (ADR-055) in Arabic and English, at a desktop and a phone width and at
// 320 px, acted by the seed's demo Investigation Committee: My Committees; the committee's page as the secretary, with a
// meeting listed, the scheduling form and a member to add, and as a member; and the meeting's logistics, as the
// secretary (the acting chair, and a witness without an account with every form on their row) and as a member (their
// own accommodations), with one confirmation. Every disclosure is open. Each meeting made here is settled and the late
// member's seat ended afterwards. Synthetic cases only.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { audit } from "./axe";
import {
  IC_DEMO,
  appointLateMember,
  closeFixtureConnections,
  demoCommitteeId,
  endLateMember,
  invitedWitness,
  openWithChairAbsent,
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
  test(`${locale}: My Committees and the committee page pass axe and reflow, for the secretary and a member`, async ({
    browser,
  }) => {
    // The committee's page lists each open proceeding with its forms, and each e2e fixture refers a case of its own to
    // the demo committee. After the e2e suite (CI runs it first, on the same database) the page holds about fifty
    // proceedings: about 1.9 MB and 8,100 elements, and one axe pass takes about 20 s (measured 2026-10-15 after the
    // P12-3a suite). The four passes here need more than the default 60 s; every check stays.
    test.setTimeout(240_000);
    const m = await meeting(`committee-a11y-${locale}`);
    const ic = await demoCommitteeId();
    // Appointed after the referral, so the secretary may add them to it: the amendment form shows.
    await appointLateMember();
    try {
      const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
      await check(secretary, "/committees", "my-committees", locale);
      await check(secretary, `/committees/${ic}`, `meeting-row-${m.meetingId}`, locale);
      await expect(secretary.getByTestId(/^schedule-[0-9a-f-]{36}-form$/).first()).toBeVisible();
      await expect(secretary.getByTestId(/^amend-[0-9a-f-]{36}-form$/).first()).toBeVisible();
      await secretary.context().close();

      const member = await signIn(browser, IC_DEMO.icMemberB, locale);
      await check(member, `/committees/${ic}`, `meeting-row-${m.meetingId}`, locale);
      await expect(member.getByTestId(/^schedule-[0-9a-f-]{36}$/)).toHaveCount(0);
      await member.context().close();
    } finally {
      await endLateMember();
    }
  });

  test(`${locale}: the meeting's logistics pass axe and reflow, for the secretary and a member`, async ({
    browser,
  }) => {
    const m = await meeting(`logistics-a11y-${locale}`);
    await invitedWitness(m);
    await openWithChairAbsent(m);
    const path = `/meetings/${m.meetingId}`;

    // The secretary: the acting chair to activate, and on the witness's row the declaration, undertaking,
    // accommodation and exclusion forms.
    const secretary = await signIn(browser, IC_DEMO.icSecretary, locale);
    await check(secretary, path, "acting-chair-form", locale);
    await expect(secretary.getByTestId(/^participant-\d+-on-behalf$/)).toHaveCount(1);
    await expect(secretary.getByTestId(/^participant-\d+-exclude-form$/)).toHaveCount(1);
    // The exclusion's confirmation, cancelled.
    await secretary.setViewportSize({ width: 1280, height: 900 });
    await secretary.goto(path);
    const exclude = secretary.getByTestId(/^participant-\d+-exclude-form$/);
    await secretary
      .getByTestId(/^participant-\d+-actions$/)
      .last()
      .locator("summary")
      .click();
    await exclude.locator("textarea").fill("Synthetic: heard and released by the committee.");
    await exclude.locator('button[type="submit"]').click();
    const dialog = secretary.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await audit(secretary);
    await dialog.getByTestId("confirm-cancel").click();
    await expect(dialog).toBeHidden();
    await expect(secretary.getByTestId("meeting-exclusions")).toHaveCount(0);
    await secretary.context().close();

    // A member: their own accommodations and the form to record one.
    const member = await signIn(browser, IC_DEMO.icMemberA, locale);
    await check(member, path, "my-accommodation-form", locale);
    await member.context().close();
  });
}
