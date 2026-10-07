"use server";
import { createHmac, randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PostgresRateLimiter, createPool } from "@cdf/infrastructure";
import { signInSchema } from "@cdf/validation";
import type { ActionState } from "@/server/actions-helpers";
import { identity, investigationService } from "@/server/container";
import { env } from "@/server/env";

const globalForLogin = globalThis as unknown as { cdfLoginLimiter?: PostgresRateLimiter };
function limiter() {
  globalForLogin.cdfLoginLimiter ??= new PostgresRateLimiter(
    createPool(env().CDF_BFF_DATABASE_URL, { applicationName: "cdf-investigation-login", max: 2 }),
  );
  return globalForLogin.cdfLoginLimiter;
}
const bucketKey = (value: string) =>
  createHmac("sha256", env().CDF_RATE_LIMIT_SALT).update(value).digest("base64url").slice(0, 43);

/** One generic failure for every reason, so sign-in never reveals which accounts exist (T07). */
const failed = (ref: string): ActionState => ({
  status: "error",
  kind: "INVALID",
  detail: "LOGIN_FAILED",
  ref,
});

export async function signInAction(_: ActionState, form: FormData): Promise<ActionState> {
  const requestId = randomUUID();
  const parsed = signInSchema.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return failed(requestId);

  // Brute-force protection per account and per client. Keys are keyed hashes; no raw emails or IPs are stored.
  const client = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const [accountOk, clientOk] = await Promise.all([
    limiter().consume(`login_account:${bucketKey(parsed.data.email)}`, 10, 900),
    limiter().consume(`login_client:${bucketKey(client)}`, 50, 900),
  ]);
  if (!accountOk || !clientOk) return { status: "error", kind: "RATE_LIMITED", ref: requestId };

  const idp = await identity();
  const session = await idp.signIn(parsed.data.email, parsed.data.password);
  if (!session) return failed(requestId);
  // Authenticated is not authorized: the user must also be ACTIVE in the platform directory (T18).
  const actor = await investigationService().loadActor({ userId: session.subject, requestId });
  if (!actor) {
    await idp.signOut();
    return failed(requestId);
  }
  redirect("/");
}

export async function signOutAction() {
  await (await identity()).signOut();
  redirect("/login");
}
