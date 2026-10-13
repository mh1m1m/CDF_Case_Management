import { describe, expect, it } from "vitest";
import { STATES, TRANSITIONS, lastReturn, progressSteps, transitionsFrom } from "./index";

describe("CDF_CASE_V1", () => {
  it("has the 15 protocol states in order", () => {
    expect(STATES).toHaveLength(15);
    expect(STATES.map((s) => s.sequence)).toEqual([...STATES.map((s) => s.sequence)].sort((a, b) => a - b));
  });

  it("only references defined states", () => {
    const codes = new Set(STATES.map((s) => s.code));
    for (const t of TRANSITIONS) {
      expect(codes.has(t.from), t.code).toBe(true);
      expect(codes.has(t.to), t.code).toBe(true);
    }
  });

  it("reaches INVESTIGATION from REFERRAL through enabled transitions (first slice)", () => {
    const path = [
      "REGISTER",
      "START_SCREENING",
      "COMPLETE_SCREENING",
      "CLEAR_CONFLICT_CHECK",
      "COMPLETE_TRIAGE",
      "CONFIRM_JURISDICTION",
      "APPROVE_INVESTIGATION",
    ];
    let state = "REFERRAL";
    for (const code of path) {
      const t = TRANSITIONS.find((x) => x.code === code && x.from === state);
      expect(t?.isEnabled, code).toBe(true);
      state = t!.to;
    }
    expect(state).toBe("INVESTIGATION");
  });

  it("requires approval and a reason to open an investigation", () => {
    const approve = transitionsFrom("INVESTIGATION_APPROVAL").find(
      (t) => t.code === "APPROVE_INVESTIGATION",
    )!;
    expect(approve.approvalRequired).toBe(true);
    expect(approve.reasonRequired).toBe(true);
  });
});

describe("progressSteps (path-aware, UX-032)", () => {
  const step = (fromState: string, toState: string) => ({ fromState, toState });
  const firstSlice = [
    step("REFERRAL", "REGISTERED"),
    step("REGISTERED", "SCREENING"),
    step("SCREENING", "CONFLICT_CHECK"),
    step("CONFLICT_CHECK", "TRIAGE"),
    step("TRIAGE", "JURISDICTION"),
    step("JURISDICTION", "INVESTIGATION_APPROVAL"),
    step("INVESTIGATION_APPROVAL", "INVESTIGATION"),
  ];

  it("marks only the states the case went through as done", () => {
    const steps = progressSteps("INVESTIGATION", firstSlice);
    expect(steps.filter((s) => s.state === "done").map((s) => s.code)).toEqual(
      firstSlice.map((p) => p.fromState),
    );
    expect(steps.filter((s) => s.state === "current").map((s) => s.code)).toEqual(["INVESTIGATION"]);
    expect(steps.filter((s) => s.state === "upcoming")).toHaveLength(7);
    expect(steps.some((s) => s.state === "skipped")).toBe(false);
  });

  it("shows a case closed at screening as one skipped run, never as a full path of ticks", () => {
    const steps = progressSteps("CLOSURE", [
      step("REFERRAL", "REGISTERED"),
      step("REGISTERED", "SCREENING"),
      step("SCREENING", "CLOSURE"),
    ]);
    expect(steps.map((s) => [s.code, s.state])).toEqual([
      ["REFERRAL", "done"],
      ["REGISTERED", "done"],
      ["SCREENING", "done"],
      ["skipped:CONFLICT_CHECK", "skipped"],
      ["CLOSURE", "current"],
      ["ARCHIVE", "upcoming"],
    ]);
    expect(steps[3]!.skipped).toHaveLength(10);
  });

  it("treats a state the case was returned from as upcoming again", () => {
    const path = [...firstSlice.slice(0, 6), step("INVESTIGATION_APPROVAL", "JURISDICTION")];
    const steps = progressSteps("JURISDICTION", path);
    expect(steps.find((s) => s.code === "INVESTIGATION_APPROVAL")!.state).toBe("upcoming");
    expect(lastReturn(path)?.toState).toBe("JURISDICTION");
    expect(lastReturn(firstSlice)).toBeUndefined();
    expect(lastReturn([step("SCREENING", "CLOSURE")])).toBeUndefined();
  });

  it("falls back to positions only when no path is recorded, and to all upcoming for an unknown state", () => {
    expect(progressSteps("TRIAGE", []).filter((s) => s.state === "done")).toHaveLength(4);
    expect(progressSteps(null, []).every((s) => s.state === "upcoming")).toBe(true);
  });
});
