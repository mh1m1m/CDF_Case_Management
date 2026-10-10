// CDF-62 · §24–§27, ADR-006, threat T05: user input never shapes a storage path, adapters refuse any key the
// database did not mint, and no code path hands the browser a storage URL (signed or public). Today there
// are no signed URLs at all; if one is ever introduced, the last test fails and must be replaced by tests of
// its scope (single object, download-only, short expiry, issued only after api.open_evidence_version).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { OBJECT_KEY_PATTERN, SupabaseEvidenceStorage, assertObjectKey } from "@cdf/infrastructure";
import type { Tx } from "@cdf/infrastructure";
import { caseId, scenario } from "../support/db";

let caseA: string;
beforeAll(async () => {
  caseA = await caseId("0001");
});

const register = (tx: Tx, fileName: string, sha: string, evidenceId: string | null = null) =>
  tx<{ evidenceId: string; versionId: string; objectKey: string }[]>`
    select o_evidence_id as "evidenceId", o_version_id as "versionId", o_object_key as "objectKey"
    from api.register_evidence_version(${caseA}, ${evidenceId}, ${evidenceId ? null : "Path probe (synthetic) ../../etc"}, null,
      ${evidenceId ? null : "DOCUMENT"}, 'Synthetic source', null, ${evidenceId ? null : "CONFIDENTIAL"}::core.classification_level,
      ${fileName}, 'application/pdf', 1024, ${sha})`;

describe("file names are data, never paths", () => {
  it.each([
    "..",
    ".",
    "...",
    "a/b.pdf",
    "/etc/passwd.pdf",
    "..\\..\\boot.pdf",
    "C:\\Windows\\win.pdf",
    "line\nbreak.pdf",
    "carriage\rreturn.pdf",
    "tab\there.pdf",
    "bell\u0007.pdf",
    "escape\u001b[31m.pdf",
    "",
    "   ",
    "x".repeat(252) + ".pdf",
  ])("the database refuses %j", async (name) => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      await s.expectError("CDF_INVALID:file_name", (tx) => register(tx, name, "9".repeat(64)));
    });
  });

  it("object keys are minted by the database, scoped to the case and item, and never echo user input", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      const [first] = await register(s.tx, "CDF-DEMO-2026-0001 ledger.pdf", "8".repeat(64));
      const [second] = await register(
        s.tx,
        "CDF-DEMO-2026-0001 ledger.pdf",
        "7".repeat(64),
        first!.evidenceId,
      );
      for (const r of [first!, second!]) {
        expect(r.objectKey).toMatch(OBJECT_KEY_PATTERN);
        expect(r.objectKey.startsWith(`cases/${caseA}/evidence/${first!.evidenceId}/`)).toBe(true);
        expect(r.objectKey).not.toMatch(/ledger|CDF-DEMO|\.\.|etc/i);
      }
      expect(second!.objectKey).not.toBe(first!.objectKey);
    });
  });
});

describe("storage adapters accept only canonical keys", () => {
  const UUID = "0e563079-e843-4cc8-be39-77a53c009ea2";
  const BAD_KEYS = [
    "",
    "../../etc/passwd",
    `cases/${UUID}/evidence/${UUID}/../${UUID}`,
    `/cases/${UUID}/evidence/${UUID}/${UUID}`,
    `cases/${UUID}/evidence/${UUID}/${UUID}/`,
    `cases/${UUID}/evidence/${UUID}/${UUID}?download`,
    `cases/${UUID}/evidence/${UUID}/${UUID}%2e%2e`,
    `cases/${UUID.toUpperCase()}/evidence/${UUID}/${UUID}`,
    `cases/${UUID}/evidence/${UUID}`,
    `https://example.test/storage/v1/object/public/evidence-vault/cases/${UUID}/evidence/${UUID}/${UUID}`,
  ];

  it.each(BAD_KEYS)("assertObjectKey refuses %j", (key) => {
    expect(() => assertObjectKey(key)).toThrow("Invalid evidence object key");
  });

  it("the Supabase adapter refuses a bad key before any network call", async () => {
    // Unroutable endpoint and a dummy key: reaching the network would surface a different error.
    const storage = new SupabaseEvidenceStorage("http://127.0.0.1:9", "test-only-not-a-key");
    for (const key of BAD_KEYS) {
      await expect(storage.openReadStream(key)).rejects.toThrow("Invalid evidence object key");
      await expect(storage.promoteToVault(key)).rejects.toThrow("Invalid evidence object key");
      await expect(storage.exists(key)).rejects.toThrow("Invalid evidence object key");
      // putQuarantine checks bucket provisioning first, then the key; either way nothing is uploaded.
      await expect(storage.putQuarantine(key, new Uint8Array([1]), "application/pdf")).rejects.toThrow();
    }
  });
});

describe("no storage URL ever reaches the browser", () => {
  const root = join(import.meta.dirname, "..", "..");
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (name === "node_modules" || name === ".next" || name.startsWith(".")) return [];
      if (statSync(full).isDirectory()) return sources(full);
      return /\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
    });

  it("no application or adapter code creates signed, public or upload URLs, or redirects to storage", () => {
    const files = [...sources(join(root, "apps")), ...sources(join(root, "packages"))];
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.flatMap((f) => {
      const text = readFileSync(f, "utf8");
      return [
        /createSignedUrls?\s*\(/,
        /createSignedUploadUrl\s*\(/,
        /getPublicUrl\s*\(/,
        /\/storage\/v1\/object\//,
        /public:\s*true/,
      ]
        .filter((re) => re.test(text))
        .map((re) => `${f.slice(root.length + 1)} ${re}`);
    });
    expect(offenders).toEqual([]);
  });

  it("the download route streams the object itself and never redirects", () => {
    const route = readFileSync(
      join(root, "apps/investigation-web/src/app/cases/[id]/evidence/[versionId]/download/route.ts"),
      "utf8",
    );
    expect(route).toMatch(/openDownload\(/);
    expect(route).not.toMatch(/redirect\(|Response\.redirect|Location/);
  });
});
