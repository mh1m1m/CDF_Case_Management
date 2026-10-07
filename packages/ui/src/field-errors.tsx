"use client";
import { createContext, useContext, type ReactNode } from "react";

/**
 * Server-side field errors keyed by control id, provided by a form (e.g. the investigation app's ActionForm)
 * so `CDFField` can render each message next to its control (WCAG 3.3.1). Messages arrive already translated.
 */
const FieldErrorsContext = createContext<Readonly<Record<string, string>>>({});

export function CDFFieldErrorsProvider({
  errors,
  children,
}: {
  errors: Readonly<Record<string, string>>;
  children: ReactNode;
}) {
  return <FieldErrorsContext.Provider value={errors}>{children}</FieldErrorsContext.Provider>;
}

/** Inline error for one control; renders nothing unless the surrounding form reported an error for `id`. */
export function CDFFieldError({ id }: { id: string }) {
  const message = useContext(FieldErrorsContext)[id];
  if (!message) return null;
  return (
    <p id={`${id}-error`} className="mt-1 text-sm font-semibold text-cdf-danger">
      {message}
    </p>
  );
}
