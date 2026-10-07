// Composition root for the investigation app. Server-only: holds the cdf_bff connection.
import "server-only";
import { cache } from "react";
import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { join } from "node:path";
import {
  createEvidenceService,
  createInterviewService,
  createInvestigationService,
  type EvidenceService,
  type EvidenceStorage,
  type InterviewService,
  type InvestigationService,
} from "@cdf/application";
import type { Actor } from "@cdf/contracts";
import {
  LocalFilesystemEvidenceStorage,
  MockMalwareScanner,
  PostgresEvidenceGateway,
  PostgresInterviewGateway,
  PostgresInvestigationGateway,
  PostgresSecurityEventSink,
  SupabaseEvidenceStorage,
  createPool,
  type Sql,
} from "@cdf/infrastructure";
import type { CookieJar } from "@cdf/infrastructure/identity";
import { env } from "./env";
import { identityProvider } from "./identity";

const globalForApp = globalThis as unknown as {
  cdfPool?: Sql;
  cdfInvestigation?: InvestigationService;
  cdfEvidence?: EvidenceService;
  cdfInterviews?: InterviewService;
};

function pool(): Sql {
  globalForApp.cdfPool ??= createPool(env().CDF_BFF_DATABASE_URL, {
    applicationName: "cdf-investigation-web",
    max: 5,
  });
  return globalForApp.cdfPool;
}

export function investigationService(): InvestigationService {
  globalForApp.cdfInvestigation ??= createInvestigationService({
    gateway: new PostgresInvestigationGateway(pool()),
    securityEvents: new PostgresSecurityEventSink(pool()),
  });
  return globalForApp.cdfInvestigation;
}

/** Evidence storage adapter from configuration (ADR-006). Both adapters are PRODUCTION_SUBSTITUTION_REQUIRED. */
function evidenceStorage(): EvidenceStorage {
  const e = env();
  if (e.CDF_EVIDENCE_STORAGE === "supabase") {
    return new SupabaseEvidenceStorage(e.SUPABASE_URL!, e.SUPABASE_SERVICE_ROLE_KEY!);
  }
  return new LocalFilesystemEvidenceStorage({
    rootDir: e.CDF_EVIDENCE_LOCAL_DIR ?? join(process.cwd(), ".local-storage", "evidence"),
    environment: e.CDF_ENVIRONMENT,
    isVercel: Boolean(process.env.VERCEL),
  });
}

export function evidenceService(): EvidenceService {
  globalForApp.cdfEvidence ??= createEvidenceService({
    gateway: new PostgresEvidenceGateway(pool()),
    storage: evidenceStorage(),
    scanner: new MockMalwareScanner(),
    securityEvents: new PostgresSecurityEventSink(pool()),
  });
  return globalForApp.cdfEvidence;
}

/** Interviews (CDF-60, ADR-012): database commands only; no storage of its own (recordings are evidence). */
export function interviewService(): InterviewService {
  globalForApp.cdfInterviews ??= createInterviewService({
    gateway: new PostgresInterviewGateway(pool()),
    securityEvents: new PostgresSecurityEventSink(pool()),
  });
  return globalForApp.cdfInterviews;
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
