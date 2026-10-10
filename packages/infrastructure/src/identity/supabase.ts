// SupabaseIdentityProvider: Supabase Auth with httpOnly cookies managed server-side (ADR-009).
// Only the anon key is used here; the service-role key is never needed for sign-in (§46).
// PRODUCTION_SUBSTITUTION_REQUIRED: production uses the CDF corporate IdP (OIDC/SAML).
import { createServerClient } from "@supabase/ssr";
import type { IdentityProvider, IdentitySession } from "@cdf/application";
import type { CookieJar } from "./cookies";

export class SupabaseIdentityProvider implements IdentityProvider {
  readonly kind = "supabase" as const;

  constructor(
    private readonly url: string,
    private readonly anonKey: string,
    private readonly cookies: CookieJar,
  ) {}

  private client() {
    return createServerClient(this.url, this.anonKey, {
      cookies: {
        getAll: () => this.cookies.getAll(),
        setAll: (items) => {
          for (const { name, value, options } of items) {
            this.cookies.set(name, value, {
              ...options,
              httpOnly: true,
              sameSite: "lax",
              path: "/",
            } as never);
          }
        },
      },
    });
  }

  async signIn(email: string, password: string): Promise<IdentitySession | null> {
    const { data, error } = await this.client().auth.signInWithPassword({ email, password });
    if (error || !data.user) return null;
    return { subject: data.user.id, issuedAt: Math.floor(Date.now() / 1000) };
  }

  async currentSession(): Promise<IdentitySession | null> {
    // getUser() validates the token with the Auth server; never trust an unvalidated session cookie.
    const { data, error } = await this.client().auth.getUser();
    if (error || !data.user) return null;
    return {
      subject: data.user.id,
      issuedAt: Math.floor(new Date(data.user.last_sign_in_at ?? Date.now()).getTime() / 1000),
    };
  }

  async signOut(): Promise<void> {
    await this.client().auth.signOut();
  }
}
