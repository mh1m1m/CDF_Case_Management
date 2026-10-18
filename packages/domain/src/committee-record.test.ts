import { describe, expect, it } from "vitest";
import { COMMITTEE_MINUTES_MAX_BYTES, COMMITTEE_RECORD_STATUSES } from "@cdf/contracts";
import {
  checkCommitteeMinutesFile,
  committeeRecordWaitingOn,
  isCommitteeRecordEditable,
  isCommitteeRecordFinal,
} from "./committee-record";

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);

describe("the signed minutes file (ADR-061: wet-ink signed and scanned)", () => {
  it.each([
    ["minutes.pdf", text("%PDF-1.7 synthetic"), "application/pdf"],
    ["scan.PNG", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a), "image/png"],
    ["scan.jpeg", bytes(0xff, 0xd8, 0xff, 0xe0), "image/jpeg"],
    ["scan.tif", bytes(0x49, 0x49, 0x2a, 0x00, 0x08), "image/tiff"],
    ["scan.tiff", bytes(0x4d, 0x4d, 0x00, 0x2a, 0x00), "image/tiff"],
  ])("accepts %s", (fileName, b, contentType) => {
    expect(checkCommitteeMinutesFile({ fileName, size: b.length, bytes: b })).toMatchObject({
      ok: true,
      contentType,
    });
  });

  it.each([
    ["minutes.docx", bytes(0x50, 0x4b, 0x03, 0x04), "TYPE_NOT_ALLOWED"],
    ["minutes.doc", bytes(0xd0, 0xcf, 0x11, 0xe0), "TYPE_NOT_ALLOWED"],
    ["minutes.txt", text("signed"), "TYPE_NOT_ALLOWED"],
    ["minutes", text("%PDF-1.7"), "NAME_INVALID"],
    ["minutes.pdf", bytes(0x89, 0x50, 0x4e, 0x47), "CONTENT_MISMATCH"],
    ["minutes.tif", text("%PDF-1.7"), "CONTENT_MISMATCH"],
    ["minutes.pdf", new Uint8Array(), "EMPTY"],
  ])("refuses %s (%s)", (fileName, b, reason) => {
    expect(checkCommitteeMinutesFile({ fileName, size: b.length, bytes: b })).toMatchObject({
      ok: false,
      reason,
    });
  });

  it("refuses more than 25 MiB", () => {
    const b = text("%PDF-1.7");
    expect(
      checkCommitteeMinutesFile({ fileName: "m.pdf", size: COMMITTEE_MINUTES_MAX_BYTES + 1, bytes: b }),
    ).toMatchObject({ ok: false, reason: "TOO_LARGE" });
  });

  it("never turns a path into a name", () => {
    const r = checkCommitteeMinutesFile({
      fileName: "../../etc/minutes.pdf",
      size: 8,
      bytes: text("%PDF-1.7"),
    });
    expect(r.fileName).not.toContain("/");
  });
});

describe("record states", () => {
  it("only a draft or a returned record is edited; committed, rejected and cancelled are final", () => {
    expect(COMMITTEE_RECORD_STATUSES.filter(isCommitteeRecordEditable)).toEqual(["DRAFT", "RETURNED"]);
    expect(COMMITTEE_RECORD_STATUSES.filter(isCommitteeRecordFinal)).toEqual([
      "COMMITTED",
      "REJECTED",
      "CANCELLED",
    ]);
  });

  it("each state waits on one party; neither layer stands in for the other", () => {
    expect(
      Object.fromEntries(COMMITTEE_RECORD_STATUSES.map((s) => [s, committeeRecordWaitingOn(s)])),
    ).toEqual({
      DRAFT: "IMPORTER",
      PENDING_CHAIR_APPROVAL: "CHAIR_APPROVAL",
      PLATFORM_ATTESTATION_IN_PROGRESS: "MEMBER_ATTESTATIONS",
      FULLY_ATTESTED: "MEMBER_ATTESTATIONS",
      READY_TO_COMMIT: "COMMIT",
      COMMITTED: "NOTHING",
      RETURNED: "IMPORTER",
      REJECTED: "NOTHING",
      CANCELLED: "NOTHING",
    });
  });
});
