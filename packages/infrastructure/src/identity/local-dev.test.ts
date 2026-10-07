import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalDevIdentityProvider, SESSION_COOKIE, type LocalDevOptions } from "./local-dev";

function jar() {
  const store = new Map<string, string>();
  return {
    store,
    getAll: () => [...store].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, o: { maxAge?: number }) =>
      o.maxAge === 0 ? store.delete(name) : store.set(name, value),
  };
}
const options = (over: Partial<LocalDevOptions> = {}): LocalDevOptions => ({
  secret: "s".repeat(32),
  password: "Synthetic-Password-1",
  environment: "local",
  isVercel: false,
  maxAgeSeconds: 3600,
  idleSeconds: 600,
  cookies: jar(),
  secureCookies: false,
  ...over,
});

afterEach(() => vi.useRealTimers());

describe("LocalDevIdentityProvider", () => {
  it("refuses to load on Vercel or outside local/test (threat T22)", () => {
    expect(() => new LocalDevIdentityProvider(options({ isVercel: true }))).toThrow();
    expect(() => new LocalDevIdentityProvider(options({ environment: "demo" }))).toThrow();
  });

  it("signs in synthetic users only, with the right password", async () => {
    const idp = new LocalDevIdentityProvider(options());
    expect(await idp.signIn("triage@example.test", "wrong")).toBeNull();
    expect(await idp.signIn("someone@cdf.gov.sa", "Synthetic-Password-1")).toBeNull();
    const session = await idp.signIn("TRIAGE@example.test", "Synthetic-Password-1");
    expect(session?.subject).toBe("a0000000-0000-4000-8000-000000000002");
    expect((await idp.currentSession())?.subject).toBe(session?.subject);
  });

  it("rejects tampered tokens", async () => {
    const o = options();
    const idp = new LocalDevIdentityProvider(o);
    await idp.signIn("triage@example.test", "Synthetic-Password-1");
    const c = o.cookies as ReturnType<typeof jar>;
    const token = c.store.get(SESSION_COOKIE)!;
    const [h, p, s] = token.split(".");
    const forged = JSON.parse(Buffer.from(p!, "base64url").toString());
    forged.sub = "a0000000-0000-4000-8000-000000000008";
    c.store.set(SESSION_COOKIE, `${h}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${s}`);
    expect(await idp.currentSession()).toBeNull();
  });

  it("expires idle sessions and extends active ones", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T08:00:00Z"));
    const idp = new LocalDevIdentityProvider(options());
    const session = (await idp.signIn("triage@example.test", "Synthetic-Password-1"))!;
    vi.setSystemTime(new Date("2026-10-07T08:09:00Z"));
    await idp.touch(session);
    vi.setSystemTime(new Date("2026-10-07T08:18:00Z"));
    expect(await idp.currentSession()).not.toBeNull();
    vi.setSystemTime(new Date("2026-10-07T08:29:00Z"));
    expect(await idp.currentSession()).toBeNull();
  });
});
