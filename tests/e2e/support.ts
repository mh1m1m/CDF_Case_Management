import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

/**
 * Each synthetic account's session cookies, one file per account in a git-ignored cache (CDF-249). The files outlive
 * the worker Playwright restarts after a failed test and the step between the e2e and accessibility runs, which use
 * the same database and servers, so a run signs each account in about once whatever fails or is retried.
 */
const SESSIONS = resolve("node_modules/.cache/cdf-e2e-sessions");
const sessionFile = (email: string) => join(SESSIONS, `${email}.json`);

function savedSession(email: string): SessionCookies | undefined {
  try {
    return JSON.parse(readFileSync(sessionFile(email), "utf8")) as SessionCookies;
  } catch {
    return undefined;
  }
}

async function saveSession(email: string, context: BrowserContext) {
  const cookies = (await context.cookies(APP)).filter((c) => c.name !== "cdf_locale");
  mkdirSync(SESSIONS, { recursive: true });
  // Written whole, then renamed into place, so a reader never sees half a file; the temporary name is the process's.
  const temporary = `${sessionFile(email)}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(cookies));
  renameSync(temporary, sessionFile(email));
}

/**
 * Signs a synthetic user in through the real login form in a fresh browser context. Later calls for the same
 * user reuse that session's cookies in a new context while it is still valid, so the combined e2e and
 * accessibility suites stay under the login rate limits without relaxing them: 10 per account and 50 per client
 * per fixed 15-minute window, and in CI every sign-in comes from the one client.
 */
export async function signIn(browser: Browser, email: string, locale: "ar" | "en" = "en"): Promise<Page> {
  const password = process.env.CDF_DEV_PASSWORD;
  if (!password) throw new Error("CDF_DEV_PASSWORD is not set");
  const cached = savedSession(email);
  if (cached) {
    const context = await contextIn(browser, locale, APP);
    await context.addCookies(cached);
    const page = await context.newPage();
    await page.goto("/");
    if (await page.getByTestId("signed-in-as").isVisible()) {
      // The visit renewed the session's idle window; keep the renewed cookie.
      await saveSession(email, context);
      return page;
    }
    rmSync(sessionFile(email), { force: true });
    await context.close();
  }
  const context = await contextIn(browser, locale, APP);
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel(locale === "en" ? "Email" : "البريد الإلكتروني").fill(email);
  await page.getByLabel(locale === "en" ? "Password" : "كلمة المرور").fill(password);
  await page.getByTestId("login-submit").click();
  // A refused sign-in (the rate limit, say) fails here with the page's own words, not a wait for the shell.
  const refused = page.getByTestId("login-error");
  await expect(page.getByTestId("signed-in-as").or(refused)).toBeVisible();
  if (await refused.isVisible())
    throw new Error(`Sign-in refused for ${email}: ${await refused.innerText()}`);
  await saveSession(email, context);
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

let sharedReport: Promise<{ reportRef: string; secret: string }> | undefined;

/**
 * One synthetic anonymous report shared by the accessibility specs that only need valid credentials. The portal
 * allows five submissions per client per hour, which the combined e2e and accessibility suites would otherwise
 * exceed; the limit itself is unchanged.
 */
export function sharedAnonymousReport(browser: Browser) {
  sharedReport ??= submitAnonymousReport(browser, "Synthetic report shared by the accessibility checks.");
  return sharedReport;
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

/**
 * Performs a workflow transition from the case page and waits for the stage badge to change. Closing, archiving
 * and returning a case ask for confirmation first (UX-031): pass `confirm` to accept the dialog.
 */
export async function transition(page: Page, code: string, reason?: string, confirm = false) {
  const item = page.getByTestId(`transition-${code}`);
  await expect(item).toBeVisible();
  if (reason) await item.locator("textarea").fill(reason);
  const before = await page.getByTestId("case-state").textContent();
  await item.getByRole("button").click();
  if (confirm) await page.getByRole("dialog").getByTestId("confirm-submit").click();
  await expect(page.getByTestId("case-state")).not.toHaveText(before ?? "");
}

/**
 * Opens the page of an evidence item on the case (UX-075), adding one synthetic PDF first when the case has none
 * (the seed holds no evidence). The page's user must be on the case's investigation team and may upload.
 */
export async function openEvidenceItem(page: Page, caseUrl: string): Promise<string> {
  await page.goto(`${caseUrl}/evidence`);
  await expect(page.getByTestId("evidence-card")).toBeVisible();
  if ((await page.locator('[data-testid^="evidence-row-"]').count()) === 0) {
    const form = page.getByTestId("evidence-form");
    await form.locator("#file").setInputFiles({
      name: "synthetic-item-page.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\n% synthetic evidence item page\n"),
    });
    await form.locator("#evidenceTitle").fill("Synthetic item page check");
    await form.locator('button[type="submit"]').click();
    await expect(form.getByRole("status")).toBeVisible();
    await page.reload();
  }
  await page.locator('[data-testid^="evidence-row-"]').first().click();
  await page.waitForURL(/\/evidence\/items\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("evidence-item")).toBeVisible();
  return page.url();
}
