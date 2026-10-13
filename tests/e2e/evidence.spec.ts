// Second vertical slice through the browser (§24–§27): an assigned investigator uploads evidence, the
// scanner rejects a test-virus file, downloads are audited and outsiders get nothing. Each item has its own page
// (UX-075). DEC-09 (migration 1850): only the investigation team sees the register, and the lead can limit an
// item to the case leads.
import { expect, test } from "@playwright/test";
import { signIn } from "./support";

// Assembled at runtime so the literal signature never sits in the repository.
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");

test("evidence is uploaded, scanned, listed, downloaded and kept from outsiders", async ({ browser }) => {
  const stamp = Date.now();
  const investigator = await signIn(browser, "investigator.a@example.test");
  await investigator.goto("/cases");
  await investigator.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
  await investigator.getByTestId("case-tab-evidence").click();
  await expect(investigator.getByTestId("evidence-card")).toBeVisible();
  const caseUrl = investigator.url();

  // 1. A clean PDF is stored; the panel shows the item, the file and the hash.
  const form = investigator.getByTestId("evidence-form");
  await form.locator("#file").setInputFiles({
    name: `synthetic-invoice-${stamp}.pdf`,
    mimeType: "application/pdf",
    buffer: Buffer.from(`%PDF-1.7\n% synthetic e2e evidence ${stamp}\n`),
  });
  await form.locator("#evidenceTitle").fill(`Synthetic invoice batch ${stamp}`);
  await form.locator("#sourceDescription").fill("Finance shared drive (synthetic)");
  await form.locator('button[type="submit"]').click();
  await expect(form.getByRole("status")).toContainText("Evidence stored");
  const table = investigator.getByTestId("evidence-table");
  await expect(table).toContainText(`Synthetic invoice batch ${stamp}`);
  await expect(table).toContainText(`synthetic-invoice-${stamp}.pdf`);
  await expect(table).toContainText("Available");

  // 2. Download goes through the audited route with download-only headers and the exact bytes.
  const row = table.locator("tr", { hasText: `Synthetic invoice batch ${stamp}` });
  const href = (await row.locator('a[data-testid^="download-"]').getAttribute("href"))!;
  expect(href).toMatch(/^\/cases\/[0-9a-f-]{36}\/evidence\/[0-9a-f-]{36}\/download$/);
  const seq = (await row.locator('[data-testid^="evidence-row-"]').getAttribute("data-testid"))!.replace(
    "evidence-row-",
    "",
  );
  const res = await investigator.request.get(href);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toContain("attachment");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["cache-control"]).toContain("no-store");
  expect((await res.body()).toString()).toContain(`synthetic e2e evidence ${stamp}`);
  // The number opens the item's own page (UX-075): its versions and its chain of custody, with the download.
  await investigator.reload();
  await investigator.getByTestId(`evidence-row-${seq}`).click();
  await expect(investigator).toHaveURL(/\/cases\/[0-9a-f-]{36}\/evidence\/items\/[0-9a-f-]{36}$/);
  const itemUrl = investigator.url();
  await expect(investigator.getByTestId("evidence-item")).toContainText(`Synthetic invoice batch ${stamp}`);
  await expect(investigator.getByTestId("evidence-about")).toContainText("Finance shared drive (synthetic)");
  await expect(investigator.getByTestId(`evidence-versions-${seq}`)).toContainText(
    `synthetic-invoice-${stamp}.pdf`,
  );
  const custody = investigator.getByTestId(`custody-${seq}`);
  await expect(custody).toContainText("Received");
  await expect(custody).toContainText("Stored in the vault");
  await expect(custody).toContainText("Downloaded");
  await expect(investigator.getByTestId(`new-version-form-${seq}`)).toBeVisible();
  // Only the case leads change who sees an item.
  await expect(investigator.getByTestId(`restriction-form-${seq}`)).toHaveCount(0);
  await investigator.getByTestId("case-tab-history").click();
  await expect(investigator.getByTestId("audit-timeline")).toContainText("Evidence stored");
  await investigator.getByTestId("case-tab-evidence").click();

  // 3. The EICAR test file is rejected by the scanner and recorded as a rejected version.
  await form
    .locator("#file")
    .setInputFiles({ name: "attachment.txt", mimeType: "text/plain", buffer: Buffer.from(EICAR) });
  await form.locator("#evidenceTitle").fill(`Suspicious attachment ${stamp}`);
  await form.locator('button[type="submit"]').click();
  await expect(form.getByTestId("action-error")).toContainText("scanner rejected");
  await expect(investigator.getByTestId("evidence-table")).toContainText("Rejected");

  // 4. A disguised executable never reaches storage or the database.
  await form.locator("#file").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("MZ\u0000\u0001 not a pdf"),
  });
  await form.locator("#evidenceTitle").fill(`Disguised file ${stamp}`);
  await form.locator('button[type="submit"]').click();
  await expect(form.getByTestId("action-error")).toContainText("does not match its extension");
  await expect(investigator.getByTestId("evidence-table")).not.toContainText(`Disguised file ${stamp}`);
  await investigator.context().close();

  // 5. An unassigned investigator cannot open the case or the download, and neither can the triage officer once
  //    the case left triage (S3, DEC-03). On a case still in triage they see the reporter's files, but not the
  //    register (DEC-09); the GRC Director's oversight gets no Evidence tab.
  const outsider = await signIn(browser, "investigator.b@example.test");
  expect((await outsider.request.get(href)).status()).toBe(404);
  expect((await outsider.goto(caseUrl))?.status()).toBe(404);
  expect((await outsider.goto(itemUrl))?.status()).toBe(404);
  await outsider.context().close();

  const triage = await signIn(browser, "triage@example.test");
  expect((await triage.request.get(href)).status()).toBe(404);
  expect((await triage.goto(caseUrl))?.status()).toBe(404);
  expect((await triage.goto(itemUrl))?.status()).toBe(404);
  await triage.goto("/cases");
  await triage.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0002"]').click();
  await triage.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
  await triage.goto(`${new URL(triage.url()).pathname}/evidence`);
  await expect(triage.getByTestId("evidence-team-only")).toBeVisible();
  await expect(triage.getByTestId("reporter-files")).toBeVisible();
  await expect(triage.getByTestId("evidence-card")).toHaveCount(0);
  await expect(triage.getByTestId("evidence-form")).toHaveCount(0);
  await triage.context().close();

  const grc = await signIn(browser, "grc.director@example.test");
  expect((await grc.goto(caseUrl))?.status()).toBe(404);
  expect((await grc.goto(itemUrl))?.status()).toBe(404);
  await grc.goto(caseUrl.replace(/\/evidence$/, ""));
  await expect(grc.getByTestId("case-header")).toBeVisible();
  await expect(grc.getByTestId("case-tab-evidence")).toHaveCount(0);
  await grc.context().close();

  // 6. The lead limits the item to the case leads: the investigator who added it no longer sees it or its
  //    item page or download; opened again, it is back. Both changes carry a reason and reach the history.
  const lead = await signIn(browser, "lead@example.test");
  const change = async (reason: string) => {
    await lead.goto(itemUrl);
    const f = lead.getByTestId(`restriction-form-${seq}`);
    await f.locator('input[name="reason"]').fill(reason);
    await f.locator('button[type="submit"]').click();
  };
  await change("Synthetic: leads only while the source is checked.");
  await expect(lead.getByTestId(`evidence-leads-${seq}`)).toBeVisible();
  const investigatorAgain = await signIn(browser, "investigator.a@example.test");
  await investigatorAgain.goto(caseUrl);
  await expect(investigatorAgain.getByTestId("evidence-card")).toBeVisible();
  await expect(investigatorAgain.getByTestId("evidence-table")).not.toContainText(
    `Synthetic invoice batch ${stamp}`,
  );
  expect((await investigatorAgain.request.get(href)).status()).toBe(404);
  expect((await investigatorAgain.goto(itemUrl))?.status()).toBe(404);
  await change("Synthetic: source checked, the team needs it.");
  await expect(lead.getByTestId(`evidence-leads-${seq}`)).toHaveCount(0);
  await lead.getByTestId("case-tab-history").click();
  await expect(lead.getByTestId("audit-timeline")).toContainText(
    `EV-${seq.padStart(3, "0")} limited to the case leads`,
  );
  await expect(lead.getByTestId("audit-timeline")).toContainText(
    `EV-${seq.padStart(3, "0")} open to the investigation team`,
  );
  await investigatorAgain.goto(caseUrl);
  await expect(investigatorAgain.getByTestId("evidence-table")).toContainText(
    `Synthetic invoice batch ${stamp}`,
  );
  await investigatorAgain.context().close();
  await lead.context().close();
});
