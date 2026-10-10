import { describe, expect, it } from "vitest";
import { STATES, TRANSITIONS, transitionsFrom } from "./index";

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
