// Identity-only entry point, importable from the Next.js proxy without loading database drivers.
export { LocalDevIdentityProvider, LOCAL_DEV_USERS, SESSION_COOKIE } from "./local-dev";
export type { LocalDevOptions } from "./local-dev";
export { SupabaseIdentityProvider } from "./supabase";
export type { CookieJar, CookieOptions } from "./cookies";
