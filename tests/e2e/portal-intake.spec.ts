// CDF-63: the three Drive reporting modes through the Arabic portal, and what the intake team sees.
// Identity fields stay in the vault: the intake view shows the report fields and the mode, never identity.
import { expect, test } from "@playwright/test";
import { PORTAL, contextIn, fillReportFields, signIn, submitAndReadReceipt } from "./support";

const DESCRIPTION = "SYNTHETIC: Purchase orders were allegedly split to stay below the approval threshold.";

test("Arabic portal: anonymous, email-only and identified reports reach intake without identity", async ({
  browser,
}) => {
  const context = await contextIn(browser, "ar", PORTAL);
  // Three submissions here: use a synthetic client address of our own (RFC 5737 documentation range) so the
  // portal's 5-per-hour submit limit is not shared with the other e2e specs' submissions.
  await context.setExtraHTTPHeaders({ "x-forwarded-for": "198.51.100.63" });
  const page = await context.newPage();

  // Anonymous.
  await page.goto("/report");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await fillReportFields(page, DESCRIPTION);
  await page.getByTestId("mode-anonymous").check();
  const anonymous = await submitAndReadReceipt(page);

  // Email only: email is mandatory and is the only identity field shown.
  await page.goto("/report");
  await fillReportFields(page, DESCRIPTION);
  await page.getByTestId("mode-email-only").check();
  await expect(page.getByTestId("identified-fields")).toHaveCount(0);
  await page.getByTestId("submit-report").click();
  await expect(page.locator("#email")).toHaveAttribute("aria-invalid", "true");
  await page.locator("#email").fill("reporter.delta@example.test");
  const emailOnly = await submitAndReadReceipt(page);

  // Identified: four-part name, gender, date of birth (Hijri), ID, city, nationality, mobile, email.
  await page.goto("/report");
  await fillReportFields(page, DESCRIPTION);
  await page.locator("#relationship").selectOption("OTHER");
  await page.locator("#relationshipOther").fill("Volunteer at a sponsored event (synthetic)");
  await page.getByTestId("mode-identified").check();
  await page.locator("#givenName").fill("Reporter");
  await page.locator("#fatherName").fill("Zeta");
  await page.locator("#grandfatherName").fill("Synthetic");
  await page.locator("#familyName").fill("Example");
  await page.locator("#gender").selectOption("FEMALE");
  await page.locator("#nationality").selectOption("SA");
  await page.getByTestId("calendar-hijri").check();
  await page.locator("#birthDate").fill("1410-09-20");
  await page.locator("#idType").selectOption("NATIONAL_ID");
  await page.locator("#idNumber").fill("2000000009");
  await page.locator("#city").selectOption("RIYADH");
  await page.locator("#phone").fill("+966 500000009");
  await page.locator("#email").fill("reporter.zeta@example.test");
  // A national ID must start with 1: the portal says so before anything is sent.
  await page.getByTestId("submit-report").click();
  await expect(page.locator("#idNumber")).toHaveAttribute("aria-invalid", "true");
  await page.locator("#idNumber").fill("1000000009");
  const identified = await submitAndReadReceipt(page);
  await context.close();

  for (const r of [anonymous, emailOnly, identified])
    expect(r.reportRef).toMatch(/^WB-[0-9A-HJKMNP-TV-Z]{12}$/);

  // Intake sees mode and Drive fields, but no identity values.
  const intake = await signIn(browser, "intake@example.test");
  for (const [r, mode] of [
    [anonymous, "Anonymous"],
    [emailOnly, "Email only"],
    [identified, "Identified"],
  ] as const) {
    await intake.goto("/intake");
    await intake.getByTestId(`report-${r.reportRef}`).click();
    await expect(intake.locator("main")).toContainText(mode);
    await expect(intake.locator("main")).toContainText("Passing irregular transactions");
    await expect(intake.locator("main")).toContainText("09:30");
    await expect(intake.locator("main")).not.toContainText(
      /reporter\.(delta|zeta)|1000000009|1410-09-20|Zeta/,
    );
  }
  await expect(intake.locator("main")).toContainText("Volunteer at a sponsored event (synthetic)");
  await intake.context().close();
});
