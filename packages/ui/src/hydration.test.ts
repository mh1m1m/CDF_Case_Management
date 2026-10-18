// CDF-255: in the markup the server sends, before the page is interactive, every submit button is disabled, so the
// browser never posts a form on its own (the investigation app would refuse that post with a bare error page). The
// components are rendered to static markup, as the server renders them, so these run with the unit suite.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CommandFormState } from "@cdf/contracts";
import { describe, expect, it } from "vitest";
import { CDFCommandForm, type CDFCommandFormProps } from "./command-form";
import type { CDFConfirmation } from "./confirm-dialog";
import { CDFSubmitButton } from "./hydration";
import { CDFNoScriptNotice } from "./shell";

const action = async (state: CommandFormState): Promise<CommandFormState> => state;

/** The opening tag of each submit button in the markup. */
const submitButtons = (html: string) => html.match(/<button\b[^>]*\btype="submit"[^>]*>/g) ?? [];

const CONFIRM: CDFConfirmation = {
  title: "Archive this case?",
  whatHappens: "The case moves to the archive.",
  undo: "No.",
  affected: "Records officers.",
  confirmLabel: "Archive case",
  cancelLabel: "Cancel",
  labels: { whatHappens: "What happens", undo: "Can it be undone?", affected: "Who is affected" },
};

describe("before the page is interactive (CDF-255)", () => {
  it.each<[string, Partial<CDFCommandFormProps>]>([
    ["a command form", {}],
    ["a command form that asks first", { confirm: CONFIRM }],
    ["a command form that sends only changed fields", { changedOnly: ["title"] }],
  ])("%s renders its submit button disabled", (_name, extra) => {
    const html = renderToStaticMarkup(
      h(CDFCommandForm, { action, locale: "en", submitLabel: "Save", testId: "f", ...extra }),
    );
    const buttons = submitButtons(html);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatch(/\sdisabled=""/);
  });

  it("renders the submit button of any other server-action form disabled", () => {
    const html = renderToStaticMarkup(
      h("form", null, h(CDFSubmitButton, { className: "btn", testId: "sign-out", children: "Sign out" })),
    );
    expect(submitButtons(html)).toEqual([
      '<button type="submit" class="btn" disabled="" data-testid="sign-out">',
    ]);
  });

  it("explains the disabled buttons only when JavaScript is off", () => {
    const html = renderToStaticMarkup(h(CDFNoScriptNotice, { text: "JavaScript is turned off." }));
    expect(html).toMatch(
      /^<noscript><p role="note" data-testid="no-script-notice"[^>]*>JavaScript is turned off\.<\/p><\/noscript>$/,
    );
  });
});
