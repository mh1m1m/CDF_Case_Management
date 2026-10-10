// CDF-54: the portal follow-up page keeps keyboard focus when its view changes (WCAG 2.4.3, 4.1.3),
// and the login error is announced once.
import { expect, test, type Page } from "@playwright/test";
import { APP, PORTAL, contextIn, submitAnonymousReport } from "../e2e/support";

let credentials: { reportRef: string; secret: string };

/** Fills the follow-up form and submits it with the keyboard, as a keyboard-only reporter would. */
async function openWithKeyboard(page: Page, secret: string) {
  await page.locator("#reportRef").fill(credentials.reportRef);
  await page.locator("#secret").fill(secret);
  await page.locator("#secret").press("Enter");
}

const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.tagName.toLowerCase(), id: el?.id ?? "", text: el?.textContent?.trim() ?? "" };
  });

test.describe("portal follow-up", () => {
  test.beforeAll(async ({ browser }) => {
    credentials = await submitAnonymousReport(browser, "Synthetic report for the follow-up focus check.");
  });

  for (const locale of ["ar", "en"] as const) {
    for (const width of [1280, 390]) {
      test(`${locale} ${width}px: focus moves to the status heading and back to the form`, async ({
        browser,
      }) => {
        const context = await contextIn(browser, locale, PORTAL);
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 800 });
        await page.goto("/follow-up");

        await openWithKeyboard(page, credentials.secret);
        await expect(page.getByTestId("report-status")).toBeVisible();
        await expect.poll(async () => (await focused(page)).tag).toBe("h2");
        expect((await focused(page)).text).toContain(credentials.reportRef);

        // Sign out of follow-up with the keyboard: focus returns to the Report ID field.
        await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("follow-up-form")).toBeVisible();
        await expect.poll(async () => (await focused(page)).id).toBe("reportRef");

        // A wrong secret keeps focus in the form rather than dropping it to <body>.
        await openWithKeyboard(page, "AAAA-BBBB-CCCC-DDDD-EEEE");
        await expect(page.getByTestId("follow-up-error")).toBeVisible();
        await expect.poll(async () => (await focused(page)).id).toBe("reportRef");
        await context.close();
      });
    }
  }
});

/** Live regions that currently hold text; the static demo notice is one of them on every page. */
const filledLiveRegions = (page: Page) =>
  page
    .locator('[role="alert"], [role="status"], [aria-live]:not([aria-live="off"])')
    .evaluateAll((els) => els.filter((el) => el.textContent?.trim()).length);

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: a failed sign-in is announced by exactly one live region`, async ({ browser }) => {
    const context = await contextIn(browser, locale, APP);
    const page = await context.newPage();
    await page.goto("/login");
    const before = await filledLiveRegions(page);
    await page.locator("#email").fill("nobody@example.test");
    await page.locator("#password").fill("synthetic-wrong-password");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-error")).toBeVisible();
    expect((await filledLiveRegions(page)) - before).toBe(1);
    await context.close();
  });
}
