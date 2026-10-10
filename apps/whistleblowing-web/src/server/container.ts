// Composition root for the public portal. Server-only: holds the cdf_portal connection and HMAC keys.
import "server-only";
import { createPortalService, type PortalService } from "@cdf/application";
import { loadPortalServerEnv } from "@cdf/config";
import {
  PostgresPortalGateway,
  PostgresRateLimiter,
  PrototypeKeyProvider,
  createPool,
} from "@cdf/infrastructure";

const globalForPortal = globalThis as unknown as { cdfPortal?: PortalService };

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
