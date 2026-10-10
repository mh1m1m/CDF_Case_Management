import { describe, expect, it } from "vitest";
import {
  ALLOWED_CONTENT_TYPES,
  EVIDENCE_MAX_BYTES,
  checkEvidenceFile,
  detectContentType,
  evidenceDisplayNumber,
  extensionOf,
  sanitizeFileName,
} from "./evidence";

const bytes = (s: string) => new TextEncoder().encode(s);
const pdf = bytes("%PDF-1.7\n%synthetic");
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);

describe("evidence file rules", () => {
  it("sanitises names: strips paths and control characters, never empty, bounded", () => {
    expect(sanitizeFileName("..\\..\\etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\x\\report.pdf")).toBe("report.pdf");
    expect(sanitizeFileName(" inv\u0000oice\u001f .pdf ")).toBe("invoice .pdf");
    expect(sanitizeFileName("...")).toBe("evidence");
    expect(sanitizeFileName("")).toBe("evidence");
    const long = sanitizeFileName("a".repeat(300) + ".pdf");
    expect(long.length).toBeLessThanOrEqual(255);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("maps extensions case-insensitively and rejects unknown ones", () => {
    expect(extensionOf("Report.PDF")).toBe("pdf");
    expect(extensionOf("noext")).toBeNull();
    const exts = ALLOWED_CONTENT_TYPES.flatMap((t) => t.extensions);
    for (const bad of ["exe", "js", "html", "zip", "bat", "sh", "svg", "docm"])
      expect(exts).not.toContain(bad);
  });

  it("sniffs content types from magic numbers", () => {
    expect(detectContentType(pdf)).toBe("application/pdf");
    expect(detectContentType(png)).toBe("image/png");
    expect(detectContentType(zip)).toBe("application/zip");
    expect(detectContentType(bytes("plain text, العربية"))).toBe("text/*");
    expect(detectContentType(new Uint8Array([0, 1, 2, 3, 0xff, 0xfe]))).toBeNull();
    expect(detectContentType(new Uint8Array())).toBeNull();
  });

  it("accepts a consistent file and canonicalises its content type", () => {
    const r = checkEvidenceFile({ fileName: "scan.PDF", size: pdf.length, bytes: pdf });
    expect(r).toEqual({
      ok: true,
      fileName: "scan.PDF",
      contentType: "application/pdf",
      evidenceType: "DOCUMENT",
    });
    const docx = checkEvidenceFile({ fileName: "memo.docx", size: zip.length, bytes: zip });
    expect(docx.ok && docx.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const csv = checkEvidenceFile({ fileName: "export.csv", size: 10, bytes: bytes("a,b\n1,2\n") });
    expect(csv.ok && csv.evidenceType).toBe("DATA_EXPORT");
  });

  it("rejects disallowed extensions, mismatched content, empty and oversized files", () => {
    expect(checkEvidenceFile({ fileName: "tool.exe", size: 4, bytes: bytes("MZ..") })).toMatchObject({
      ok: false,
      reason: "EXTENSION_NOT_ALLOWED",
    });
    expect(checkEvidenceFile({ fileName: "noext", size: 4, bytes: pdf })).toMatchObject({
      ok: false,
      reason: "EXTENSION_NOT_ALLOWED",
    });
    // An executable renamed to .pdf, or a PDF renamed to .png
    expect(checkEvidenceFile({ fileName: "x.pdf", size: 4, bytes: bytes("MZ\u0000\u0001") })).toMatchObject({
      ok: false,
      reason: "CONTENT_MISMATCH",
    });
    expect(checkEvidenceFile({ fileName: "x.png", size: pdf.length, bytes: pdf })).toMatchObject({
      ok: false,
      reason: "CONTENT_MISMATCH",
    });
    // Binary content in a text extension, HTML-ish text is still text (sanitised on download by nosniff + attachment)
    expect(
      checkEvidenceFile({ fileName: "notes.txt", size: 4, bytes: new Uint8Array([0, 1, 2, 3]) }),
    ).toMatchObject({
      ok: false,
      reason: "CONTENT_MISMATCH",
    });
    expect(checkEvidenceFile({ fileName: "empty.pdf", size: 0, bytes: new Uint8Array() })).toMatchObject({
      ok: false,
      reason: "EMPTY",
    });
    expect(
      checkEvidenceFile({ fileName: "big.pdf", size: EVIDENCE_MAX_BYTES + 1, bytes: pdf }),
    ).toMatchObject({
      ok: false,
      reason: "TOO_LARGE",
    });
  });

  it("formats display numbers", () => {
    expect(evidenceDisplayNumber(1)).toBe("EV-001");
    expect(evidenceDisplayNumber(1234)).toBe("EV-1234");
  });
});
