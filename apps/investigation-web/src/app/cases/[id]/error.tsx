"use client";
// Translated error page for the case segment (UX-080): generic text and the error reference only (§82).
import { CDFRouteError } from "@cdf/ui";

export default function CaseError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <CDFRouteError {...props} home={{ href: "/cases", label: "system.backToCases" }} />;
}
