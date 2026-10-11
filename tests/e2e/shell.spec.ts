// UX redesign S1 (CDF-117, CDF-118, CDF-121, CDF-171, CDF-172): the signed-in shell, the landing and My Work.
// The sidebar and the landing come from api.my_areas() (permission AND a live relationship, never a role name);
// every page still enforces access on its own and answers the uniform 404 when the caller may not see it.
import { expect, test, type Page } from "@playwright/test";
import { APP, contextIn, signIn } from "./support";

const navKeys = (page: Page) =>
  page
    .getByTestId("app-sidebar")
    .getByRole("link")
    .evaluateAll((links) => links.map((l) => (l.getAttribute("data-testid") ?? "").replace(/^nav-/, "")));

test("each account sees only its own areas and lands where its work is", async ({ browser }) => {
  const expected: [string, string[], RegExp][] = [
    ["investigator.a@example.test", ["my-work", "cases"], /\/my-work$/],
    ["triage@example.test", ["my-work", "intake", "cases"], /\/my-work$/],
    ["records@example.test", ["my-work", "records"], /\/records$/],
    ["admin@example.test", ["admin"], /\/admin\/users$/],
    ["soc@example.test", ["oversight"], /\/oversight\?view=security-events$/],
    ["audit@example.test", ["oversight"], /\/oversight\?view=ledger$/],
  ];
  for (const [email, areas, landing] of expected) {
    const page = await signIn(browser, email);
    await page.goto("/");
    await expect(page, email).toHaveURL(landing);
    expect(await navKeys(page), email).toEqual(areas);
    // At most five primary destinations (audit §20.5).
    expect(areas.length).toBeLessThanOrEqual(5);
    await page.context().close();
  }
});

test("areas outside the caller's work answer the same 404 as a missing page", async ({ browser }) => {
  const investigator = await signIn(browser, "investigator.a@example.test");
  for (const path of [
    "/admin/users",
    "/oversight",
    "/oversight?view=security-events",
    "/records/legal-holds",
  ])
    expect((await investigator.request.get(path)).status(), path).toBe(404);
  await investigator.context().close();

  // The administrator manages accounts, never case content (§21).
  const admin = await signIn(browser, "admin@example.test");
  for (const path of ["/my-work", "/cases", "/intake"])
    expect((await admin.request.get(path)).status(), path).toBe(404);
  await admin.goto("/admin/users");
  await expect(admin.getByTestId("user-register")).toBeVisible();
  await expect(admin.getByText("CDF-DEMO-")).toHaveCount(0);
  await admin.context().close();
});

test("My Work lists the caller's own items, keeps the view in the URL and across the language switch", async ({
  browser,
}) => {
  const investigator = await signIn(browser, "investigator.a@example.test");
  await investigator.goto("/my-work?view=my-cases");
  const list = investigator.getByTestId("my-work-my-cases");
  await expect(list.getByTestId("work-item-MY_CASE")).toHaveCount(1);
  await expect(list).toContainText("CDF-DEMO-2026-0001");
  // A case the investigator is not on never appears, not even as a count.
  await expect(investigator.getByText("CDF-DEMO-2026-0003")).toHaveCount(0);

  await investigator.getByTestId("language-switch").click();
  await expect(investigator).toHaveURL(/\/my-work\?view=my-cases$/);
  await expect(investigator.locator("html")).toHaveAttribute("dir", "rtl");

  // The item opens the page where the work is done.
  await list.getByTestId("work-item-MY_CASE").getByRole("link").click();
  await expect(investigator).toHaveURL(/\/cases\/[0-9a-f-]{36}$/);
  await expect(investigator.getByTestId("nav-cases")).toHaveAttribute("aria-current", "page");
  await investigator.context().close();
});

test("a page opened while signed out comes back after sign-in; a foreign target never does", async ({
  browser,
}) => {
  const password = process.env.CDF_DEV_PASSWORD!;
  const context = await contextIn(browser, "en", APP);
  const page = await context.newPage();
  await page.goto("/my-work?view=waiting");
  await expect(page).toHaveURL(/\/login\?next=%2Fmy-work%3Fview%3Dwaiting$/);
  await page.getByLabel("Email").fill("investigator.b@example.test");
  await page.getByLabel("Password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/my-work\?view=waiting$/);
  await context.close();

  const other = await contextIn(browser, "en", APP);
  const login = await other.newPage();
  await login.goto("/login?next=https%3A%2F%2Fevil.example.test%2F");
  await expect(login.locator('input[name="next"]')).toHaveCount(0);
  await login.getByLabel("Email").fill("lead@example.test");
  await login.getByLabel("Password").fill(password);
  await login.getByTestId("login-submit").click();
  await expect(login).toHaveURL(/\/my-work$/);
  await other.close();
});
