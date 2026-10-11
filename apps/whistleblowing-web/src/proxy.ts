// Per-request CSP nonce and security headers (§50). The portal has no sessions and sets no cookies here.
import { NextResponse, type NextRequest } from "next/server";
import { securityHeaders } from "@cdf/config";
import { restoredFormPostOrigin } from "./server/form-post-origin";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const headers = securityHeaders({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    secure: request.nextUrl.protocol === "https:",
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", headers["Content-Security-Policy"]!);
  // A same-origin form posted without JavaScript arrives with `Origin: null` (see form-post-origin.ts).
  const origin = restoredFormPostOrigin({
    method: request.method,
    pathname: request.nextUrl.pathname,
    protocol: request.nextUrl.protocol,
    headers: request.headers,
  });
  if (origin) requestHeaders.set("origin", origin);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  // Reports and secrets must never be cached by browsers or intermediaries.
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|cdf-logo.png).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
