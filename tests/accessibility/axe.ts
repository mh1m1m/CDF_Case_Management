// The WCAG 2.2 AA net (DEC-52, approved 2026-10-11; ADR-016 D0). One axe configuration for every
// accessibility spec, so the conformance target is raised in one place. `wcag22aa` adds the 2.2 rules axe can
// check automatically, such as target size (2.5.8). Criteria axe cannot check (focus not obscured, dragging,
// redundant entry, accessible authentication) stay with the manual review of each proof screen.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Fails on any serious or critical violation, listing each rule and the elements it found. */
export async function audit(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
