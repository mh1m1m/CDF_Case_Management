// CDF-72 · ADR-015: an anonymous reporter adds supporting files from the receipt, in Arabic and English.
// The file name never leaves the browser: intake sees a generated ATT-nnn name and can download only scanned files.
import { expect, test } from "@playwright/test";
import { PORTAL, contextIn, fillReportFields, signIn, submitAndReadReceipt } from "./support";

const PDF = Buffer.from("%PDF-1.7\n% SYNTHETIC attachment for CDF-72 e2e\n%%EOF\n");

for (const [locale, address] of [
  ["ar", "198.51.100.72"],
  ["en", "198.51.100.73"],
] as const) {
  test(`${locale}: anonymous reporter attaches a file; intake downloads it under a generated name`, async ({
    browser,
  }) => {
    const context = await contextIn(browser, locale, PORTAL);
    // A synthetic client address of our own (RFC 5737) so the portal limits are not shared with other specs.
    await context.setExtraHTTPHeaders({ "x-forwarded-for": address });
    const page = await context.newPage();
    await page.goto("/report");
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(page.getByTestId("attachments-notice")).toBeVisible();
    await fillReportFields(page, `SYNTHETIC: supporting files for CDF-72 (${locale}).`);
    await page.getByTestId("mode-anonymous").check();
    const { reportRef } = await submitAndReadReceipt(page);

    const uploader = page.getByTestId("attachment-uploader");
    await expect(uploader).toBeVisible();

    // Nothing chosen: the control says so and keeps focus.
    await page.getByTestId("upload-attachments").click();
    await expect(page.locator("#attachments")).toHaveAttribute("aria-invalid", "true");

    // One accepted file and one refused type, uploaded one request each.
    await page.locator("#attachments").setInputFiles([
      { name: "Employee Alpha notes.pdf", mimeType: "application/pdf", buffer: PDF },
      { name: "tool.exe", mimeType: "application/pdf", buffer: Buffer.from("MZ synthetic") },
    ]);
    await page.getByTestId("upload-attachments").click();
    const results = page.getByTestId("attachment-result");
    await expect(results).toHaveCount(2);
    await expect(results.nth(0)).toHaveAttribute("data-ok", "true");
    await expect(results.nth(0)).toContainText("ATT-001.pdf");
    await expect(results.nth(1)).toHaveAttribute("data-ok", "false");
    await context.close();

    // Intake sees the generated name only, and the download is the stored file.
    const intake = await signIn(browser, "intake@example.test", locale);
    await intake.goto("/intake");
    await intake.getByTestId(`report-${reportRef}`).click();
    const item = intake.getByTestId("attachment-ATT-001.pdf");
    await expect(item).toBeVisible();
    await expect(intake.getByTestId("report-attachments")).not.toContainText("Employee Alpha notes");
    await expect(intake.getByTestId("report-attachments")).not.toContainText("tool.exe");
    const href = await item.getByRole("link").getAttribute("href");
    expect(href).toMatch(/^\/intake\/[0-9a-f-]{36}\/attachments\/[0-9a-f-]{36}$/);
    const download = await intake.request.get(href!);
    expect(download.status()).toBe(200);
    expect(download.headers()["content-disposition"]).toContain("attachment");
    expect(download.headers()["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(await download.body()).equals(PDF)).toBe(true);
    await intake.context().close();
  });
}

test("the upload endpoint refuses cross-site posts and unknown reports alike", async ({ request }) => {
  const multipart = {
    reportRef: "WB-0123456789AB",
    secret: "ABCD-EFGH-JKMN-PQRS-TVWX",
    source: "REPORT",
    file: { name: "a.pdf", mimeType: "application/pdf", buffer: PDF },
  };
  const crossSite = await request.post(`${PORTAL}/report/attachments`, {
    headers: { origin: "https://attacker.example.test", "x-forwarded-for": "198.51.100.74" },
    multipart,
  });
  expect(crossSite.status()).toBe(403);
  const unknown = await request.post(`${PORTAL}/report/attachments`, {
    headers: { origin: PORTAL, "x-forwarded-for": "198.51.100.74" },
    multipart,
  });
  expect(unknown.status()).toBe(422);
  expect(await unknown.json()).toEqual({ ok: false, code: "NOT_ACCEPTED" });
});
