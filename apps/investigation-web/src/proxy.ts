// Per-request CSP nonce, security headers, sign-in gate and idle-session refresh (§46, §50).
// The gate here only routes; every page and action re-verifies the session and loads the actor from the database.
import { NextResponse, type NextRequest } from "next/server";
import { loadInvestigationServerEnv, securityHeaders } from "@cdf/config";
import { identityProvider } from "./server/identity";

const PUBLIC_PATHS = ["/login", "/locale"];

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const secure = request.nextUrl.protocol === "https:";
  const headers = securityHeaders({ nonce, isDev: process.env.NODE_ENV === "development", secure });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", headers["Content-Security-Policy"]!);

  let response = NextResponse.next({ request: { headers: requestHeaders } });
  const jar = {
    getAll: () => request.cookies.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name: string, value: string, options: object) => response.cookies.set(name, value, options),
  };
  const idp = identityProvider(loadInvestigationServerEnv(), jar, secure);
  const session = await idp.currentSession();

  const isPublic = PUBLIC_PATHS.some(
    (p) => request.nextUrl.pathname === p || request.nextUrl.pathname.startsWith(`${p}/`),
  );
  if (!session && !isPublic) {
    response = NextResponse.redirect(new URL("/login", request.url), 303);
  } else if (session && idp.touch) {
    await idp.touch(session);
  }

  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
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
