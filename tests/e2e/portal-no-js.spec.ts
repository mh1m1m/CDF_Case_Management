// CDF-87 / UX-002 (DEC-59): with JavaScript off, every portal form must post to its own page, so no report text,
// Report ID or secret reaches a URL, a Referer, a redirect or a history entry. Report submission, follow-up sign-in
// and replies are server actions, so without script the portal does not act on the form: the outcome asserted here
// is that safe failure (nothing created, nothing disclosed, the page comes back empty), in Arabic and English.
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { PORTAL, contextIn, fillReportFields, submitAndReadReceipt } from "./support";

const NARRATIVE = "SYNTHETIC-PORTAL-NOJS report text, Employee Alpha example";
const REPLY = "SYNTHETIC-PORTAL-NOJS reply text from Witness Gamma";
const UNKNOWN = { reportRef: "WB-0000DEAD0000", secret: "ZZZZ-YYYY-XXXX-WWWW-VVVV" };
// Own synthetic client address (RFC 5737) so the portal's submit limit is not shared with other specs.
const CLIENT = "198.51.100.88";

async function noScript(browser: Browser, locale: "ar" | "en") {
  const context = await browser.newContext({ baseURL: PORTAL, javaScriptEnabled: false });
  await context.addCookies([{ name: "cdf_locale", value: locale, url: PORTAL }]);
  await context.setExtraHTTPHeaders({ "x-forwarded-for": CLIENT });
  return { context, page: await context.newPage() };
}

/** Submits the form as a browser without script does; asserts POST and that no URL carries a query or a needle. */
async function submitNatively(page: Page, form: Locator, needles: string[]) {
  await expect(form).toHaveAttribute("method", "post");
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.isNavigationRequest()),
    form.locator('button[type="submit"]').click(),
  ]);
  await page.waitForLoadState("load");
  const response = await request.response();
  expect(request.method()).toBe("POST");
  expect(response?.status()).toBe(200);
  const urls = [request.url(), request.headers()["referer"], response?.headers()["location"], page.url()];
  for (const url of urls.filter((u): u is string => Boolean(u))) {
    expect(new URL(url).search, url).toBe("");
    const decoded = decodeURIComponent(url.replaceAll("+", " "));
    for (const needle of needles) expect(decoded).not.toContain(needle);
  }
  return { body: new URLSearchParams(request.postData() ?? ""), html: await page.content() };
}

let realReport: Promise<{ reportRef: string; secret: string }> | undefined;

/** One synthetic report submitted with JavaScript on, so the no-JS sign-in is also tried with valid credentials. */
function realCredentials(browser: Browser) {
  realReport ??= (async () => {
    const context = await contextIn(browser, "en", PORTAL);
    await context.setExtraHTTPHeaders({ "x-forwarded-for": CLIENT });
    const page = await context.newPage();
    await page.goto("/report");
    await fillReportFields(page, "SYNTHETIC: report whose credentials the no-JS follow-up checks use.");
    await page.getByTestId("mode-anonymous").check();
    const receipt = await submitAndReadReceipt(page);
    await context.close();
    return receipt;
  })();
  return realReport;
}

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: the report form posts without JavaScript, creates nothing and keeps the text out of URLs`, async ({
    browser,
  }) => {
    const { context, page } = await noScript(browser, locale);
    await page.goto("/report");
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await fillReportFields(page, NARRATIVE);
    await page.getByTestId("mode-anonymous").check();
    const { body, html } = await submitNatively(page, page.getByTestId("report-form"), [
      NARRATIVE,
      "description=",
    ]);
    // The narrative travelled in the request body only.
    expect(body.get("description")).toBe(NARRATIVE);
    // Safe failure: no receipt (no Report ID or secret issued), an empty form, no error detail, nothing echoed.
    await expect(page.getByTestId("report-form")).toBeVisible();
    await expect(page.getByTestId("report-receipt")).toHaveCount(0);
    await expect(page.getByTestId("form-error")).toHaveCount(0);
    await expect(page.locator("#description")).toHaveValue("");
    expect(html).not.toContain(NARRATIVE);
    await context.close();
  });

  test(`${locale}: the follow-up sign-in posts without JavaScript and reveals nothing for a real or unknown report`, async ({
    browser,
  }) => {
    const real = await realCredentials(browser);
    for (const creds of [UNKNOWN, real]) {
      const { context, page } = await noScript(browser, locale);
      await page.goto("/follow-up");
      await page.locator("#reportRef").fill(creds.reportRef);
      await page.locator("#secret").fill(creds.secret);
      const { body, html } = await submitNatively(page, page.getByTestId("follow-up-form"), [
        creds.reportRef,
        creds.secret,
        "secret=",
      ]);
      expect(body.get("secret")).toBe(creds.secret);
      // The same empty sign-in form for both: no status, no error, so no signal that the Report ID exists.
      await expect(page.getByTestId("follow-up-form")).toBeVisible();
      await expect(page.getByTestId("report-status")).toHaveCount(0);
      await expect(page.getByTestId("follow-up-error")).toHaveCount(0);
      await expect(page.locator("#secret")).toHaveValue("");
      expect(html).not.toContain(creds.secret);
      expect(html).not.toContain(creds.reportRef);
      await context.close();
    }
  });
}

test("the reporter reply form posts without JavaScript and keeps the reply out of URLs", async ({
  browser,
}) => {
  const real = await realCredentials(browser);
  // The reply form exists only after a sign-in, which needs script: take its markup from a real signed-in page.
  const signedIn = await contextIn(browser, "en", PORTAL);
  await signedIn.setExtraHTTPHeaders({ "x-forwarded-for": CLIENT });
  const jsPage = await signedIn.newPage();
  await jsPage.goto("/follow-up");
  await jsPage.locator("#reportRef").fill(real.reportRef);
  await jsPage.locator("#secret").fill(real.secret);
  await jsPage.getByTestId("open-report").click();
  await expect(jsPage.locator("#body")).toBeVisible();
  const markup = await jsPage.locator("form", { has: jsPage.locator("#body") }).evaluate((f) => f.outerHTML);
  await signedIn.close();
  expect(markup).not.toContain(real.secret);

  const { context, page } = await noScript(browser, "en");
  await page.goto("/follow-up");
  await expect(page.locator("#body")).toHaveCount(0);
  // Without script the browser submits whatever form markup it has; place the real reply form and submit it.
  await page.locator("main").evaluate((main, html) => main.insertAdjacentHTML("beforeend", html), markup);
  await page.locator("#body").fill(REPLY);
  const { body, html } = await submitNatively(page, page.locator("form", { has: page.locator("#body") }), [
    REPLY,
    "body=",
    real.secret,
  ]);
  expect(body.get("body")).toBe(REPLY);
  expect([...body.keys()]).toEqual(["body"]);
  await expect(page.getByTestId("follow-up-form")).toBeVisible();
  await expect(page.getByTestId("report-status")).toHaveCount(0);
  expect(html).not.toContain(REPLY);
  await context.close();
});
