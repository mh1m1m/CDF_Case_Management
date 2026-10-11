// UX-014 / RC-04: form-control boundaries reach 3:1 against every background they can sit on, in both themes
// (WCAG 2.2 1.4.11). Reads the real tokens.css, so a token change that breaks the ratio fails here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--cdf-[\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const light = block(":root");
const dark = { ...light, ...block(':root[data-theme="dark"]') };

function resolve(theme: Record<string, string>, name: string): string {
  let value = theme[name];
  for (let i = 0; value?.startsWith("var("); i += 1) {
    if (i > 5) throw new Error(`unresolved ${name}`);
    value = theme[value.slice(4, -1).trim()];
  }
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} is not a hex colour: ${value}`);
  return value;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// Every background a control can sit on: the page, cards, subtle panels and the four notice tints.
const BACKGROUNDS = [
  "--cdf-bg",
  "--cdf-surface",
  "--cdf-surface-subtle",
  "--cdf-info-bg",
  "--cdf-success-bg",
  "--cdf-warning-bg",
  "--cdf-danger-bg",
] as const;

describe("--cdf-border-control (UX-014)", () => {
  for (const [themeName, theme] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    for (const bg of BACKGROUNDS) {
      it(`reaches 3:1 against ${bg} (${themeName})`, () => {
        const ratio = contrast(resolve(theme, "--cdf-border-control"), resolve(theme, bg));
        expect(ratio).toBeGreaterThanOrEqual(3);
      });
    }
  }

  it("records the measured light and dark ratios", () => {
    const ratio = (theme: Record<string, string>, bg: string) =>
      Math.round(contrast(resolve(theme, "--cdf-border-control"), resolve(theme, bg)) * 100) / 100;
    expect(ratio(light, "--cdf-surface")).toBe(5.98);
    expect(ratio(light, "--cdf-surface-subtle")).toBe(5.63);
    expect(ratio(light, "--cdf-bg")).toBe(5.43);
    expect(ratio(dark, "--cdf-bg")).toBe(5.56);
    expect(ratio(dark, "--cdf-surface")).toBe(5.04);
    expect(ratio(dark, "--cdf-surface-subtle")).toBe(3.69);
  });

  it("is what the shared input class draws, not the decorative border", () => {
    const source = readFileSync(new URL("./components.tsx", import.meta.url), "utf8");
    const inputClass = /export const inputClass =\s*"([^"]+)"/.exec(source)?.[1] ?? "";
    expect(inputClass.split(/\s+/)).toContain("border-cdf-border-control");
    expect(inputClass.split(/\s+/)).not.toContain("border-cdf-border");
  });

  it("keeps the decorative border, which is below 3:1 and must never bound a control", () => {
    expect(contrast(resolve(light, "--cdf-border"), resolve(light, "--cdf-surface"))).toBeLessThan(3);
  });

  it("draws checkboxes and radios with the control border, and keeps a visible focus outline", () => {
    expect(css).toMatch(/input\[type="radio"\]\s*\{[^}]*border: 2px solid var\(--cdf-border-control\)/);
    expect(css).toMatch(/:focus-visible\s*\{\s*outline: 3px solid var\(--cdf-focus\)/);
  });
});
