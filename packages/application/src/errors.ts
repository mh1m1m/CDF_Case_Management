import type { AppErrorKind } from "@cdf/contracts";

/**
 * The only error type that crosses from the application layer to the apps (§82).
 * `detail` is a stable machine code (e.g. a field name or blocking-condition code), never database text.
 */
export class AppError extends Error {
  override name = "AppError";
  constructor(
    readonly kind: AppErrorKind,
    readonly correlationId: string,
    readonly detail?: string,
    /** Original error for server-side diagnostics only; never serialised to the client. */
    options?: { cause?: unknown },
  ) {
    super(detail ? `${kind}:${detail}` : kind, options);
  }
}

const DB_CODE = /^CDF_(UNAUTHENTICATED|NOT_FOUND|FORBIDDEN|INVALID|CONFLICT)(?::([A-Za-z0-9_.:-]{0,80}))?$/;

/** Maps an error thrown by a database command to a safe AppError. Unknown errors become UNAVAILABLE. */
export function toAppError(error: unknown, correlationId: string): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : "";
  const match = DB_CODE.exec(message);
  if (match) return new AppError(match[1] as AppErrorKind, correlationId, match[2] || undefined);
  // Raw privilege errors mean the DB boundary caught something the pre-check did not.
  if (/permission denied/i.test(message)) return new AppError("FORBIDDEN", correlationId);
  return new AppError("UNAVAILABLE", correlationId, undefined, { cause: error });
}
