// The only return targets the app follows after sign-in or a language switch (UX redesign S1, RC-07; DEC-20
// security review). A same-site absolute path made of plain path characters, optionally with a plain query.
// Everything else (another origin, "//host", backslashes, encoded slashes in the path, control characters,
// fragments, the sign-in page itself) falls back to the landing. The target page still re-authorises.
const PATH = /^\/(?![/\\])[\w\-/]*$/;
const QUERY = /^[\w\-=&.%]*$/;
const MAX = 512;

function check(raw: unknown, allowSignIn: boolean): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX) return null;
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? "" : raw.slice(q + 1);
  if (!PATH.test(path) || !QUERY.test(query)) return null;
  if (path === "/locale" || path.startsWith("/locale/")) return null;
  if (!allowSignIn && (path === "/login" || path.startsWith("/login/"))) return null;
  return query ? `${path}?${query}` : path;
}

/** Where to go after signing in. */
export function safeReturnPath(raw: unknown, fallback = "/"): string {
  return check(raw, false) ?? fallback;
}

/** Where to go back to after a language switch: the same page and view, the sign-in page included. */
export function safeLocaleReturnPath(raw: unknown): string {
  return check(raw, true) ?? "/";
}
