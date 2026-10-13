// DEC-51 (CDF-209) through the browser: a formal generated record, the disposition certificate, shows each date
// Gregorian first and Hijri second, from the platform's Umm al-Qura calendar, in English and Arabic; its machine
// value is the stored timestamp; and the operational records screens keep Gregorian dates only.
import { expect, test, type Locator } from "@playwright/test";
import { signIn } from "./support";
import { closeFixtureConnections, disposedCase } from "./records-fixture";

test.afterAll(closeFixtureConnections);

const FIELDS = ["trigger-at", "retain-until", "requested-at", "approved-at", "issued-at"] as const;
const LONG = { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Riyadh" } as const;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What the date should read, worked out here from its own machine value. */
async function expectDualDate(date: Locator, locale: "ar" | "en") {
  const at = new Date((await date.getAttribute("datetime"))!);
  const gregorian = new Intl.DateTimeFormat(
    locale === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB",
    LONG,
  ).format(at);
  const h = Object.fromEntries(
    new Intl.DateTimeFormat(
      locale === "ar" ? "ar-SA-u-ca-islamic-umalqura-nu-latn" : "en-GB-u-ca-islamic-umalqura",
      LONG,
    )
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const hijri = `${h.day} ${h.month} ${h.year}${locale === "ar" ? "هـ" : "H"}`;
  await expect(date.locator('[data-part="gregorian"]')).toHaveText(gregorian);
  await expect(date.locator('[data-part="hijri"]')).toHaveText(hijri);
  // Gregorian first, Hijri second in brackets, then the time.
  await expect(date).toHaveText(
    new RegExp(`^${escape(gregorian)} \\(${escape(hijri)}\\)${locale === "ar" ? "،" : ","} \\S`),
  );
}

test("the disposition certificate shows its dates in Gregorian and Hijri, in English and Arabic (DEC-51)", async ({
  browser,
}) => {
  const c = await disposedCase("dual-dates");
  for (const locale of ["en", "ar"] as const) {
    const page = await signIn(browser, "records@example.test", locale);
    await page.goto(`/records/certificates/${c.certificateId}`);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    for (const field of FIELDS) await expectDualDate(page.getByTestId(`certificate-${field}`), locale);
    // The machine value is the stored timestamp, not a rendering of it.
    await expect(page.getByTestId("certificate-issued-at")).toHaveAttribute("datetime", c.issuedAt);
    await page.context().close();
  }
});

test("operational records screens keep Gregorian dates only (DEC-51)", async ({ browser }) => {
  const c = await disposedCase("gregorian-only");
  for (const locale of ["en", "ar"] as const) {
    const page = await signIn(browser, "records@example.test", locale);
    for (const path of [`/records/${c.caseId}`, `/records?caseNumber=${c.caseNumber}`]) {
      await page.goto(path);
      const main = page.locator("main");
      // Dates are shown, in the operational Gregorian form ("13 Oct 2026", «13/10/2026»), and none in Hijri.
      await expect(main, path).toContainText(
        locale === "en" ? /\d{1,2} [A-Z][a-z]{2,3} \d{4}/ : /\d{1,2}\u200f?\/\d{1,2}\u200f?\/\d{4}/,
      );
      await expect(main.locator('[data-part="hijri"]'), path).toHaveCount(0);
      await expect(main, path).not.toContainText(locale === "en" ? /\d{4}H\)|\d{4} AH/ : "هـ");
    }
    await page.context().close();
  }
});
