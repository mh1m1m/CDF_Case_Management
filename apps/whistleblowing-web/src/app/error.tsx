"use client";
// Translated error page for the portal (UX-080). Generic text plus the error reference; never the message,
// a stack trace or SQL (§82), and never anything the reporter typed.
import { CDFRouteError } from "@cdf/ui";

export default function RouteError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <CDFRouteError {...props} home={{ href: "/", label: "system.backHome" }} />;
}
