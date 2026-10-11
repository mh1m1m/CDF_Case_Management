// CDF-87 / UX-002 (DEC-59): with JavaScript off, the portal works and keeps secrets out of URLs. The report form,
// the follow-up sign-in and the reply all POST natively; the server answers in the POST response (receipt, status,
// conversation), and no report text, Report ID or secret reaches a URL, Referer, Location or history entry.
// Arabic and English. Fields JavaScript would reveal are reachable; a failed submission keeps the reporter's text
// but never echoes identity; the secret is never written into a response.
import { expect, test, type Browser, type Locator, type Page, type Request } from "@playwright/test";
import postgres from "postgres";
import { PORTAL, fillReportFields } from "./support";

const TAG = Date.now().toString(36);
const UNKNOWN = { reportRef: "WB-0000DEAD0000", secret: "ZZZZ-YYYY-XXXX-WWWW-VVVV" };
// Own synthetic client addresses (RFC 5737) so the portal's limits are not shared with other specs.
const CLIENT = { ar: "198.51.100.88", en: "198.51.100.89", followUp: "198.51.100.90", csrf: "198.51.100.91" };
const NO_MESSAGES = { ar: "لا توجد رسائل بعد.", en: "No messages yet." };

/** Test-only read: reports carrying this exact synthetic narrative (the portal role cannot read intake rows). */
async function reportsWith(narrative: string): Promise<number> {
  const host = process.env.CDF_TEST_DB_HOST ?? "127.0.0.1";
  const port = process.env.CDF_TEST_DB_PORT ?? "54322";
  const pw = process.env.CDF_ADMIN_DB_PASSWORD;
  const url =
    process.env.CDF_ADMIN_DATABASE_URL ??
    `postgresql://postgres${pw ? `:${encodeURIComponent(pw)}` : ""}@${host}:${port}/postgres`;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from intake.report where description = ${narrative}`;
    return row?.n ?? 0;
  } finally {
    await sql.end();
  }
}

async function noScript(browser: Browser, locale: "ar" | "en", client: string) {
  const context = await browser.newContext({ baseURL: PORTAL, javaScriptEnabled: false });
  await context.addCookies([{ name: "cdf_locale", value: locale, url: PORTAL }]);
  await context.setExtraHTTPHeaders({ "x-forwarded-for": client });
  const page = await context.newPage();
  const requests: Request[] = [];
  page.on("request", (r) => requests.push(r));
  return { context, page, requests };
}

/** Submits the form as a browser without script does. Asserts POST and 200; returns the raw response HTML. */
async function submitNatively(page: Page, form: Locator) {
  await expect(form).toHaveAttribute("method", /^post$/i);
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.isNavigationRequest()),
    form.locator('button[type="submit"]').first().click(),
  ]);
  await page.waitForLoadState("load");
  const response = await request.response();
  expect(request.method()).toBe("POST");
  expect(response?.status()).toBe(200);
  return { html: (await response?.text()) ?? "" };
}

/** Every URL the browser sent or kept: request URLs, Referer and Location headers, and the history entries. */
async function urlTrail(page: Page, requests: Request[]): Promise<string[]> {
  const trail: string[] = [];
  for (const r of requests) {
    trail.push(r.url());
    const referer = r.headers()["referer"];
    if (referer) trail.push(referer);
    const location = (await r.response())?.headers()["location"];
    if (location) trail.push(new URL(location, r.url()).toString());
  }
  const cdp = await page.context().newCDPSession(page);
  const { entries } = await cdp.send("Page.getNavigationHistory");
  await cdp.detach();
  return [...trail, ...entries.map((e) => e.url)];
}

function expectClean(trail: string[], needles: string[]) {
  for (const url of trail.filter((u) => !u.startsWith("about:"))) {
    if (!new URL(url).pathname.startsWith("/_next/")) expect(new URL(url).search, url).toBe("");
    const decoded = decodeURIComponent(url.replaceAll("+", " "));
    for (const needle of needles) expect(decoded, "a URL carries a sensitive value").not.toContain(needle);
  }
}

let followUpReport: Promise<{ reportRef: string; secret: string }> | undefined;

/** One report submitted without JavaScript, shared by the follow-up tests. */
function noScriptReport(browser: Browser) {
  followUpReport ??= (async () => {
    const { context, page } = await noScript(browser, "en", CLIENT.followUp);
    await page.goto("/report");
    await fillReportFields(page, `SYNTHETIC-PORTAL-NOJS ${TAG}: report followed up without JavaScript.`);
    await submitNatively(page, page.getByTestId("report-form"));
    const reportRef = (await page.getByTestId("receipt-ref").textContent())!.trim();
    const secret = (await page.getByTestId("receipt-secret").textContent())!.trim();
    await context.close();
    return { reportRef, secret };
  })();
  return followUpReport;
}

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: a report submitted without JavaScript is created once and its receipt never reaches a URL`, async ({
    browser,
  }) => {
    const { context, page, requests } = await noScript(browser, locale, CLIENT[locale]);
    await page.goto("/report");
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    const narrative = `SYNTHETIC-PORTAL-NOJS ${locale} ${TAG}: report text, Employee Alpha example`;
    await fillReportFields(page, narrative);
    // The default mode is in the markup, so a form without JavaScript starts anonymous.
    await expect(page.getByTestId("mode-anonymous")).toBeChecked();
    expect(await reportsWith(narrative)).toBe(0);

    const { html } = await submitNatively(page, page.getByTestId("report-form"));
    expect(await reportsWith(narrative)).toBe(1);
    await expect(page.getByTestId("report-receipt")).toBeVisible();
    await expect(page.getByTestId("receipt-ref")).toHaveCount(1);
    const reportRef = (await page.getByTestId("receipt-ref").textContent())!.trim();
    const secret = (await page.getByTestId("receipt-secret").textContent())!.trim();
    expect(reportRef).toMatch(/^WB-/);
    // The receipt is the POST response itself.
    expect(html).toContain(reportRef);
    // Uploading needs JavaScript: the receipt says so instead of offering a control that cannot work.
    await expect(page.getByTestId("attachments-need-javascript")).toBeVisible();
    await expect(page.getByTestId("upload-attachments")).toBeDisabled();
    expectClean(await urlTrail(page, requests), [narrative, reportRef, secret, "description=", "secret="]);

    // Shown once: opening the form again shows no receipt and no secret.
    const again = await page.goto("/report");
    await expect(page.getByTestId("report-receipt")).toHaveCount(0);
    expect(await again!.text()).not.toContain(secret);
    expect(await reportsWith(narrative)).toBe(1);
    await context.close();
  });

  test(`${locale}: a report that fails validation without JavaScript keeps the text and never echoes identity`, async ({
    browser,
  }) => {
    const { context, page, requests } = await noScript(browser, locale, CLIENT[locale]);
    await page.goto("/report");
    const narrative = `SYNTHETIC-PORTAL-NOJS invalid ${locale} ${TAG}: report text, Employee Alpha example`;
    await fillReportFields(page, narrative);
    await page.locator("#incidentTime").fill(""); // the one invalid field
    // Fields JavaScript would reveal are reachable without it.
    await page.locator("#category").selectOption("OTHER");
    await page.locator("#categoryOther").fill("SYNTHETIC other category");
    await page.getByTestId("mode-identified").check();
    const identity = {
      givenName: "NoJsGiven",
      fatherName: "NoJsFather",
      grandfatherName: "NoJsGrandfather",
      familyName: "NoJsFamily",
      birthDate: "1991-07-22", // not the hint's own example date, which the page shows anyway
      idNumber: "1000000088",
      phone: "+966 500000088",
      email: "nojs.reporter@example.test",
    };
    for (const [id, value] of Object.entries(identity)) await page.locator(`#${id}`).fill(value);
    await page.locator("#gender").selectOption("FEMALE");
    await page.locator("#nationality").selectOption("SA");
    await page.locator("#idType").selectOption("NATIONAL_ID");
    await page.locator("#city").selectOption("RIYADH");

    const { html } = await submitNatively(page, page.getByTestId("report-form"));
    expect(await reportsWith(narrative)).toBe(0);
    await expect(page.getByTestId("report-receipt")).toHaveCount(0);
    // Error summary and inline error, with the reporter's non-identity values kept.
    await expect(page.getByTestId("report-form").locator('[role="alert"]').first()).toBeVisible();
    await expect(page.locator("#incidentTime")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#description")).toHaveValue(narrative);
    await expect(page.locator("#categoryOther")).toHaveValue("SYNTHETIC other category");
    await expect(page.getByTestId("mode-identified")).toBeChecked();
    // Identity is never sent back: the page says plainly to enter it again.
    await expect(page.getByTestId("reenter-identity")).toBeVisible();
    await expect(page.locator("#givenName")).toHaveValue("");
    for (const value of Object.values(identity)) expect(html).not.toContain(value);
    expectClean(await urlTrail(page, requests), [narrative, ...Object.values(identity), "description="]);
    await context.close();
  });

  test(`${locale}: follow-up without JavaScript signs in, refuses uniformly and replies; the secret is never in a response`, async ({
    browser,
  }) => {
    const real = await noScriptReport(browser);
    const { context, page, requests } = await noScript(browser, locale, CLIENT.followUp);

    // An unknown Report ID and a wrong secret get the same answer (§23).
    const refusals: string[] = [];
    for (const creds of [UNKNOWN, { reportRef: real.reportRef, secret: UNKNOWN.secret }]) {
      await page.goto("/follow-up");
      await page.locator("#reportRef").fill(creds.reportRef);
      await page.locator("#secret").fill(creds.secret);
      const { html } = await submitNatively(page, page.getByTestId("follow-up-form"));
      await expect(page.getByTestId("follow-up-error")).toBeVisible();
      await expect(page.getByTestId("report-status")).toHaveCount(0);
      expect(html).not.toContain(creds.secret);
      refusals.push(await page.locator("main").innerText());
    }
    expect(refusals[1]).toBe(refusals[0]);

    // Valid credentials: the status and the conversation come back in the POST response.
    await page.goto("/follow-up");
    await page.locator("#reportRef").fill(real.reportRef);
    await page.locator("#secret").fill(real.secret);
    const signedIn = await submitNatively(page, page.getByTestId("follow-up-form"));
    await expect(page.getByTestId("report-status")).toBeVisible();
    await expect(page.getByTestId("public-status")).toBeVisible();
    // The conversation: its messages, or its empty state when nothing has been exchanged yet.
    await expect(page.getByTestId("report-messages").or(page.getByText(NO_MESSAGES[locale]))).toBeVisible();
    expect(signedIn.html).not.toContain(real.secret);

    // The reply form asks for the secret again; it is never written into the page.
    await expect(page.getByTestId("reply-form").locator("#secret")).toHaveValue("");
    const reply = `SYNTHETIC-PORTAL-NOJS reply ${locale} ${TAG} from Witness Gamma`;
    await page.locator("#secret").fill(real.secret);
    await page.locator("#body").fill(reply);
    const replied = await submitNatively(page, page.getByTestId("reply-form"));
    await expect(page.getByTestId("reply-sent")).toBeVisible();
    await expect(page.getByTestId("report-messages")).toContainText(reply);
    expect(replied.html).not.toContain(real.secret);
    expectClean(await urlTrail(page, requests), [real.reportRef, real.secret, reply, "secret=", "body="]);
    await context.close();
  });
}

test("a forged report post from another origin creates nothing, even with Origin: null", async ({
  browser,
}) => {
  // The report form exactly as the server renders it, with its progressive-enhancement action fields.
  const probe = await browser.newContext();
  const served = await (await probe.request.get(`${PORTAL}/report`)).text();
  await probe.close();
  const markup = /<form[^>]*data-testid="report-form"[\s\S]*?<\/form>/.exec(served)![0];
  const attempt = async (origin: string, noReferrer: boolean) => {
    const narrative = `SYNTHETIC-PORTAL-NOJS forged ${TAG} ${origin} ${noReferrer}: report text, Employee Alpha example`;
    const context = await browser.newContext();
    await context.setExtraHTTPHeaders({ "x-forwarded-for": CLIENT.csrf });
    const form = markup
      .replace(
        /<form([^>]*)>/,
        (_m, attrs: string) =>
          `<form${attrs.replace(/\saction="[^"]*"/, "")} action="${PORTAL}/report" id="forged">`,
      )
      .replace(/(<textarea[^>]*name="description"[^>]*>)[\s\S]*?<\/textarea>/, `$1${narrative}</textarea>`);
    await context.route(`${origin}/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><html><head>${noReferrer ? '<meta name="referrer" content="no-referrer">' : ""}</head><body>${form}<script>
const f = document.getElementById("forged");
for (const [n, v] of [["relationship", "EMPLOYEE"], ["category", "IRREGULAR_TRANSACTIONS"], ["incidentDate", "2026-09-01"],
  ["incidentTime", "09:30"], ["location", "Procurement (synthetic)"], ["subjectDescription", "Employee Alpha (synthetic)"]])
  f.elements[n].value = v;
f.querySelector('[name="willingToCooperate"][value="YES"]').checked = true;
f.querySelector('[name="acknowledgement"]').checked = true;
f.submit();
</script></body></html>`,
      }),
    );
    const page = await context.newPage();
    const posted = page.waitForResponse((r) => r.request().method() === "POST" && r.url().startsWith(PORTAL));
    await page.goto(`${origin}/csrf`);
    const response = await posted;
    await context.close();
    return { status: response.status(), created: await reportsWith(narrative) };
  };

  for (const origin of ["http://attacker.example.test", "http://127.0.0.1:3999"]) {
    for (const noReferrer of [false, true]) {
      const r = await attempt(origin, noReferrer);
      expect(r.created, `${origin} no-referrer=${noReferrer}`).toBe(0);
      expect(r.status).not.toBe(200);
    }
  }
  // Positive control: the identical markup served from the portal's own origin (Origin: null, same-origin
  // Fetch Metadata) does submit, so the refusals above are the origin check at work.
  const own = await attempt(`${PORTAL}/__csrf-selftest`, true);
  expect(own).toEqual({ status: 200, created: 1 });
});

test("negative control: a form without method=post would leak, and these checks catch it", async ({
  browser,
}) => {
  const { context, page } = await noScript(browser, "en", CLIENT.en);
  // Serve the real markup with React's method="POST" removed, as the forms were before CDF-87.
  await context.route(`${PORTAL}/report`, async (route) => {
    if (route.request().method() !== "GET" || new URL(route.request().url()).search) return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(/\smethod="post"/i, "") });
  });
  await page.goto("/report");
  const narrative = `SYNTHETIC-PORTAL-NOJS negative control ${TAG}`;
  await page.locator("#description").fill(narrative);
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.isNavigationRequest()),
    page.getByTestId("submit-report").click(),
  ]);
  expect(request.method()).toBe("GET");
  expect(() => expectClean([request.url()], [narrative])).toThrow();
  await context.close();
});
