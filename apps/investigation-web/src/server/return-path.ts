// The only return targets the app follows after sign-in or a language switch (UX redesign S1, RC-07; DEC-20
// security review). A same-site absolute path made of plain path characters, optionally with a plain query.
// Everything else (another origin, "//host", backslashes, encoded slashes in the path, control characters,
// fragments, the sign-in page itself) falls back to the landing. The target page still re-authorises.
const PATH = /^\/(?![/\\])[\w\-/]*$/;
const QUERY = /^[\w\-=&.%]*$/;
const MAX = 512;

export function safeReturnPath(raw: unknown, fallback = "/"): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX) return fallback;
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? "" : raw.slice(q + 1);
  if (!PATH.test(path) || !QUERY.test(query)) return fallback;
  if (path === "/login" || path.startsWith("/login/") || path === "/locale") return fallback;
  return query ? `${path}?${query}` : path;
}
