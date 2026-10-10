// Builds the configured IdentityProvider over a cookie jar (ADR-009).
import type { IdentityProvider } from "@cdf/application";
import {
  LocalDevIdentityProvider,
  SupabaseIdentityProvider,
  type CookieJar,
} from "@cdf/infrastructure/identity";
import type { InvestigationServerEnv } from "@cdf/config";

export function identityProvider(
  env: InvestigationServerEnv,
  cookies: CookieJar,
  secureCookies: boolean,
): IdentityProvider & {
  touch?: LocalDevIdentityProvider["touch"];
} {
  if (env.CDF_IDENTITY_PROVIDER === "supabase") {
    return new SupabaseIdentityProvider(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, cookies);
  }
  const local = new LocalDevIdentityProvider({
    secret: env.CDF_DEV_IDENTITY_SECRET!,
    password: env.CDF_DEV_PASSWORD!,
    environment: env.CDF_ENVIRONMENT,
    isVercel: Boolean(process.env.VERCEL),
    maxAgeSeconds: env.CDF_SESSION_MAX_AGE_SECONDS,
    idleSeconds: env.CDF_SESSION_IDLE_SECONDS,
    cookies,
    secureCookies,
  });
  return Object.assign(local, { touch: local.touch.bind(local) });
}
