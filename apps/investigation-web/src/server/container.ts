// Composition root for the investigation app. Server-only: holds the cdf_bff connection.
import "server-only";
import { cache } from "react";
import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createInvestigationService, type InvestigationService } from "@cdf/application";
import type { Actor } from "@cdf/contracts";
import { PostgresInvestigationGateway, PostgresSecurityEventSink, createPool } from "@cdf/infrastructure";
import type { CookieJar } from "@cdf/infrastructure/identity";
import { env } from "./env";
import { identityProvider } from "./identity";

const globalForApp = globalThis as unknown as { cdfInvestigation?: InvestigationService };

export function investigationService(): InvestigationService {
  if (!globalForApp.cdfInvestigation) {
    const sql = createPool(env().CDF_BFF_DATABASE_URL, { applicationName: "cdf-investigation-web", max: 5 });
    globalForApp.cdfInvestigation = createInvestigationService({
      gateway: new PostgresInvestigationGateway(sql),
      securityEvents: new PostgresSecurityEventSink(sql),
    });
  }
  return globalForApp.cdfInvestigation;
}

/** Cookie jar over next/headers. Writes are ignored where Next forbids them (Server Components). */
export async function cookieJar(): Promise<CookieJar> {
  const store = await cookies();
  return {
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => {
      try {
        store.set(name, value, options);
      } catch {
        // Read-only during render; the proxy refreshes sessions instead.
      }
    },
  };
}

export async function identity() {
  const h = await headers();
  const secure = h.get("x-forwarded-proto") === "https";
  return identityProvider(env(), await cookieJar(), secure);
}

export interface RequestScope {
  actor: Actor;
  ctx: { userId: string; requestId: string };
}

/**
 * Resolves the signed-in, ACTIVE user for this request, or redirects to sign-in.
 * The actor (roles, permissions, clearance) comes from the database, never from the session token.
 */
export const requireActor = cache(async (): Promise<RequestScope> => {
  const session = await (await identity()).currentSession();
  if (!session) redirect("/login");
  const ctx = { userId: session.subject, requestId: randomUUID() };
  const actor = await investigationService().loadActor(ctx);
  if (!actor) redirect("/login?reason=inactive");
  return { actor, ctx };
});
