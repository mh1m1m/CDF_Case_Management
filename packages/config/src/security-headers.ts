/**
 * HTTP security headers shared by both apps (§50, threats T14, T15). Applied in each app's proxy so a
 * fresh CSP nonce is generated per request.
 */
export interface SecurityHeaderOptions {
  nonce: string;
  isDev: boolean;
  /** HTTPS deployment (Vercel). Adds HSTS and upgrade-insecure-requests. */
  secure: boolean;
}

export function contentSecurityPolicy({ nonce, isDev, secure }: SecurityHeaderOptions): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    secure ? "upgrade-insecure-requests" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function securityHeaders(options: SecurityHeaderOptions): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(options),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...(options.secure ? { "Strict-Transport-Security": "max-age=63072000; includeSubDomains" } : {}),
  };
}
