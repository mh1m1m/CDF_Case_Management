// Shared foundation (UX redesign S0): the status registry, the indicators, bidi-safe identifiers and the
// decision panel. Rendered to static markup, so these run with the unit suite and need no browser.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ALLEGATION_STATUSES,
  BCP_BATCH_STATUSES,
  CORRECTIVE_ACTION_STATUSES,
  EVIDENCE_STATUSES,
  EVIDENCE_VERSION_STATUSES,
  EXPORT_STATUSES,
  FORM_STATUSES,
  INTERVIEW_STATUSES,
  LEGAL_HOLD_REQUEST_STATUSES,
  MEETING_CONFLICT_CONCERN_STATUSES,
  MEETING_STATUSES,
  MINUTES_STATUSES,
  RECORDS_STATES,
  REPORT_STATUSES,
  VOTE_ITEM_STATUSES,
} from "@cdf/contracts";
import { describe, expect, it } from "vitest";
import { CDFDescriptionList } from "./components";
import { CDFDecisionPanel } from "./decision-panel";
import { CDFDateTime, CDFIdentifier, CDFMeta, CDFRecordDate } from "./identifier";
import {
  CDFClassificationBadge,
  CDFLegalHoldIndicator,
  CDFNamedAccessFlag,
  CDFStatusBadge,
  STATUS_TONES,
  statusTone,
} from "./status";

describe("status registry", () => {
  it("has a tone for every status code of every domain", () => {
    const domains: [keyof typeof STATUS_TONES, readonly string[]][] = [
      ["report", REPORT_STATUSES],
      ["form", FORM_STATUSES],
      ["interview", INTERVIEW_STATUSES],
      ["evidence", EVIDENCE_STATUSES],
      ["evidenceVersion", EVIDENCE_VERSION_STATUSES],
      ["records", RECORDS_STATES],
      ["holdRequest", LEGAL_HOLD_REQUEST_STATUSES],
      ["meeting", MEETING_STATUSES],
      ["voteItem", VOTE_ITEM_STATUSES],
      ["minutes", MINUTES_STATUSES],
      ["concern", MEETING_CONFLICT_CONCERN_STATUSES],
      ["allegation", ALLEGATION_STATUSES],
      ["correctiveAction", CORRECTIVE_ACTION_STATUSES],
      ["exportRequest", EXPORT_STATUSES],
      ["bcpImport", BCP_BATCH_STATUSES],
    ];
    for (const [domain, codes] of domains)
      expect(Object.keys(STATUS_TONES[domain]).sort(), domain).toEqual([...codes].sort());
  });

  it("keeps red for failures only", () => {
    const red = Object.entries(STATUS_TONES).flatMap(([domain, tones]) =>
      Object.entries(tones as Record<string, string>)
        .filter(([, tone]) => tone === "danger")
        .map(([code]) => `${domain}.${code}`),
    );
    expect(red.sort()).toEqual(
      ["attachment.REJECTED", "evidence.REJECTED", "evidenceVersion.REJECTED", "scan.INFECTED"].sort(),
    );
  });

  it("gives one status the same tone wherever it appears, and an unknown code a neutral tone", () => {
    // The audit found REVIEWED green on forms and amber on interviews; both wait for an approver.
    expect(statusTone("form", "REVIEWED")).toBe(statusTone("interview", "REVIEWED"));
    expect(statusTone("form", "PREPARED")).toBe(statusTone("interview", "PREPARED"));
    expect(statusTone("records", "SOMETHING_NEW")).toBe("neutral");
  });

  it("renders the label as text, so colour is never the only cue", () => {
    const html = renderToStaticMarkup(
      h(CDFStatusBadge, { domain: "form", status: "APPROVED", testId: "s", children: "Approved" }),
    );
    expect(html).toContain(">Approved<");
    expect(html).toContain('data-status="APPROVED"');
    expect(html).toContain("rounded-full");
  });
});

describe("indicators", () => {
  it("draws classification as an outlined rectangle with a glyph, never in the danger colour", () => {
    for (const level of ["INTERNAL", "RESTRICTED", "CONFIDENTIAL", "SECRET"]) {
      const html = renderToStaticMarkup(h(CDFClassificationBadge, { level, label: level }));
      expect(html).toContain("border-cdf-indicator-outline");
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toContain("danger");
      expect(html).toContain(`>${level}</span>`);
    }
  });

  it("keeps the named-access flag and the legal-hold indicator out of red", () => {
    const flag = renderToStaticMarkup(h(CDFNamedAccessFlag, { label: "Restricted case" }));
    const hold = renderToStaticMarkup(h(CDFLegalHoldIndicator, { label: "Legal hold" }));
    expect(flag).toContain("bg-cdf-named-access");
    expect(hold).toContain("bg-cdf-legal-hold");
    for (const html of [flag, hold]) expect(html).not.toContain("danger");
  });
});

describe("bidi-safe identifiers", () => {
  it("isolates a case number left-to-right and keeps it on one line", () => {
    const html = renderToStaticMarkup(h(CDFIdentifier, null, "CDF-DEMO-2026-0001"));
    expect(html).toBe('<bdi dir="ltr" class="whitespace-nowrap tabular-nums">CDF-DEMO-2026-0001</bdi>');
  });

  it("gives a date a machine-readable value and an isolated Arabic label", () => {
    const html = renderToStaticMarkup(h(CDFDateTime, { value: "2026-10-11T09:04:00.000Z", locale: "ar" }));
    expect(html).toMatch(
      /^<time datetime="2026-10-11T09:04:00.000Z"><bdi class="whitespace-nowrap">[^<]+<\/bdi><\/time>$/i,
    );
  });

  it("gives a record date both calendars, each kept on one line, and the stored value as its machine date (DEC-51)", () => {
    const html = renderToStaticMarkup(
      h(CDFRecordDate, { value: "2026-10-13T11:05:00.000Z", locale: "en", withTime: true }),
    );
    expect(html).toMatch(/^<time datetime="2026-10-13T11:05:00.000Z"><bdi>/i);
    expect(html).toContain(
      '<span data-part="gregorian" class="whitespace-nowrap">13 October 2026</span> (' +
        '<span data-part="hijri" class="whitespace-nowrap">2 Jumada I 1448H</span>), ' +
        '<span data-part="time" class="whitespace-nowrap">14:05</span></bdi></time>',
    );
    const ar = renderToStaticMarkup(h(CDFRecordDate, { value: "2026-10-13T11:05:00.000Z", locale: "ar" }));
    expect(ar).toContain('<span data-part="hijri" class="whitespace-nowrap">2 جمادى الأولى 1448هـ</span>');
  });

  it("stacks a description list in a narrow column, so a formal date never pushes past it", () => {
    const items = [{ term: "Generated", value: "13 October 2026 (2 Jumada I 1448H)" }];
    expect(renderToStaticMarkup(h(CDFDescriptionList, { items }))).toContain(
      "sm:grid-cols-[max-content_1fr]",
    );
    expect(renderToStaticMarkup(h(CDFDescriptionList, { items, stacked: true }))).not.toContain(
      "grid-cols-[",
    );
  });

  it("isolates every part of a metadata line, and hides the separators", () => {
    const html = renderToStaticMarkup(
      h(CDFMeta, {
        parts: [
          { key: "n", value: "10" },
          { key: "at", value: "2026/10/11" },
          { key: "who", value: "Triage Officer Beta" },
          { key: "empty", value: "" },
        ],
      }),
    );
    expect(html.match(/<bdi>/g)).toHaveLength(3);
    expect(html.match(/aria-hidden="true">·</g)).toHaveLength(2);
    expect(html).toContain("<bdi>Triage Officer Beta</bdi>");
  });
});

describe("decision panel", () => {
  const panel = (reasonAlways = false) =>
    renderToStaticMarkup(
      h(CDFDecisionPanel, {
        id: "decision",
        name: "decision",
        legend: "Decision",
        requiredLabel: "Required",
        notice: "You prepared this form, so you cannot approve it.",
        options: [
          { value: "APPROVE", label: "Approve", consequence: "The form becomes final." },
          {
            value: "RETURN",
            label: "Return",
            consequence: "The preparer is asked to change it.",
            requiresReason: true,
          },
        ],
        reason: { name: "reason", label: "Reason", requiredLabel: "Required", always: reasonAlways },
      }),
    );

  it("pre-selects nothing", () => {
    expect(panel()).not.toMatch(/\schecked=""/);
  });

  it("states each option's consequence and ties it to the option", () => {
    const html = panel();
    expect(html).toContain('aria-describedby="decision-consequence"');
    expect(html).toContain('id="decision-consequence"');
    expect(html).toContain('aria-describedby="decision-1-consequence"');
    expect(html).toContain("The preparer is asked to change it.");
  });

  it("states who may not decide before the options", () => {
    const html = panel();
    expect(html.indexOf("cannot approve it")).toBeLessThan(html.indexOf("The form becomes final."));
  });

  it("keeps the reason hidden and unsubmitted until an option needs it", () => {
    const hidden = panel();
    expect(hidden).toMatch(/<div class="mt-4" hidden="">/);
    expect(hidden).toMatch(/<textarea[^>]*disabled=""/);
    const always = panel(true);
    expect(always).not.toMatch(/hidden=""/);
    expect(always).toMatch(/<textarea[^>]*required=""/);
  });
});
