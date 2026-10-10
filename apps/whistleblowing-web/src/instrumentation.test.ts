// CDF-81 · SENTRY_PLAN.md §7: an error carrying synthetic case content goes through the real
// Sentry SDK with a transport stub; the outgoing envelope holds none of the synthetic values.
import * as Sentry from "@sentry/nextjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSentryServerOptions } from "@cdf/infrastructure/observability";

// SYNTHETIC values only (CLAUDE.md §1); secret-shaped values are assembled from parts.
const DSN = ["https://", "examplepublickey", "@", "o0.ingest.example.test", "/1"].join("");
const SECRET = ["7K3M", "Q9TZ", "4HXW", "B2RC", "N8PD"].join("-");
const REF = ["WB", "7K3MQ9TZ4HXW"].join("-");
const AR_NARRATIVE = "قام الموظف ألفا بتحويل مبلغ إلى حساب شخصي دون موافقة";
const EN_NARRATIVE = "Employee Alpha moved funds to a personal account without approval";
const EMAIL = "witness.gamma@example.test";
const SYNTHETIC = [SECRET, REF, AR_NARRATIVE, EN_NARRATIVE, EMAIL, "Witness Gamma", "0500000003"];

const sent: string[] = [];

beforeAll(() => {
  const options = buildSentryServerOptions("whistleblowing-web", {
    SENTRY_DSN: DSN,
    CDF_ENVIRONMENT: "test",
  });
  if (!options) throw new Error("expected Sentry options");
  Sentry.init({
    ...options,
    // Capture serialised envelopes instead of sending them anywhere.
    transport: (transportOptions: Parameters<typeof Sentry.createTransport>[0]) =>
      Sentry.createTransport(transportOptions, async (request) => {
        sent.push(typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body));
        return { statusCode: 200 };
      }),
  });
});

afterAll(async () => {
  await Sentry.close(1000);
});

describe("Sentry envelope (real SDK, transport stub)", () => {
  it("sends a scrubbed error and none of the synthetic case content", async () => {
    Sentry.addBreadcrumb({ category: "console", message: `reporter ${EMAIL}` });
    Sentry.addBreadcrumb({ category: "ui.input", message: EN_NARRATIVE });
    Sentry.withScope((scope) => {
      scope.setUser({ email: EMAIL, username: "Witness Gamma" });
      scope.setExtra("narrative", EN_NARRATIVE);
      scope.setExtra("kind", { witness: "Witness Gamma" });
      scope.setExtra("correlationId", "corr-0001");
      scope.setContext("report", { description: AR_NARRATIVE, secret: SECRET });
      scope.setTag("reportRef", REF);
      Sentry.captureException(
        new Error(
          `Failing row contains (${EN_NARRATIVE}) for ${REF} ${SECRET} ${EMAIL} ${AR_NARRATIVE} 0500000003`,
        ),
      );
    });
    await Sentry.flush(2000);

    expect(sent.length).toBe(1);
    const envelope = sent.join("\n");
    expect(envelope).toContain('"type":"Error"');
    expect(envelope).toContain("corr-0001");
    expect(envelope).toContain('"app":"whistleblowing-web"');
    for (const value of SYNTHETIC) expect(envelope).not.toContain(value);
  });

  it("sends nothing for a non-error event type", async () => {
    const before = sent.length;
    Sentry.getClient()?.captureEvent({ type: "feedback" as never, message: EN_NARRATIVE });
    await Sentry.flush(2000);
    expect(sent.length).toBe(before);
  });
});
