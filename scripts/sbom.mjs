#!/usr/bin/env node
// Minimal SBOM (protocol §70): production dependencies with version and license, from the lockfile-resolved tree.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const raw = execFileSync("pnpm", ["licenses", "list", "--json", "--prod"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const byLicense = JSON.parse(raw);
const components = [];
for (const [license, pkgs] of Object.entries(byLicense)) {
  for (const p of pkgs) {
    for (const version of p.versions ?? [p.version]) {
      components.push({ name: p.name, version, license, type: "production" });
    }
  }
}
components.sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
const sbom = {
  format: "cdf-sbom-v1",
  generatedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? null,
  componentCount: components.length,
  components,
};
mkdirSync("compliance/evidence", { recursive: true });
writeFileSync("compliance/evidence/sbom.json", JSON.stringify(sbom, null, 2) + "\n");
console.warn(`SBOM written: ${components.length} production components`);
