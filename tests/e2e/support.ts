import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

export const PORTAL = "http://127.0.0.1:3001";
export const APP = "http://127.0.0.1:3000";

export async function contextIn(
  browser: Browser,
  locale: "ar" | "en",
  baseURL: string,
): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL });
  await context.addCookies([{ name: "cdf_locale", value: locale, url: baseURL }]);
  return context;
}

type SessionCookies = Awaited<ReturnType<BrowserContext["cookies"]>>;
const sessions = new Map<string, SessionCookies>();

/**
 * Signs a synthetic user in through the real login form in a fresh browser context. Later calls for the same
 * user reuse that session's cookies in a new context while it is still valid, so the combined e2e and
 * accessibility suites stay under the per-account login rate limit (10 per 15 minutes) without relaxing it.
 */
export async function signIn(browser: Browser, email: string, locale: "ar" | "en" = "en"): Promise<Page> {
  const password = process.env.CDF_DEV_PASSWORD;
  if (!password) throw new Error("CDF_DEV_PASSWORD is not set");
  const cached = sessions.get(email);
  if (cached) {
    const context = await contextIn(browser, locale, APP);
    await context.addCookies(cached);
    const page = await context.newPage();
    await page.goto("/");
    if (await page.getByTestId("signed-in-as").isVisible()) return page;
    sessions.delete(email);
    await context.close();
  }
  const context = await contextIn(browser, locale, APP);
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel(locale === "en" ? "Email" : "البريد الإلكتروني").fill(email);
  await page.getByLabel(locale === "en" ? "Password" : "كلمة المرور").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("signed-in-as")).toBeVisible();
  sessions.set(
    email,
    (await context.cookies(APP)).filter((c) => c.name !== "cdf_locale"),
  );
  return page;
}

export async function submitAnonymousReport(
  browser: Browser,
  description: string,
  locale: "ar" | "en" = "en",
) {
  const context = await contextIn(browser, locale, PORTAL);
  const page = await context.newPage();
  await page.goto("/report");
  await page.locator("#category").selectOption("PROCUREMENT");
  await page.locator("#description").fill(description);
  await page.locator('input[name="acknowledgement"]').check();
  await page.getByTestId("submit-report").click();
  await expect(page.getByTestId("report-receipt")).toBeVisible();
  const reportRef = (await page.getByTestId("receipt-ref").textContent())!.trim();
  const secret = (await page.getByTestId("receipt-secret").textContent())!.trim();
  await context.close();
  return { reportRef, secret };
}

export async function publicStatus(browser: Browser, reportRef: string, secret: string) {
  const context = await contextIn(browser, "en", PORTAL);
  const page = await context.newPage();
  await page.goto("/follow-up");
  await page.locator("#reportRef").fill(reportRef);
  await page.locator("#secret").fill(secret);
  await page.getByTestId("open-report").click();
  const status = (await page.getByTestId("public-status").textContent())?.trim();
  await context.close();
  return status;
}

/** Performs a workflow transition from the case page and waits for the stage badge to change. */
export async function transition(page: Page, code: string, reason?: string) {
  const item = page.getByTestId(`transition-${code}`);
  await expect(item).toBeVisible();
  if (reason) await item.locator("textarea").fill(reason);
  const before = await page.getByTestId("case-state").textContent();
  await item.getByRole("button").click();
  await expect(page.getByTestId("case-state")).not.toHaveText(before ?? "");
}
