"use client";
// Translated error page for any failure below the root layout (UX-080). Generic text plus the error reference;
// never the message, a stack trace or SQL (§82).
import { CDFRouteError } from "@cdf/ui";

export default function RouteError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <CDFRouteError {...props} home={{ href: "/", label: "system.backHome" }} />;
}
