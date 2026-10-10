// Second vertical slice through the browser (§24–§27): an assigned investigator uploads evidence, the
// scanner rejects a test-virus file, downloads are audited and outsiders get nothing.
import { expect, test } from "@playwright/test";
import { signIn } from "./support";

// Assembled at runtime so the literal signature never sits in the repository.
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");

test("evidence is uploaded, scanned, listed, downloaded and kept from outsiders", async ({ browser }) => {
  const stamp = Date.now();
  const investigator = await signIn(browser, "investigator.a@example.test");
  await investigator.goto("/cases");
  await investigator.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
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
  const res = await investigator.request.get(href);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toContain("attachment");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["cache-control"]).toContain("no-store");
  expect((await res.body()).toString()).toContain(`synthetic e2e evidence ${stamp}`);
  await investigator.reload();
  const details = investigator.locator('[data-testid^="evidence-versions-"]').last();
  await details.locator("summary").click();
  await expect(details).toContainText("Received");
  await expect(details).toContainText("Stored in the vault");
  await expect(details).toContainText("Downloaded");
  await expect(investigator.getByTestId("audit-timeline")).toContainText("Evidence stored");

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

  // 5. An unassigned investigator cannot open the case or the download; the triage officer sees the case
  //    but has no download permission and no link.
  const outsider = await signIn(browser, "investigator.b@example.test");
  expect((await outsider.request.get(href)).status()).toBe(404);
  expect((await outsider.goto(caseUrl))?.status()).toBe(404);
  await outsider.context().close();

  const triage = await signIn(browser, "triage@example.test");
  await triage.goto(caseUrl);
  await expect(triage.getByTestId("evidence-card")).toBeVisible();
  await expect(triage.getByTestId("evidence-form")).toHaveCount(0);
  await expect(triage.getByTestId("evidence-table").locator('a[data-testid^="download-"]')).toHaveCount(0);
  expect((await triage.request.get(href)).status()).toBe(404);
  await triage.context().close();
});
