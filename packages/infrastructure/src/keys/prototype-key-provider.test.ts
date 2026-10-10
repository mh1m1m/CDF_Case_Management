import { describe, expect, it } from "vitest";
import { PrototypeKeyProvider } from "./prototype-key-provider";

describe("PrototypeKeyProvider", () => {
  it("requires strong keys", () => {
    expect(() => new PrototypeKeyProvider("short", "x".repeat(32))).toThrow();
  });
  it("produces stable, pepper-dependent HMACs that never contain the input", async () => {
    const a = new PrototypeKeyProvider("p".repeat(32), "s".repeat(32));
    const b = new PrototypeKeyProvider("q".repeat(32), "s".repeat(32));
    const h = await a.reportSecretHmac("ABCD-EFGH");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await a.reportSecretHmac("ABCD-EFGH")).toBe(h);
    expect(await b.reportSecretHmac("ABCD-EFGH")).not.toBe(h);
    expect(await a.rateLimitKey("203.0.113.7")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
