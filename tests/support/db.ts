// Test harness for database security and integration tests.
// Connects exactly like the apps do: cdf_bff (→ authenticated) and cdf_portal (→ anon), never as the owner,
// except `admin` which only inspects catalogs and verifies results.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll } from "vitest";
import { createPool, type Sql, type Tx } from "@cdf/infrastructure";

const host = process.env.CDF_TEST_DB_HOST ?? "127.0.0.1";
const port = process.env.CDF_TEST_DB_PORT ?? "54322";
const db = process.env.CDF_TEST_DB_NAME ?? "postgres";
const url = (user: string, pwVar: string) => {
  const pw = process.env[pwVar];
  return `postgresql://${user}${pw ? `:${encodeURIComponent(pw)}` : ""}@${host}:${port}/${db}`;
};

export const bff: Sql = createPool(
  process.env.CDF_BFF_DATABASE_URL ?? url("cdf_bff", "CDF_BFF_DB_PASSWORD"),
  {
    applicationName: "cdf-tests-bff",
  },
);
export const portal: Sql = createPool(
  process.env.CDF_PORTAL_DATABASE_URL ?? url("cdf_portal", "CDF_PORTAL_DB_PASSWORD"),
  {
    applicationName: "cdf-tests-portal",
  },
);
/** Owner connection: catalog inspection and assertions only. */
export const admin: Sql = postgres(
  process.env.CDF_ADMIN_DATABASE_URL ?? url("postgres", "CDF_ADMIN_DB_PASSWORD"),
  {
    max: 2,
    onnotice: () => undefined,
  },
);

afterAll(async () => {
  await Promise.all([bff.end(), portal.end(), admin.end()]);
});

/** Synthetic users from infrastructure/supabase/seed/01_synthetic_users.sql. */
export const USERS = {
  intake: "a0000000-0000-4000-8000-000000000001",
  triage: "a0000000-0000-4000-8000-000000000002",
  caseManager: "a0000000-0000-4000-8000-000000000003",
  investigatorA: "a0000000-0000-4000-8000-000000000004",
  investigatorB: "a0000000-0000-4000-8000-000000000005",
  lead: "a0000000-0000-4000-8000-000000000006",
  committee: "a0000000-0000-4000-8000-000000000007",
  grcDirector: "a0000000-0000-4000-8000-000000000008",
  platformAdmin: "a0000000-0000-4000-8000-000000000009",
  internalAudit: "a0000000-0000-4000-8000-000000000010",
  soc: "a0000000-0000-4000-8000-000000000011",
  dpo: "a0000000-0000-4000-8000-000000000012",
  revoked: "a0000000-0000-4000-8000-000000000013",
  grcDeputy: "a0000000-0000-4000-8000-000000000014",
} as const;
export type UserKey = keyof typeof USERS;

export async function caseId(caseNumberSuffix: string): Promise<string> {
  const [row] = await admin<
    { id: string }[]
  >`select id from case_mgmt.case_record where case_number like ${"CDF-DEMO-%-" + caseNumberSuffix}`;
  if (!row) throw new Error(`seed case ${caseNumberSuffix} missing; run pnpm db:reset`);
  return row.id;
}

export async function reportId(ref: string): Promise<string> {
  const [row] = await admin<{ id: string }[]>`select id from intake.report where report_ref = ${ref}`;
  if (!row) throw new Error(`seed report ${ref} missing; run pnpm db:reset`);
  return row.id;
}

class Rollback extends Error {}

export interface Scenario {
  tx: Tx;
  /** Switch the acting user (or anonymous with null) inside the same transaction. */
  as(user: UserKey | null): Promise<void>;
  /** Run a statement that must fail with the given CDF error prefix; the transaction stays usable. */
  expectError(prefix: string, fn: (tx: Tx) => Promise<unknown>): Promise<void>;
}

/**
 * Runs a multi-actor scenario on the BFF connection in one transaction and rolls it back,
 * so tests never leak state into each other or the seed.
 */
export async function scenario(fn: (s: Scenario) => Promise<void>): Promise<void> {
  try {
    await bff.begin(async (tx) => {
      await tx`select set_config('cdf.request_id', ${randomUUID()}, true)`;
      const s: Scenario = {
        tx,
        async as(user) {
          await tx`reset role`;
          await tx`select set_config('request.jwt.claims', ${user ? JSON.stringify({ sub: USERS[user], role: "authenticated" }) : ""}, true)`;
          await tx.unsafe(user ? "set local role authenticated" : "set local role anon");
        },
        async expectError(prefix, run) {
          let message: string | undefined;
          try {
            await tx.savepoint(async (sp) => {
              await run(sp as unknown as Tx);
            });
          } catch (error) {
            message = (error as Error).message;
          }
          if (message === undefined)
            throw new Error(`expected an error starting with ${prefix}, but the statement succeeded`);
          if (!message.startsWith(prefix))
            throw new Error(`expected an error starting with ${prefix}, got: ${message}`);
        },
      };
      await fn(s);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

/** Same as scenario() but on the portal connection, which can only ever be anon. */
export async function portalScenario(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await portal.begin(async (tx) => {
      await tx`select set_config('cdf.request_id', ${randomUUID()}, true)`;
      await tx`set local role anon`;
      await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

// ---- Portal credentials (mirror of the portal's PrototypeKeyProvider) ---------------------
const TEST_PEPPER = "test-only-pepper-not-a-secret-0123456789";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newReportRef(): string {
  const bytes = randomBytes(12);
  return "WB-" + Array.from(bytes, (b) => CROCKFORD[b % 32]).join("");
}
export function newSecret(): string {
  return randomBytes(24).toString("base64url");
}
export function secretHmac(secret: string): string {
  return createHmac("sha256", TEST_PEPPER).update(secret, "utf8").digest("hex");
}
