// WCAG 2.2 AA on the Phase 12 P12-1 case structure tabs (ADR-017 to ADR-019) in Arabic and English, at a desktop and
// a phone width and at 320 px: the Allegations tab with a person, their path and findings in two proceedings, and the
// Proceedings tab with the concluded preliminary review and the committee as copied at referral, every disclosure
// open. The restricted referral approval, with what the referral would copy now (migration 2045) at the same three
// widths, and its confirmation are checked too. Synthetic cases only.
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { audit } from "./axe";
import {
  builtStructureCase,
  closeFixtureConnections,
  endInvestigatorAssignment,
  preliminaryReferral,
  restrictedStructureCase,
} from "../e2e/records-fixture";
import { signIn } from "../e2e/support";

// Investigator Alpha joins every case made here and leaves it after each test (the seed's "my cases" stay as they
// were). The restricted case is left through its owner.
const joined: { caseId: string; by: "caseManager" | "grcDirector" }[] = [];
test.afterEach(async () => {
  for (const c of joined.splice(0)) await endInvestigatorAssignment(c.caseId, c.by);
});
test.afterAll(closeFixtureConnections);

const WIDTHS = [1280, 390, 320] as const;

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: both case structure tabs pass axe and reflow with every disclosure open`, async ({
    browser,
  }) => {
    const c = await builtStructureCase(`structure-a11y-${locale}-${randomUUID().slice(0, 8)}`);
    joined.push({ caseId: c.caseId, by: "caseManager" });
    const page = await signIn(browser, "casemanager@example.test", locale);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const tab of ["allegations", "proceedings"]) {
        await page.goto(`/cases/${c.caseId}/${tab}`);
        await expect(page.getByTestId("case-header")).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        // The tab's own disclosures; the header's overflow menu is a popover with its own check (case-workspace).
        await page.locator('main details:not([data-testid="case-overflow"])').evaluateAll((all) => {
          for (const d of all) (d as HTMLDetailsElement).open = true;
        });
        if (width !== 320) await audit(page);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(overflow, `horizontal overflow on ${tab} at ${width}px`).toBe(false);
      }
    }
    // What the checks above saw: a committee finding the decision uses, and the committee snapshot.
    await page.goto(`/cases/${c.caseId}/allegations`);
    await expect(page.getByTestId("finding-1-3-1")).toHaveAttribute("data-governing", "true");
    await page.goto(`/cases/${c.caseId}/proceedings`);
    await expect(page.getByTestId("proceeding-1-status")).toHaveAttribute("data-status", "CONCLUDED");
    await expect(page.getByTestId("committee-snapshot-3")).toBeVisible();
    await page.context().close();
  });

  test(`${locale}: the restricted referral approval, its preview and its confirmation pass axe`, async ({
    browser,
  }) => {
    const c = await restrictedStructureCase(`restricted-a11y-${locale}-${randomUUID().slice(0, 8)}`);
    joined.push({ caseId: c.caseId, by: "grcDirector" });
    // The approval is offered once the preliminary review has referred the case (AMB-018).
    await preliminaryReferral(c.caseId);
    const owner = await signIn(browser, "grc.director@example.test", locale);
    for (const width of WIDTHS) {
      await owner.setViewportSize({ width, height: 900 });
      await owner.goto(`/cases/${c.caseId}/proceedings`);
      await expect(owner.getByTestId("approve-referral-form")).toBeVisible();
      await expect(owner.getByTestId("referral-preview")).toBeVisible();
      if (width !== 320) await audit(owner);
      const overflow = await owner.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow, `horizontal overflow at ${width}px`).toBe(false);
    }
    await owner.setViewportSize({ width: 1280, height: 900 });
    await owner
      .locator("#approveReason")
      .fill("Synthetic: accessibility check of the approval confirmation.");
    await owner.getByTestId("approve-referral-form").locator('button[type="submit"]').click();
    const dialog = owner.getByRole("dialog");
    // What an uncleared member cannot do, the single use, and the three totals the referral would copy now.
    await expect(dialog.getByTestId("confirm-fact")).toHaveCount(5);
    await audit(owner);
    // Cancelling keeps the case waiting for the approval.
    await dialog.getByTestId("confirm-cancel").click();
    await expect(dialog).toBeHidden();
    await expect(owner.getByTestId("referral-approvals")).toHaveCount(0);
    await owner.context().close();
  });
}
