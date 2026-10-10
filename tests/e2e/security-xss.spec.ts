// CDF-62 · threat T14 (stored XSS), §46: text written by an anonymous reporter or by staff is rendered as
// text in both apps. Each payload would set window.__cdfXss, open a dialog or add an element if it ran; the
// test fails if any of that happens, and checks the payload is still shown literally (so the input reached
// the page and the test is not vacuous).
import { expect, test, type Page } from "@playwright/test";
import { APP, PORTAL, contextIn, signIn, submitAnonymousReport } from "./support";

const MARK = `x${Date.now().toString(36)}`;
const PAYLOAD =
  `<img src=x id="${MARK}-img" onerror="window.__cdfXss=1">` +
  `<script id="${MARK}-script">window.__cdfXss=1</script>` +
  `<svg id="${MARK}-svg" onload="window.__cdfXss=1"></svg>` +
  `<a id="${MARK}-a" href="javascript:window.__cdfXss=1">link</a>` +
  `"><iframe id="${MARK}-frame" srcdoc="<script>parent.__cdfXss=1</script>"></iframe>`;

function watch(page: Page) {
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  return dialogs;
}

async function expectInert(page: Page, dialogs: string[]) {
  // Give any injected handler a chance to run.
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { __cdfXss?: number }).__cdfXss)).toBeUndefined();
  expect(dialogs).toEqual([]);
  for (const suffix of ["img", "script", "svg", "a", "frame"])
    await expect(page.locator(`[id="${MARK}-${suffix}"]`)).toHaveCount(0);
  // The payload is displayed as text.
  await expect(page.getByText(`${MARK}-script`, { exact: false }).first()).toBeVisible();
}

test("reporter, staff and case text is rendered inert in both apps", async ({ browser }) => {
  // 1. An anonymous report whose description is a payload.
  const { reportRef, secret } = await submitAnonymousReport(browser, `SYNTHETIC XSS probe: ${PAYLOAD}`);

  // 2. The reporter follows up with a payload message.
  const portalCtx = await contextIn(browser, "en", PORTAL);
  const portalPage = await portalCtx.newPage();
  const portalDialogs = watch(portalPage);
  await portalPage.goto("/follow-up");
  await portalPage.locator("#reportRef").fill(reportRef);
  await portalPage.locator("#secret").fill(secret);
  await portalPage.getByTestId("open-report").click();
  await expect(portalPage.getByTestId("public-status")).toBeVisible();
  await portalPage.locator("#body").fill(`Reporter follow-up ${PAYLOAD}`);
  await portalPage.getByTestId("send-reply").click();
  await expect(portalPage.getByTestId("report-messages")).toContainText(`${MARK}-script`);
  await expectInert(portalPage, portalDialogs);

  // 3. Staff open the report: description and reporter message are inert; staff reply with a payload.
  const triage = await signIn(browser, "triage@example.test");
  const staffDialogs = watch(triage);
  await triage.goto("/intake");
  await triage.getByTestId(`report-${reportRef}`).click();
  await expect(triage.getByTestId("report-messages")).toContainText(`${MARK}-script`);
  await expectInert(triage, staffDialogs);
  await triage.getByTestId("reply-form").locator("#body").fill(`Staff reply ${PAYLOAD}`);
  await triage.getByTestId("reply-form").getByRole("button").click();
  await expect(triage.getByTestId("report-messages")).toContainText("Staff reply");
  await expectInert(triage, staffDialogs);

  // 4. A case whose title and summary are payloads, viewed on the case page and in the case list.
  await triage.locator("#outcome").selectOption("OPEN_CASE");
  await triage.locator("#reason").fill("Synthetic: XSS regression probe, accepted.");
  await triage.getByTestId("triage-form").getByRole("button").click();
  await expect(triage.getByTestId("create-case-form")).toBeVisible();
  await triage.locator("#title").fill(`XSS ${MARK}-script <b>t</b>`.slice(0, 120));
  await triage.locator("#summary").fill(`Synthetic summary ${PAYLOAD}`);
  await triage.locator("#classification").selectOption("CONFIDENTIAL");
  await triage.getByTestId("create-case-form").getByRole("button").click();
  await expect(triage).toHaveURL(/\/cases\/[0-9a-f-]{36}$/);
  await expectInert(triage, staffDialogs);
  await triage.goto(`${APP}/cases`);
  await expectInert(triage, staffDialogs);
  await triage.context().close();

  // 5. The reporter sees the staff reply, inert.
  await portalPage.reload();
  await portalPage.locator("#reportRef").fill(reportRef);
  await portalPage.locator("#secret").fill(secret);
  await portalPage.getByTestId("open-report").click();
  await expect(portalPage.getByTestId("report-messages")).toContainText("Staff reply");
  await expectInert(portalPage, portalDialogs);
  await portalCtx.close();
});
