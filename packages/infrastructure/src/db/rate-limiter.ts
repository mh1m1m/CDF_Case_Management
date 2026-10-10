// RateLimiter over PostgreSQL (public_api.consume_rate_limit and consume_rate_limit_amount).
// PRODUCTION_SUBSTITUTION_REQUIRED: the edge WAF / API gateway enforces limits in production.
import type { RateLimiter } from "@cdf/application";
import { randomUUID } from "node:crypto";
import { withAnonContext, type Sql } from "./security-context";

export class PostgresRateLimiter implements RateLimiter {
  constructor(private readonly sql: Sql) {}

  async consume(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
    return withAnonContext(this.sql, randomUUID(), async (tx) => {
      const [row] = await tx<
        { ok: boolean }[]
      >`select public_api.consume_rate_limit(${bucket}, ${limit}, ${windowSeconds}) as ok`;
      return row?.ok === true;
    });
  }

  async consumeAmount(
    bucket: string,
    amount: number,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean> {
    return withAnonContext(this.sql, randomUUID(), async (tx) => {
      const [row] = await tx<{ ok: boolean }[]>`
        select public_api.consume_rate_limit_amount(${bucket}, ${amount}, ${limit}, ${windowSeconds}) as ok`;
      return row?.ok === true;
    });
  }
}
