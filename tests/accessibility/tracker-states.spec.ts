// CDF-55: the workflow tracker conveys each step's state without colour (WCAG 1.4.1, 1.3.1)
// and is a single labelled region rather than a nav plus a region with the same name.
import { expect, test } from "@playwright/test";
import { signIn } from "../e2e/support";

const text = {
  en: { label: "Case progress", done: "(completed)", current: "(current step)", upcoming: "(not started)" },
  ar: { label: "مسار القضية", done: "(مكتملة)", current: "(المرحلة الحالية)", upcoming: "(لم تبدأ)" },
} as const;

for (const locale of ["ar", "en"] as const) {
  test(`${locale}: tracker steps state their status in text and shape, not colour alone`, async ({
    browser,
  }) => {
    const page = await signIn(browser, "casemanager@example.test", locale);
    await page.goto("/cases");
    await page.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
    const expected = text[locale];

    // One landmark carries the tracker's name, and it is not navigation.
    await expect(page.getByRole("region", { name: expected.label, exact: true })).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: expected.label, exact: true })).toHaveCount(0);

    const steps = await page
      .getByRole("region", { name: expected.label, exact: true })
      .locator("li")
      .evaluateAll((lis) =>
        lis.map((li) => ({
          state: li.getAttribute("data-state"),
          current: li.getAttribute("aria-current"),
          text: li.textContent ?? "",
          icon: li.querySelector('svg[aria-hidden="true"]') !== null,
          borderStyle: getComputedStyle(li).borderTopStyle,
        })),
      );
    const done = steps.filter((s) => s.state === "done");
    const current = steps.filter((s) => s.state === "current");
    const upcoming = steps.filter((s) => s.state === "upcoming");
    expect(done.length).toBeGreaterThan(0);
    expect(current).toHaveLength(1);
    expect(upcoming.length).toBeGreaterThan(0);

    // Every step carries its state as text for assistive technology.
    for (const s of done) expect(s.text).toContain(expected.done);
    expect(current[0]!.text).toContain(expected.current);
    expect(current[0]!.current).toBe("step");
    for (const s of upcoming) expect(s.text).toContain(expected.upcoming);

    // Sighted users get a non-colour cue: a check mark on done steps, a dashed outline on upcoming ones.
    for (const s of done) expect(s.icon).toBe(true);
    for (const s of upcoming) {
      expect(s.icon).toBe(false);
      expect(s.borderStyle).toBe("dashed");
    }

    // The visually hidden state text is positioned inside the scrolling region, so a long tracker scrolls
    // within it instead of widening the page at 320 px (WCAG 1.4.10).
    const escaped = await page
      .getByRole("region", { name: expected.label, exact: true })
      .evaluate(
        (region) =>
          Array.from(region.querySelectorAll<HTMLElement>(".sr-only")).filter(
            (el) => !el.offsetParent || !region.contains(el.offsetParent),
          ).length,
      );
    expect(escaped).toBe(0);
    await page.context().close();
  });
}
