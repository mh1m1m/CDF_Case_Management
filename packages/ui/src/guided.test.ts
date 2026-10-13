// Guided-by-design building blocks (ADR-030; UX redesign Phase 12), rendered to static markup: the workflow guide
// offers the viewer's command only when the database says they can act, the purpose banner says what is not shown,
// a configured value always says where it comes from, and the consequence preview names who is told.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CDFConfirmDialog } from "./confirm-dialog";
import { CDFConfiguredValue, CDFPurposeBanner, CDFWorkflowGuide } from "./guided";

const guide = (canAct: boolean) =>
  renderToStaticMarkup(
    h(
      CDFWorkflowGuide,
      {
        title: "Where this stands",
        trackerLabel: "Proceeding path",
        steps: [
          { code: "REFERRED", label: "Referred" },
          { code: "MEETING", label: "Meeting" },
          { code: "DECIDED", label: "Decided" },
        ],
        current: "MEETING",
        stateLabels: { done: "done", current: "current", upcoming: "upcoming" },
        now: "Meeting scheduled",
        nextActor: "Committee secretary",
        you: canAct
          ? "You can record attendance as the secretary."
          : "Only the secretary records attendance.",
        canAct,
        labels: { now: "Now", nextActor: "Who acts next", you: "You" },
      },
      h("button", { type: "button", "data-testid": "act" }, "Record attendance"),
    ),
  );

describe("CDFWorkflowGuide", () => {
  it("shows the path, the current step, who acts next and why the viewer can act, with their command", () => {
    const html = guide(true);
    expect(html).toContain('data-can-act="true"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Who acts next");
    expect(html).toContain("Committee secretary");
    expect(html).toContain("You can record attendance as the secretary.");
    expect(html).toContain('data-testid="act"');
  });
  it("explains why not, and offers no command, when the viewer cannot act", () => {
    const html = guide(false);
    expect(html).toContain('data-can-act="false"');
    expect(html).toContain("Only the secretary records attendance.");
    expect(html).not.toContain('data-testid="act"');
  });
});

describe("CDFPurposeBanner and CDFConfiguredValue", () => {
  it("says what is open and what is not shown", () => {
    const html = renderToStaticMarkup(
      h(CDFPurposeBanner, {
        title: "Meeting view",
        purpose: "You see this meeting as a participant.",
        notShown: "The case itself is not shown.",
      }),
    );
    expect(html).toContain('data-testid="purpose-banner"');
    expect(html).toContain("You see this meeting as a participant.");
    expect(html).toContain("The case itself is not shown.");
  });
  it("always says where a value comes from, in text", () => {
    const html = renderToStaticMarkup(
      h(CDFConfiguredValue, {
        value: "30 days",
        source: "SOURCE_REQUIRED",
        sourceLabel: "Provisional: awaiting the CDF source",
        testId: "window",
      }),
    );
    expect(html).toContain('data-source="SOURCE_REQUIRED"');
    expect(html).toContain("30 days");
    expect(html).toContain("Provisional: awaiting the CDF source");
  });
});

describe("consequence preview (ADR-030)", () => {
  const base = {
    title: "Lift the restriction?",
    whatHappens: "The case is no longer restricted.",
    undo: "Only by restricting it again.",
    affected: "Everyone cleared for the case's classification.",
    confirmLabel: "Lift restriction",
    cancelLabel: "Cancel",
    labels: { whatHappens: "What happens", undo: "Can it be undone?", affected: "Who is affected" },
  };
  const render = (c: Parameters<typeof CDFConfirmDialog>[0]["confirmation"]) =>
    renderToStaticMarkup(
      h(CDFConfirmDialog, { open: false, confirmation: c, onConfirm: () => {}, onDismiss: () => {} }),
    );
  it("names who is told and the database's counts when given, and nothing extra otherwise", () => {
    const html = render({
      ...base,
      notified: "The case authority is told; the notice names no case content.",
      facts: [{ term: "People who gain access", value: "4 (Investigator, Case Manager)" }],
      labels: { ...base.labels, notified: "Who is told" },
    });
    expect(html).toContain('data-testid="confirm-notified"');
    expect(html).toContain("Who is told");
    expect(html).toContain("4 (Investigator, Case Manager)");
    const plain = render(base);
    expect(plain).not.toContain("confirm-notified");
    expect(plain).not.toContain("confirm-fact");
  });
});
