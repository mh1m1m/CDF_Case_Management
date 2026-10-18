// CDF-255: with JavaScript off, or before the page is interactive, the investigation app never answers a form with a
// bare error page. Every submit button stays disabled until the page is interactive, so the browser posts nothing on
// its own: not on a click, not on Enter in a field. With JavaScript off a notice says that signing in, signing out and
// sending forms need it; pages can still be read and links followed. Arabic and English, desktop and phone width.
// The server's origin check is unchanged: tests/e2e/security-csrf.spec.ts still sees a cross-origin post refused.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { APP, signIn } from "./support";

type Locale = "ar" | "en";

const SEED_REF = "WB-SEED00000006"; // awaiting information: intake officers can reply

const NOTICE: Record<Locale, string> = {
  en: "JavaScript is turned off in this browser. You can still read pages, but you need to turn it on to sign in, sign out or send a form.",
  ar: "جافا سكريبت معطلة في هذا المتصفح. يمكنك قراءة الصفحات، لكن تسجيل الدخول أو الخروج أو إرسال أي نموذج يتطلب تفعيلها.",
};

async function newContext(
  browser: Browser,
  locale: Locale,
  options: { javaScriptEnabled?: boolean; viewport?: { width: number; height: number } } = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: APP, ...options });
  await context.addCookies([{ name: "cdf_locale", value: locale, url: APP }]);
  return context;
}

/** Every answer of 500 or more the page receives. */
function serverErrors(page: Page): string[] {
  const seen: string[] = [];
  page.on("response", (r) => {
    if (r.status() >= 500) seen.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return seen;
}

/** Runs `act` and returns the URL of any POST the page sends within the next 1.5 s, or null. */
async function postAfter(page: Page, act: () => Promise<void>): Promise<string | null> {
  const post = page
    .waitForRequest((r) => r.method() === "POST", { timeout: 1_500 })
    .then(
      (r) => r.url(),
      () => null,
    );
  await act();
  return post;
}

async function signInIsHeld(page: Page) {
  const submit = page.getByTestId("login-submit");
  await expect(submit).toBeDisabled();
  await page.locator("#email").fill("intake@example.test");
  // Never the real password: whatever happens, nothing here may sign anyone in.
  await page.locator("#password").fill("not-the-password");
  // Enter in a field submits only through an enabled default button, and a disabled button takes no click.
  expect(await postAfter(page, () => page.locator("#password").press("Enter"))).toBeNull();
  expect(await postAfter(page, () => submit.click({ force: true }))).toBeNull();
  await expect(page.getByTestId("login-form")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
}

for (const locale of ["en", "ar"] as const) {
  test(`${locale}: with JavaScript off, sign-in waits for it and says so`, async ({ browser }) => {
    const context = await newContext(browser, locale, { javaScriptEnabled: false });
    const page = await context.newPage();
    const errors = serverErrors(page);
    await page.goto("/login");
    await expect(page.getByTestId("no-script-notice")).toHaveText(NOTICE[locale]);
    await signInIsHeld(page);
    expect(errors).toEqual([]);
    await context.close();
  });

  test(`${locale}: with JavaScript off, a signed-in page reads but sends nothing`, async ({ browser }) => {
    // The session comes from a normal sign-in; with JavaScript on there is no notice.
    const signedIn = await signIn(browser, "intake@example.test", locale);
    await expect(signedIn.getByTestId("no-script-notice")).toHaveCount(0);
    const session = (await signedIn.context().cookies(APP)).filter((c) => c.name !== "cdf_locale");
    await signedIn.context().close();

    const context = await newContext(browser, locale, { javaScriptEnabled: false });
    await context.addCookies(session);
    const page = await context.newPage();
    const errors = serverErrors(page);
    await page.goto("/intake");
    await expect(page.getByTestId("no-script-notice")).toHaveText(NOTICE[locale]);
    // Reading and following links work without JavaScript.
    await page.getByTestId(`report-${SEED_REF}`).click();
    await expect(page.getByTestId("reply-form")).toBeVisible();
    await expect(page.getByTestId("no-script-notice")).toHaveText(NOTICE[locale]);

    // Every form on the page waits, and a click on its button sends nothing.
    const buttons = page.locator('form button[type="submit"]');
    expect(await buttons.count()).toBeGreaterThan(0);
    for (const button of await buttons.all()) await expect(button).toBeDisabled();
    await page
      .getByTestId("reply-form")
      .locator("#body")
      .fill(`No-JS reply ${Date.now().toString(36)} (synthetic)`);
    const send = page.getByTestId("reply-form").getByRole("button");
    expect(await postAfter(page, () => send.click({ force: true }))).toBeNull();

    // The account menu opens without JavaScript; signing out waits for it too.
    await page.getByTestId("signed-in-as").click();
    await expect(page.getByTestId("sign-out")).toBeVisible();
    await expect(page.getByTestId("sign-out")).toBeDisabled();
    expect(errors).toEqual([]);
    await context.close();
  });
}

test("at phone width, the notice wraps without widening the page", async ({ browser }) => {
  for (const locale of ["en", "ar"] as const) {
    const context = await newContext(browser, locale, {
      javaScriptEnabled: false,
      viewport: { width: 320, height: 640 },
    });
    const page = await context.newPage();
    await page.goto("/login");
    await expect(page.getByTestId("no-script-notice")).toBeVisible();
    const width = await page.locator("html").evaluate((html) => html.scrollWidth);
    expect(width, locale).toBeLessThanOrEqual(320);
    await context.close();
  }
});

test("before the page is interactive, nothing is posted, and once it is the form works", async ({
  browser,
}) => {
  // JavaScript on, but the app's scripts held back: the page stays as the server sent it, before hydration.
  const held = await newContext(browser, "en");
  await held.route("**/*", (route) =>
    route.request().resourceType() === "script" ? route.abort() : route.continue(),
  );
  const page = await held.newPage();
  const errors = serverErrors(page);
  await page.goto("/login");
  // The notice is only for JavaScript off; here the button alone waits.
  await expect(page.getByTestId("no-script-notice")).toHaveCount(0);
  await signInIsHeld(page);
  expect(errors).toEqual([]);
  await held.close();

  // Once the page is interactive the same button is enabled.
  const ready = await newContext(browser, "en");
  const live = await ready.newPage();
  await live.goto("/login");
  await expect(live.getByTestId("login-submit")).toBeEnabled();
  await ready.close();
});
