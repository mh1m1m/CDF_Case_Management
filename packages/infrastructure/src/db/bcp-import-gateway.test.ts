// The continuity batch's read model mapping (UX redesign P12-6b-1; `api.bcp_import_batch_view`, final in migration
// 2110). The gateway renames keys and decides nothing, so these pin what the page relies on: row metadata only, a
// capability or flag the database left out or null reads as false (fail closed), the per-row flag is SKIP only, a list
// it left out is empty, and timestamps are ISO instants.
import { describe, expect, it } from "vitest";
import { toBcpImportBatchView, type RawBcpBatchView } from "./bcp-import-gateway";

const BATCH = "44444444-4444-4444-8444-444444444444";
const ROW = "55555555-5555-4555-8555-555555555555";
const CASE = "11111111-1111-4111-8111-111111111111";
const IMPORTER = "a0000000-0000-4000-8000-000000000003";
const PREPARER = "a0000000-0000-4000-8000-000000000005";
const HASH = "b".repeat(64);

const raw: RawBcpBatchView = {
  batch_id: BATCH,
  template_version: "BCP-1",
  workbook_id: "BCP-DEMO-0002-WB1",
  scope: "CASE",
  committee_proceeding_id: null,
  file_sha256: "a".repeat(64),
  offline_from: "2026-10-01 08:00:00+03",
  offline_to: null,
  prepared_by: PREPARER,
  status: "STAGED",
  preview_hash: HASH,
  previewed_at: "2026-10-18 12:00:00+03",
  preview_clean: true,
  submitted_hash: null,
  imported_by: IMPORTER,
  decided_by: null,
  decision_reason: null,
  created_at: "2026-10-18 11:00:00+03",
  submitted_at: null,
  decided_at: null,
  applied_at: null,
  cancelled_at: null,
  updated_at: "2026-10-18 12:00:00+03",
  row_version: 3,
  current_hash: HASH,
  workbook_revoked: false,
  official_record_required: false,
  counts: { rows: 2, unresolved: 0, by_state: { NEW: 1, INVALID: 1 } },
  rows: [
    {
      row_id: ROW,
      sheet_code: "06_ALLEGATIONS",
      row_number: 5,
      row_key: "BCP-A3",
      state: "INVALID",
      detail: "ORIGINAL_EVENT_AT",
      resolution: "SKIP",
      resolution_reason: "Synthetic: resolved during the import review.",
      resolved_by: IMPORTER,
      resolved_at: "2026-10-18 11:30:00+03",
      outcome: null,
      original_event_at: null,
      recorded_offline_by: null,
      purged_at: null,
      may_resolve: true,
    },
  ],
  case: { case_id: CASE, case_number: "CDF-DEMO-2026-0002" },
  capabilities: {
    may_resolve_rows: true,
    may_preview: true,
    may_submit: true,
    may_decide: false,
    may_approve: false,
    may_apply: false,
    may_cancel: true,
  },
};

describe("continuity batch view mapping", () => {
  it("renames every key, writes timestamps as ISO instants and keeps the counts", () => {
    const v = toBcpImportBatchView(raw);
    expect(v).toMatchObject({
      batchId: BATCH,
      templateVersion: "BCP-1",
      workbookId: "BCP-DEMO-0002-WB1",
      scope: "CASE",
      committeeProceedingId: null,
      offlineFrom: "2026-10-01T05:00:00.000Z",
      offlineTo: null,
      preparedBy: PREPARER,
      importedBy: IMPORTER,
      status: "STAGED",
      previewHash: HASH,
      previewedAt: "2026-10-18T09:00:00.000Z",
      previewClean: true,
      createdAt: "2026-10-18T08:00:00.000Z",
      currentHash: HASH,
      workbookRevoked: false,
      officialRecordRequired: false,
      counts: { rows: 2, unresolved: 0, ballots: 0, byState: { NEW: 1, INVALID: 1 } },
      caseId: CASE,
      caseNumber: "CDF-DEMO-2026-0002",
      capabilities: {
        mayResolveRows: true,
        mayPreview: true,
        maySubmit: true,
        mayDecide: false,
        mayApprove: false,
        mayApply: false,
        mayCancel: true,
      },
    });
    expect(v.rows).toEqual([
      {
        rowId: ROW,
        sheetCode: "06_ALLEGATIONS",
        rowNumber: 5,
        rowKey: "BCP-A3",
        state: "INVALID",
        detail: "ORIGINAL_EVENT_AT",
        resolution: "SKIP",
        resolutionReason: "Synthetic: resolved during the import review.",
        resolvedBy: IMPORTER,
        resolvedAt: "2026-10-18T08:30:00.000Z",
        outcome: null,
        originalEventAt: null,
        recordedOfflineBy: null,
        purgedAt: null,
        maySkip: true,
      },
    ]);
    // Row metadata only: nothing named like a cell or the control block survives the mapping.
    expect(Object.keys(v.rows[0]!)).not.toContain("cells");
    expect(Object.keys(v)).not.toContain("control");
  });

  it("fails closed: null or missing flags are false, missing lists and counts are empty", () => {
    const v = toBcpImportBatchView({
      ...raw,
      preview_clean: null,
      workbook_revoked: null,
      official_record_required: null,
      counts: null,
      rows: [{ ...raw.rows![0]!, may_resolve: null }],
      case: null,
      capabilities: null,
    });
    expect([v.previewClean, v.workbookRevoked, v.officialRecordRequired]).toEqual([false, false, false]);
    expect(v.counts).toEqual({ rows: 0, unresolved: 0, ballots: 0, byState: {} });
    expect(v.rows[0]!.maySkip).toBe(false);
    expect([v.caseId, v.caseNumber]).toEqual([null, null]);
    expect(Object.values(v.capabilities).every((f) => f === false)).toBe(true);
    expect(toBcpImportBatchView({ ...raw, rows: null }).rows).toEqual([]);
  });
});
