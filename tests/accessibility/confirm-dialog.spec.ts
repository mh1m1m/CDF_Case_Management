// UX-031: controlled and irreversible acts ask first, in Arabic (RTL) and English (LTR). The native <dialog>
// is named by its heading, described by what happens / whether it can be undone / who is affected, opens with
// Cancel focused, returns focus to its verb-labelled trigger on Escape or Cancel, and only the confirm button
// runs the existing command. Checked with axe while open (WCAG 2.1 AA).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "../e2e/support";
import { closeFixtureConnections, closedCase, screeningCase } from "../e2e/records-fixture";

test.afterAll(closeFixtureConnections);

async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const T = {
  en: {
    archive: "Archive case",
    archiveTitle: "Archive this case?",
    archiveBody: "The case moves to the archive and to records management.",
    archiveUndo: "No. An archived case cannot be reopened in this version.",
    archiveAffected: "records officers",
    cancel: "Cancel",
    closure: "Closure",
    archived: "Archive",
    withdraw: "Withdraw form",
    withdrawTitle: "Withdraw this form?",
    withdrawn: "Withdrawn",
    conflictTitle: "Declare a conflict of interest?",
    noDeclaration: "You have not declared yet.",
  },
  ar: {
    archive: "أرشفة القضية",
    archiveTitle: "أرشفة هذه القضية؟",
    archiveBody: "تنتقل القضية إلى الأرشيف وإلى إدارة السجلات.",
    archiveUndo: "لا. لا يمكن إعادة فتح القضية المؤرشفة في هذا الإصدار.",
    archiveAffected: "مسؤولو السجلات",
    cancel: "إلغاء",
    closure: "الإغلاق",
    archived: "الأرشيف",
    withdraw: "سحب النموذج",
    withdrawTitle: "سحب هذا النموذج؟",
    withdrawn: "مسحوب",
    conflictTitle: "الإفصاح عن تعارض مصالح؟",
    noDeclaration: "لم تقدم إقرارك بعد.",
  },
} as const;

for (const locale of ["ar", "en"] as const) {
  const t = T[locale];

  test(`${locale}: archiving asks first; Escape and Cancel change nothing; confirm archives`, async ({
    browser,
  }) => {
    const closed = await closedCase(`confirm-archive-${locale}`);
    const page = await signIn(browser, "casemanager@example.test", locale);
    await page.goto(`/cases/${closed.caseId}`);
    const state = page.getByTestId("case-state");
    await expect(state).toHaveText(t.closure);

    // The trigger says what it does, not "Confirm".
    const trigger = page.getByTestId("transition-ARCHIVE_CASE").getByRole("button", { name: t.archive });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(t.archiveTitle);
    await expect(dialog).toHaveAccessibleDescription(
      new RegExp(t.archiveBody.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    await expect(dialog).toHaveCSS("direction", locale === "ar" ? "rtl" : "ltr");
    await expect(dialog.getByTestId("confirm-what")).toContainText(t.archiveBody);
    await expect(dialog.getByTestId("confirm-undo")).toHaveText(t.archiveUndo);
    await expect(dialog.getByTestId("confirm-affected")).toContainText(t.archiveAffected);
    // Cancel has the default focus; the confirm button repeats the trigger's verb.
    await expect(dialog.getByTestId("confirm-cancel")).toBeFocused();
    await expect(dialog.getByTestId("confirm-cancel")).toHaveText(t.cancel);
    await expect(dialog.getByTestId("confirm-submit")).toHaveText(t.archive);
    await audit(page);

    // Escape closes it, returns focus to the trigger and archives nothing.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(state).toHaveText(t.closure);

    // Cancel does the same, from the keyboard: Enter opens it, Enter on the focused Cancel closes it.
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("confirm-cancel")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.reload();
    await expect(state).toHaveText(t.closure);

    // Only the confirm button runs the existing command.
    await trigger.click();
    await dialog.getByTestId("confirm-submit").click();
    await expect(state).toHaveText(t.archived);
    await page.context().close();
  });

  test(`${locale}: withdrawing a form and declaring a conflict ask first`, async ({ browser }) => {
    const fresh = await screeningCase(`confirm-acts-${locale}`);
    const page = await signIn(browser, "casemanager@example.test", locale);

    // Declaring "I have a conflict" removes the declarant's own access, so it asks; Cancel records nothing.
    await page.goto(`/cases/${fresh.caseId}`);
    const conflict = page.getByTestId("conflict-form");
    await conflict.getByTestId("conflict-yes").check();
    await conflict.locator("#declaration").fill("Synthetic: a declaration that is cancelled.");
    await conflict.locator('button[type="submit"]').click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveAccessibleName(t.conflictTitle);
    await expect(dialog.getByTestId("confirm-cancel")).toBeFocused();
    await audit(page);
    await dialog.getByTestId("confirm-cancel").click();
    await expect(dialog).toBeHidden();
    await expect(conflict.locator('button[type="submit"]')).toBeFocused();
    // The answer and the text are still there after cancelling.
    await expect(conflict.getByTestId("conflict-yes")).toBeChecked();
    await page.reload();
    await expect(page.getByTestId("my-conflict-status")).toHaveText(t.noDeclaration);

    // Withdrawing a form is final: the trigger names it and the dialog asks; confirming withdraws it.
    await page.goto(`/cases/${fresh.caseId}/forms`);
    await page.locator('[data-testid^="start-WB-FRM-"]').first().locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/forms\/[0-9a-f-]{36}$/);
    const withdraw = page.getByTestId("withdraw-form");
    await withdraw.locator("#withdraw-reason").fill("Synthetic: opened by mistake.");
    await withdraw.getByRole("button", { name: t.withdraw }).click();
    await expect(dialog).toHaveAccessibleName(t.withdrawTitle);
    await expect(dialog.getByTestId("confirm-submit")).toHaveText(t.withdraw);
    await audit(page);
    await dialog.getByTestId("confirm-submit").click();
    await expect(page.getByTestId("form-status")).toHaveText(t.withdrawn);
    await page.context().close();
  });
}
