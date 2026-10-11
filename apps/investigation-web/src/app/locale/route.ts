// Switches the interface language and returns to the same page and view (safeLocaleReturnPath).
import { NextResponse, type NextRequest } from "next/server";
import { isLocale } from "@cdf/i18n";
import { safeLocaleReturnPath } from "@/server/return-path";

export function GET(request: NextRequest) {
  const to = request.nextUrl.searchParams.get("to");
  const safeNext = safeLocaleReturnPath(request.nextUrl.searchParams.get("next"));
  // A relative Location keeps the browser on the host it used. An absolute URL built from request.url can name
  // the server's own bind address (localhost) instead, where the session cookie is not sent.
  const response = new NextResponse(null, { status: 303, headers: { Location: safeNext } });
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
