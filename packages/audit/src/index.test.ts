import { describe, expect, it } from "vitest";
import { assertSafeMetadata } from "./index";

describe("security event metadata guard", () => {
  it("allows small technical context", () => {
    expect(() => assertSafeMetadata({ command: "assign_case", code: "CDF_FORBIDDEN" })).not.toThrow();
  });
  it.each(["email", "reporterName", "password", "body"])("rejects %s", (key) => {
    expect(() => assertSafeMetadata({ [key]: "x" })).toThrow();
  });
});
