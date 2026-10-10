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

/** Signs a synthetic user in through the real login form in a fresh browser context. */
export async function signIn(browser: Browser, email: string, locale: "ar" | "en" = "en"): Promise<Page> {
  const password = process.env.CDF_DEV_PASSWORD;
  if (!password) throw new Error("CDF_DEV_PASSWORD is not set");
  const context = await contextIn(browser, locale, APP);
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel(locale === "en" ? "Email" : "البريد الإلكتروني").fill(email);
  await page.getByLabel(locale === "en" ? "Password" : "كلمة المرور").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("signed-in-as")).toBeVisible();
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
  await fillReportFields(page, description);
  await page.getByTestId("mode-anonymous").check();
  const receipt = await submitAndReadReceipt(page);
  await context.close();
  return receipt;
}

/** Fills the mandatory, mode-independent fields of the Drive intake field set (CDF-63). */
export async function fillReportFields(page: Page, description: string) {
  await page.locator("#relationship").selectOption("EMPLOYEE");
  await page.locator("#category").selectOption("IRREGULAR_TRANSACTIONS");
  await page.locator("#description").fill(description);
  await page.locator("#incidentDate").fill("2026-09-01");
  await page.locator("#incidentTime").fill("09:30");
  await page.locator("#location").fill("Procurement department (synthetic)");
  await page.locator("#subjectDescription").fill("Employee Alpha (synthetic)");
  await page.getByTestId("cooperate-yes").check();
  await page.locator('input[name="acknowledgement"]').check();
}

export async function submitAndReadReceipt(page: Page) {
  await page.getByTestId("submit-report").click();
  await expect(page.getByTestId("report-receipt")).toBeVisible();
  const reportRef = (await page.getByTestId("receipt-ref").textContent())!.trim();
  const secret = (await page.getByTestId("receipt-secret").textContent())!.trim();
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
