// UX redesign S4 (ADR-025, migration 1920; audit RC-06): the header bell, the caller's own notifications and their
// notification settings, in Arabic (RTL) and English (LTR). A notice names the kind of event only; only its
// recipient sees or marks it; a mandatory notice has no off switch; another user's notice id answers the generic
// not-found refusal and changes nothing.
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./support";
import {
  closeFixtureConnections,
  demoCommitteeId,
  noticeRead,
  seatNotice,
  setNoticePreference,
} from "./records-fixture";

test.afterAll(closeFixtureConnections);

const TEXT = {
  en: {
    seat: "You have been appointed to a committee seat.",
    markRead: "Mark as read",
    bell: /^Notifications(, \d+ unread)?$/,
    saved: "Your notification settings are saved.",
  },
  ar: {
    seat: "تم تعيينك في مقعد بإحدى اللجان.",
    markRead: "تعليم كمقروء",
    bell: /^الإشعارات(، \d+ غير مقروءة)?$/,
    saved: "حُفظت إعدادات الإشعارات.",
  },
} as const;

const unread = async (page: Page) =>
  Number(await page.getByTestId("notification-bell").getAttribute("data-unread"));

for (const locale of ["ar", "en"] as const) {
  const text = TEXT[locale];

  test(`${locale}: the bell counts my unread notices, and I mark one read`, async ({ browser }) => {
    const id = await seatNotice("committee");
    const page = await signIn(browser, "committee@example.test", locale);
    await page.goto("/my-work");
    const bell = page.getByTestId("notification-bell");
    await expect(bell).toHaveAccessibleName(text.bell);
    const before = await unread(page);
    expect(before).toBeGreaterThan(0);

    await bell.click();
    await page.waitForURL(/\/notifications$/);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    const row = page.getByTestId(`notification-${id}`);
    await expect(row).toHaveAttribute("data-read", "false");
    await expect(row).toContainText(text.seat);
    await expect(row.getByTestId(`notification-unread-${id}`)).toBeVisible();
    // The committee's page has shipped (P12-2b), so the notice leads there, and that page checks the seat again. A
    // notice whose page has not shipped links nowhere (S4: no dead links; work-routes.test.ts).
    await expect(row.getByTestId(`notification-open-${id}`)).toHaveAttribute(
      "href",
      `/committees/${await demoCommitteeId()}`,
    );

    await row.getByRole("button", { name: `${text.markRead}: ${text.seat}` }).click();
    await expect(row).toHaveAttribute("data-read", "true");
    await expect(row.getByTestId(`notification-unread-${id}`)).toHaveCount(0);
    expect(await noticeRead("committee", id)).toBe(true);
    await expect.poll(() => unread(page)).toBe(before - 1);

    // The unread view no longer lists it.
    await page.goto("/notifications?view=unread");
    await expect(page.getByTestId(`notification-${id}`)).toHaveCount(0);
    await page.context().close();
  });

  test(`${locale}: another user's notice is invisible and cannot be marked read`, async ({ browser }) => {
    const theirs = await seatNotice("committee");
    const mine = await seatNotice("legalB");
    const page = await signIn(browser, "legal.b@example.test", locale);
    await page.goto("/notifications");
    await expect(page.getByTestId(`notification-${theirs}`)).toHaveCount(0);
    const form = page.getByTestId(`notification-mark-read-${mine}`);
    await expect(form).toBeVisible();
    // A forged id in my own form: the database answers the generic refusal, and nothing changes.
    await form.locator('input[name="notificationId"]').evaluate((el, value) => {
      (el as HTMLInputElement).value = value;
    }, theirs);
    await form.locator('button[type="submit"]').click();
    await expect(form.getByTestId("action-error")).toBeVisible();
    await expect(form.getByTestId("action-error")).not.toContainText(theirs);
    expect(await noticeRead("committee", theirs)).toBe(false);
    expect(await noticeRead("legalB", mine)).toBe(false);
    await page.context().close();
  });

  test(`${locale}: settings keep mandatory notices on and save my choice for an optional one`, async ({
    browser,
  }) => {
    await setNoticePreference("committee", "COMMITTEE_SEAT_ASSIGNED", "IN_APP", false);
    const page = await signIn(browser, "committee@example.test", locale);
    await page.goto("/my-work");
    await page.getByTestId("signed-in-as").click();
    await page.getByTestId("notification-settings-link").click();
    await page.waitForURL(/\/settings\/notifications$/);

    // A mandatory notice is listed as always sent and has no control at all.
    const mandatory = page.getByTestId("notification-settings-mandatory");
    await expect(mandatory).toBeVisible();
    await expect(mandatory.locator("input")).toHaveCount(0);
    await expect(page.getByTestId("receive-MEETING_INVITATION-IN_APP")).toHaveCount(0);
    await expect(page.getByTestId("email-stub-note")).toContainText("PRODUCTION_SUBSTITUTION_REQUIRED");

    // Email is off by rule for an optional notice: no box that would promise an email.
    await expect(page.getByTestId("receive-COMMITTEE_SEAT_ASSIGNED-EMAIL")).toHaveCount(0);
    await expect(page.getByTestId("off-COMMITTEE_SEAT_ASSIGNED-EMAIL")).toBeVisible();

    const choice = page.getByTestId("receive-COMMITTEE_SEAT_ASSIGNED-IN_APP");
    await expect(choice).toBeChecked();
    await choice.uncheck();
    await page.getByTestId("notification-settings-form").locator('button[type="submit"]').click();
    await expect(page.getByTestId("notification-settings-form")).toContainText(text.saved);
    await page.reload();
    await expect(page.getByTestId("receive-COMMITTEE_SEAT_ASSIGNED-IN_APP")).not.toBeChecked();

    // Saving again with nothing changed keeps the email setting unmuted (a missing box is not an untick).
    await page.getByTestId("notification-settings-form").locator('button[type="submit"]').click();
    await expect(page.getByTestId("notification-settings-form")).toContainText(text.saved);
    await expect(page.getByTestId("off-COMMITTEE_SEAT_ASSIGNED-EMAIL")).toBeVisible();

    // Restore the seed's setting through the same form.
    await page.getByTestId("receive-COMMITTEE_SEAT_ASSIGNED-IN_APP").check();
    await page.getByTestId("notification-settings-form").locator('button[type="submit"]').click();
    await expect(page.getByTestId("notification-settings-form")).toContainText(text.saved);
    await page.reload();
    await expect(page.getByTestId("receive-COMMITTEE_SEAT_ASSIGNED-IN_APP")).toBeChecked();
    await page.context().close();
  });
}
