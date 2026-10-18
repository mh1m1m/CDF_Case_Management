// CDF-232: when the page-level refusal notice shows a command's refusal, and with which words. The rule tested first:
// a form still on the page shows its own refusal, so the page never shows a second one.
import { describe, expect, it } from "vitest";
import { createTranslator } from "@cdf/i18n";
import {
  NO_REFUSAL_NOTICE,
  refusalNotice,
  type Refusal,
  type RefusalNoticeState,
} from "./refusal-notice-state";
import { refusalMessage, refusalTitle } from "./refusal-words";

const REFUSED: Refusal = {
  kind: "CONFLICT",
  detail: "ALREADY_DISPOSED",
  ref: "00000000-0000-4000-8000-000000000001",
  codeSections: ["correctiveActions.codes", "codes"],
};
const LATER: Refusal = { kind: "FORBIDDEN", ref: "00000000-0000-4000-8000-000000000002" };

const run = (...events: Parameters<typeof refusalNotice>[1][]): RefusalNoticeState =>
  events.reduce(refusalNotice, NO_REFUSAL_NOTICE);

describe("refusalNotice (CDF-232)", () => {
  it("leaves a refusal to its form while the form is on the page", () => {
    const state = run(
      { type: "answered", formId: "a", refusal: REFUSED, mounted: true },
      { type: "shownByForm", formId: "a" },
    );
    expect(state).toEqual(NO_REFUSAL_NOTICE);
    // The form leaving afterwards (a navigation, say) brings nothing back.
    expect(refusalNotice(state, { type: "formLeft", formId: "a" })).toEqual(NO_REFUSAL_NOTICE);
  });

  it("shows the refusal of a form that left the page before showing it", () => {
    const state = run(
      { type: "answered", formId: "a", refusal: REFUSED, mounted: true },
      { type: "formLeft", formId: "a" },
    );
    expect(state).toEqual({ pending: null, shown: REFUSED });
  });

  it("shows the refusal of a form that had already left when its command answered", () => {
    expect(run({ type: "answered", formId: "a", refusal: REFUSED, mounted: false })).toEqual({
      pending: null,
      shown: REFUSED,
    });
  });

  it("ignores other forms showing their refusals or leaving the page", () => {
    const pending = run({ type: "answered", formId: "a", refusal: REFUSED, mounted: true });
    expect(refusalNotice(pending, { type: "shownByForm", formId: "b" })).toBe(pending);
    expect(refusalNotice(pending, { type: "formLeft", formId: "b" })).toBe(pending);
  });

  it("clears on the next command's answer, which replaces it", () => {
    const shown = run({ type: "answered", formId: "a", refusal: REFUSED, mounted: false });
    expect(refusalNotice(shown, { type: "answered", formId: "b", refusal: null, mounted: true })).toEqual(
      NO_REFUSAL_NOTICE,
    );
    expect(refusalNotice(shown, { type: "answered", formId: "b", refusal: LATER, mounted: true })).toEqual({
      pending: { formId: "b", refusal: LATER },
      shown: null,
    });
    expect(refusalNotice(shown, { type: "answered", formId: "b", refusal: LATER, mounted: false })).toEqual({
      pending: null,
      shown: LATER,
    });
  });

  it("clears on navigation, shown or still pending", () => {
    const shown = run({ type: "answered", formId: "a", refusal: REFUSED, mounted: false });
    const pending = run({ type: "answered", formId: "a", refusal: REFUSED, mounted: true });
    expect(refusalNotice(shown, { type: "navigated" })).toEqual(NO_REFUSAL_NOTICE);
    expect(refusalNotice(pending, { type: "navigated" })).toEqual(NO_REFUSAL_NOTICE);
    // Nothing to clear: the same state, so the page does not render again.
    expect(refusalNotice(NO_REFUSAL_NOTICE, { type: "navigated" })).toBe(NO_REFUSAL_NOTICE);
  });

  it("holds the refusal's codes and reference only, never text", () => {
    const state = run({ type: "answered", formId: "a", refusal: REFUSED, mounted: false });
    expect(Object.keys(state.shown ?? {}).sort()).toEqual(["codeSections", "detail", "kind", "ref"]);
  });
});

describe("refusal words (UX-078, CDF-232)", () => {
  it("titles a refusal by its class; an unknown class reads as unavailable", () => {
    expect(refusalTitle("CONFLICT")).toBe("errors.title.CONFLICT");
    expect(refusalTitle("RATE_LIMITED")).toBe("errors.title.RATE_LIMITED");
    expect(refusalTitle("SOMETHING_ELSE")).toBe("errors.title.UNAVAILABLE");
  });

  it("says the command's own words for its code, from the first section that has them", () => {
    for (const locale of ["en", "ar"] as const) {
      const t = createTranslator(locale);
      const words = refusalMessage(t, "CONFLICT", "ALREADY_DISPOSED", REFUSED.codeSections);
      expect(words).toBe(t("correctiveActions.codes.ALREADY_DISPOSED"));
      expect(words).not.toBe(t("errors.CONFLICT"));
    }
  });

  it("falls back to the class's generic words for an unknown code or none", () => {
    const t = createTranslator("en");
    expect(refusalMessage(t, "CONFLICT", "NO_SUCH_CODE", REFUSED.codeSections)).toBe(t("errors.CONFLICT"));
    expect(refusalMessage(t, "CONFLICT")).toBe(t("errors.CONFLICT"));
    expect(refusalMessage(t, "RATE_LIMITED", "NO_SUCH_CODE")).toBe(t("errors.RATE_LIMITED"));
  });
});
