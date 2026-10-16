// Composition root for the investigation app. Server-only: holds the cdf_bff connection.
import "server-only";
import { cache } from "react";
import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { join } from "node:path";
import {
  createCaseStructureService,
  createCommitteeProceedingsService,
  createCommitteesService,
  createEvidenceService,
  createFormsService,
  createInboxService,
  createInterviewService,
  createInvestigationService,
  createMeetingsService,
  createRecordsService,
  type CaseStructureService,
  type CommitteeProceedingsService,
  type CommitteesService,
  type EvidenceService,
  type EvidenceStorage,
  type FormsService,
  type InboxService,
  type InterviewService,
  type InvestigationService,
  type MeetingsService,
  type RecordsService,
} from "@cdf/application";
import { shellAreas } from "@cdf/authorization";
import type { Actor, MyArea } from "@cdf/contracts";
import {
  LocalFilesystemEvidenceStorage,
  MockMalwareScanner,
  PostgresCaseStructureGateway,
  PostgresCommitteeProceedingsGateway,
  PostgresCommitteesGateway,
  PostgresEvidenceGateway,
  PostgresFormsGateway,
  PostgresInboxGateway,
  PostgresInterviewGateway,
  PostgresInvestigationGateway,
  PostgresMeetingsGateway,
  PostgresRecordsGateway,
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
  cdfForms?: FormsService;
  cdfInterviews?: InterviewService;
  cdfRecords?: RecordsService;
  cdfInbox?: InboxService;
  cdfCaseStructure?: CaseStructureService;
  cdfMeetings?: MeetingsService;
  cdfCommittees?: CommitteesService;
  cdfCommitteeProceedings?: CommitteeProceedingsService;
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

export function formsService(): FormsService {
  globalForApp.cdfForms ??= createFormsService({
    gateway: new PostgresFormsGateway(pool()),
    securityEvents: new PostgresSecurityEventSink(pool()),
  });
  return globalForApp.cdfForms;
}

/** Interviews (CDF-60, ADR-012): database commands only; no storage of its own (recordings are evidence). */
export function interviewService(): InterviewService {
  globalForApp.cdfInterviews ??= createInterviewService({
    gateway: new PostgresInterviewGateway(pool()),
    securityEvents: new PostgresSecurityEventSink(pool()),
  });
  return globalForApp.cdfInterviews;
}

/** Records, retention and legal hold (CDF-71, ADR-013/014): database commands only; no deletion path. */
export function recordsService(): RecordsService {
  globalForApp.cdfRecords ??= createRecordsService({
    gateway: new PostgresRecordsGateway(pool()),
    securityEvents: new PostgresSecurityEventSink(pool()),
  });
  return globalForApp.cdfRecords;
}

/** The caller's own in-app notifications and settings (UX redesign S4, ADR-025): RLS returns only their own rows. */
export function inboxService(): InboxService {
  globalForApp.cdfInbox ??= createInboxService({
    gateway: new PostgresInboxGateway(pool()),
    securityEvents: new PostgresSecurityEventSink(pool()),
  });
  return globalForApp.cdfInbox;
}

/** Proceedings, subjects, allegations, findings and committee referral (ADR-017 to ADR-019; Phase 12 P12-1). */
export function caseStructureService(): CaseStructureService {
  globalForApp.cdfCaseStructure ??= createCaseStructureService({
    gateway: new PostgresCaseStructureGateway(pool()),
    securityEvents: new PostgresSecurityEventSink(pool()),
  });
  return globalForApp.cdfCaseStructure;
}

/** The committee's meeting and minutes screens (ADR-054; Phase 12 P12-2a): purpose read models and commands only. */
export function meetingsService(): MeetingsService {
  globalForApp.cdfMeetings ??= createMeetingsService({
    gateway: new PostgresMeetingsGateway(pool()),
    securityEvents: new PostgresSecurityEventSink(pool()),
  });
  return globalForApp.cdfMeetings;
}

/** My Committees and the committee's page (ADR-055; Phase 12 P12-2b): the seat basis's read models and commands only. */
export function committeesService(): CommitteesService {
  globalForApp.cdfCommittees ??= createCommitteesService({
    gateway: new PostgresCommitteesGateway(pool()),
    securityEvents: new PostgresSecurityEventSink(pool()),
  });
  return globalForApp.cdfCommittees;
}

/**
 * The proceeding before the committee (ADR-056; Phase 12 P12-2c): the seat basis's read models, R1, R2 and the
 * package commands only.
 */
export function committeeProceedingsService(): CommitteeProceedingsService {
  globalForApp.cdfCommitteeProceedings ??= createCommitteeProceedingsService({
    committees: new PostgresCommitteesGateway(pool()),
    gateway: new PostgresCommitteeProceedingsGateway(pool()),
    securityEvents: new PostgresSecurityEventSink(pool()),
  });
  return globalForApp.cdfCommitteeProceedings;
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

/**
 * The caller's sidebar areas for this request (api.my_areas() after the application floor), read once and shared by
 * the shell and the pages that gate on an area. Explains access; each page's own reads still enforce it.
 */
export const myShellAreas = cache(async (): Promise<MyArea[]> => {
  const { actor, ctx } = await requireActor();
  return shellAreas(actor, await investigationService().myAreas(ctx));
});

/** The caller's unread in-app notifications for this request, read once for the header bell. */
export const myUnreadCount = cache(async (): Promise<number> => {
  const { ctx } = await requireActor();
  return inboxService().unreadCount(ctx);
});
