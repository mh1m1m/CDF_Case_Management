// Switches the interface language. Only same-site relative paths are accepted as the return target.
import { NextResponse, type NextRequest } from "next/server";
import { isLocale } from "@cdf/i18n";

export function GET(request: NextRequest) {
  const to = request.nextUrl.searchParams.get("to");
  const next = request.nextUrl.searchParams.get("next") ?? "/";
  const safeNext = /^\/(?!\/)[\w\-/]*$/.test(next) ? next : "/";
  const response = NextResponse.redirect(new URL(safeNext, request.url), 303);
  if (isLocale(to)) {
    response.cookies.set("cdf_locale", to, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 31_536_000,
      secure: request.nextUrl.protocol === "https:",
    });
  }
  return response;
}
