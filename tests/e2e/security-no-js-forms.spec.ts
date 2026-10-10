// CDF-87: a portal form submitted before hydration (or with JavaScript off) must never put report content,
// a Report ID or a secret in a URL, where browser history, server and proxy logs and Referer headers keep it.
import { expect, test, type Browser, type Page, type Request } from "@playwright/test";
import { PORTAL, contextIn, fillReportFields, submitAndReadReceipt } from "./support";

const NARRATIVE = "SYNTHETIC-NOJS-NARRATIVE allegation text that must stay out of URLs";
const REF = "WB-0123456789AB";
const SECRET = "ABCD-EFGH-JKMN-PQRS-TVWX";

async function noJsPage(browser: Browser) {
  const context = await browser.newContext({ baseURL: PORTAL, javaScriptEnabled: false });
  await context.addCookies([{ name: "cdf_locale", value: "en", url: PORTAL }]);
  const page = await context.newPage();
  const requests: Request[] = [];
  page.on("request", (r) => requests.push(r));
  return { context, page, requests };
}

function urlsCarrying(requests: Request[], needles: string[]) {
  return requests
    .map((r) => decodeURIComponent(r.url().replaceAll("+", " ")))
    .filter((url) => needles.some((n) => url.includes(n)) || new URL(url).search.length > 0);
}

async function submitWithoutScript(page: Page, testId: string) {
  const form = page.getByTestId(testId);
  await expect(form).toHaveAttribute("method", "post");
  await Promise.all([page.waitForLoadState("load"), form.locator('button[type="submit"]').first().click()]);
}

test("the report form, submitted without JavaScript, keeps the narrative out of every URL", async ({
  browser,
}) => {
  const { context, page, requests } = await noJsPage(browser);
  await page.goto("/report");
  await page.locator("#description").fill(NARRATIVE);
  await page.locator("#location").fill("SYNTHETIC-NOJS-LOCATION");
  requests.length = 0;
  await submitWithoutScript(page, "report-form");
  const navigation = requests.find((r) => r.isNavigationRequest());
  expect(navigation?.method()).toBe("POST");
  expect(urlsCarrying(requests, [NARRATIVE, "SYNTHETIC-NOJS-LOCATION", "description="])).toEqual([]);
  expect(new URL(page.url()).search).toBe("");
  // The server answers with the page again, not an error or a stack trace.
  await expect(page.getByTestId("report-form")).toBeVisible();
  await context.close();
});

test("the follow-up form, submitted without JavaScript, keeps the Report ID and secret out of every URL", async ({
  browser,
}) => {
  const { context, page, requests } = await noJsPage(browser);
  await page.goto("/follow-up");
  await page.locator("#reportRef").fill(REF);
  await page.locator("#secret").fill(SECRET);
  requests.length = 0;
  await submitWithoutScript(page, "follow-up-form");
  const navigation = requests.find((r) => r.isNavigationRequest());
  expect(navigation?.method()).toBe("POST");
  expect(urlsCarrying(requests, [REF, SECRET, "secret="])).toEqual([]);
  expect(new URL(page.url()).search).toBe("");
  await expect(page.getByTestId("follow-up-form")).toBeVisible();
  await context.close();
});

test("every portal form declares method=post, including the reporter reply form", async ({ browser }) => {
  const context = await contextIn(browser, "en", PORTAL);
  // Own synthetic client address (RFC 5737) so the portal's submit limit is not shared with other specs.
  await context.setExtraHTTPHeaders({ "x-forwarded-for": "198.51.100.87" });
  const page = await context.newPage();
  const methods = async () =>
    page
      .locator("form")
      .evaluateAll((forms) => forms.map((f) => (f.getAttribute("method") ?? "").toLowerCase()));
  for (const path of ["/", "/report", "/follow-up"]) {
    await page.goto(path);
    expect(
      (await methods()).filter((m) => m !== "post"),
      path,
    ).toEqual([]);
  }
  // The reply form appears only after signing in to a report.
  await page.goto("/report");
  await fillReportFields(page, "SYNTHETIC: report for the CDF-87 form-method check.");
  await page.getByTestId("mode-anonymous").check();
  const { reportRef, secret } = await submitAndReadReceipt(page);
  await page.goto("/follow-up");
  await page.locator("#reportRef").fill(reportRef);
  await page.locator("#secret").fill(secret);
  await page.getByTestId("open-report").click();
  await expect(page.locator("#body")).toBeVisible();
  const all = await methods();
  expect(all.length).toBeGreaterThan(0);
  expect(all.filter((m) => m !== "post")).toEqual([]);
  await context.close();
});
