import { describe, expect, it } from "vitest";
import { EICAR_TEST_SIGNATURE, MockMalwareScanner } from "./mock-scanner";

describe("MockMalwareScanner", () => {
  const scanner = new MockMalwareScanner();
  const hint = { contentType: "text/plain", objectKey: "cases/a/evidence/b/c" };

  it("flags the EICAR test signature and nothing else", async () => {
    expect(EICAR_TEST_SIGNATURE).toHaveLength(68);
    expect((await scanner.scan(new TextEncoder().encode(EICAR_TEST_SIGNATURE), hint)).status).toBe(
      "INFECTED",
    );
    expect((await scanner.scan(new TextEncoder().encode("%PDF-1.7 synthetic invoice"), hint)).status).toBe(
      "CLEAN",
    );
    expect((await scanner.scan(new Uint8Array(), hint)).status).toBe("CLEAN");
  });

  it("names itself as a production substitution", async () => {
    expect((await scanner.scan(new Uint8Array([1]), hint)).scanner).toMatch(
      /PRODUCTION_SUBSTITUTION_REQUIRED/,
    );
  });
});
