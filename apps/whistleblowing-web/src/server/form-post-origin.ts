// UX-002: a portal form submitted without JavaScript is a same-origin POST navigation. Under the portal's
// Referrer-Policy `no-referrer` the browser sends `Origin: null` for it (Fetch, "append a request `Origin`
// header"), and Next.js's Server Action CSRF check rejects a null origin, so the report would fail.
// Fetch Metadata is set by the browser and cannot be forged by a page: `Sec-Fetch-Site: same-origin` with
// `Sec-Fetch-Mode: navigate` means this origin's own page submitted the form. For exactly that case the
// request's own origin is restored before the check runs. Cross-site and same-site posts, fetches, other
// paths, and requests without Fetch Metadata are left unchanged and still face the full check.

/** Pages whose forms post natively (progressive enhancement). */
export const NATIVE_FORM_PATHS: ReadonlySet<string> = new Set(["/report", "/follow-up"]);

export interface FormPostRequest {
  method: string;
  pathname: string;
  /** `http:` or `https:` */
  protocol: string;
  headers: Headers;
}

/** The origin to restore, or null when the request must be left as it is. */
export function restoredFormPostOrigin(request: FormPostRequest): string | null {
  const h = request.headers;
  if (request.method !== "POST" || !NATIVE_FORM_PATHS.has(request.pathname)) return null;
  if (h.get("origin") !== "null") return null;
  if (h.get("sec-fetch-site") !== "same-origin" || h.get("sec-fetch-mode") !== "navigate") return null;
  // The same host Next.js compares the origin with: x-forwarded-host first, then host.
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host");
  return host ? `${request.protocol}//${host}` : null;
}
