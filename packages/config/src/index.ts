/**
 * Environment configuration for both applications.
 *
 * Server-only variables are parsed here and must never be read from client components.
 * Protocol §46–§48: privileged values never use the NEXT_PUBLIC_ prefix.
 */
import { z } from "zod";

export const CDF_ENVIRONMENTS = ["local", "test", "dev", "demo"] as const;
export type CdfEnvironment = (typeof CDF_ENVIRONMENTS)[number];

const secret = (name: string) =>
  z.string().min(32, `${name} must be at least 32 characters of high-entropy secret material`);

const base = z.object({
  CDF_ENVIRONMENT: z.enum(CDF_ENVIRONMENTS),
});

export const investigationServerEnvSchema = base.extend({
  CDF_BFF_DATABASE_URL: z.string().url(),
  CDF_IDENTITY_PROVIDER: z.enum(["supabase", "local-dev"]),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().min(20).optional(),
  CDF_DEV_IDENTITY_SECRET: secret("CDF_DEV_IDENTITY_SECRET").optional(),
  CDF_DEV_PASSWORD: z.string().min(12).optional(),
  CDF_SESSION_MAX_AGE_SECONDS: z.coerce.number().int().min(300).max(43_200).default(28_800),
  CDF_SESSION_IDLE_SECONDS: z.coerce.number().int().min(60).max(7_200).default(1_800),
});
export type InvestigationServerEnv = z.infer<typeof investigationServerEnvSchema>;

export const portalServerEnvSchema = base.extend({
  CDF_PORTAL_DATABASE_URL: z.string().url(),
  CDF_REPORT_SECRET_PEPPER: secret("CDF_REPORT_SECRET_PEPPER"),
  CDF_RATE_LIMIT_SALT: secret("CDF_RATE_LIMIT_SALT"),
});
export type PortalServerEnv = z.infer<typeof portalServerEnvSchema>;

const PUBLIC_PREFIX = "NEXT_PUBLIC_";
const FORBIDDEN_PUBLIC_NAME = /(SECRET|SERVICE|PASSWORD|PRIVATE|DATABASE|PEPPER|SALT|TOKEN|KEY)/;

/**
 * Fails if any browser-exposed variable looks like a credential (threat R4, protocol §47).
 */
export function assertNoSecretsInPublicEnv(env: Record<string, string | undefined>): void {
  const offenders = Object.keys(env).filter(
    (k) => k.startsWith(PUBLIC_PREFIX) && FORBIDDEN_PUBLIC_NAME.test(k.slice(PUBLIC_PREFIX.length)),
  );
  if (offenders.length > 0) {
    throw new Error(
      `Refusing to start: credential-like public environment variables: ${offenders.join(", ")}`,
    );
  }
}

export class ConfigurationError extends Error {
  override name = "ConfigurationError";
}

function parse<T extends z.ZodType>(schema: T, env: Record<string, string | undefined>): z.infer<T> {
  assertNoSecretsInPublicEnv(env);
  const result = schema.safeParse(env);
  if (!result.success) {
    // Names only; never echo values.
    const fields = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new ConfigurationError(`Invalid server configuration: ${fields}`);
  }
  return result.data;
}

export function loadInvestigationServerEnv(env: Record<string, string | undefined> = process.env) {
  const parsed = parse(investigationServerEnvSchema, env);
  if (parsed.CDF_IDENTITY_PROVIDER === "supabase" && (!parsed.SUPABASE_URL || !parsed.SUPABASE_ANON_KEY)) {
    throw new ConfigurationError("Invalid server configuration: SUPABASE_URL, SUPABASE_ANON_KEY");
  }
  if (
    parsed.CDF_IDENTITY_PROVIDER === "local-dev" &&
    (!parsed.CDF_DEV_IDENTITY_SECRET || !parsed.CDF_DEV_PASSWORD)
  ) {
    throw new ConfigurationError("Invalid server configuration: CDF_DEV_IDENTITY_SECRET, CDF_DEV_PASSWORD");
  }
  return parsed;
}

export function loadPortalServerEnv(env: Record<string, string | undefined> = process.env) {
  return parse(portalServerEnvSchema, env);
}

/** True only where synthetic local identity substitutes may run (ADR-010, threat T22). */
export function isLocalOnlyEnvironment(env: Record<string, string | undefined> = process.env): boolean {
  return !env.VERCEL && (env.CDF_ENVIRONMENT === "local" || env.CDF_ENVIRONMENT === "test");
}
