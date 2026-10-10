import { describe, expect, it } from "vitest";
import { isDeniedKey, scrubBreadcrumb, scrubData, scrubSentryEvent, scrubString } from "./scrub";

// SYNTHETIC test data only (CLAUDE.md §1).
// Assembled from groups so secret scanners do not mistake the synthetic value for a credential.
const SECRET = ["7K3M", "Q9TZ", "4HXW", "B2RC", "N8PD"].join("-");
const REF = "WB-7K3MQ9TZ4HXW";
const AR_NARRATIVE = "قام الموظف ألفا بتحويل مبلغ إلى حساب شخصي دون موافقة";
const EN_NARRATIVE = "Employee Alpha moved funds to a personal account without approval";

// Same shapes as @cdf/domain generateReportRef / generateReporterSecret (not a dependency here).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const randomCrockford = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => CROCKFORD[b & 31]).join("");
const generateReportRef = () => `WB-${randomCrockford(12)}`;
const generateReporterSecret = () => randomCrockford(20).match(/.{4}/g)!.join("-");

const serialised = (v: unknown) => JSON.stringify(v);

describe("scrubString", () => {
  it.each([
    ["email", "contact witness.gamma@example.test now", "witness.gamma@example.test"],
    ["reporter secret (grouped)", `secret was ${SECRET}`, SECRET],
    ["reporter secret (compact)", "secret was 7K3MQ9TZ4HXWB2RCN8PD", "7K3MQ9TZ4HXWB2RCN8PD"],
    ["report reference", `lookup ${REF} failed`, REF],
    ["report reference (lower case)", "lookup wb-7k3mq9tz4hxw failed", "wb-7k3mq9tz4hxw"],
    ["Saudi national ID", "national id 1012345678 rejected", "1012345678"],
    ["Iqama", "iqama 2012345678 rejected", "2012345678"],
    ["international phone", "call +966 50 000 0001", "000 0001"],
    ["00-prefixed phone", "call 00966500000002", "00966500000002"],
    ["Saudi mobile", "call 0500000003", "0500000003"],
    ["Saudi mobile with separators", "call 050-000-0004", "050-000-0004"],
    ["IPv4", "client 203.0.113.7 blocked", "203.0.113.7"],
    ["IPv6", "client 2001:db8::7 blocked", "2001:db8::7"],
    ["full IPv6", "client 2001:0db8:0000:0000:0000:0000:0000:0007 blocked", "0db8"],
    ["bearer token", "Authorization: Bearer abc.def-ghi_123", "abc.def-ghi_123"],
    ["JWT", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl seen", "eyJhbGciOiJIUzI1NiJ9"],
    ["credential pair", "failed with password=hunter2-synthetic", "hunter2-synthetic"],
    ["quoted credential pair", 'config {"access_token": "tok-synthetic"}', "tok-synthetic"],
    ["URL query string", "GET /follow-up?ref=abc&secret=xyz 500", "ref=abc"],
    ["HMAC digest", `hmac ${"ab".repeat(32)} mismatch`, "ab".repeat(32)],
    ["Arabic narrative", `failed to save: ${AR_NARRATIVE}`, "الموظف"],
  ])("removes %s", (_label, input, leaked) => {
    const out = scrubString(input);
    expect(out).not.toContain(leaked);
    expect(out).toContain("[REDACTED:");
  });

  it("removes generated report references and secrets", () => {
    for (let i = 0; i < 50; i++) {
      const ref = generateReportRef();
      const secret = generateReporterSecret();
      const out = scrubString(`status ${ref} ${secret} ${secret.replace(/-/g, "")}`);
      expect(out).not.toContain(ref);
      expect(out).not.toContain(secret);
      expect(out).not.toContain(secret.replace(/-/g, ""));
    }
  });

  it("keeps technical text intact", () => {
    for (const text of [
      "TypeError: Cannot read properties of undefined (reading 'id')",
      "case a0000000-0000-4000-8000-000000000001 not found",
      "at handler (/var/task/apps/investigation-web/.next/server/chunk.js:12:345)",
      "timeout after 30000ms at 12:30:45",
      "CDF_NOT_FOUND",
      "GET /cases/[id] 404",
    ]) {
      expect(scrubString(text)).toBe(text);
    }
  });
});

describe("isDeniedKey", () => {
  it.each([
    "description",
    "subject_description",
    "subjectDescription",
    "Subject-Description",
    "fullName",
    "email",
    "phone",
    "national_id",
    "secret",
    "secretHmac",
    "reportRef",
    "access_token",
    "Set-Cookie",
    "Authorization",
    "x-forwarded-for",
    "ip_address",
    "SUPABASE_SERVICE_ROLE_KEY",
    "REPORT_SECRET_PEPPER",
    "originalFileName",
  ])("denies %s", (key) => expect(isDeniedKey(key)).toBe(true));

  it.each(["status_code", "method", "route", "correlationId", "name", "version", "caseId"])(
    "allows %s",
    (key) => expect(isDeniedKey(key)).toBe(false),
  );
});

function syntheticEvent() {
  return {
    event_id: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    timestamp: 1_760_000_000.123,
    level: "error",
    platform: "node",
    release: "cd0776a",
    environment: "dev",
    server_name: "cdf-whistleblowing",
    sdk: { name: "sentry.javascript.nextjs", version: "0.0.0-synthetic" },
    message: { message: `could not file ${REF}`, params: [SECRET] },
    exception: {
      values: [
        {
          type: "Error",
          value: `submit failed for witness.gamma@example.test: ${AR_NARRATIVE}`,
          mechanism: { type: "onerror", handled: false, data: { description: EN_NARRATIVE } },
          stacktrace: {
            frames: [
              {
                filename: "app:///apps/whistleblowing-web/src/app/report/actions.ts",
                function: "submitReportAction",
                lineno: 42,
                colno: 7,
                context_line: `const secret = "${SECRET}";`,
                vars: { description: EN_NARRATIVE, secret: SECRET },
              },
            ],
          },
        },
      ],
    },
    request: {
      method: "POST",
      url: `https://cdf-whistleblowing.example.test/follow-up?ref=${REF}&secret=${SECRET}#top`,
      query_string: `ref=${REF}&secret=${SECRET}`,
      cookies: { "cdf-session": "synthetic-session-value" },
      data: { description: AR_NARRATIVE, identity: { fullName: "Employee Alpha" } },
      env: { REMOTE_ADDR: "203.0.113.7" },
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: "cdf-session=synthetic-session-value",
        Authorization: "Bearer synthetic-token",
        "X-Forwarded-For": "203.0.113.7",
        "User-Agent": "Mozilla/5.0 (synthetic)",
        "X-Correlation-Id": "corr-0001",
      },
    },
    user: { id: "u-1", email: "investigator.beta@example.test", ip_address: "203.0.113.7" },
    tags: { route: "/report", reportRef: REF, locale: "ar" },
    extra: {
      subjectDescription: EN_NARRATIVE,
      form: { description: AR_NARRATIVE, phone: "+966500000001", category: "FRAUD" },
      note: "free text",
      attempt: 2,
      correlationId: "corr-0001",
    },
    contexts: {
      runtime: { name: "node", version: "v22.12.0" },
      app: { reporter_email: "witness.gamma@example.test" },
    },
    breadcrumbs: {
      values: [
        {
          category: "fetch",
          type: "http",
          timestamp: 1_760_000_000,
          data: { method: "GET", url: `/api/status?secret=${SECRET}`, status_code: 500 },
        },
        { category: "navigation", data: { from: "/report?draft=1", to: `/follow-up?ref=${REF}` } },
        { category: "console", level: "log", message: `reporter phone 0500000003 ${AR_NARRATIVE}` },
      ],
    },
    spans: [
      {
        op: "db",
        description: "select * from x where email = 'witness.gamma@example.test'",
        data: { body: "x" },
      },
    ],
    fingerprint: ["{{ default }}", REF],
  };
}

const LEAKS = [
  SECRET,
  SECRET.replace(/-/g, ""),
  REF,
  "witness.gamma@example.test",
  "investigator.beta@example.test",
  "203.0.113.7",
  "500000001",
  "0500000003",
  "Employee Alpha",
  "الموظف",
  "moved funds",
  "synthetic-session-value",
  "synthetic-token",
  "free text",
  "Mozilla",
];

describe("scrubSentryEvent", () => {
  it("removes every personal, case and credential value", () => {
    const out = serialised(scrubSentryEvent(syntheticEvent()));
    for (const leak of LEAKS) expect(out, leak).not.toContain(leak);
  });

  it("removes Arabic and English narrative fields", () => {
    const out = scrubSentryEvent(syntheticEvent());
    expect(out.extra).toEqual({ correlationId: "corr-0001" });
    expect(out.request.data).toBe("[REDACTED:field]");
    expect(out.exception.values[0]!.value).toBe("submit failed for [REDACTED:email]: [REDACTED:text]");
  });

  it("drops the user, cookies, request body, query string, env and non-allowed headers", () => {
    const out = scrubSentryEvent(syntheticEvent()) as Record<string, unknown>;
    expect(out).not.toHaveProperty("user");
    const request = out.request as Record<string, unknown>;
    expect(request.url).toBe("https://cdf-whistleblowing.example.test/follow-up");
    expect(request.cookies).toBe("[REDACTED:field]");
    expect(request.query_string).toBe("[REDACTED:field]");
    expect(request.env).toBe("[REDACTED:field]");
    expect(request.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Correlation-Id": "corr-0001",
    });
  });

  it("drops frame variables and format parameters", () => {
    const out = scrubSentryEvent(syntheticEvent());
    const frame = out.exception.values[0]!.stacktrace.frames[0]!;
    expect(frame.vars).toBe("[REDACTED:field]");
    expect(frame.context_line).toBe("const secret = [REDACTED:credential];");
    expect(out.message.params).toBe("[REDACTED:field]");
  });

  it("keeps URL paths in breadcrumbs but not their query strings", () => {
    const out = scrubSentryEvent(syntheticEvent());
    const [fetch, nav] = out.breadcrumbs.values;
    expect(fetch!.data).toEqual({ method: "GET", status_code: 500, url: "/api/status" });
    expect(nav!.data).toEqual({ from: "/report", to: "/follow-up" });
  });

  it("preserves the event structure and technical metadata", () => {
    const input = syntheticEvent();
    const out = scrubSentryEvent(input);
    const { user: _user, ...withoutUser } = input;
    expect(Object.keys(out).sort()).toEqual(Object.keys(withoutUser).sort());
    for (const key of [
      "event_id",
      "timestamp",
      "level",
      "platform",
      "release",
      "environment",
      "server_name",
    ] as const) {
      expect(out[key]).toEqual(input[key]);
    }
    expect(out.sdk).toEqual(input.sdk);
    const frame = out.exception.values[0]!.stacktrace.frames[0]!;
    expect(frame.filename).toBe(input.exception.values[0]!.stacktrace.frames[0]!.filename);
    expect(frame.function).toBe("submitReportAction");
    expect(frame.lineno).toBe(42);
    expect(out.exception.values[0]!.type).toBe("Error");
    expect(out.exception.values[0]!.mechanism.handled).toBe(false);
    expect(out.contexts.runtime).toEqual({ name: "node", version: "v22.12.0" });
    expect(out.tags.route).toBe("/report");
    expect(out.tags.locale).toBe("ar");
    expect(out.extra.correlationId).toBe("corr-0001");
    expect(out.breadcrumbs.values).toHaveLength(3);
  });

  it("does not mutate its input", () => {
    const input = syntheticEvent();
    const before = serialised(input);
    scrubSentryEvent(input);
    expect(serialised(input)).toBe(before);
  });

  it("is idempotent", () => {
    const once = scrubSentryEvent(syntheticEvent());
    expect(scrubSentryEvent(once)).toEqual(once);
    for (const s of [...LEAKS, `${EN_NARRATIVE} ${SECRET} ${AR_NARRATIVE}`]) {
      expect(scrubString(scrubString(s))).toBe(scrubString(s));
    }
  });

  it("handles cycles, deep nesting and non-object input", () => {
    const cyclic: Record<string, unknown> = { attempt: 1 };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = { leaf: "witness.gamma@example.test" };
    for (let i = 0; i < 50; i++) deep = { next: deep };
    const out = serialised(scrubData({ cyclic, deep }));
    expect(out).toContain("[REDACTED:cycle]");
    expect(out).not.toContain("witness.gamma");
    expect(scrubSentryEvent(null)).toBeNull();
    expect(scrubSentryEvent("x")).toBe("x");
  });
});

describe("security review findings (CDF-62 on ade1340)", () => {
  it.each([
    "abcd-efgh-jkmn-pqrs-tvwx",
    "ABCO-EFGH-JKMN-PQRS-TVWI",
    "ABCD.EFGH.JKMN.PQRS.TVWX",
    "abcd_efgh_jkmn_pqrs_tvwx",
    "7k3m q9tz 4hxw b2rc n8pd",
    "7k3mq9tz4hxwb2rcn8pd",
    "WB-0123456789AO",
    "WB0123456789AB",
    "wb-0123456789ab",
  ])("M1: redacts the non-canonical secret or reference %s", (value) => {
    const out = scrubString(`status lookup ${value} failed`);
    expect(out).not.toContain(value);
    expect(out).toMatch(/\[REDACTED:report-(secret|ref)\]/);
  });

  it("M1: leaves ordinary English groups of four-letter words alone", () => {
    expect(scrubString("next page data been sent")).toBe("next page data been sent");
  });

  it("M2: redacts PostgreSQL row and key echoes and denies detail/where/hint", () => {
    const row =
      'new row violates check constraint: Failing row contains (a0, Employee Alpha accepted a bribe, "x").';
    expect(scrubString(row)).toBe(
      "new row violates check constraint: Failing row contains ([REDACTED:db-row]).",
    );
    expect(scrubString("Key (email)=(employee alpha) already exists.")).toBe(
      "Key (email)=([REDACTED:db-row]) already exists.",
    );
    expect(scrubData({ detail: "Employee Alpha", where: "PL/pgSQL x", hint: "Witness Gamma" })).toEqual({
      detail: "[REDACTED:field]",
      where: "[REDACTED:field]",
      hint: "[REDACTED:field]",
    });
    const event = scrubSentryEvent({
      contexts: { DatabaseError: { detail: "Failing row contains (Employee Alpha)" } },
    });
    expect(serialised(event)).not.toContain("Employee Alpha");
  });

  it("M3: contexts, extra and tags are allow-listed", () => {
    const out = scrubSentryEvent({
      contexts: {
        os: { name: "Linux", version: "6.1" },
        runtime: { name: "node", version: "v22.12.0", subjectName: "Employee Alpha" },
        response: { status_code: 500, body: "Employee Alpha" },
        case: { name: "Employee Alpha", accusedName: "Employee Alpha" },
      },
      extra: {
        name: "Employee Alpha",
        subjectName: "Employee Alpha",
        participantName: "Witness Gamma",
        value: "Employee Alpha took funds",
        answer: "yes, Employee Alpha",
        input: "Employee Alpha",
        witnesses: ["Witness Gamma"],
        args: ["Employee Alpha"],
        correlationId: "corr-0002",
      },
      tags: { route: "/cases/[id]", accusedName: "Employee Alpha", locale: "en" },
    });
    expect(out).toEqual({
      contexts: {
        os: { name: "Linux", version: "6.1" },
        runtime: { name: "node", version: "v22.12.0" },
        response: { status_code: 500 },
      },
      extra: { correlationId: "corr-0002" },
      tags: { route: "/cases/[id]", locale: "en" },
    });
  });

  it("LOW: drops object keys that carry personal data", () => {
    const out = scrubSentryEvent({
      measurements: { "employee.alpha@example.test": { value: 1 }, lcp: { value: 2 } },
    });
    expect(serialised(out)).not.toContain("employee.alpha");
    expect(out.measurements).toEqual({ lcp: { value: 2 } });
  });

  it("LOW: redacts spaced 966 phone numbers and new-format Supabase secret keys", () => {
    expect(scrubString("call 966 50 000 0005 now")).toBe("call [REDACTED:phone] now");
    expect(scrubString("966500000006")).not.toContain("966500000006");
    expect(scrubString("key sb_secret_SyntheticNotARealKey_123 leaked")).toBe(
      "key [REDACTED:credential] leaked",
    );
  });

  it("LOW: drops sdkProcessingMetadata and unknown top-level keys", () => {
    const out = scrubSentryEvent({
      level: "error",
      sdkProcessingMetadata: { normalizedRequest: { cookies: { s: "x" }, data: "Employee Alpha" } },
      somethingNew: { name: "Employee Alpha" },
    });
    expect(out).toEqual({ level: "error" });
  });

  it("is idempotent across the review cases", () => {
    for (const s of [
      "Failing row contains (Employee Alpha)",
      "Key (email)=(x) already exists",
      "abcd-efgh-jkmn-pqrs-tvwx 966 50 000 0005 sb_secret_abc",
    ]) {
      expect(scrubString(scrubString(s))).toBe(scrubString(s));
    }
  });
});

describe("scrubBreadcrumb", () => {
  it("scrubs a standalone breadcrumb for beforeBreadcrumb", () => {
    const out = scrubBreadcrumb({
      category: "ui.input",
      message: `typed ${AR_NARRATIVE}`,
      data: { url: `/report?x=${SECRET}`, description: EN_NARRATIVE },
    });
    expect(out).toEqual({
      category: "ui.input",
      message: "[REDACTED:text]",
      data: { url: "/report" },
    });
  });
});

// CDF-81: the three LOW residuals from the CDF-62 re-review of PR #35.
describe("CDF-62 LOW residuals (CDF-81)", () => {
  const [a, b, c, d, e] = SECRET.split("-");

  it.each([
    ["mixed separators", `${a}-${b} ${c}-${d} ${e}`],
    ["spaced hyphens", [a, b, c, d, e].join(" - ")],
    ["dot and slash", `${a}.${b}/${c}.${d}/${e}`],
    ["lower case, mixed", `${a}_${b}  ${c}-${d}.${e}`.toLowerCase()],
  ])("redacts a reporter secret with %s", (_name, input) => {
    expect(scrubString(`secret ${input} rejected`)).toBe("secret [REDACTED:report-secret] rejected");
  });

  it.each([["WB 7K3MQ9TZ4HXW"], ["WB - 7K3MQ9TZ4HXW"], ["wb 7k3mq9tz4hxw"]])(
    "redacts the report reference %s",
    (input) => {
      expect(scrubString(`lookup ${input} failed`)).toBe("lookup [REDACTED:report-ref] failed");
    },
  );

  it("leaves UUIDs and ordinary English alone", () => {
    for (const s of [
      "case a0000000-0000-4000-8000-000000000001 not found",
      "this that with from have been",
      "wb configuration failed",
    ]) {
      expect(scrubString(s)).toBe(s);
    }
  });

  it("keeps only scalar values under allow-listed extra and tag keys", () => {
    const out = scrubSentryEvent({
      extra: { kind: { witness: "Witness Gamma" }, route: ["/cases", EN_NARRATIVE], correlationId: "c-1" },
      tags: { errorKind: { nested: EN_NARRATIVE }, handled: false, level: "error" },
    }) as Record<string, Record<string, unknown>>;
    expect(out.extra).toEqual({ kind: "[REDACTED:field]", route: "[REDACTED:field]", correlationId: "c-1" });
    expect(out.tags).toEqual({ errorKind: "[REDACTED:field]", handled: false, level: "error" });
    expect(serialised(out)).not.toContain("Witness Gamma");
    expect(serialised(out)).not.toContain("Employee Alpha");
  });

  it("replaces English free text in non-technical breadcrumb messages", () => {
    const crumbs = [
      { category: "sentry.event", message: EN_NARRATIVE },
      { category: "ui.click", message: "Witness Gamma clicked submit" },
      { message: EN_NARRATIVE },
    ].map(scrubBreadcrumb);
    for (const crumb of crumbs) expect(crumb.message).toBe("[REDACTED:text]");
  });

  it("keeps technical breadcrumb messages as paths only", () => {
    expect(scrubBreadcrumb({ category: "navigation", message: "/report?ref=x" }).message).toBe("/report");
  });
});
