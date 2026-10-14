// S3 purpose-bound access (ADR-016 D2; DEC-02): a committee seat opens no case. A committee chair whose case
// grant was narrowed keeps only the forms they still had a part in, reached from My Work on a route of their
// own that never names the case; the case itself and its form route are not found for them. The case team
// still sees who holds each kept form on the access roster. Synthetic cases only.
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { closeFixtureConnections, formOnlyCase } from "./records-fixture";
import { signIn } from "./support";

test.afterAll(closeFixtureConnections);

const TEXT = {
  en: {
    banner: "You are seeing one form, not the case file",
    basis: "One form (not the case)",
    myWork: "My work",
  },
  ar: {
    banner: "تعرض نموذجًا واحدًا، لا ملف القضية",
    basis: "نموذج واحد (لا القضية)",
    myWork: "أعمالي",
  },
} as const;

for (const locale of ["en", "ar"] as const) {
  test(`${locale}: a kept form opens on its own, the case stays closed`, async ({ browser }) => {
    const f = await formOnlyCase(`purpose-${locale}-${randomUUID().slice(0, 8)}`);
    const formPath = `/my-work/forms/${f.instanceId}`;
    const chair = await signIn(browser, "committee.chair@example.test", locale);

    // My Work carries the form, linked to the purpose route, not to the case.
    await chair.goto("/my-work");
    const item = chair.locator(`a[href="${formPath}"]`);
    await expect(item).toBeVisible();
    await expect(chair.locator(`a[href^="/cases/${f.caseId}"]`)).toHaveCount(0);
    await expect(chair.locator("main")).not.toContainText(f.caseNumber);
    await item.click();
    await expect(chair).toHaveURL(new RegExp(`${formPath}$`));

    // The form says what this view is, and the way back is My Work, never the case.
    if (locale === "ar") await expect(chair.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(chair.getByTestId("form-purpose-banner")).toContainText(TEXT[locale].banner);
    await expect(chair.getByTestId("breadcrumbs")).toContainText(TEXT[locale].myWork);
    await expect(chair.getByTestId("breadcrumbs").locator('a[href^="/cases"]')).toHaveCount(0);
    await expect(chair.locator("main")).not.toContainText(f.caseNumber);
    // The chair does their part: the prepared formation is theirs to review.
    await expect(chair.getByTestId("decision-card")).toBeVisible();
    await expect(chair.getByTestId("draft-form")).toHaveCount(0);
    await expect(chair.getByTestId("withdraw-card")).toHaveCount(0);

    // The case, its forms tab and the case route of the same form: the same 404 as a case that does not exist.
    expect((await chair.goto(`/cases/${f.caseId}`))?.status()).toBe(404);
    expect((await chair.goto(`/cases/${f.caseId}/forms`))?.status()).toBe(404);
    expect((await chair.goto(`/cases/${f.caseId}/forms/${f.instanceId}`))?.status()).toBe(404);

    // My access names the form, not the case.
    await chair.goto("/settings/access");
    const access = chair.getByTestId("my-access-table");
    await expect(access).toContainText(TEXT[locale].basis);
    await expect(access).not.toContainText(f.caseNumber);
    // The row leads to that form, which is how forms on different cases are told apart.
    await access.getByTestId(`my-access-form-${f.instanceId}`).click();
    await expect(chair).toHaveURL(new RegExp(`${formPath}$`));
    await expect(chair.getByTestId("form-purpose-banner")).toBeVisible();
    await chair.context().close();
  });
}

test("the chair reviews the kept form; the case team sees who holds it", async ({ browser }) => {
  const f = await formOnlyCase(`purpose-review-${randomUUID().slice(0, 8)}`);
  const chair = await signIn(browser, "committee.chair@example.test");
  await chair.goto(`/my-work/forms/${f.instanceId}`);
  await expect(chair.getByTestId("form-status")).toHaveText("Prepared");
  const review = chair.getByTestId("decision-form");
  await review.getByTestId("outcome-accept").check();
  await review.locator('button[type="submit"]').click();
  await expect(chair.getByTestId("form-status")).toHaveText("Reviewed");
  await expect(chair).toHaveURL(new RegExp(`/my-work/forms/${f.instanceId}$`));
  await chair.context().close();

  // The case manager sees the chair's form-only access on the roster, and the form's history.
  const manager = await signIn(browser, "casemanager@example.test");
  await manager.goto(`/cases/${f.caseId}/people`);
  const row = manager.getByTestId("roster-FORM_ACCESS-WB-FRM-13:1");
  await expect(row).toContainText("Committee Chair Xi");
  await expect(row).toContainText("One form (not the case)");
  // A case form opened by the case team goes to the case route, not the purpose route.
  expect((await manager.goto(`/my-work/forms/${f.instanceId}`))?.url()).toContain(
    `/cases/${f.caseId}/forms/${f.instanceId}`,
  );
  await expect(manager.getByTestId("form-events")).toContainText("Reviewed");
  await expect(manager.getByTestId("form-purpose-banner")).toHaveCount(0);
  await manager.context().close();
});
