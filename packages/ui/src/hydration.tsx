"use client";
// CDF-255: a server-action form sent before the page is interactive is posted by the browser itself. The
// investigation app sends no referrer (Referrer-Policy: no-referrer), so the browser marks such a post `Origin: null`,
// and Next.js refuses it as a cross-site request with a bare error page. Every submit there therefore waits until the
// page is interactive. The server's origin check is unchanged: a cross-origin post is still refused.
import { useSyncExternalStore, type ReactNode } from "react";

const noSubscription = () => () => undefined;

/** False in the server-rendered markup and during hydration, true once the page is interactive. */
export const useHydrated = (): boolean =>
  useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );

/**
 * The submit button of a server-action form that is not a CDFCommandForm (CDF-255). It stays disabled until the page
 * is interactive, so the browser never posts the form on its own; a disabled default button also blocks submitting
 * with Enter. With JavaScript off it stays disabled, and the app's no-script notice says why.
 */
export function CDFSubmitButton(props: { className: string; testId?: string; children: ReactNode }) {
  const hydrated = useHydrated();
  return (
    <button type="submit" className={props.className} disabled={!hydrated} data-testid={props.testId}>
      {props.children}
    </button>
  );
}
