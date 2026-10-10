"use server";
import { identity } from "@/server/container";

/**
 * "Stay signed in" from the idle-session warning (CDF-57, WCAG 2.2.1). The request itself passes through the
 * proxy, which re-verifies the session and extends the idle window; this only reports whether a session is
 * still valid. It never extends the absolute session lifetime (CDF_SESSION_MAX_AGE_SECONDS).
 */
export async function extendSessionAction(): Promise<boolean> {
  const idp = await identity();
  const session = await idp.currentSession();
  if (!session) return false;
  if (idp.touch) await idp.touch(session);
  return true;
}
