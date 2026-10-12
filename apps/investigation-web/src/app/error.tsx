"use client";
// Translated error page for a failure outside both route groups (UX-080); it has no chrome to sit in. Generic text plus the error reference;
// never the message, a stack trace or SQL (§82).
import { CDFRouteError } from "@cdf/ui";

export default function RouteError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-6">
      <CDFRouteError {...props} home={{ href: "/", label: "system.backHome" }} />
    </main>
  );
}
