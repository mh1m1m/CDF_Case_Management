// Meeting and minutes schemas (Phase 12 P12-2a and P12-2b; ADR-054 and ADR-055). The database re-checks every rule,
// including who may act; these refuse early with the commands' own lengths and choices, so a form shows the problem
// before a round trip.
import { describe, expect, it } from "vitest";
import {
  activateActingChairSchema,
  activateActingSecretarySchema,
  activateAlternateMemberSchema,
  amendProceedingSnapshotSchema,
  cancelMeetingSchema,
  castCastingVoteSchema,
  castVoteSchema,
  closeVoteItemSchema,
  declareMeetingConflictSchema,
  decideMeetingConflictSchema,
  excludeMeetingWitnessSchema,
  generateMinutesSchema,
  openMeetingSchema,
  openVoteItemSchema,
  overruleMinutesObjectionSchema,
  raiseMeetingConflictSchema,
  recordAttendanceSchema,
  recordExcusedAbsenceSchema,
  recordMeetingAccommodationSchema,
  recordVoteForMemberSchema,
  recordVoteNoteSchema,
  reverseMeetingConflictSchema,
  reviewMinutesSchema,
  reviseVoteSchema,
  scheduleEmergencyMeetingSchema,
  scheduleMeetingSchema,
} from "./meetings";
import { fieldErrors } from "./index";

const ID = "8f8c2a52-4f0e-4b5a-9a43-0f7f2c1d9e10";
const messages = (r: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) =>
  (r.error?.issues ?? []).map((i) => `${i.path.join(".")}:${i.message}`);

describe("meeting schemas", () => {
  it("opening, closing and cancelling a meeting need its id and a reason of 5 to 2,000 characters", () => {
    for (const schema of [openMeetingSchema, cancelMeetingSchema]) {
      expect(schema.safeParse({ meetingId: ID, reason: "Synthetic reason." }).success).toBe(true);
      expect(messages(schema.safeParse({ meetingId: ID, reason: "abc" }))).toEqual([
        "reason:validation.tooShort",
      ]);
      expect(messages(schema.safeParse({ meetingId: "not-a-uuid", reason: "   " }))).toEqual([
        "meetingId:validation.invalid",
        "reason:validation.required",
      ]);
      expect(messages(schema.safeParse({ meetingId: ID, reason: "x".repeat(2001) }))).toEqual([
        "reason:validation.tooLong",
      ]);
    }
  });

  it("attendance takes only what the secretary records; an excuse goes through its own command", () => {
    for (const attendance of ["PRESENT", "ABSENT", "EXCUSED_CONFLICT"]) {
      expect(recordAttendanceSchema.safeParse({ participantId: ID, attendance }).success).toBe(true);
    }
    for (const attendance of ["EXCUSED", "NOT_RECORDED", ""]) {
      expect(recordAttendanceSchema.safeParse({ participantId: ID, attendance }).success).toBe(false);
    }
    expect(messages(recordExcusedAbsenceSchema.safeParse({ participantId: ID, reason: "" }))).toEqual([
      "reason:validation.required",
    ]);
  });

  it("a declared conflict needs its reason; no conflict may come with one or without", () => {
    expect(declareMeetingConflictSchema.safeParse({ participantId: ID, status: "NO_CONFLICT" }).success).toBe(
      true,
    );
    const empty = declareMeetingConflictSchema.safeParse({
      participantId: ID,
      status: "NO_CONFLICT",
      reason: "",
    });
    expect(empty.success && empty.data.reason).toBeUndefined();
    expect(
      messages(declareMeetingConflictSchema.safeParse({ participantId: ID, status: "CONFLICT_DECLARED" })),
    ).toEqual(["reason:validation.required"]);
    expect(
      declareMeetingConflictSchema.safeParse({
        participantId: ID,
        status: "CONFLICT_DECLARED",
        reason: "Synthetic: related to a party.",
      }).success,
    ).toBe(true);
    // PENDING and NOT_REQUIRED are states, not declarations.
    for (const status of ["PENDING", "NOT_REQUIRED"]) {
      expect(declareMeetingConflictSchema.safeParse({ participantId: ID, status }).success).toBe(false);
    }
    expect(
      messages(
        declareMeetingConflictSchema.safeParse({ participantId: ID, status: "NO_CONFLICT", reason: "abc" }),
      ),
    ).toEqual(["reason:validation.tooShort"]);
  });

  it("raising, deciding and reversing a conflict need a fuller reason of 10 characters or more", () => {
    const short = "Too short";
    const reason = "Synthetic: the member reviewed this case before.";
    expect(messages(raiseMeetingConflictSchema.safeParse({ participantId: ID, reason: short }))).toEqual([
      "reason:validation.tooShort",
    ]);
    expect(raiseMeetingConflictSchema.safeParse({ participantId: ID, reason }).success).toBe(true);
    expect(decideMeetingConflictSchema.safeParse({ concernId: ID, decision: "UPHELD", reason }).success).toBe(
      true,
    );
    expect(decideMeetingConflictSchema.safeParse({ concernId: ID, decision: "OPEN", reason }).success).toBe(
      false,
    );
    expect(messages(reverseMeetingConflictSchema.safeParse({ concernId: ID, reason: short }))).toEqual([
      "reason:validation.tooShort",
    ]);
  });
});

describe("vote schemas", () => {
  it("the screen opens votes on other business only; a vote on a finding waits for the package screens", () => {
    const r = openVoteItemSchema.safeParse({ meetingId: ID, title: "Synthetic business" });
    expect(r.success && r.data.targetType).toBe("OTHER");
    expect(
      openVoteItemSchema.safeParse({ meetingId: ID, targetType: "FINDING", title: "Synthetic" }).success,
    ).toBe(false);
    expect(messages(openVoteItemSchema.safeParse({ meetingId: ID, title: "ab" }))).toEqual([
      "title:validation.tooShort",
    ]);
  });

  it("a member's own vote takes the four member choices; ABSENT and UNABLE_TO_VOTE are the secretary's to record", () => {
    for (const choice of ["APPROVE", "REJECT", "ABSTAIN", "RECUSED"]) {
      expect(castVoteSchema.safeParse({ voteItemId: ID, choice }).success).toBe(true);
      expect(reviseVoteSchema.safeParse({ voteItemId: ID, choice }).success).toBe(true);
    }
    for (const choice of ["ABSENT", "UNABLE_TO_VOTE", ""]) {
      expect(castVoteSchema.safeParse({ voteItemId: ID, choice }).success).toBe(false);
    }
    expect(messages(castVoteSchema.safeParse({ voteItemId: ID, choice: "APPROVE", reason: "abc" }))).toEqual([
      "reason:validation.tooShort",
    ]);
  });

  it("the deciding vote is approve or reject", () => {
    expect(castCastingVoteSchema.safeParse({ voteItemId: ID, choice: "REJECT" }).success).toBe(true);
    expect(castCastingVoteSchema.safeParse({ voteItemId: ID, choice: "ABSTAIN" }).success).toBe(false);
  });

  it("a note is 10 to 4,000 characters and says whether it goes to the minutes", () => {
    const note = "Synthetic: I voted against because of the timeline.";
    expect(recordVoteNoteSchema.safeParse({ voteItemId: ID, note, annexToMinutes: false }).success).toBe(
      true,
    );
    expect(messages(recordVoteNoteSchema.safeParse({ voteItemId: ID, note }))).toEqual([
      "annexToMinutes:validation.invalid",
    ]);
    expect(
      messages(recordVoteNoteSchema.safeParse({ voteItemId: ID, note: "short", annexToMinutes: true })),
    ).toEqual(["note:validation.tooShort"]);
  });

  it("closing a vote carries the quorum attestation as a boolean, checked by the database for the rule in force", () => {
    expect(closeVoteItemSchema.safeParse({ voteItemId: ID, customQuorumAttested: false }).success).toBe(true);
    expect(closeVoteItemSchema.safeParse({ voteItemId: ID, customQuorumAttested: "on" }).success).toBe(false);
  });

  it("the secretary records only non-substantive choices for a member, at a time that is not in the future", () => {
    const base = { voteItemId: ID, participantId: ID, reason: "Synthetic: travelling." };
    for (const choice of ["ABSENT", "UNABLE_TO_VOTE", "RECUSED"]) {
      expect(recordVoteForMemberSchema.safeParse({ ...base, choice }).success).toBe(true);
    }
    for (const choice of ["APPROVE", "REJECT", "ABSTAIN"]) {
      expect(recordVoteForMemberSchema.safeParse({ ...base, choice }).success).toBe(false);
    }
    // A datetime-local value is Riyadh time (UTC+3, no DST).
    const local = recordVoteForMemberSchema.safeParse({
      ...base,
      choice: "ABSENT",
      originalEventAt: "2026-01-02T09:30",
    });
    expect(local.success && local.data.originalEventAt).toBe("2026-01-02T06:30:00.000Z");
    const empty = recordVoteForMemberSchema.safeParse({ ...base, choice: "ABSENT", originalEventAt: "" });
    expect(empty.success && empty.data.originalEventAt).toBeUndefined();
    expect(
      messages(
        recordVoteForMemberSchema.safeParse({
          ...base,
          choice: "ABSENT",
          originalEventAt: "2999-01-01T00:00",
        }),
      ),
    ).toEqual(["originalEventAt:validation.futureDate"]);
    expect(
      messages(
        recordVoteForMemberSchema.safeParse({ ...base, choice: "ABSENT", originalEventAt: "yesterday" }),
      ),
    ).toEqual(["originalEventAt:validation.invalid"]);
  });
});

describe("minutes schemas", () => {
  it("the narrative is 10 to 20,000 characters", () => {
    expect(
      generateMinutesSchema.safeParse({ meetingId: ID, narrative: "Synthetic minutes text." }).success,
    ).toBe(true);
    expect(messages(generateMinutesSchema.safeParse({ meetingId: ID, narrative: "Too short" }))).toEqual([
      "narrative:validation.tooShort",
    ]);
  });

  it("asking for changes needs a comment; an approval may carry one", () => {
    expect(reviewMinutesSchema.safeParse({ minutesId: ID, decision: "APPROVE" }).success).toBe(true);
    expect(messages(reviewMinutesSchema.safeParse({ minutesId: ID, decision: "REQUEST_CHANGES" }))).toEqual([
      "comment:validation.required",
    ]);
    expect(
      reviewMinutesSchema.safeParse({
        minutesId: ID,
        decision: "REQUEST_CHANGES",
        comment: "Synthetic: vote 2's count is wrong.",
      }).success,
    ).toBe(true);
  });

  it("overruling an objection needs a reason of 10 characters or more", () => {
    expect(messages(overruleMinutesObjectionSchema.safeParse({ minutesId: ID, reason: "short" }))).toEqual([
      "reason:validation.tooShort",
    ]);
  });
});

describe("scheduling a meeting (P12-2b)", () => {
  const room = {
    committeeProceedingId: ID,
    purpose: "DELIBERATION",
    mode: "IN_PERSON",
    location: "Meeting room (synthetic)",
    scheduledStart: "2026-11-02T10:00",
    scheduledEnd: "2026-11-02T11:30",
    reason: "Synthetic: first deliberation.",
  };

  it("reads the times as Riyadh time and needs the end after the start", () => {
    const r = scheduleMeetingSchema.safeParse(room);
    expect(r.success && [r.data.scheduledStart, r.data.scheduledEnd]).toEqual([
      "2026-11-02T07:00:00.000Z",
      "2026-11-02T08:30:00.000Z",
    ]);
    expect(messages(scheduleMeetingSchema.safeParse({ ...room, scheduledEnd: "2026-11-02T10:00" }))).toEqual([
      "scheduledEnd:validation.endAfterStart",
    ]);
    expect(
      messages(scheduleMeetingSchema.safeParse({ ...room, scheduledStart: "", scheduledEnd: "soon" })),
    ).toEqual(["scheduledStart:validation.required", "scheduledEnd:validation.invalid"]);
  });

  it("asks for a place in a room and a link online, both when hybrid, and refuses the other instead of dropping it", () => {
    const link = "https://meet.example.test/synthetic-1";
    expect(messages(scheduleMeetingSchema.safeParse({ ...room, location: " " }))).toEqual([
      "location:validation.required",
    ]);
    expect(messages(scheduleMeetingSchema.safeParse({ ...room, onlineUrl: link }))).toEqual([
      "onlineUrl:validation.noLinkInPerson",
    ]);
    const online = { ...room, mode: "TEAMS", location: "" };
    expect(messages(scheduleMeetingSchema.safeParse(online))).toEqual(["onlineUrl:validation.required"]);
    expect(scheduleMeetingSchema.safeParse({ ...online, onlineUrl: link }).success).toBe(true);
    expect(
      messages(scheduleMeetingSchema.safeParse({ ...online, onlineUrl: link, location: "Room (synthetic)" })),
    ).toEqual(["location:validation.noPlaceOnline"]);
    expect(scheduleMeetingSchema.safeParse({ ...room, mode: "HYBRID", onlineUrl: link }).success).toBe(true);
    expect(messages(scheduleMeetingSchema.safeParse({ ...room, mode: "HYBRID" }))).toEqual([
      "onlineUrl:validation.required",
    ]);
  });

  it("names each problem with a message the form can show, never the generic one", () => {
    // fieldErrors passes on only validation.* keys: anything else would reach the form as "not valid".
    const r = scheduleMeetingSchema.safeParse({ ...room, mode: "TEAMS" });
    expect(r.success ? null : fieldErrors(r.error)).toEqual({
      location: "validation.noPlaceOnline",
      onlineUrl: "validation.required",
    });
  });

  it("takes only an https link of 12 to 500 characters with no spaces, as the command does", () => {
    const online = { ...room, mode: "TEAMS", location: undefined };
    for (const onlineUrl of [
      "http://meet.example.test/x",
      "https://a b.example.test",
      "https://x",
      "javascript:alert(1)",
    ]) {
      expect(messages(scheduleMeetingSchema.safeParse({ ...online, onlineUrl }))).toEqual([
        "onlineUrl:validation.httpsLink",
      ]);
    }
    expect(
      scheduleMeetingSchema.safeParse({ ...online, onlineUrl: `https://example.test/${"x".repeat(479)}` })
        .success,
    ).toBe(true);
    expect(
      scheduleMeetingSchema.safeParse({ ...online, onlineUrl: `https://example.test/${"x".repeat(480)}` })
        .success,
    ).toBe(false);
  });

  it("takes only the purposes and modes the command accepts", () => {
    expect(scheduleMeetingSchema.safeParse({ ...room, purpose: "VOTE" }).success).toBe(false);
    expect(scheduleMeetingSchema.safeParse({ ...room, mode: "PHONE" }).success).toBe(false);
    expect(scheduleMeetingSchema.safeParse({ ...room, purpose: "HEARING" }).success).toBe(true);
  });

  it("an emergency meeting needs its own reason of 10 characters or more", () => {
    expect(messages(scheduleEmergencyMeetingSchema.safeParse(room))).toEqual([
      "emergencyReason:validation.required",
    ]);
    expect(
      messages(scheduleEmergencyMeetingSchema.safeParse({ ...room, emergencyReason: "Urgent" })),
    ).toEqual(["emergencyReason:validation.tooShort"]);
    expect(
      scheduleEmergencyMeetingSchema.safeParse({
        ...room,
        emergencyReason: "Synthetic: a deadline falls first.",
      }).success,
    ).toBe(true);
  });
});

describe("the proceeding's committee and the meeting's logistics (P12-2b)", () => {
  it("adding a member to a proceeding names the membership and a reason of 10 characters or more", () => {
    expect(
      amendProceedingSnapshotSchema.safeParse({
        committeeProceedingId: ID,
        membershipId: ID,
        reason: "Synthetic: appointed after referral.",
      }).success,
    ).toBe(true);
    expect(
      messages(
        amendProceedingSnapshotSchema.safeParse({
          committeeProceedingId: ID,
          membershipId: "",
          reason: "short",
        }),
      ),
    ).toEqual(["membershipId:validation.invalid", "reason:validation.tooShort"]);
  });

  it("excluding a witness and each activation need a reason of 10 to 2,000 characters", () => {
    const full = "Synthetic: the chair is absent today.";
    expect(excludeMeetingWitnessSchema.safeParse({ participantId: ID, reason: full }).success).toBe(true);
    expect(activateActingChairSchema.safeParse({ meetingId: ID, reason: full }).success).toBe(true);
    expect(activateActingSecretarySchema.safeParse({ meetingId: ID, reason: full }).success).toBe(true);
    for (const r of [
      excludeMeetingWitnessSchema.safeParse({ participantId: ID, reason: "Too short" }),
      activateActingChairSchema.safeParse({ meetingId: ID, reason: "Too short" }),
      activateActingSecretarySchema.safeParse({ meetingId: ID, reason: "Too short" }),
    ]) {
      expect(messages(r)).toEqual(["reason:validation.tooShort"]);
    }
    expect(
      activateAlternateMemberSchema.safeParse({
        alternateParticipantId: ID,
        replacesParticipantId: ID,
        reason: full,
      }).success,
    ).toBe(true);
    expect(
      messages(activateAlternateMemberSchema.safeParse({ alternateParticipantId: ID, reason: full })),
    ).toEqual(["replacesParticipantId:validation.invalid"]);
  });

  it("an accommodation is 5 to 2,000 characters", () => {
    expect(
      recordMeetingAccommodationSchema.safeParse({
        participantId: ID,
        details: "Step-free access (synthetic).",
      }).success,
    ).toBe(true);
    expect(
      messages(recordMeetingAccommodationSchema.safeParse({ participantId: ID, details: "Lift" })),
    ).toEqual(["details:validation.tooShort"]);
    expect(messages(recordMeetingAccommodationSchema.safeParse({ participantId: ID, details: "" }))).toEqual([
      "details:validation.required",
    ]);
  });
});
