import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFilesystemEvidenceStorage } from "./local-fs";

const KEY =
  "cases/11111111-1111-4111-8111-111111111111/evidence/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333";
let root: string;
let storage: LocalFilesystemEvidenceStorage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cdf-evidence-"));
  storage = new LocalFilesystemEvidenceStorage({ rootDir: root, environment: "test", isVercel: false });
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function read(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const c of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
  return Buffer.concat(chunks).toString();
}

describe("LocalFilesystemEvidenceStorage", () => {
  it("refuses to run on Vercel or outside local/test", () => {
    expect(
      () => new LocalFilesystemEvidenceStorage({ rootDir: root, environment: "test", isVercel: true }),
    ).toThrow();
    expect(
      () => new LocalFilesystemEvidenceStorage({ rootDir: root, environment: "demo", isVercel: false }),
    ).toThrow();
  });

  it("quarantine → vault, read-only, streamable, never overwritten", async () => {
    await storage.putQuarantine(KEY, new TextEncoder().encode("synthetic body"), "text/plain");
    await expect(storage.putQuarantine(KEY, new TextEncoder().encode("other"), "text/plain")).rejects.toThrow(
      /EEXIST/,
    );
    expect(await storage.exists(KEY)).toBe(false);
    await storage.promoteToVault(KEY);
    expect(await storage.exists(KEY)).toBe(true);
    const vaultPath = storage.vaultPathFor(KEY);
    expect((await stat(vaultPath)).mode & 0o777).toBe(0o400);
    expect(await readFile(vaultPath, "utf8")).toBe("synthetic body");
    expect(await read(await storage.openReadStream(KEY))).toBe("synthetic body");
    // A second promotion attempt for the same key cannot replace the vault copy.
    await storage.putQuarantine(KEY, new TextEncoder().encode("replacement"), "text/plain");
    await expect(storage.promoteToVault(KEY)).rejects.toThrow(/EEXIST/);
    expect(await readFile(vaultPath, "utf8")).toBe("synthetic body");
  });

  it("rejects anything that is not a canonical object key", async () => {
    for (const bad of [
      "../../etc/passwd",
      "cases/x/evidence/y/z",
      `${KEY}/../other`,
      "",
      "cases/" + "a".repeat(36),
    ]) {
      await expect(storage.putQuarantine(bad, new Uint8Array([1]), "text/plain")).rejects.toThrow(
        /Invalid evidence object key/,
      );
      expect(await storage.exists(bad).catch(() => "threw")).toBe("threw");
    }
  });
});
