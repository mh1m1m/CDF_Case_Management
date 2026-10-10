// CDF-62 · threat T15 (CSRF), I-3: a signed-in investigator's browser cannot be made to run a state-changing
// Server Action from another origin. The reply form's server-rendered markup (with its progressive-enhancement
// action fields) is replayed from a page on another origin in the same browser context, both cross-site and
// same-site (another port of the same host, where SameSite cookies are still sent and only the framework's
// Origin check protects). The forged reply must never appear; the same form submitted from the app must.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { APP, signIn } from "./support";

const SEED_REF = "WB-SEED00000006"; // awaiting information: intake officers can reply

async function openSeedReport(browser: Parameters<typeof signIn>[0]): Promise<Page> {
  const page = await signIn(browser, "intake@example.test");
  await page.goto("/intake");
  await page.getByTestId(`report-${SEED_REF}`).click();
  await expect(page.getByTestId("reply-form")).toBeVisible();
  return page;
}

/** The reply form exactly as the server rendered it, with an absolute action and the given body. */
async function forgedFormHtml(page: Page, body: string): Promise<string> {
  const html = await (await page.request.get(page.url())).text();
  const match = /<form[^>]*data-testid="reply-form"[\s\S]*?<\/form>/.exec(html);
  expect(match, "server-rendered reply form").not.toBeNull();
  const action = new URL(page.url()).toString();
  return match![0]
    .replace(
      /<form([^>]*)>/,
      (_m, attrs: string) =>
        `<form${attrs.replace(/\saction="[^"]*"/, "")} action="${action}" method="post" enctype="multipart/form-data" id="forged">`,
    )
    .replace(/<textarea([^>]*)>[\s\S]*?<\/textarea>/, `<textarea$1>${body}</textarea>`);
}

/** Serves an attacker page at `origin` (intercepted, nothing listens there) that auto-submits the form. */
async function submitFrom(context: BrowserContext, origin: string, formHtml: string) {
  const attacker = await context.newPage();
  await context.route(`${origin}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body>${formHtml}<script>document.getElementById("forged").submit()</script></body></html>`,
    }),
  );
  const posted = attacker.waitForResponse((r) => r.request().method() === "POST" && r.url().startsWith(APP), {
    timeout: 15_000,
  });
  await attacker.goto(`${origin}/csrf`);
  const response = await posted.catch(() => null);
  await attacker.close();
  return response;
}

const messages = async (page: Page) => {
  await page.reload();
  return (await page.getByTestId("report-messages").textContent()) ?? "";
};

test("a forged cross-origin Server Action POST changes nothing", async ({ browser }) => {
  const page = await openSeedReport(browser);
  const tag = Date.now().toString(36);

  for (const origin of ["http://attacker.example.test", "http://127.0.0.1:3999"]) {
    const body = `Forged reply ${tag} from ${origin}`;
    // Whatever the server answers, the forged action must have no effect.
    await submitFrom(page.context(), origin, await forgedFormHtml(page, body));
    expect(await messages(page), origin).not.toContain(body);
  }

  // Positive control 1: the identical forged markup, served from the app's own origin, does take effect,
  // so the refusals above are the Origin check at work and not a malformed form.
  const sameOrigin = `Same-origin replay ${tag} (synthetic)`;
  await submitFrom(
    page.context(),
    APP.replace(/\/$/, "") + "/__csrf-selftest",
    await forgedFormHtml(page, sameOrigin),
  );
  expect(await messages(page)).toContain(sameOrigin);

  // Positive control 2: the same form, submitted from the app itself, works.
  const genuine = `Genuine reply ${tag} (synthetic)`;
  await page.getByTestId("reply-form").locator("#body").fill(genuine);
  await page.getByTestId("reply-form").getByRole("button").click();
  await expect(page.getByTestId("report-messages")).toContainText(genuine);
  await page.context().close();
});

test("the session cookie is HttpOnly and SameSite, and state never changes on GET", async ({ browser }) => {
  const page = await openSeedReport(browser);
  const cookies = await page.context().cookies(APP);
  const session = cookies.find((c) => c.name === "cdf_session");
  expect(session).toBeDefined();
  expect(session!.httpOnly).toBe(true);
  expect(["Strict", "Lax"]).toContain(session!.sameSite);

  // The only GET route with a side effect is the language preference, and it accepts only local paths.
  for (const next of [
    "https://attacker.example.test/",
    "//attacker.example.test/",
    "/\\attacker.example.test",
  ]) {
    const res = await page.request.get(`${APP}/locale?to=en&next=${encodeURIComponent(next)}`, {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(303);
    const location = new URL(res.headers()["location"]!, APP);
    expect(["127.0.0.1", "localhost"]).toContain(location.hostname);
    expect(location.pathname).toBe("/");
  }
  await page.context().close();
});
