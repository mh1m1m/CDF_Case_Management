import { describe, expect, it } from "vitest";
import { NOTIFICATION_TEMPLATES, type NotificationTemplate, type OutgoingNotification } from "@cdf/contracts";
import { composeNotificationEmail, createNotificationService } from "./notifications";
import type { NotificationOutbox, NotificationSender } from "./ports";

const wording = Object.fromEntries(NOTIFICATION_TEMPLATES.map((t) => [t, `Wording for ${t}`])) as Record<
  NotificationTemplate,
  string
>;

describe("composeNotificationEmail (N18)", () => {
  it("contains only the template wording and the link", () => {
    const mail = composeNotificationEmail(
      { template: "MEETING_INVITATION", deepLink: "/meetings/0b6a2f8e-0000-4000-8000-000000000001" },
      wording,
      "https://investigations.example.test/some/path?x=1",
    );
    expect(mail).toEqual({
      subject: "Wording for MEETING_INVITATION",
      body: "Wording for MEETING_INVITATION\n\nhttps://investigations.example.test/meetings/0b6a2f8e-0000-4000-8000-000000000001",
    });
  });

  it("refuses a link that could carry text", () => {
    for (const deepLink of [
      "/meetings/x?name=Employee%20Sigma",
      "https://evil.example.test/",
      "/Meetings/1",
      "meetings",
    ])
      expect(() =>
        composeNotificationEmail({ template: "MEETING_INVITATION", deepLink }, wording, "https://a.test"),
      ).toThrow();
  });
});

describe("createNotificationService", () => {
  it("sends each claimed notification and settles it; a sender error counts as not delivered", async () => {
    const claimed: OutgoingNotification[] = [
      { id: "n1", recipientId: "u1", template: "MEETING_INVITATION", deepLink: "/meetings/1", attempts: 1 },
      {
        id: "n2",
        recipientId: "u2",
        template: "LEGAL_REVIEW_ASSIGNED",
        deepLink: "/legal-reviews/2",
        attempts: 5,
      },
      {
        id: "n3",
        recipientId: "u3",
        template: "DEFENCE_NOTICE_ISSUED",
        deepLink: "/my-defence/3",
        attempts: 2,
      },
    ];
    const settled: [string, boolean][] = [];
    const outbox: NotificationOutbox = {
      claimEmailBatch: async () => claimed,
      recordEmailDelivery: async (id, delivered) => {
        settled.push([id, delivered]);
        if (delivered) return "SENT";
        return claimed.find((c) => c.id === id)!.attempts >= 5 ? "FAILED" : "PENDING";
      },
      emitDueReminders: async () => 2,
    };
    const sender: NotificationSender = {
      kind: "stub-email",
      send: async (n) => {
        if (n.id === "n3") throw new Error("smtp refused someone@example.test");
        return n.id === "n1";
      },
    };
    const service = createNotificationService({ outbox, sender });
    expect(await service.dispatchEmail()).toEqual({ sent: 1, failed: 1, retrying: 1 });
    expect(settled).toEqual([
      ["n1", true],
      ["n2", false],
      ["n3", false],
    ]);
    expect(await service.emitDueReminders()).toBe(2);
  });
});
