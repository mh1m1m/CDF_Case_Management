import { describe, expect, it, vi } from "vitest";
import {
  breadcrumbOrDrop,
  buildSentryServerOptions,
  cdfEventFilter,
  isValidSentryDsn,
  scrubOrDrop,
  selectIntegrations,
  sentryEnvironment,
} from "./sentry-options";
import * as scrub from "./scrub";

// SYNTHETIC values only (CLAUDE.md §1). The DSN is assembled from parts so secret scanners do not
// mistake it for a credential; its host is reserved (.test) and never resolves.
const DSN = ["https://", "examplepublickey", "@", "o0.ingest.example.test", "/1"].join("");
// The options accept any SDK event; tests build loose objects.
const ev = (event: object) => event as { type?: string };
const AR_NARRATIVE = "قام الموظف ألفا بتحويل مبلغ إلى حساب شخصي دون موافقة";

describe("buildSentryServerOptions", () => {
  it("stays off without a DSN", () => {
    expect(buildSentryServerOptions("whistleblowing-web", { CDF_ENVIRONMENT: "dev" })).toBeNull();
    expect(buildSentryServerOptions("whistleblowing-web", { SENTRY_DSN: "  " })).toBeNull();
  });

  it("stays off, without echoing the value, when the DSN is malformed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of [
      "not a url",
      "http://k@o0.ingest.example.test/1",
      "https://o0.ingest.example.test/1",
    ]) {
      expect(buildSentryServerOptions("investigation-web", { SENTRY_DSN: bad })).toBeNull();
    }
    for (const [message] of warn.mock.calls) expect(String(message)).not.toContain("example.test");
    warn.mockRestore();
  });

  it("refuses to start when any Sentry variable is public", () => {
    expect(() =>
      buildSentryServerOptions("whistleblowing-web", { SENTRY_DSN: DSN, NEXT_PUBLIC_SENTRY_DSN: DSN }),
    ).toThrow(/NEXT_PUBLIC_SENTRY_DSN/);
  });

  it("uses the privacy defaults from SENTRY_PLAN.md §5", () => {
    const options = buildSentryServerOptions("whistleblowing-web", {
      SENTRY_DSN: DSN,
      CDF_ENVIRONMENT: "dev",
      VERCEL_GIT_COMMIT_SHA: "abc1234",
    });
    expect(options).toMatchObject({
      dsn: DSN,
      environment: "dev",
      release: "abc1234",
      sendDefaultPii: false,
      includeLocalVariables: false,
      sendClientReports: false,
      tracesSampleRate: 0.1,
      tracePropagationTargets: [],
      initialScope: { tags: { app: "whistleblowing-web" } },
    });
    expect(options?.beforeSend).toBe(scrubOrDrop);
    expect(options?.beforeSendTransaction).toBe(scrubOrDrop);
    expect(options?.beforeBreadcrumb).toBe(breadcrumbOrDrop);
  });

  it("samples no traces outside dev and preview", () => {
    expect(
      buildSentryServerOptions("investigation-web", { SENTRY_DSN: DSN, CDF_ENVIRONMENT: "demo" }),
    ).toMatchObject({ environment: "demo", tracesSampleRate: 0 });
  });

  it("labels Vercel preview deployments as preview", () => {
    expect(sentryEnvironment({ VERCEL_ENV: "preview", CDF_ENVIRONMENT: "dev" })).toBe("preview");
    expect(sentryEnvironment({ VERCEL_ENV: "production", CDF_ENVIRONMENT: "dev" })).toBe("dev");
  });

  it("accepts only https DSNs with a public key and a numeric project", () => {
    expect(isValidSentryDsn(DSN)).toBe(true);
    expect(isValidSentryDsn(`${DSN}?x=1`)).toBe(false);
    // The SDK would print a DSN it cannot parse; such values are refused before it sees them.
    expect(isValidSentryDsn(DSN.replace("examplepublickey", "example-public-key"))).toBe(false);
    expect(isValidSentryDsn(DSN.replace("/1", "/project"))).toBe(false);
  });
});

describe("beforeSend / beforeSendTransaction", () => {
  it("runs every event through the CDF-64 scrubber", () => {
    const spy = vi.spyOn(scrub, "scrubSentryEvent");
    const out = scrubOrDrop(
      ev({
        exception: { values: [{ type: "Error", value: `failed for ${AR_NARRATIVE}` }] },
        user: { email: "witness.gamma@example.test" },
        extra: { narrative: AR_NARRATIVE, correlationId: "c-1" },
      }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(out).toEqual({
      exception: { values: [{ type: "Error", value: "failed for [REDACTED:text]" }] },
      extra: { correlationId: "c-1" },
    });
  });

  it("scrubs transactions", () => {
    const out = scrubOrDrop(ev({ type: "transaction", transaction: "/follow-up?ref=WB-7K3MQ9TZ4HXW" }));
    expect(out).toEqual({ type: "transaction", transaction: "/follow-up" });
  });

  it.each(["replay_event", "feedback", "profile", "check_in", "anything-else"])(
    "drops %s events (event-type allow-list)",
    (type) => {
      expect(scrubOrDrop(ev({ type, message: "x" }))).toBeNull();
    },
  );

  it("filters every event type in the SDK's event processor, not only in beforeSend", () => {
    expect(cdfEventFilter.processEvent(ev({ type: "feedback" }))).toBeNull();
    expect(cdfEventFilter.processEvent(ev({}))).toEqual({});
  });

  it("drops an event the scrubber cannot process (fail closed)", () => {
    const spy = vi.spyOn(scrub, "scrubSentryEvent").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(scrubOrDrop(ev({ message: "x" }))).toBeNull();
    spy.mockRestore();
  });
});

describe("beforeBreadcrumb", () => {
  it("removes console, local-variable, session and source-context integrations and adds the event filter", () => {
    const names = selectIntegrations(
      ["Console", "LocalVariablesAsync", "ContextLines", "ProcessSession", "Http", "OnUncaughtException"].map(
        (name) => ({
          name,
        }),
      ),
    ).map((i) => i.name);
    expect(names).toEqual(["Http", "OnUncaughtException", "CdfEventFilter"]);
  });

  it("drops console breadcrumbs and scrubs the rest", () => {
    expect(breadcrumbOrDrop({ category: "console", message: "Witness Gamma" })).toBeNull();
    expect(breadcrumbOrDrop({ category: "http", data: { url: "/report?x=1", body: "x" } })).toEqual({
      category: "http",
      data: { url: "/report" },
    });
  });
});
