// Phase 12 P12-0b (migration 2045, ADR-051): the purpose kinds in My Work, in Arabic (RTL) and English (LTR), at a
// desktop and a phone width. A preliminary recommendation the GRC Director prepared waits for the GRC Sector Head's
// approval: the sector head's row says what to do, names no case they cannot see, and opens nothing while its page
// has not shipped, and the page says so. Returned with two reasons, it leaves the sector head's list and reaches its
// preparer with the reasons as translated codes, never the comment, in My Work and on the case. Synthetic data only.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  RETURN_COMMENT,
  awaitingPreliminaryApproval,
  closeFixtureConnections,
  returnPreliminary,
  screeningCase,
  settlePreliminary,
} from "./records-fixture";
import { signIn } from "./support";

// Every case made here ends with its preliminary review approved, so no row stays in anyone's My Work.
const made: string[] = [];
test.afterEach(async () => {
  for (const caseId of made.splice(0)) await settlePreliminary(caseId);
});
test.afterAll(closeFixtureConnections);

const TEXT = {
  en: {
    approve: "Approve a preliminary recommendation",
    rework: "Rework a returned preliminary recommendation",
    returned: "Returned: Missing information and Unclear allegation",
    later:
      "Items without a link open in a later release, when their page arrives. They stay here until the work is done.",
  },
  ar: {
    approve: "اعتماد توصية أولية",
    rework: "تعديل توصية أولية مُعادة",
    returned: "أُعيد بسبب: معلومات ناقصة وادعاء غير واضح",
    later: "العناصر التي بلا رابط تُفتح في إصدار لاحق عند وصول صفحتها، وتبقى هنا حتى يُنجز العمل.",
  },
} as const;

async function expectNoOverflow(page: Page, what: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow, `horizontal overflow on ${what}`).toBe(false);
}

for (const locale of ["ar", "en"] as const) {
  const text = TEXT[locale];

  test(`${locale}: a purpose item says what to do and opens nothing until its page ships`, async ({
    browser,
  }) => {
    const c = await screeningCase(`purpose-${locale}-${randomUUID().slice(0, 8)}`);
    made.push(c.caseId);
    const recommendation = await awaitingPreliminaryApproval(c.caseId);

    // The approver: no case number they may not see, and no link until the page ships.
    const head = await signIn(browser, "grc.sector.head@example.test", locale);
    for (const width of [1280, 390]) {
      await head.setViewportSize({ width, height: 900 });
      await head.goto("/my-work");
      await expect(head.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      const row = head.getByTestId("work-item-PRELIMINARY_TO_APPROVE");
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(text.approve);
      await expect(row).not.toContainText(c.caseNumber);
      await expect(row.locator('[data-opens="later"]')).toBeVisible();
      await expect(row.getByRole("link")).toHaveCount(0);
      await expect(head.getByTestId("my-work-page-later")).toHaveText(text.later);
      await expectNoOverflow(head, `My Work at ${width}px`);
    }

    // Returned with two reasons: it leaves the approver's list and reaches its preparer.
    await returnPreliminary(recommendation);
    await head.reload();
    await expect(head.getByTestId("work-item-PRELIMINARY_TO_APPROVE")).toHaveCount(0);
    await head.context().close();

    const director = await signIn(browser, "grc.director@example.test", locale);
    for (const width of [1280, 390]) {
      await director.setViewportSize({ width, height: 900 });
      await director.goto("/my-work");
      const row = director.getByTestId("work-item-PRELIMINARY_RETURNED").filter({ hasText: c.caseNumber });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(text.rework);
      // The reasons, as codes translated; never the approver's comment (DEC-22, AMB-250).
      await expect(row).toContainText(text.returned);
      await expect(row).not.toContainText(RETURN_COMMENT);
      await expect(row.getByRole("link")).toHaveCount(0);
      await expect(director.getByTestId("my-work-page-later")).toHaveText(text.later);
      await expectNoOverflow(director, `My Work at ${width}px`);

      // The same row among the director's items on the case, where the header already names the case.
      await director.goto(`/cases/${c.caseId}`);
      const mine = director.getByTestId("your-items").getByTestId("work-item-PRELIMINARY_RETURNED");
      await expect(mine).toHaveCount(1);
      await expect(mine).toContainText(text.returned);
      await expect(mine).not.toContainText(c.caseNumber);
      await expect(director.getByTestId("your-items-page-later")).toHaveText(text.later);
      await expectNoOverflow(director, `the case at ${width}px`);
    }
    await director.context().close();
  });
}
