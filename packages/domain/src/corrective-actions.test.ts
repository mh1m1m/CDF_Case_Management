import { describe, expect, it } from "vitest";
import { CORRECTIVE_ACTION_STATUSES } from "@cdf/contracts";
import {
  allowedActionCommands,
  executionState,
  isActionClosed,
  isOverdue,
  riyadhDate,
  type ActionProgress,
} from "./corrective-actions";

const TODAY = "2026-10-12";
const a = (status: ActionProgress["status"], dueDate = "2026-10-20"): ActionProgress => ({ status, dueDate });

describe("corrective-action rules (ADR-033)", () => {
  it("offers the commands each status allows, mirroring the api.* commands", () => {
    expect(allowedActionCommands("OPEN")).toContain("submitCompletion");
    expect(allowedActionCommands("PENDING_VERIFICATION")).toEqual(["changeDueDate", "verify", "waive"]);
    expect(allowedActionCommands("COMPLETED")).toEqual(["reopen"]);
    expect(allowedActionCommands("WAIVED")).toEqual([]);
    for (const s of CORRECTIVE_ACTION_STATUSES) {
      // Reporting and verification never coexist: the owner submits, someone else verifies.
      const cmds = allowedActionCommands(s);
      expect(cmds.includes("verify") && cmds.includes("submitCompletion")).toBe(false);
      expect(isActionClosed(s)).toBe(s === "COMPLETED" || s === "WAIVED");
    }
  });

  it("is overdue only while still with its owner after the due date", () => {
    expect(isOverdue(a("OPEN", "2026-10-11"), TODAY)).toBe(true);
    expect(isOverdue(a("IN_PROGRESS", "2026-10-11"), TODAY)).toBe(true);
    expect(isOverdue(a("IN_PROGRESS", TODAY), TODAY)).toBe(false);
    for (const s of ["PENDING_VERIFICATION", "COMPLETED", "WAIVED"] as const) {
      expect(isOverdue(a(s, "2026-01-01"), TODAY)).toBe(false);
    }
  });

  it("dates due dates in Riyadh", () => {
    expect(riyadhDate(new Date("2026-10-11T20:59:59Z"))).toBe("2026-10-11");
    expect(riyadhDate(new Date("2026-10-11T21:00:00Z"))).toBe("2026-10-12");
  });

  it("derives the case's execution state from its approved items and their actions", () => {
    expect(executionState([], TODAY)).toBeNull();
    expect(executionState([[]], TODAY)).toBe("NOT_STARTED");
    expect(executionState([[a("OPEN")], []], TODAY)).toBe("NOT_STARTED");
    expect(executionState([[a("IN_PROGRESS")], []], TODAY)).toBe("IN_PROGRESS");
    expect(executionState([[a("PENDING_VERIFICATION")], [a("OPEN")]], TODAY)).toBe("FOLLOW_UP");
    expect(executionState([[a("COMPLETED")], []], TODAY)).toBe("PARTIALLY_EXECUTED");
    expect(executionState([[a("COMPLETED"), a("OPEN")], [a("WAIVED")]], TODAY)).toBe("PARTIALLY_EXECUTED");
    expect(executionState([[a("COMPLETED")], [a("WAIVED")]], TODAY)).toBe("EXECUTED");
    // Overdue wins over everything else, so it is never hidden by partial execution.
    expect(executionState([[a("COMPLETED")], [a("OPEN", "2026-10-01")]], TODAY)).toBe("OVERDUE");
    // A reopened action takes an executed item back.
    expect(executionState([[a("COMPLETED")], [a("IN_PROGRESS")]], TODAY)).toBe("PARTIALLY_EXECUTED");
  });
});
