// LocalDevIdentityProvider: signs synthetic users in without an external identity service, for local
// development and CI only (ADR-009). It refuses to load on Vercel or outside local/test environments.
// PRODUCTION_SUBSTITUTION_REQUIRED: never a production control; production uses the CDF corporate IdP.
import { timingSafeEqual, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { SignJWT, jwtVerify } from "jose";
import type { IdentityProvider, IdentitySession } from "@cdf/application";
import type { CookieJar } from "./cookies";

/** Subjects of the synthetic seed users (infrastructure/supabase/seed/01_synthetic_users.sql). */
export const LOCAL_DEV_USERS: Readonly<Record<string, string>> = {
  "intake@example.test": "a0000000-0000-4000-8000-000000000001",
  "triage@example.test": "a0000000-0000-4000-8000-000000000002",
  "casemanager@example.test": "a0000000-0000-4000-8000-000000000003",
  "investigator.a@example.test": "a0000000-0000-4000-8000-000000000004",
  "investigator.b@example.test": "a0000000-0000-4000-8000-000000000005",
  "lead@example.test": "a0000000-0000-4000-8000-000000000006",
  "committee@example.test": "a0000000-0000-4000-8000-000000000007",
  "grc.director@example.test": "a0000000-0000-4000-8000-000000000008",
  "admin@example.test": "a0000000-0000-4000-8000-000000000009",
  "audit@example.test": "a0000000-0000-4000-8000-000000000010",
  "soc@example.test": "a0000000-0000-4000-8000-000000000011",
  "dpo@example.test": "a0000000-0000-4000-8000-000000000012",
  "revoked@example.test": "a0000000-0000-4000-8000-000000000013",
  "grc.deputy@example.test": "a0000000-0000-4000-8000-000000000014",
  "committee.secretary@example.test": "a0000000-0000-4000-8000-000000000015",
  "committee.chair@example.test": "a0000000-0000-4000-8000-000000000016",
  "records@example.test": "a0000000-0000-4000-8000-000000000019",
  "records.b@example.test": "a0000000-0000-4000-8000-000000000020",
  "legal@example.test": "a0000000-0000-4000-8000-000000000021",
  "legal.b@example.test": "a0000000-0000-4000-8000-000000000022",
};

export const SESSION_COOKIE = "cdf_session";

export interface LocalDevOptions {
  secret: string;
  password: string;
  environment: string;
  isVercel: boolean;
  maxAgeSeconds: number;
  idleSeconds: number;
  cookies: CookieJar;
  secureCookies: boolean;
}

// scrypt is memory-hard, so a leaked comparison key cannot be brute-forced cheaply (CodeQL js/insufficient-password-hash).
const deriveKey = promisify(scrypt) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

export class LocalDevIdentityProvider implements IdentityProvider {
  readonly kind = "local-dev" as const;
  private readonly key: Uint8Array;

  constructor(private readonly options: LocalDevOptions) {
    if (options.isVercel || !["local", "test"].includes(options.environment)) {
      throw new Error("LocalDevIdentityProvider is only available in local and test environments");
    }
    if (options.secret.length < 32) throw new Error("CDF_DEV_IDENTITY_SECRET must be at least 32 characters");
    this.key = new TextEncoder().encode(options.secret);
  }

  async signIn(email: string, password: string): Promise<IdentitySession | null> {
    const subject = LOCAL_DEV_USERS[email.trim().toLowerCase()];
    // Derive both sides with scrypt (salted by the deployment's identity secret) and compare in constant
    // time. Always runs, even for unknown users, so timing reveals neither password length nor which
    // accounts exist (T24).
    const [submitted, expected] = await Promise.all([
      deriveKey(password, this.options.secret, 32),
      deriveKey(this.options.password, this.options.secret, 32),
    ]);
    const passwordOk = timingSafeEqual(submitted, expected);
    if (!subject || !passwordOk) return null;
    const now = Math.floor(Date.now() / 1000);
    await this.issue(subject, now, now);
    return { subject, issuedAt: now };
  }

  async currentSession(): Promise<IdentitySession | null> {
    const token = this.options.cookies.getAll().find((c) => c.name === SESSION_COOKIE)?.value;
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: "cdf-local-dev",
        audience: "cdf-investigation",
      });
      const now = Math.floor(Date.now() / 1000);
      const iat = Number(payload.iat);
      const lastSeen = Number(payload.lst);
      if (!payload.sub || now - iat > this.options.maxAgeSeconds || now - lastSeen > this.options.idleSeconds)
        return null;
      return { subject: payload.sub, issuedAt: iat };
    } catch {
      return null;
    }
  }

  /** Extends the idle window. Call where cookies are writable (proxy, server actions). */
  async touch(session: IdentitySession): Promise<void> {
    await this.issue(session.subject, session.issuedAt, Math.floor(Date.now() / 1000));
  }

  async signOut(): Promise<void> {
    this.options.cookies.set(SESSION_COOKIE, "", {
      path: "/",
      maxAge: 0,
      httpOnly: true,
      sameSite: "strict",
      secure: this.options.secureCookies,
    });
  }

  private async issue(subject: string, issuedAt: number, lastSeen: number) {
    const token = await new SignJWT({ lst: lastSeen })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(subject)
      .setIssuedAt(issuedAt)
      .setIssuer("cdf-local-dev")
      .setAudience("cdf-investigation")
      .setExpirationTime(issuedAt + this.options.maxAgeSeconds)
      .sign(this.key);
    this.options.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.options.secureCookies,
      sameSite: "strict",
      path: "/",
      maxAge: this.options.maxAgeSeconds,
    });
  }
}
