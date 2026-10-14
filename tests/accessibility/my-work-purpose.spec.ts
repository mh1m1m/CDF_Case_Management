// WCAG 2.2 AA on the Phase 12 purpose kinds in My Work (P12-0b; migration 2045, ADR-051) in Arabic and English, at a
// desktop and a phone width: a row that opens nothing while its page has not shipped, with the page's note, for the
// approver of a preliminary recommendation; and, once it is returned, its preparer's row with the reasons, in My Work
// and on the case. Synthetic cases only.
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { audit } from "./axe";
import {
  awaitingPreliminaryApproval,
  closeFixtureConnections,
  returnPreliminary,
  screeningCase,
  settlePreliminary,
} from "../e2e/records-fixture";
import { signIn } from "../e2e/support";

// Every case made here ends with its preliminary review approved, so no row stays in anyone's My Work.
const made: string[] = [];
test.afterEach(async () => {
  for (const caseId of made.splice(0)) await settlePreliminary(caseId);
});
test.afterAll(closeFixtureConnections);

const WIDTHS = [1280, 390] as const;

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: purpose rows without a page yet, and returned work with its reasons`, async ({
    browser,
  }) => {
    const c = await screeningCase(`purpose-a11y-${locale}-${randomUUID().slice(0, 8)}`);
    made.push(c.caseId);
    const recommendation = await awaitingPreliminaryApproval(c.caseId);

    const head = await signIn(browser, "grc.sector.head@example.test", locale);
    for (const width of WIDTHS) {
      await head.setViewportSize({ width, height: 900 });
      await head.goto("/my-work");
      await expect(head.getByTestId("work-item-PRELIMINARY_TO_APPROVE")).toBeVisible();
      await audit(head);
    }
    await head.context().close();

    await returnPreliminary(recommendation);
    const director = await signIn(browser, "grc.director@example.test", locale);
    for (const width of WIDTHS) {
      await director.setViewportSize({ width, height: 900 });
      await director.goto("/my-work");
      await expect(
        director.getByTestId("work-item-PRELIMINARY_RETURNED").filter({ hasText: c.caseNumber }),
      ).toBeVisible();
      await audit(director);
      await director.goto(`/cases/${c.caseId}`);
      await expect(director.getByTestId("your-items-page-later")).toBeVisible();
      await audit(director);
    }
    await director.context().close();
  });
}
