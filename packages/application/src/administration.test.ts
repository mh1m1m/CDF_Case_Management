// Administration service (UX redesign Phase 12 P12-8a and P12-8b; ADR-051's P12-8a amendment, ADR-063): each register
// opens only where the caller's permissions open its page, before the gateway is asked, and a page the database refuses
// is the same not-found; both are recorded as ACCESS_DENIED with the page's name only. Each form's command validates
// with the shared schema and pre-checks the page's permission before the gateway; a refusal is recorded with the
// command and the outcome, never the reason typed. The five page rules that narrow a command (coordinator rulings on
// F4, 2026-10-18 21:17, and of 23:20 and 23:50) are pinned here: a mandatory notice takes no rule, a new export rule
// never takes NONE, a policy version is never looser than one in force or scheduled, a committee's rules never change an
// option that follows a decision, and a committee's safeguards are kept or made stricter, never loosened. The database
// side (each page's permission, row-level security, every command's checks) is in
// tests/integration/administration.spec.ts and tests/security/administration-capabilities-2127.spec.ts.
import { describe, expect, it } from "vitest";
import {
  COMPLETION_EVIDENCE_RULES,
  EXPORT_RULE_ACTIONS,
  EXPORT_RULE_ADD_ACTIONS,
  type Actor,
  type AdminView,
  type Permission,
} from "@cdf/contracts";
import type { SecurityEvent } from "@cdf/audit";
import {
  acceptsEvidenceKind,
  createAdministrationService,
  decidedOptionsNamed,
  looserCompletionRule,
  looserRuleSafeguard,
  needsEvidenceReference,
  ruleSetChanges,
  type AdministrationGateway,
  type CompletionRule,
  type RuleSetSafeguards,
} from "./administration";
import {
  DECIDED_RULE_KEYS,
  EDITABLE_RULE_KEYS,
  MAX_MINIMUM_NOTICE_DAYS,
  reviseCommitteeRuleSetSchema,
  TIGHTEN_ONLY_RULE_KEYS,
  type DecidedRuleKey,
  type RuleSafeguards,
  type TightenOnlyRuleKey,
} from "@cdf/validation";

const ctx = {
  userId: "a0000000-0000-4000-8000-000000000009",
  requestId: "22222222-2222-4222-8222-222222222222",
};

function actor(permissions: Permission[]): Actor {
  return {
    userId: ctx.userId,
    email: "platformadmin@example.test",
    displayName: "Platform Admin Eta",
    displayNameAr: "مسؤول المنصة إيتا",
    roles: ["PLATFORM_ADMIN"],
    permissions,
    clearance: "INTERNAL",
  };
}

/** Each page with the permission that opens it, and the service read that returns it. */
const PAGES = [
  ["committees", ["COMMITTEE_ADMIN"], "committees"],
  ["sectors", ["SECTOR_ADMIN"], "sectors"],
  ["notification-rules", ["NOTIFICATION_ADMIN"], "notificationRules"],
  ["export-policy", ["EXPORT_POLICY_ADMIN"], "exportPolicy"],
  ["corrective-action-policy", ["CORRECTIVE_ACTION_POLICY_ADMIN"], "correctiveActionPolicy"],
  ["calendar", ["BUSINESS_CALENDAR_ADMIN"], "calendar"],
] as const satisfies readonly (readonly [AdminView, readonly Permission[], keyof AdministrationGateway])[];

type Read = (typeof PAGES)[number][2];

const NEW_ID = "55555555-5555-4555-8555-555555555555";

interface HarnessOptions {
  /** The notice templates the notification rules page reads (the mandatory check reads them). */
  templates?: { code: string; isMandatory: boolean }[];
  /** The policy versions in force or scheduled that the gateway gives the "never looser" guard. */
  policyVersions?: CompletionRule[];
  /** A committee's rule set versions in force or scheduled that the gateway gives the safeguards guard. */
  ruleVersions?: RuleSetSafeguards[];
}

function harness(fail?: Error, options: HarnessOptions = {}) {
  const calls: { name: string; input?: unknown }[] = [];
  const events: SecurityEvent[] = [];
  const page =
    (name: string, extra: object = {}) =>
    async () => {
      calls.push({ name });
      if (fail) throw fail;
      return { page: name, ...extra } as never;
    };
  const run =
    <T>(name: string, value: T) =>
    async (_: unknown, input: unknown) => {
      calls.push({ name, input });
      if (fail) throw fail;
      return value;
    };
  const gateway: AdministrationGateway = {
    views: async () => {
      calls.push({ name: "views" });
      if (fail) throw fail;
      return ["calendar"];
    },
    committees: page("committees"),
    sectors: page("sectors"),
    notificationRules: page("notificationRules", options.templates ? { templates: options.templates } : {}),
    exportPolicy: page("exportPolicy"),
    correctiveActionPolicy: page("correctiveActionPolicy"),
    calendar: page("calendar"),
    setCalendarDay: run("setCalendarDay", "33333333-3333-4333-8333-333333333333"),
    setWeekPattern: run("setWeekPattern", "44444444-4444-4444-8444-444444444444"),
    withdrawCalendarDay: run("withdrawCalendarDay", undefined),
    createSector: run("createSector", NEW_ID),
    revokeDelegation: run("revokeDelegation", undefined),
    setNotificationRule: run("setNotificationRule", NEW_ID),
    addExportRule: run("addExportRule", NEW_ID),
    setExportPurpose: run("setExportPurpose", undefined),
    setCorrectiveActionPolicy: async (_, input, guard) => {
      calls.push({ name: "setCorrectiveActionPolicy", input });
      if (fail) throw fail;
      const refusal = guard(options.policyVersions ?? []);
      if (refusal) throw new Error(`CDF_CONFLICT:${refusal}`);
      return NEW_ID;
    },
    // As the gateway does, the guard runs first and the command is asked (and recorded here) only if it passes.
    reviseCommitteeRuleSet: async (_, input, guard) => {
      const refusal = guard(options.ruleVersions ?? []);
      if (refusal) throw new Error(`CDF_CONFLICT:${refusal}`);
      calls.push({ name: "reviseCommitteeRuleSet", input });
      if (fail) throw fail;
      return NEW_ID;
    },
  };
  const service = createAdministrationService({
    gateway,
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, calls, events };
}

const day = { calendarDate: "2027-01-03", dayType: "HOLIDAY", reason: "Synthetic: a demo holiday." };
const week = { nonWorkingDays: ["5", "6"], effectiveFrom: "2027-01-03", reason: "Synthetic: a demo week." };

describe("the registers", () => {
  for (const [view, permissions, read] of PAGES) {
    it(`${view} opens to the holder of its permission and reads its register`, async () => {
      const { service, calls, events } = harness();
      expect(await service[read as Read](ctx, actor([...permissions]))).toEqual({ page: read });
      expect(calls).toEqual([{ name: read }]);
      expect(events).toEqual([]);
    });

    it(`${view} is the uniform not-found without its permission, and the gateway is never asked`, async () => {
      const { service, calls, events } = harness();
      // Every other administrator's permission, but not this page's.
      const others = PAGES.filter(([v]) => v !== view).flatMap(([, p]) => p);
      expect(await service[read as Read](ctx, actor([...others, "USER_ADMIN", "ROLE_ADMIN"]))).toBeNull();
      expect(calls).toEqual([]);
      expect(events).toEqual([
        { action: "ACCESS_DENIED", objectType: "administration", objectId: view, metadata: { read: view } },
      ]);
    });

    it(`${view} refused by the database is the same not-found`, async () => {
      for (const code of ["CDF_FORBIDDEN", "CDF_NOT_FOUND"]) {
        const { service, calls, events } = harness(new Error(code));
        expect(await service[read as Read](ctx, actor([...permissions]))).toBeNull();
        expect(calls).toEqual([{ name: read }]);
        expect(events).toEqual([
          { action: "ACCESS_DENIED", objectType: "administration", objectId: view, metadata: { read: view } },
        ]);
      }
    });
  }

  it("export policy never opens to an export approver, even one who also holds EXPORT_POLICY_ADMIN (DEC-F24)", async () => {
    for (const approval of ["EXPORT_APPROVE", "EXPORT_SECOND_APPROVE"] as const) {
      const { service, calls, events } = harness();
      expect(await service.exportPolicy(ctx, actor(["EXPORT_POLICY_ADMIN", approval]))).toBeNull();
      expect(calls).toEqual([]);
      expect(events).toHaveLength(1);
    }
  });

  it("any other database failure is not hidden as a not-found", async () => {
    const { service, events } = harness(new Error("connection reset"));
    await expect(service.calendar(ctx, actor(["BUSINESS_CALENDAR_ADMIN"]))).rejects.toMatchObject({
      kind: "UNAVAILABLE",
    });
    expect(events).toEqual([]);
  });

  it("a failing security sink never masks the not-found", async () => {
    const quiet = createAdministrationService({
      gateway: {} as AdministrationGateway,
      securityEvents: {
        record: async () => {
          throw new Error("sink down");
        },
      },
    });
    expect(await quiet.sectors(ctx, actor([]))).toBeNull();
  });
});

describe("the calendar's commands", () => {
  const admin = actor(["BUSINESS_CALENDAR_ADMIN"]);

  it("a day goes to the gateway as the schema reads it", async () => {
    const { service, calls, events } = harness();
    const result = await service.setCalendarDay(ctx, admin, { ...day, sourceReference: "  " });
    expect(result).toEqual({ ok: true, value: "33333333-3333-4333-8333-333333333333" });
    expect(calls).toEqual([{ name: "setCalendarDay", input: { ...day, sourceReference: undefined } }]);
    expect(events).toEqual([]);
  });

  it("a week goes to the gateway with its days as sorted numbers", async () => {
    const { service, calls } = harness();
    const result = await service.setWeekPattern(ctx, admin, { ...week, nonWorkingDays: ["6", "5"] });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ name: "setWeekPattern", input: { ...week, nonWorkingDays: [5, 6] } }]);
  });

  it("invalid input never reaches the gateway and records nothing", async () => {
    const { service, calls, events } = harness();
    const bad = await service.setCalendarDay(ctx, admin, { ...day, dayType: "WEEKEND", reason: "abc" });
    expect(bad.ok).toBe(false);
    expect("fieldErrors" in bad && bad.fieldErrors.issues.map((i) => i.path.join("."))).toEqual(
      expect.arrayContaining(["dayType", "reason"]),
    );
    const all = await service.setWeekPattern(ctx, admin, {
      ...week,
      nonWorkingDays: ["1", "2", "3", "4", "5", "6", "7"],
    });
    expect("fieldErrors" in all && all.fieldErrors.issues.map((i) => i.message)).toEqual([
      "validation.oneWorkingDay",
    ]);
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });

  for (const [name, run] of [
    [
      "set_business_calendar_day",
      (s: ReturnType<typeof harness>["service"], a: Actor) => s.setCalendarDay(ctx, a, day),
    ],
    [
      "set_business_week_pattern",
      (s: ReturnType<typeof harness>["service"], a: Actor) => s.setWeekPattern(ctx, a, week),
    ],
  ] as const) {
    it(`${name} is refused before the gateway without BUSINESS_CALENDAR_ADMIN, and recorded`, async () => {
      const { service, calls, events } = harness();
      // Every other administrator's permission is not enough.
      const result = await run(service, actor(PAGES.flatMap(([v, p]) => (v === "calendar" ? [] : p))));
      expect(result).toMatchObject({ ok: false, error: { kind: "FORBIDDEN" } });
      expect(calls).toEqual([]);
      expect(events).toEqual([
        {
          action: "COMMAND_DENIED",
          objectType: "command",
          objectId: undefined,
          metadata: { command: name, outcome: "FORBIDDEN" },
        },
      ]);
    });

    it(`${name} refused by the database is recorded with the outcome only`, async () => {
      const { service, events } = harness(new Error("CDF_FORBIDDEN"));
      expect(await run(service, admin)).toMatchObject({ ok: false, error: { kind: "FORBIDDEN" } });
      expect(events).toEqual([
        {
          action: "COMMAND_DENIED",
          objectType: "command",
          objectId: undefined,
          metadata: { command: name, outcome: "FORBIDDEN" },
        },
      ]);
    });

    it(`${name}: a conflict or an invalid value comes back with its code and is not a denial`, async () => {
      for (const [message, kind, detail] of [
        ["CDF_CONFLICT:CALENDAR_DAY_EXISTS", "CONFLICT", "CALENDAR_DAY_EXISTS"],
        ["CDF_INVALID:effective_from", "INVALID", "effective_from"],
      ] as const) {
        const { service, events } = harness(new Error(message));
        expect(await run(service, admin)).toMatchObject({ ok: false, error: { kind, detail } });
        expect(events).toEqual([]);
      }
    });
  }
});

// ---- P12-8b: the Administration pages' other forms (ADR-063) -----------------------------------------------------

const REASON = "Synthetic: a demo reason.";
const FROM = "2027-01-03";
const DAY_ID = "66666666-6666-4666-8666-666666666666";
const DELEGATION_ID = "77777777-7777-4777-8777-777777777777";
const COMMITTEE_ID = "88888888-8888-4888-8888-888888888888";
const PURPOSE = {
  code: "DEMO_PURPOSE",
  nameEn: "Demo purpose",
  nameAr: "غرض تجريبي",
  requiresJustification: false,
  isActive: false,
  sortOrder: "90",
  reason: REASON,
};
const NOTICE = {
  layer: "EVENT_RULE",
  templateCode: "MEETING_SCHEDULED",
  channel: "EMAIL",
  enabled: "off",
  effectiveFrom: FROM,
  reason: REASON,
};
const NOT_MANDATORY = [{ code: "MEETING_SCHEDULED", isMandatory: false }];

type Service = ReturnType<typeof harness>["service"];
type FormMethod =
  | "withdrawCalendarDay"
  | "createSector"
  | "revokeDelegation"
  | "setNotificationRule"
  | "addExportRule"
  | "addExportPurpose"
  | "editExportPurpose"
  | "setCorrectiveActionPolicy"
  | "reviseCommitteeRuleSet";

/** Each form: its command, the service method, the gateway method it reaches, the page's permission, a valid input. */
const FORMS: readonly (readonly [string, FormMethod, string, Permission, Record<string, unknown>])[] = [
  [
    "withdraw_business_calendar_day",
    "withdrawCalendarDay",
    "withdrawCalendarDay",
    "BUSINESS_CALENDAR_ADMIN",
    { dayId: DAY_ID, reason: REASON },
  ],
  [
    "create_sector",
    "createSector",
    "createSector",
    "SECTOR_ADMIN",
    { code: "DEMO_SECTOR", nameEn: "Demo sector", nameAr: "قطاع تجريبي" },
  ],
  [
    "revoke_referral_delegation",
    "revokeDelegation",
    "revokeDelegation",
    "SECTOR_ADMIN",
    { delegationId: DELEGATION_ID, reason: REASON },
  ],
  ["set_notification_rule", "setNotificationRule", "setNotificationRule", "NOTIFICATION_ADMIN", NOTICE],
  [
    "set_export_rule",
    "addExportRule",
    "addExportRule",
    "EXPORT_POLICY_ADMIN",
    {
      code: "DEMO_RULE",
      audience: "EXTERNAL",
      restrictedOnly: false,
      action: "REFUSE",
      effectiveFrom: FROM,
      reason: REASON,
    },
  ],
  ["set_export_purpose", "addExportPurpose", "setExportPurpose", "EXPORT_POLICY_ADMIN", PURPOSE],
  [
    "set_export_purpose",
    "editExportPurpose",
    "setExportPurpose",
    "EXPORT_POLICY_ADMIN",
    { ...PURPOSE, expectedVersion: "2" },
  ],
  [
    "set_corrective_action_policy",
    "setCorrectiveActionPolicy",
    "setCorrectiveActionPolicy",
    "CORRECTIVE_ACTION_POLICY_ADMIN",
    {
      actionType: "CORRECTIVE_ACTION",
      completionEvidence: "REFERENCE_REQUIRED",
      effectiveFrom: FROM,
      reason: REASON,
    },
  ],
  [
    "revise_committee_rule_set",
    "reviseCommitteeRuleSet",
    "reviseCommitteeRuleSet",
    "COMMITTEE_ADMIN",
    {
      committeeId: COMMITTEE_ID,
      committeeKind: "INVESTIGATION",
      minimumNoticeDays: "7",
      effectiveFrom: FROM,
      reason: REASON,
    },
  ],
];

/** Every administrator's permission (the six pages', user and role administration). */
const EVERY_ADMIN: Permission[] = [...PAGES.flatMap(([, p]) => p), "USER_ADMIN", "ROLE_ADMIN"];

describe("the P12-8b forms", () => {
  for (const [command, method, reaches, permission, input] of FORMS) {
    const call = (s: Service, a: Actor, raw: unknown = input) => s[method](ctx, a, raw);

    it(`${method} reaches the gateway for the holder of ${permission} and records nothing`, async () => {
      const { service, calls, events } = harness(undefined, { templates: NOT_MANDATORY });
      expect((await call(service, actor([permission]))).ok).toBe(true);
      expect(calls.filter((c) => c.name !== "notificationRules").map((c) => c.name)).toEqual([reaches]);
      expect(events).toEqual([]);
    });

    it(`${method} is refused before the gateway without ${permission}, and recorded`, async () => {
      const { service, calls, events } = harness(undefined, { templates: NOT_MANDATORY });
      const result = await call(service, actor(EVERY_ADMIN.filter((p) => p !== permission)));
      expect(result).toMatchObject({ ok: false, error: { kind: "FORBIDDEN" } });
      expect(calls).toEqual([]);
      expect(events).toEqual([
        {
          action: "COMMAND_DENIED",
          objectType: "command",
          objectId: undefined,
          metadata: { command, outcome: "FORBIDDEN" },
        },
      ]);
    });

    it(`${method} refused by the database is recorded with the outcome only, never the reason typed`, async () => {
      for (const kind of ["FORBIDDEN", "NOT_FOUND"] as const) {
        const { service, events } = harness(new Error(`CDF_${kind}`), { templates: NOT_MANDATORY });
        expect(await call(service, actor([permission]))).toMatchObject({ ok: false, error: { kind } });
        expect(events).toEqual([
          {
            action: "COMMAND_DENIED",
            objectType: "command",
            objectId: undefined,
            metadata: { command, outcome: kind },
          },
        ]);
        expect(JSON.stringify(events)).not.toContain(REASON);
      }
    });

    it(`${method}: a conflict comes back with its code and is not a denial`, async () => {
      const { service, events } = harness(new Error("CDF_CONFLICT:SOMETHING_TAKEN"), {
        templates: NOT_MANDATORY,
      });
      expect(await call(service, actor([permission]))).toMatchObject({
        ok: false,
        error: { kind: "CONFLICT", detail: "SOMETHING_TAKEN" },
      });
      expect(events).toEqual([]);
    });

    it(`${method}: invalid input never reaches the gateway and records nothing`, async () => {
      const { service, calls, events } = harness(undefined, { templates: NOT_MANDATORY });
      const result = await call(service, actor([permission]), {});
      expect(result.ok).toBe(false);
      expect("fieldErrors" in result).toBe(true);
      expect(calls).toEqual([]);
      expect(events).toEqual([]);
    });
  }

  it("the export policy's forms are refused to an export approver, even one who also holds EXPORT_POLICY_ADMIN (DEC-F24)", async () => {
    for (const approval of ["EXPORT_APPROVE", "EXPORT_SECOND_APPROVE"] as const)
      for (const [, method, , permission, input] of FORMS.filter(
        ([, , , p]) => p === "EXPORT_POLICY_ADMIN",
      )) {
        const { service, calls } = harness();
        expect(await service[method](ctx, actor([permission, approval]), input), method).toMatchObject({
          ok: false,
          error: { kind: "FORBIDDEN" },
        });
        expect(calls).toEqual([]);
      }
  });

  it("the Administration pages come from the database (F3)", async () => {
    const { service, calls } = harness();
    expect(await service.views(ctx)).toEqual(["calendar"]);
    expect(calls).toEqual([{ name: "views" }]);
  });
});

describe("a notice rule (coordinator ruling on F4: a mandatory notice takes no rule)", () => {
  const admin = actor(["NOTIFICATION_ADMIN"]);

  it("a mandatory notice is refused with MANDATORY_NOTICE before the command, and is not a denial", async () => {
    const { service, calls, events } = harness(undefined, {
      templates: [{ code: "MEETING_SCHEDULED", isMandatory: true }],
    });
    expect(await service.setNotificationRule(ctx, admin, NOTICE)).toMatchObject({
      ok: false,
      error: { kind: "CONFLICT", detail: "MANDATORY_NOTICE" },
    });
    expect(calls).toEqual([{ name: "notificationRules" }]);
    expect(events).toEqual([]);
  });

  it("goes to the command with the start date, the channel and on or off as read", async () => {
    const { service, calls } = harness(undefined, { templates: NOT_MANDATORY });
    await service.setNotificationRule(ctx, admin, { ...NOTICE, enabled: "on" });
    expect(calls.at(-1)).toEqual({
      name: "setNotificationRule",
      input: { ...NOTICE, enabled: true, committeeId: undefined },
    });
  });

  it("a committee's default names its committee, and a platform-wide rule names none", async () => {
    const { service, calls } = harness(undefined, { templates: NOT_MANDATORY });
    const missing = await service.setNotificationRule(ctx, admin, { ...NOTICE, layer: "COMMITTEE_DEFAULT" });
    expect(
      "fieldErrors" in missing && missing.fieldErrors.issues.map((i) => [i.path.join("."), i.message]),
    ).toEqual([["committeeId", "validation.required"]]);
    const extra = await service.setNotificationRule(ctx, admin, { ...NOTICE, committeeId: COMMITTEE_ID });
    expect(
      "fieldErrors" in extra && extra.fieldErrors.issues.map((i) => [i.path.join("."), i.message]),
    ).toEqual([["committeeId", "validation.noCommittee"]]);
    expect(calls).toEqual([]);
  });
});

describe("an export rule and an export purpose (coordinator ruling on F4)", () => {
  const admin = actor(["EXPORT_POLICY_ADMIN"]);
  const rule = FORMS.find(([, m]) => m === "addExportRule")![4];

  it("a new rule offers exactly the command's actions that add a requirement or a refusal: never NONE", async () => {
    expect([...EXPORT_RULE_ADD_ACTIONS].sort()).toEqual(
      EXPORT_RULE_ACTIONS.filter((a) => a !== "NONE").sort(),
    );
    const { service, calls } = harness();
    for (const action of EXPORT_RULE_ADD_ACTIONS)
      expect((await service.addExportRule(ctx, admin, { ...rule, action })).ok, action).toBe(true);
    const none = await service.addExportRule(ctx, admin, { ...rule, action: "NONE" });
    expect("fieldErrors" in none && none.fieldErrors.issues.map((i) => i.path.join("."))).toEqual(["action"]);
    expect(calls.map((c) => (c.input as { action: string }).action)).toEqual([...EXPORT_RULE_ADD_ACTIONS]);
  });

  it("no form sends a source status: one sent is dropped, never passed on", async () => {
    const { service, calls } = harness();
    await service.addExportRule(ctx, admin, { ...rule, sourceStatus: "APPROVED" });
    await service.addExportPurpose(ctx, admin, {
      ...PURPOSE,
      sourceStatus: "SOURCE_REQUIRED",
      isLegacy: true,
    });
    await service.editExportPurpose(ctx, admin, {
      ...PURPOSE,
      expectedVersion: "2",
      sourceStatus: "OWNER_DEFAULT",
      isLegacy: true,
    });
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.input).not.toHaveProperty("sourceStatus");
      expect(c.input).not.toHaveProperty("isLegacy");
    }
  });

  it("an edit names the version read (F13), and a new purpose names none", async () => {
    const { service, calls } = harness();
    const unversioned = await service.editExportPurpose(ctx, admin, PURPOSE);
    expect(
      "fieldErrors" in unversioned && unversioned.fieldErrors.issues.map((i) => i.path.join(".")),
    ).toEqual(["expectedVersion"]);
    await service.editExportPurpose(ctx, admin, { ...PURPOSE, expectedVersion: "2" });
    await service.addExportPurpose(ctx, admin, { ...PURPOSE, expectedVersion: "2" });
    expect(calls.map((c) => (c.input as { expectedVersion?: number }).expectedVersion)).toEqual([
      2,
      undefined,
    ]);
  });

  it("the purpose Other always needs a justification", async () => {
    const { service, calls } = harness();
    for (const method of ["addExportPurpose", "editExportPurpose"] as const) {
      const r = await service[method](ctx, admin, { ...PURPOSE, code: "OTHER", expectedVersion: "1" });
      expect(
        "fieldErrors" in r && r.fieldErrors.issues.map((i) => [i.path.join("."), i.message]),
        method,
      ).toEqual([["requiresJustification", "validation.otherJustification"]]);
    }
    expect(calls).toEqual([]);
  });
});

describe("a corrective-action policy version (coordinator ruling on F4: never looser)", () => {
  const admin = actor(["CORRECTIVE_ACTION_POLICY_ADMIN"]);
  const version = FORMS.find(([, m]) => m === "setCorrectiveActionPolicy")![4];
  const REFERENCE: CompletionRule = { completionEvidence: "REFERENCE_REQUIRED", allowedEvidenceTypes: null };

  it("a version looser than one in force or scheduled is refused with its code, and is not a denial", async () => {
    for (const [versions, next, code] of [
      [[REFERENCE], { completionEvidence: "NOTE_ONLY" }, "LOOSER_COMPLETION_EVIDENCE"],
      [
        [{ ...REFERENCE, allowedEvidenceTypes: ["DOCUMENT_REF"] }],
        { allowedEvidenceTypes: ["DOCUMENT_REF", "SYSTEM_REF"] },
        "LOOSER_EVIDENCE_TYPES",
      ],
      [[{ ...REFERENCE, allowedEvidenceTypes: ["DOCUMENT_REF"] }], {}, "LOOSER_EVIDENCE_TYPES"],
    ] as const) {
      const { service, events } = harness(undefined, { policyVersions: [...versions] });
      expect(await service.setCorrectiveActionPolicy(ctx, admin, { ...version, ...next })).toMatchObject({
        ok: false,
        error: { kind: "CONFLICT", detail: code },
      });
      expect(events).toEqual([]);
    }
  });

  it("a version as strict as, or stricter than, the ones in force or scheduled goes to the command", async () => {
    const { service, calls } = harness(undefined, {
      policyVersions: [REFERENCE, { ...REFERENCE, allowedEvidenceTypes: ["DOCUMENT_REF", "SYSTEM_REF"] }],
    });
    const result = await service.setCorrectiveActionPolicy(ctx, admin, {
      ...version,
      allowedEvidenceTypes: ["SYSTEM_REF"],
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.input).toMatchObject({ allowedEvidenceTypes: ["SYSTEM_REF"], escalationSteps: [] });
  });

  it("is sent with every value the command takes, empty ones left unset, and blank further steps dropped", async () => {
    const { service, calls } = harness();
    await service.setCorrectiveActionPolicy(ctx, admin, {
      ...version,
      defaultDueDays: "30",
      reminderDaysBefore: "",
      escalationSteps: [
        { afterDaysOverdue: "3", recipientKind: "ROLE", roleCode: "CASE_MANAGER" },
        { afterDaysOverdue: "", recipientKind: "", roleCode: "" },
        { afterDaysOverdue: "10", recipientKind: "OWNER", roleCode: "" },
      ],
    });
    expect(calls[0]?.input).toEqual({
      actionType: "CORRECTIVE_ACTION",
      defaultDueDays: 30,
      reminderDaysBefore: undefined,
      reminderRepeatDays: undefined,
      overdueAfterDays: undefined,
      escalateAfterDays: undefined,
      completionEvidence: "REFERENCE_REQUIRED",
      allowedEvidenceTypes: null,
      escalationSteps: [
        { afterDaysOverdue: 3, recipientKind: "ROLE", roleCode: "CASE_MANAGER" },
        { afterDaysOverdue: 10, recipientKind: "OWNER", roleCode: null },
      ],
      effectiveFrom: FROM,
      reason: REASON,
    });
  });

  it("a half-filled step, a role on a step that names no role, or a repeat without a reminder is refused", async () => {
    const { service, calls } = harness();
    for (const [extra, path, message] of [
      [
        { escalationSteps: [{ afterDaysOverdue: "3" }] },
        "escalationSteps.0.recipientKind",
        "validation.chooseOne",
      ],
      [
        { escalationSteps: [{ afterDaysOverdue: "3", recipientKind: "OWNER", roleCode: "CASE_MANAGER" }] },
        "escalationSteps.0.roleCode",
        "validation.noRole",
      ],
      [
        { escalationSteps: [{ afterDaysOverdue: "3", recipientKind: "ROLE" }] },
        "escalationSteps.0.roleCode",
        "validation.chooseOne",
      ],
      [{ reminderRepeatDays: "7" }, "reminderRepeatDays", "validation.repeatNeedsReminder"],
    ] as const) {
      const r = await service.setCorrectiveActionPolicy(ctx, admin, { ...version, ...extra });
      expect("fieldErrors" in r && r.fieldErrors.issues.map((i) => [i.path.join("."), i.message])).toEqual([
        [path, message],
      ]);
    }
    expect(calls).toEqual([]);
  });
});

describe("never looser: the comparison is the completion command's own", () => {
  /** What a completion may carry: no reference, a reference with no kind, or a reference of one kind. */
  const KINDS = ["DOCUMENT_REF", "SYSTEM_REF", "MEETING_REF"];
  const completions: { reference: boolean; kind: string | null }[] = [
    { reference: false, kind: null },
    { reference: true, kind: null },
    ...KINDS.map((kind) => ({ reference: true, kind })),
  ];
  /**
   * Whether `api.submit_corrective_action_completion` (2040) accepts a completion under a version: a reference is
   * needed unless the version is NOTE_ONLY; a version that lists kinds accepts a reference of a listed kind only.
   */
  const accepts = (v: CompletionRule, c: (typeof completions)[number]) =>
    !c.reference
      ? !needsEvidenceReference(v.completionEvidence)
      : v.allowedEvidenceTypes === null ||
        (c.kind !== null && acceptsEvidenceKind(v.allowedEvidenceTypes, c.kind));
  const lists: (string[] | null)[] = [
    null,
    ["DOCUMENT_REF"],
    ["SYSTEM_REF"],
    ["DOCUMENT_REF", "SYSTEM_REF"],
    KINDS,
  ];
  const rules: CompletionRule[] = COMPLETION_EVIDENCE_RULES.flatMap((completionEvidence) =>
    lists.map((allowedEvidenceTypes) => ({ completionEvidence, allowedEvidenceTypes })),
  );

  it("needs a reference unless NOTE_ONLY, and accepts a listed kind, or any kind where none is listed", () => {
    expect(COMPLETION_EVIDENCE_RULES.filter(needsEvidenceReference)).toEqual(["REFERENCE_REQUIRED"]);
    expect(acceptsEvidenceKind(null, "ANY_KIND")).toBe(true);
    expect(acceptsEvidenceKind(["DOCUMENT_REF"], "DOCUMENT_REF")).toBe(true);
    expect(acceptsEvidenceKind(["DOCUMENT_REF"], "SYSTEM_REF")).toBe(false);
  });

  it("a version is refused exactly when it accepts a completion a version in force or scheduled refuses", () => {
    for (const before of rules)
      for (const next of rules) {
        const looser = completions.some((c) => accepts(next, c) && !accepts(before, c));
        const label = `${JSON.stringify(before)} then ${JSON.stringify(next)}`;
        expect(looserCompletionRule(next, [before]) !== null, label).toBe(looser);
      }
  });

  it("no version in force or scheduled refuses nothing, and every one counts", () => {
    for (const next of rules) expect(looserCompletionRule(next, [])).toBeNull();
    const loose: CompletionRule = { completionEvidence: "NOTE_ONLY", allowedEvidenceTypes: null };
    const strict: CompletionRule = {
      completionEvidence: "REFERENCE_REQUIRED",
      allowedEvidenceTypes: ["SYSTEM_REF"],
    };
    expect(looserCompletionRule(loose, [loose, strict])).toBe("LOOSER_COMPLETION_EVIDENCE");
    expect(looserCompletionRule({ ...strict, allowedEvidenceTypes: null }, [loose, strict])).toBe(
      "LOOSER_EVIDENCE_TYPES",
    );
  });
});

describe("a new version of a committee's rules", () => {
  const admin = actor(["COMMITTEE_ADMIN"]);
  const base = { committeeId: COMMITTEE_ID, committeeKind: "GRIEVANCE", effectiveFrom: FROM, reason: REASON };

  it("sends only the options changed, by the command's names, and never a source status", async () => {
    const { service, calls } = harness();
    const result = await service.reviseCommitteeRuleSet(ctx, admin, {
      ...base,
      ballotSecrecy: "SECRET_BALLOT",
      voteRevisionAllowed: "off",
      minimumNoticeDays: null,
      sanctionRequiresDefenceNotice: "on",
      grievanceCompletionDays: "20",
      sourceStatus: "APPROVED",
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        name: "reviseCommitteeRuleSet",
        input: {
          committeeId: COMMITTEE_ID,
          effectiveFrom: FROM,
          reason: REASON,
          changes: {
            ballot_secrecy: "SECRET_BALLOT",
            vote_revision_allowed: false,
            minimum_notice_days: null,
            sanction_requires_defence_notice: true,
            grievance_completion_days: 20,
          },
        },
      },
    ]);
  });

  // Coordinator ruling of 2026-10-18 23:20: the form never sends an option that follows a decision (it has no field
  // for one), and a revision that names one is refused before the command is asked, whatever its value, even with a
  // change the form may make; nothing reaches the gateway. Each value below is one the schema takes, and the seeded one.
  it("a revision that names an option following a decision is refused before the gateway, whatever its value, and is not a denial", async () => {
    const VALUES: Record<DecidedRuleKey, string | null> = {
      quorumType: "MAJORITY_ELIGIBLE",
      quorumValue: null,
      castingVoteEnabled: "on",
      minutesReviewBusinessDays: "3",
      deemedApprovalEnabled: "on",
      noSubstantiveVoteOutcome: "NO_DECISION",
      conflictDecider: "CHAIR",
      actingChairCastingVote: "off",
      grievanceWindowDays: "30",
      admissibilityDecider: "SECRETARY",
      grievanceWindowStartBasis: "DELIVERY",
      nonAdmissionDecider: "COMMITTEE",
    };
    expect(Object.keys(VALUES).sort()).toEqual(Object.keys(DECIDED_RULE_KEYS).sort());
    const { service, calls, events } = harness();
    for (const [key, value] of Object.entries(VALUES)) {
      for (const input of [
        { ...base, [key]: value },
        { ...base, dissentNoteAllowed: "off", [key]: value },
      ])
        expect(await service.reviseCommitteeRuleSet(ctx, admin, input), key).toMatchObject({
          ok: false,
          error: { kind: "CONFLICT", detail: "DECIDED_OPTION" },
        });
    }
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
    // The same revision without the decided option is recorded.
    expect(
      (await service.reviseCommitteeRuleSet(ctx, admin, { ...base, dissentNoteAllowed: "off" })).ok,
    ).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("a caller without COMMITTEE_ADMIN is refused first, and recorded, whatever the revision names", async () => {
    const { service, calls, events } = harness();
    expect(
      await service.reviseCommitteeRuleSet(ctx, actor(["NOTIFICATION_ADMIN"]), {
        ...base,
        conflictDecider: "SECRETARY",
      }),
    ).toMatchObject({ ok: false, error: { kind: "FORBIDDEN" } });
    expect(calls).toEqual([]);
    expect(events).toEqual([
      {
        action: "COMMAND_DENIED",
        objectType: "command",
        objectId: undefined,
        metadata: { command: "revise_committee_rule_set", outcome: "FORBIDDEN" },
      },
    ]);
  });

  it("a version with no option changed is refused as INVALID changes before the gateway, and is not a denial", async () => {
    const { service, calls, events } = harness();
    expect(await service.reviseCommitteeRuleSet(ctx, admin, base)).toMatchObject({
      ok: false,
      error: { kind: "INVALID", detail: "changes" },
    });
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it("an option the form may clear is cleared when emptied; any other emptied option is refused", async () => {
    const { service, calls } = harness();
    await service.reviseCommitteeRuleSet(ctx, admin, {
      ...base,
      minimumNoticeDays: null,
      grievanceCompletionDays: null,
    });
    expect((calls[0]?.input as { changes: object }).changes).toEqual({
      minimum_notice_days: null,
      grievance_completion_days: null,
    });
    // The quorum's value may be cleared by the command, but it follows a decision, so the page never clears it.
    expect(await service.reviseCommitteeRuleSet(ctx, admin, { ...base, quorumValue: null })).toMatchObject({
      ok: false,
      error: { kind: "CONFLICT", detail: "DECIDED_OPTION" },
    });
    for (const key of ["minutesReviewBusinessDays", "grievanceWindowDays"]) {
      const r = await service.reviseCommitteeRuleSet(ctx, admin, { ...base, [key]: null });
      expect(
        "fieldErrors" in r && r.fieldErrors.issues.map((i) => [i.path.join("."), i.message]),
        key,
      ).toEqual([[key, "validation.required"]]);
    }
    expect(calls).toHaveLength(1);
  });

  it("a grievance option on any other committee is refused", async () => {
    const { service, calls } = harness();
    const r = await service.reviseCommitteeRuleSet(ctx, admin, {
      ...base,
      committeeKind: "INVESTIGATION",
      admissibilityDecider: "CHAIR",
      grievanceCompletionDays: null,
    });
    expect("fieldErrors" in r && r.fieldErrors.issues.map((i) => [i.path.join("."), i.message])).toEqual([
      ["admissibilityDecider", "validation.grievanceOnly"],
      ["grievanceCompletionDays", "validation.grievanceOnly"],
    ]);
    expect(calls).toEqual([]);
  });

  it("a quorum is checked as the command checks it, and a valid one is still refused: it follows a decision (Q51)", async () => {
    const { service, calls } = harness();
    for (const [quorumType, quorumValue, message] of [
      ["FIXED_NUMBER", "2.5", "validation.quorumNumber"],
      ["FIXED_NUMBER", "0", "validation.quorumNumber"],
      ["FIXED_NUMBER", null, "validation.required"],
      ["PERCENTAGE", "0", "validation.quorumPercentage"],
      ["PERCENTAGE", "100.5", "validation.quorumPercentage"],
      ["MAJORITY_ELIGIBLE", "3", "validation.noQuorumValue"],
      ["CUSTOM", "3", "validation.noQuorumValue"],
    ] as const) {
      const r = await service.reviseCommitteeRuleSet(ctx, admin, { ...base, quorumType, quorumValue });
      expect("fieldErrors" in r && r.fieldErrors.issues.map((i) => [i.path.join("."), i.message])).toEqual([
        ["quorumValue", message],
      ]);
    }
    for (const [quorumType, quorumValue] of [
      ["FIXED_NUMBER", "3"],
      ["PERCENTAGE", "50.5"],
      ["MAJORITY_ELIGIBLE", null],
    ] as const)
      expect(
        await service.reviseCommitteeRuleSet(ctx, admin, { ...base, quorumType, quorumValue }),
      ).toMatchObject({
        ok: false,
        error: { kind: "CONFLICT", detail: "DECIDED_OPTION" },
      });
    expect(calls).toEqual([]);
  });

  it("names only the options the page may change, each by the command's name, once; never an option that follows a decision", () => {
    const every = {
      committeeId: COMMITTEE_ID,
      committeeKind: "GRIEVANCE",
      effectiveFrom: FROM,
      reason: REASON,
      quorumType: "FIXED_NUMBER",
      quorumValue: 3,
      castingVoteEnabled: true,
      minutesReviewBusinessDays: 7,
      deemedApprovalEnabled: false,
      noSubstantiveVoteOutcome: "NO_DECISION",
      conflictDecider: "CHAIR",
      actingChairCastingVote: true,
      voteRevisionAllowed: false,
      ballotSecrecy: "SECRET_BALLOT",
      minimumNoticeDays: 5,
      minutesObjectionBlocksDeemed: true,
      sanctionRequiresDefenceNotice: true,
      dissentNoteAllowed: true,
      grievanceWindowDays: 30,
      admissibilityDecider: "SECRETARY",
      grievanceWindowStartBasis: "DELIVERY",
      nonAdmissionDecider: "COMMITTEE",
      grievanceCompletionDays: 20,
    } as const;
    // Even handed every option, as no form sends them, the changes name the editable ones only.
    expect(Object.keys(ruleSetChanges(every)).sort()).toEqual(
      [
        "vote_revision_allowed",
        "ballot_secrecy",
        "minimum_notice_days",
        "minutes_objection_blocks_deemed",
        "sanction_requires_defence_notice",
        "dissent_note_allowed",
        "grievance_completion_days",
      ].sort(),
    );
    expect(Object.keys(ruleSetChanges(every))).toHaveLength(EDITABLE_RULE_KEYS.length);
    expect(decidedOptionsNamed(every).sort()).toEqual(Object.keys(DECIDED_RULE_KEYS).sort());
    expect(decidedOptionsNamed({ ...base, committeeKind: "GRIEVANCE", dissentNoteAllowed: true })).toEqual(
      [],
    );
  });
});

// Coordinator ruling of 2026-10-18 23:50: a committee's safeguards are kept or made stricter, never loosened (AMB-026
// and AMB-092, the ruling's own, and AMB-061 and AMB-083, this page's reading of it, listed for a ruling). The gateway
// gives the guard the committee's versions in force or scheduled, the open one marked, under a lock on the committee's
// revisions, before the command is asked; a looser value is refused with nothing sent, and is not a denial.
describe("a committee's safeguards: kept or made stricter, never loosened", () => {
  const admin = actor(["COMMITTEE_ADMIN"]);
  const base = { committeeId: COMMITTEE_ID, committeeKind: "GRIEVANCE", effectiveFrom: FROM, reason: REASON };
  /** The version open now: both guards on, the ballot seen after close, five days' notice. */
  const OPEN: RuleSetSafeguards = {
    open: true,
    minimumNoticeDays: 5,
    ballotSecrecy: "COMMITTEE_AFTER_CLOSE",
    minutesObjectionBlocksDeemed: true,
    sanctionRequiresDefenceNotice: true,
  };
  const LOOSER = { ok: false, error: { kind: "CONFLICT", detail: "LOOSER_RULE_OPTION" } };

  it("a value looser than the version open now is refused before the command, with nothing sent, and is not a denial", async () => {
    for (const [loosen, versions] of [
      [{ sanctionRequiresDefenceNotice: "off" }, [OPEN]],
      [{ minutesObjectionBlocksDeemed: "off" }, [OPEN]],
      [{ minimumNoticeDays: "4" }, [OPEN]],
      [{ minimumNoticeDays: "0" }, [OPEN]],
      [{ minimumNoticeDays: null }, [OPEN]],
      [{ ballotSecrecy: "COMMITTEE_AFTER_CLOSE" }, [{ ...OPEN, ballotSecrecy: "SECRET_BALLOT" }]],
    ] as const) {
      const { service, calls, events } = harness(undefined, { ruleVersions: [...versions] });
      // Alone, and beside a change the page may make.
      for (const input of [
        { ...base, ...loosen },
        { ...base, dissentNoteAllowed: "off", voteRevisionAllowed: "off", ...loosen },
      ])
        expect(await service.reviseCommitteeRuleSet(ctx, admin, input), JSON.stringify(loosen)).toMatchObject(
          LOOSER,
        );
      expect(calls, JSON.stringify(loosen)).toEqual([]);
      expect(events, JSON.stringify(loosen)).toEqual([]);
    }
  });

  it("a value as strict or stricter goes to the command, and a safeguard not sent is carried as strict as it is", async () => {
    const { service, calls } = harness(undefined, { ruleVersions: [OPEN] });
    for (const input of [
      { minimumNoticeDays: "5" },
      { minimumNoticeDays: "6" },
      { minimumNoticeDays: String(MAX_MINIMUM_NOTICE_DAYS) },
      { ballotSecrecy: "SECRET_BALLOT" },
      { ballotSecrecy: "COMMITTEE_AFTER_CLOSE" },
      { sanctionRequiresDefenceNotice: "on", minutesObjectionBlocksDeemed: "on" },
      { dissentNoteAllowed: "off", voteRevisionAllowed: "off", grievanceCompletionDays: null },
    ])
      expect(
        (await service.reviseCommitteeRuleSet(ctx, admin, { ...base, ...input })).ok,
        JSON.stringify(input),
      ).toBe(true);
    expect(calls).toHaveLength(7);
  });

  it("every version in force or scheduled counts, and a looser value carried from the open version is refused until made as strict", async () => {
    // In force: both guards on. Open, starting later (recorded before this page): the defence-notice guard off.
    const carried = harness(undefined, {
      ruleVersions: [
        { ...OPEN, open: false },
        { ...OPEN, sanctionRequiresDefenceNotice: false },
      ],
    });
    expect(
      await carried.service.reviseCommitteeRuleSet(ctx, admin, { ...base, dissentNoteAllowed: "off" }),
    ).toMatchObject(LOOSER);
    expect(carried.calls).toEqual([]);
    expect(
      (
        await carried.service.reviseCommitteeRuleSet(ctx, admin, {
          ...base,
          dissentNoteAllowed: "off",
          sanctionRequiresDefenceNotice: "on",
        })
      ).ok,
    ).toBe(true);
    // A notice as long as the version in force but shorter than the one starting later is refused.
    const notice = harness(undefined, {
      ruleVersions: [
        { ...OPEN, open: false, minimumNoticeDays: 3 },
        { ...OPEN, minimumNoticeDays: 10 },
      ],
    });
    for (const minimumNoticeDays of ["3", "9", null])
      expect(
        await notice.service.reviseCommitteeRuleSet(ctx, admin, { ...base, minimumNoticeDays }),
        String(minimumNoticeDays),
      ).toMatchObject(LOOSER);
    expect(notice.calls).toEqual([]);
    expect(
      (await notice.service.reviseCommitteeRuleSet(ctx, admin, { ...base, minimumNoticeDays: "10" })).ok,
    ).toBe(true);
  });

  it("a safeguard's new value is refused exactly when it is looser than its value in some version in force or scheduled", () => {
    // Each safeguard's values, loosest first: an unset notice enforces nothing; a secret ballot and a guard that is on
    // are the stricter values.
    const ORDER: { [K in TightenOnlyRuleKey]: RuleSafeguards[K][] } = {
      minimumNoticeDays: [null, 0, 1, 5, 59, MAX_MINIMUM_NOTICE_DAYS],
      ballotSecrecy: ["COMMITTEE_AFTER_CLOSE", "SECRET_BALLOT"],
      minutesObjectionBlocksDeemed: [false, true],
      sanctionRequiresDefenceNotice: [false, true],
    };
    expect(Object.keys(ORDER).sort()).toEqual(Object.keys(TIGHTEN_ONLY_RULE_KEYS).sort());
    const loosest: RuleSetSafeguards = {
      open: true,
      minimumNoticeDays: null,
      ballotSecrecy: "COMMITTEE_AFTER_CLOSE",
      minutesObjectionBlocksDeemed: false,
      sanctionRequiresDefenceNotice: false,
    };
    const parsed = reviseCommitteeRuleSetSchema.parse(base);
    for (const key of Object.keys(ORDER) as TightenOnlyRuleKey[]) {
      const values = ORDER[key] as RuleSafeguards[TightenOnlyRuleKey][];
      for (const [i, floor] of values.entries())
        for (const [j, next] of values.entries()) {
          const label = `${key}: ${String(floor)} then ${String(next)}`;
          // Sent, against a version in force (as the floor) and the open one.
          const versions = [{ ...loosest, open: false, [key]: floor }, loosest];
          expect(looserRuleSafeguard({ ...parsed, [key]: next }, versions), label).toBe(j < i ? key : null);
          // Not sent: carried from the open version.
          const carried = [
            { ...loosest, open: false, [key]: floor },
            { ...loosest, [key]: next },
          ];
          expect(looserRuleSafeguard(parsed, carried), `${label} (carried)`).toBe(j < i ? key : null);
        }
    }
    // No version read (a caller who cannot see the committee): nothing is refused here; the command refuses the caller.
    expect(looserRuleSafeguard({ ...parsed, sanctionRequiresDefenceNotice: false }, [])).toBeNull();
  });
});
