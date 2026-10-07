/** Framework-neutral cookie access, provided by the app (Next.js cookies() / proxy request+response). */
export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax";
  path?: string;
  maxAge?: number;
}
export interface CookieJar {
  getAll(): { name: string; value: string }[];
  set(name: string, value: string, options: CookieOptions): void;
}
