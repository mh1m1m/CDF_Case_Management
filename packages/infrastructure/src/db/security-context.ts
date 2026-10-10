// Per-transaction database security context (ADR-003).
//
// The apps connect as NOINHERIT login roles (cdf_bff / cdf_portal) that hold no privileges of their own.
// Each unit of work runs in one transaction that first assumes `authenticated` or `anon` with SET LOCAL ROLE
// and sets the verified subject as `request.jwt.claims`, the same shape Supabase PostgREST uses, so RLS
// policies and authz.* functions behave identically for server-side SQL and Supabase.
//
// PRODUCTION_SUBSTITUTION_REQUIRED: production (ASP.NET Core on Alibaba RDS) sets the same session
// variables from a token issued by the CDF corporate IdP.
import postgres from "postgres";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PoolOptions {
  /** Max connections. Serverless functions should keep this small. */
  max?: number;
  /** Identifies the app in pg_stat_activity. */
  applicationName: string;
}

export function createPool(connectionString: string, options: PoolOptions): Sql {
  return postgres(connectionString, {
    max: options.max ?? 5,
    idle_timeout: 20,
    connect_timeout: 10,
    // Required for transaction-mode poolers (Supabase Supavisor :6543); harmless elsewhere.
    prepare: false,
    connection: { application_name: options.applicationName },
    // Never echo SQL notices (which may carry data) to stdout.
    onnotice: () => undefined,
  });
}

export interface UserContext {
  /** Verified identity-provider subject. Never taken from user input. */
  userId: string;
  /** Correlation id shown to users on errors and stored on audit events. */
  requestId: string;
}

function assertUuid(value: string, name: string): void {
  if (!UUID.test(value)) throw new Error(`${name} must be a UUID`);
}

/** Runs `fn` in a transaction as `authenticated` with the given subject. */
export async function withUserContext<T>(sql: Sql, ctx: UserContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  assertUuid(ctx.userId, "userId");
  assertUuid(ctx.requestId, "requestId");
  const claims = JSON.stringify({ sub: ctx.userId, role: "authenticated" });
  return sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true), set_config('cdf.request_id', ${ctx.requestId}, true)`;
    await tx`set local role authenticated`;
    return fn(tx);
  }) as Promise<T>;
}

/** Runs `fn` in a transaction as `anon` (public portal, pre-authentication). */
export async function withAnonContext<T>(
  sql: Sql,
  requestId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid(requestId, "requestId");
  return sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', '', true), set_config('cdf.request_id', ${requestId}, true)`;
    await tx`set local role anon`;
    return fn(tx);
  }) as Promise<T>;
}
