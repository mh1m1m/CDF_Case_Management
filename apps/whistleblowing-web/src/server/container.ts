// Composition root for the public portal. Server-only: holds the cdf_portal connection and HMAC keys.
import "server-only";
import { join } from "node:path";
import { createPortalService, type PortalDeps, type PortalService } from "@cdf/application";
import { isLocalOnlyEnvironment, loadPortalServerEnv, type PortalServerEnv } from "@cdf/config";
import {
  LocalFilesystemEvidenceStorage,
  MockMalwareScanner,
  PostgresPortalGateway,
  PostgresRateLimiter,
  PrototypeKeyProvider,
  createPool,
} from "@cdf/infrastructure";

const globalForPortal = globalThis as unknown as { cdfPortal?: PortalService };

/**
 * Reporter attachments (ADR-015): a write-only view of evidence storage plus the scanner, or nothing
 * (uploads off). Local/test only for now; both pieces are PRODUCTION_SUBSTITUTION_REQUIRED.
 */
function attachments(env: PortalServerEnv): PortalDeps["attachments"] {
  const mode = env.CDF_PORTAL_ATTACHMENTS ?? (isLocalOnlyEnvironment() ? "local-fs" : "off");
  if (mode === "off") return undefined;
  const storage = new LocalFilesystemEvidenceStorage({
    // Same local store as the investigation app, which serves the files after the download gate.
    rootDir:
      env.CDF_EVIDENCE_LOCAL_DIR ??
      join(process.cwd(), "..", "investigation-web", ".local-storage", "evidence"),
    environment: env.CDF_ENVIRONMENT,
    isVercel: Boolean(process.env.VERCEL),
  });
  return {
    // Only the two write operations are handed over: the portal can never read an object back.
    dropbox: {
      kind: storage.kind,
      putQuarantine: (key, body, type) => storage.putQuarantine(key, body, type),
      promoteToVault: (key) => storage.promoteToVault(key),
    },
    scanner: new MockMalwareScanner(),
  };
}

export function portalService(): PortalService {
  if (!globalForPortal.cdfPortal) {
    const env = loadPortalServerEnv();
    const sql = createPool(env.CDF_PORTAL_DATABASE_URL, {
      applicationName: "cdf-whistleblowing-web",
      max: 3,
    });
    globalForPortal.cdfPortal = createPortalService({
      gateway: new PostgresPortalGateway(sql),
      keys: new PrototypeKeyProvider(env.CDF_REPORT_SECRET_PEPPER, env.CDF_RATE_LIMIT_SALT),
      rateLimiter: new PostgresRateLimiter(sql),
      attachments: attachments(env),
    });
  }
  return globalForPortal.cdfPortal;
}

/**
 * Client fingerprint for rate limiting only. Hashed with a keyed HMAC before use and never stored raw (T21).
 * On Vercel the platform sets x-forwarded-for; locally it falls back to a constant.
 */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip") || "local";
}
