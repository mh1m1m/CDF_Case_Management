// ADR-034 D3: the container is checked before anything is inflated, and nothing inflates past what it declares.
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { rawZip } from "./test-zip";
import { ZipArchive, ZipRejected, crc32, isSafeEntryName, type ZipLimits } from "./zip";
import { storedZip } from "./workbook-writer";

const LIMITS: ZipLimits = {
  maxArchiveBytes: 1024 * 1024,
  maxEntries: 10,
  maxEntryBytes: 64 * 1024,
  maxTotalBytes: 128 * 1024,
  maxRatio: 100,
};

const text = (b: Uint8Array) => new TextDecoder().decode(b);

function rejection(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ZipRejected) return e.code;
    throw e;
  }
  return "ACCEPTED";
}

describe("ZIP container (untrusted upload)", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("reads stored and deflated entries and checks their CRC", () => {
    const zip = ZipArchive.open(
      rawZip([
        { name: "a.xml", data: "<a/>" },
        { name: "dir/b.xml", data: "<b>".repeat(200), method: 8 },
        { name: "dir/", data: "" },
      ]),
      LIMITS,
    );
    expect([...zip.entries.keys()]).toEqual(["a.xml", "dir/b.xml"]);
    expect(text(zip.read("a.xml"))).toBe("<a/>");
    expect(text(zip.read("dir/b.xml"))).toBe("<b>".repeat(200));
  });

  it("reads what the template writer stores", () => {
    const zip = ZipArchive.open(storedZip([["x/y.xml", new TextEncoder().encode("<y/>")]]), LIMITS);
    expect(text(zip.read("x/y.xml"))).toBe("<y/>");
  });

  it("refuses unsafe entry names", () => {
    for (const name of [
      "../x.xml",
      "a/../../x.xml",
      "/abs.xml",
      "a\\b.xml",
      "C:x.xml",
      "a/./b.xml",
      "a//b.xml",
      "",
      "a\u0000b",
    ]) {
      expect(isSafeEntryName(name), JSON.stringify(name)).toBe(false);
      if (name !== "")
        expect(
          rejection(() => ZipArchive.open(rawZip([{ name, data: "x" }]), LIMITS)),
          name,
        ).toBe("UNSAFE_PATH");
    }
    for (const name of ["xl/workbook.xml", "[Content_Types].xml", "_rels/.rels", "docProps/"]) {
      expect(isSafeEntryName(name), name).toBe(true);
    }
  });

  it("refuses duplicate names, also by case", () => {
    expect(
      rejection(() =>
        ZipArchive.open(
          rawZip([
            { name: "xl/a.xml", data: "1" },
            { name: "XL/A.xml", data: "2" },
          ]),
          LIMITS,
        ),
      ),
    ).toBe("DUPLICATE_ENTRY");
  });

  it("checks the archive size, entry count and declared sizes before inflating anything", () => {
    expect(rejection(() => ZipArchive.open(new Uint8Array(LIMITS.maxArchiveBytes + 1), LIMITS))).toBe(
      "TOO_LARGE",
    );
    expect(rejection(() => ZipArchive.open(new Uint8Array(100), LIMITS))).toBe("NOT_A_ZIP");
    expect(rejection(() => ZipArchive.open(new TextEncoder().encode("PK not really a zip"), LIMITS))).toBe(
      "NOT_A_ZIP",
    );
    const many = Array.from({ length: LIMITS.maxEntries + 1 }, (_, i) => ({ name: `e${i}.xml`, data: "x" }));
    expect(rejection(() => ZipArchive.open(rawZip(many), LIMITS))).toBe("TOO_MANY_ENTRIES");
    // One entry declaring more than the per-entry cap, whatever it really holds.
    expect(
      rejection(() =>
        ZipArchive.open(
          rawZip([{ name: "big.xml", data: "x", declaredSize: LIMITS.maxEntryBytes + 1 }]),
          LIMITS,
        ),
      ),
    ).toBe("ENTRY_TOO_LARGE");
    // Entries under the per-entry cap that add up past the total.
    const half = new Uint8Array(LIMITS.maxEntryBytes).fill(65);
    expect(
      rejection(() =>
        ZipArchive.open(
          rawZip([
            { name: "1.xml", data: half, method: 8 },
            { name: "2.xml", data: half, method: 8 },
            { name: "3.xml", data: half, method: 8 },
          ]),
          { ...LIMITS, maxRatio: 10_000 },
        ),
      ),
    ).toBe("TOTAL_TOO_LARGE");
  });

  it("refuses a zip bomb by its ratio, and never inflates past the declared size", () => {
    const zeros = new Uint8Array(60 * 1024);
    expect(
      rejection(() => ZipArchive.open(rawZip([{ name: "bomb.xml", data: zeros, method: 8 }]), LIMITS)),
    ).toBe("RATIO_TOO_HIGH");
    // A stream that lies about its size: it declares 100 bytes and would inflate to 60 KiB.
    const liar = ZipArchive.open(rawZip([{ name: "liar.xml", data: zeros, method: 8, declaredSize: 100 }]), {
      ...LIMITS,
      maxRatio: 10_000,
    });
    expect(rejection(() => liar.read("liar.xml"))).toBe("CORRUPT");
    expect(deflateRawSync(zeros).length).toBeLessThan(100);
  });

  it("refuses encryption, unknown methods, ZIP64, a bad CRC and mismatched local headers", () => {
    expect(
      rejection(() => ZipArchive.open(rawZip([{ name: "e.xml", data: "x", flags: 0x0801 }]), LIMITS)),
    ).toBe("ENCRYPTED");
    expect(rejection(() => ZipArchive.open(rawZip([{ name: "m.xml", data: "x", method: 12 }]), LIMITS))).toBe(
      "UNSUPPORTED_METHOD",
    );
    expect(
      rejection(() =>
        ZipArchive.open(rawZip([{ name: "z.xml", data: "x", declaredSize: 0xffffffff }]), LIMITS),
      ),
    ).toBe("ZIP64");
    expect(
      rejection(() =>
        ZipArchive.open(rawZip([{ name: "a.xml", data: "x" }], { totalOverride: 0xffff }), LIMITS),
      ),
    ).toBe("ZIP64");
    const badCrc = ZipArchive.open(rawZip([{ name: "c.xml", data: "abc", declaredCrc: 1 }]), LIMITS);
    expect(rejection(() => badCrc.read("c.xml"))).toBe("CORRUPT");
    const renamed = ZipArchive.open(rawZip([{ name: "a.xml", data: "abc", localName: "../a.xml" }]), LIMITS);
    expect(rejection(() => renamed.read("a.xml"))).toBe("CORRUPT");
    const stored = ZipArchive.open(rawZip([{ name: "a.xml", data: "abc" }]), LIMITS);
    expect(rejection(() => stored.read("missing.xml"))).toBe("CORRUPT");
  });

  it("tolerates an archive comment but not trailing garbage", () => {
    expect(
      ZipArchive.open(rawZip([{ name: "a.xml", data: "x" }], { comment: "synthetic" }), LIMITS).entries.size,
    ).toBe(1);
    const zip = rawZip([{ name: "a.xml", data: "x" }]);
    const padded = new Uint8Array(zip.length + 4);
    padded.set(zip);
    expect(rejection(() => ZipArchive.open(padded, LIMITS))).toBe("NOT_A_ZIP");
  });
});
