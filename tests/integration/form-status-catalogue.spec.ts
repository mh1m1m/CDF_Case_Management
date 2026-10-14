// Business architecture rebase phase 11, migration 1970 (ADR-028, ADR-029, ADR-035): the form and status catalogue as
// reference data. The catalogue is grounded, not asserted: stored dimension values equal the columns' own check
// constraints or config.status_code, every audit event it names is emitted by a command today (or is marked PLANNED and
// emitted nowhere), every module command, permission and delivering migration exists, and the two rationalisation
// documents equal the database row for row. The suite fails when a later migration changes a vocabulary without the
// catalogue, or the catalogue without the documents.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { admin } from "../support/db";

const ROOT = join(import.meta.dirname, "..", "..");
const DOCS = join(ROOT, "docs", "business-architecture");
const MIGRATIONS = join(ROOT, "infrastructure", "supabase", "migrations");

/** The rows of the first markdown table under `heading`, as trimmed cells with escaped pipes restored. */
function docTable(file: string, heading: string): string[][] {
  const text = readFileSync(join(DOCS, file), "utf8");
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`${file}: no heading ${heading}`);
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(/\n## /);
  const lines = (end < 0 ? rest : rest.slice(0, end)).split("\n");
  const first = lines.findIndex((l) => l.startsWith("|"));
  const rows: string[][] = [];
  for (const line of lines.slice(first + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((c) => c.trim().replace(/\\\|/g, "|")),
    );
  }
  return rows;
}

const dash = (s: string) => (s === "—" || s === "" ? null : s);
const code = (s: string) => s.replace(/`/g, "");
const event = (s: string) => {
  const v = dash(s);
  if (v === null) return { event: null, state: null };
  return v.endsWith(" (planned)")
    ? { event: v.slice(0, -" (planned)".length), state: "PLANNED" }
    : { event: v, state: "IMPLEMENTED" };
};

interface StatusRow {
  catalogue: string;
  legacy_code: string;
  legacy_name_ar: string;
  legacy_name_en: string | null;
  semantic_type: string;
  target_dimension: string | null;
  target_value: string | null;
  target_event: string | null;
  target_event_state: string | null;
  target_module: string;
  disposition: string;
  duplicate_of: string | null;
  same_as_code: string | null;
  code_conflict: boolean;
  gap_ref: string | null;
}

async function statusRows(catalogue: string): Promise<StatusRow[]> {
  return admin<StatusRow[]>`
    select catalogue, legacy_code, legacy_name_ar, legacy_name_en, semantic_type, target_dimension, target_value,
           target_event, target_event_state, target_module, disposition, duplicate_of, same_as_code, code_conflict,
           gap_ref
    from config.legacy_status_map where catalogue = ${catalogue} order by legacy_code collate "C"`;
}

interface FormRow {
  catalogue: string;
  sequence_no: number;
  legacy_id: string;
  legacy_name: string;
  track: string;
  business_intent: string;
  target_class: string;
  target_module: string;
  merge_target: string;
  disposition: string;
  data_owner: string;
  actor: string;
  trigger_text: string | null;
  primary_status: string | null;
  resulting_status: string | null;
  allowed_statuses: string[];
  same_as: string[];
  legacy_state: string;
  source_required: string | null;
  gap_ref: string | null;
}

async function formRows(catalogue: string): Promise<FormRow[]> {
  return admin<FormRow[]>`
    select catalogue, sequence_no, legacy_id, legacy_name, track, business_intent, target_class, target_module,
           merge_target, disposition, data_owner, actor, trigger_text, primary_status, resulting_status,
           allowed_statuses, same_as, legacy_state, source_required, gap_ref
    from config.legacy_form_map where catalogue = ${catalogue} order by sequence_no`;
}

describe("status vocabulary is grounded in the schema", () => {
  it("each stored dimension holds exactly the values its column's check constraint allows", async () => {
    const rows = await admin<{ dimension: string; catalogue: string[]; constraint: string[] | null }[]>`
      select d.code as dimension,
             array(select v.value from config.status_dimension_value v where v.dimension = d.code
                   order by v.value collate "C") as catalogue,
             (select array(select m[1] from regexp_matches(pg_get_constraintdef(c.oid), '''([^'']*)''::text', 'g') m
                           order by m[1] collate "C")
              from pg_constraint c
              where c.conrelid = d.source_relation::regclass
                and c.conname = split_part(d.source_relation, '.', 2) || '_' || d.source_column || '_check') as constraint
      from config.status_dimension d where d.kind = 'STORED' order by d.code`;
    expect(rows.length).toBe(14);
    for (const r of rows) expect(r.catalogue, r.dimension).toEqual(r.constraint);
  });

  it("each status-code dimension holds exactly the active config.status_code rows, and every such row is in it", async () => {
    const rows = await admin<{ dimension: string; catalogue: string[]; codes: string[] }[]>`
      select d.code as dimension,
             array(select v.value from config.status_dimension_value v where v.dimension = d.code
                   order by v.value collate "C") as catalogue,
             array(select s.code from config.status_code s where s.dimension = d.code and s.is_active
                   order by s.code collate "C") as codes
      from config.status_dimension d where d.kind = 'STATUS_CODE' order by d.code`;
    expect(rows.map((r) => r.dimension)).toEqual(["OUTCOME_CODE", "SUSPENSION_REASON", "WAITING_REASON"]);
    for (const r of rows) expect(r.catalogue, r.dimension).toEqual(r.codes);
    // RETURN_REASON is a reason on a return action, not a status; it is the only status_code dimension left out.
    const [left] = await admin<{ dims: string[] }[]>`
      select array_agg(distinct s.dimension) as dims from config.status_code s
      where not exists (select 1 from config.status_dimension d where d.code = s.dimension)`;
    expect(left!.dims).toEqual(["RETURN_REASON"]);
  });

  it("names the column each stored dimension lives on", async () => {
    const missing = await admin<{ code: string }[]>`
      select d.code from config.status_dimension d
      where d.kind in ('STORED', 'STATUS_CODE')
        and not exists (select 1 from information_schema.columns c
                        where c.table_schema || '.' || c.table_name = d.source_relation
                          and c.column_name = d.source_column)`;
    expect(missing).toEqual([]);
  });

  it("marks stored values ACTIVE and derived or planned values PLANNED; every derived value says how", async () => {
    // Migration 2040 (DEC-F10): a stored value may also be INACTIVE, kept for existing records but refused for new
    // ones. Pinned below: only the owner's decision has withdrawn values so far.
    const wrong = await admin<{ dimension: string; value: string }[]>`
      select v.dimension, v.value from config.status_dimension_value v join config.status_dimension d on d.code = v.dimension
      where (d.kind in ('STORED', 'STATUS_CODE')) <> (v.state in ('ACTIVE', 'INACTIVE'))
         or (d.kind = 'DERIVED' and v.derivation is null)`;
    expect(wrong).toEqual([]);
    const inactive = await admin<{ dimension: string; value: string }[]>`
      select dimension, value from config.status_dimension_value where state = 'INACTIVE'
      order by dimension collate "C", value collate "C"`;
    expect(inactive).toEqual([
      { dimension: "PRELIMINARY_OUTCOME", value: "NOT_FEASIBLE" },
      { dimension: "PRELIMINARY_OUTCOME", value: "NO_PERSONAL_JURISDICTION" },
    ]);
  });

  it("adds the six reason codes the owner's 140-status list names, and nothing else", async () => {
    const rows = await admin<{ dimension: string; code: string; source_status: string }[]>`
      select dimension, code, source_status from config.status_code
      where code in ('HEARING', 'INVESTIGATOR_ASSIGNMENT', 'SUBJECT_STATEMENT', 'INVESTIGATOR_CHANGE',
                     'NON_COOPERATION', 'RESOURCE_SHORTAGE')
      order by dimension, code`;
    expect(rows).toEqual([
      { dimension: "SUSPENSION_REASON", code: "INVESTIGATOR_CHANGE", source_status: "OWNER_DEFAULT" },
      { dimension: "SUSPENSION_REASON", code: "NON_COOPERATION", source_status: "OWNER_DEFAULT" },
      { dimension: "SUSPENSION_REASON", code: "RESOURCE_SHORTAGE", source_status: "OWNER_DEFAULT" },
      { dimension: "WAITING_REASON", code: "HEARING", source_status: "OWNER_DEFAULT" },
      { dimension: "WAITING_REASON", code: "INVESTIGATOR_ASSIGNMENT", source_status: "OWNER_DEFAULT" },
      { dimension: "WAITING_REASON", code: "NON_COOPERATION", source_status: "OWNER_DEFAULT" },
      { dimension: "WAITING_REASON", code: "SUBJECT_STATEMENT", source_status: "OWNER_DEFAULT" },
    ]);
  });
});

describe("legacy statuses", () => {
  it("each catalogue's item count equals its mapped rows", async () => {
    const rows = await admin<{ code: string; item_count: number; mapped: number }[]>`
      select c.code, c.item_count,
             (select count(*)::int from config.legacy_status_map s where s.catalogue = c.code)
             + (select count(*)::int from config.legacy_form_map f where f.catalogue = c.code) as mapped
      from config.legacy_catalogue c order by c.code`;
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(r.mapped, r.code).toBe(r.item_count);
  });

  it("every IMPLEMENTED event is emitted by a command or a workflow transition today; no PLANNED one is", async () => {
    const rows = await admin<{ event: string; state: string; emitted: boolean }[]>`
      with src as (select string_agg(p.prosrc, ' ') as s from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname not in ('pg_catalog', 'information_schema'))
      select distinct m.target_event as event, m.target_event_state as state,
             position('''' || m.target_event || '''' in (select s from src)) > 0
               or exists (select 1 from workflow.workflow_transition_definition d
                          where d.audit_action = m.target_event) as emitted
      from config.legacy_status_map m where m.target_event is not null order by 1`;
    expect(rows.length).toBeGreaterThan(40);
    const wrong = rows.filter((r) => r.emitted !== (r.state === "IMPLEMENTED"));
    expect(wrong).toEqual([]);
    // One state per event: an event is either built or not.
    expect(new Set(rows.map((r) => r.event)).size).toBe(rows.length);
  });

  it("CDF_CASE_V1 rows are the live workflow states, and a state that sets a records state maps to it", async () => {
    const rows = await admin<
      { code: string; same_name: boolean; records_state: string; dim: string; value: string }[]
    >`
      select w.code, coalesce(m.legacy_name_ar = w.name_ar and m.legacy_name_en = w.name_en, false) as same_name,
             w.records_state, m.target_dimension as dim, m.target_value as value
      from workflow.workflow_state w
      full join config.legacy_status_map m on m.catalogue = 'CDF_CASE_V1' and m.legacy_code = w.code
      where w.workflow_code = 'CDF_CASE_V1' or m.catalogue = 'CDF_CASE_V1'
      order by w.sequence`;
    expect(rows).toHaveLength(15);
    for (const r of rows) {
      expect(r.same_name, r.code).toBe(true);
      if (r.records_state === "ACTIVE") expect(r.dim, r.code).toBe("CASE_STAGE");
      else expect([r.dim, r.value], r.code).toEqual(["RECORDS_STATE", r.records_state]);
    }
  });

  it("keeps both status catalogues: ten codes mean something else in the 140 list, every other code maps alike", async () => {
    const drive = await statusRows("CRM_STATUS_DRIVE_150");
    const d = await statusRows("CRM_STATUS_D_140");
    const range = (n: number) => Array.from({ length: n }, (_, i) => `S${String(i + 1).padStart(3, "0")}`);
    expect(drive.map((r) => r.legacy_code)).toEqual(range(150));
    expect(d.map((r) => r.legacy_code)).toEqual(range(140));
    expect(d.filter((r) => r.code_conflict).map((r) => r.legacy_code)).toEqual([
      "S021",
      "S022",
      "S023",
      "S025",
      "S026",
      "S027",
      "S028",
      "S030",
      "S099",
      "S100",
    ]);
    const byCode = new Map(drive.map((r) => [r.legacy_code, r]));
    const target = (r: StatusRow) => ({
      semantic_type: r.semantic_type,
      target_dimension: r.target_dimension,
      target_value: r.target_value,
      target_event: r.target_event,
      target_module: r.target_module,
      disposition: r.disposition,
      duplicate_of: r.duplicate_of,
    });
    for (const r of d) {
      if (r.code_conflict) {
        // A conflicting code never resolves to the 150-list status of the same code.
        expect(r.same_as_code, r.legacy_code).not.toBe(r.legacy_code);
        continue;
      }
      expect(r.same_as_code, r.legacy_code).toBe(r.legacy_code);
      expect(target(r), r.legacy_code).toEqual(target(byCode.get(r.legacy_code)!));
    }
    // S100 in the 140 list is the 150 list's S099 (post-implementation impact assessment).
    expect(target(d.find((r) => r.legacy_code === "S100")!)).toEqual(target(byCode.get("S099")!));
  });
});

describe("modules trace to the implementation (playbook §115)", () => {
  it("every command, permission and delivering migration a module names exists", async () => {
    const missing = await admin<{ module: string; kind: string; name: string }[]>`
      select m.code as module, 'command' as kind, c as name
      from config.target_module m, unnest(m.commands) c
      where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname || '.' || p.proname = c and n.nspname in ('api', 'public_api'))
      union all
      select m.code, 'permission', p from config.target_module m, unnest(m.permissions) p
      where not exists (select 1 from iam.permission x where x.code = p)
      order by 1, 2, 3`;
    expect(missing).toEqual([]);
    const numbers = new Set(readdirSync(MIGRATIONS).map((f) => f.slice(10, 14)));
    const modules = await admin<{ code: string; delivered_in: string[] }[]>`
      select code, delivered_in from config.target_module order by code`;
    expect(modules).toHaveLength(61);
    for (const m of modules)
      for (const n of m.delivered_in) expect(numbers.has(n), `${m.code} ${n}`).toBe(true);
  });

  it("a delivered module names at least one command; a planned one names none", async () => {
    const wrong = await admin<{ code: string }[]>`
      select code from config.target_module
      where (delivery_state in ('IMPLEMENTED', 'PARTIAL')) <> (cardinality(commands) > 0)`;
    expect(wrong).toEqual([]);
  });
});

describe("legacy forms", () => {
  it("has two user-entered forms, the portal report and the grievance submission (DEC-31 as narrowed)", async () => {
    const rows = await admin<{ module: string; n: number }[]>`
      select target_module as module, count(*)::int as n from config.legacy_form_map
      where target_class = 'USER_FORM' group by 1 order by 1`;
    expect(rows).toEqual([
      { module: "GRIEVANCE_SUBMISSION", n: 5 },
      { module: "PORTAL_REPORT", n: 3 },
    ]);
  });

  it("retires only by mapping: every WB-FRM form stays enabled, and each retirement waits for a decision", async () => {
    const live = await formRows("WB_FRM_19");
    const forms = await admin<{ code: string; is_enabled: boolean }[]>`
      select code, is_enabled from forms.form_definition order by sequence_no`;
    expect(live.map((r) => r.legacy_id)).toEqual(forms.map((f) => f.code));
    expect(forms.every((f) => f.is_enabled)).toBe(true);
    expect(live.every((r) => r.legacy_state === "LIVE")).toBe(true);
    for (const r of live) expect(r.source_required !== null, r.legacy_id).toBe(r.disposition !== "KEEP");
    const [notBuilt] = await admin<{ n: number }[]>`
      select count(*)::int as n from config.legacy_form_map where legacy_state = 'LIVE' and catalogue <> 'WB_FRM_19'`;
    expect(notBuilt!.n).toBe(0);
  });

  it("catalogue D rows name only statuses of the 140-status list", async () => {
    const d = await formRows("CONTROL_CATALOGUE_D_274");
    const codes = new Set((await statusRows("CRM_STATUS_D_140")).map((r) => r.legacy_code));
    expect(d).toHaveLength(274);
    for (const r of d) {
      expect(r.allowed_statuses.length, r.legacy_id).toBeGreaterThan(0);
      for (const s of r.allowed_statuses) expect(codes.has(s), `${r.legacy_id} ${s}`).toBe(true);
    }
  });
});

describe("the documents equal the database", () => {
  it("CRM_STATUS_RATIONALIZATION.md: target dimensions", async () => {
    // Compared as sets: the document's order is presentation, not data.
    const doc = docTable("CRM_STATUS_RATIONALIZATION.md", "## Target dimensions");
    const db = await admin<
      { code: string; kind: string; semantic_type: string; held_on: string; values: string[] }[]
    >`
      select d.code, d.kind, d.semantic_type, d.held_on,
             array(select v.value from config.status_dimension_value v where v.dimension = d.code) as values
      from config.status_dimension d`;
    const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code);
    expect(
      doc
        .map((c) => ({
          code: code(c[0]!),
          kind: c[1],
          semantic_type: c[2],
          held_on: c[3],
          values: c[4]!.split(", ").sort(),
        }))
        .sort(byCode),
    ).toEqual(db.map((r) => ({ ...r, values: [...r.values].sort() })).sort(byCode));
  });

  it("CRM_STATUS_RATIONALIZATION.md: the 150-status mapping", async () => {
    const doc = docTable("CRM_STATUS_RATIONALIZATION.md", "## Mapping (all 150)");
    const db = await statusRows("CRM_STATUS_DRIVE_150");
    expect(
      doc.map((c) => ({
        legacy_code: c[0],
        legacy_name_ar: c[1],
        legacy_name_en: c[2],
        semantic_type: c[4],
        target_dimension: dash(c[5]!),
        target_value: dash(c[6]!),
        target_event: event(c[7]!).event,
        target_event_state: event(c[7]!).state,
        target_module: code(c[8]!),
        disposition: c[11],
      })),
    ).toEqual(
      db.map((r) => ({
        legacy_code: r.legacy_code,
        legacy_name_ar: r.legacy_name_ar,
        legacy_name_en: r.legacy_name_en,
        semantic_type: r.semantic_type,
        target_dimension: r.target_dimension,
        target_value: r.target_value,
        target_event: r.target_event,
        target_event_state: r.target_event_state,
        target_module: r.target_module,
        disposition: r.disposition,
      })),
    );
  });

  it("CRM_STATUS_RATIONALIZATION.md: the 140-status catalogue and the CDF_CASE_V1 states", async () => {
    const doc = docTable("CRM_STATUS_RATIONALIZATION.md", "## The 140-status catalogue");
    const db = await statusRows("CRM_STATUS_D_140");
    expect(
      doc.map((c) => ({
        legacy_code: c[0],
        legacy_name_ar: c[1],
        same_as_code: dash(c[2]!),
        code_conflict: c[3] === "yes",
        semantic_type: c[4],
        target_dimension: dash(c[5]!),
        target_value: dash(c[6]!),
        target_event: event(c[7]!).event,
        target_module: code(c[8]!),
        disposition: c[9],
      })),
    ).toEqual(
      db.map((r) => ({
        legacy_code: r.legacy_code,
        legacy_name_ar: r.legacy_name_ar,
        same_as_code: r.same_as_code,
        code_conflict: r.code_conflict,
        semantic_type: r.semantic_type,
        target_dimension: r.target_dimension,
        target_value: r.target_value,
        target_event: r.target_event,
        target_module: r.target_module,
        disposition: r.disposition,
      })),
    );
    const v1 = docTable("CRM_STATUS_RATIONALIZATION.md", "## CDF_CASE_V1 states");
    const states = await admin<
      { legacy_code: string; target_dimension: string; target_value: string; target_module: string }[]
    >`
      select m.legacy_code, m.target_dimension, m.target_value, m.target_module
      from config.legacy_status_map m join workflow.workflow_state w on w.workflow_code = 'CDF_CASE_V1' and w.code = m.legacy_code
      where m.catalogue = 'CDF_CASE_V1' order by w.sequence`;
    expect(
      v1.map((c) => ({
        legacy_code: c[0],
        target_dimension: c[3],
        target_value: c[4],
        target_module: code(c[5]!),
      })),
    ).toEqual(states);
  });

  it("FORM_CATALOGUE_RATIONALIZATION.md: sources A, C and D", async () => {
    const sources: [string, string][] = [
      ["## 3. Catalogue items (source A)", "CRM_FORM_A_169"],
      ["## 4. Repository forms WB-FRM-01..19 (source C)", "WB_FRM_19"],
    ];
    for (const [heading, catalogue] of sources) {
      const doc = docTable("FORM_CATALOGUE_RATIONALIZATION.md", heading);
      const db = await formRows(catalogue);
      expect(
        doc.map((c) => ({
          legacy_id: c[0],
          legacy_name: c[1],
          track: c[2],
          business_intent: c[3],
          target_class: c[4],
          data_owner: c[6],
          actor: c[7],
          trigger_text: c[8],
          merge_target: c[11],
          disposition: c[12],
        })),
        catalogue,
      ).toEqual(
        db.map((r) => ({
          legacy_id: r.legacy_id,
          legacy_name: r.legacy_name,
          track: r.track,
          business_intent: r.business_intent,
          target_class: r.target_class,
          data_owner: r.data_owner,
          actor: r.actor,
          trigger_text: r.trigger_text,
          merge_target: r.merge_target,
          disposition: r.disposition,
        })),
      );
    }
    const doc = docTable("FORM_CATALOGUE_RATIONALIZATION.md", "## 5. Business control catalogue (source D)");
    const db = await formRows("CONTROL_CATALOGUE_D_274");
    expect(
      doc.map((c) => ({
        legacy_id: c[0],
        legacy_name: c[1],
        track: c[2],
        business_intent: c[3],
        target_class: c[4],
        target_module: code(c[5]!),
        data_owner: c[6],
        actor: c[7],
        statuses: c[8],
        merge_target: c[9],
        disposition: c[10],
        same_as: c[11] ? c[11].split("; ") : [],
        source_required: dash(c[12]!),
        gap_ref: dash(c[13]!),
      })),
    ).toEqual(
      db.map((r) => ({
        legacy_id: r.legacy_id,
        legacy_name: r.legacy_name,
        track: r.track,
        business_intent: r.business_intent,
        target_class: r.target_class,
        target_module: r.target_module,
        data_owner: r.data_owner,
        actor: r.actor,
        statuses: `${r.primary_status ?? "—"} → ${r.resulting_status ?? "—"}`,
        merge_target: r.merge_target,
        disposition: r.disposition,
        same_as: r.same_as,
        source_required: r.source_required,
        gap_ref: r.gap_ref,
      })),
    );
  });

  it("FORM_CATALOGUE_RATIONALIZATION.md: modules and the gap register", async () => {
    const doc = docTable(
      "FORM_CATALOGUE_RATIONALIZATION.md",
      "### Target modules (where the catalogue lands)",
    );
    const db = await admin<{ code: string; name_en: string; delivery_state: string; ui_surface: string }[]>`
      select code, name_en, delivery_state, ui_surface from config.target_module`;
    const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code);
    expect(
      doc
        .map((c) => ({ code: code(c[0]!), name_en: c[1], delivery_state: c[2], ui_surface: c[3] }))
        .sort(byCode),
    ).toEqual(db.sort(byCode));
    // An open gap is referenced from the rows it affects; the migration that closes a gap clears its references.
    const register = docTable("FORM_CATALOGUE_RATIONALIZATION.md", "## 6. Gaps found while mapping");
    const used = await admin<{ gap_ref: string }[]>`
      select gap_ref from config.legacy_form_map where gap_ref is not null
      union select gap_ref from config.legacy_status_map where gap_ref is not null order by 1`;
    expect(used.map((r) => r.gap_ref)).toEqual(register.filter((c) => c[1] === "OPEN").map((c) => c[0]));
    const closed = register.filter((c) => c[1] !== "OPEN");
    const numbers = new Set(readdirSync(MIGRATIONS).map((f) => f.slice(10, 14)));
    for (const c of closed) {
      expect(c[1], c[0]).toMatch(/^CLOSED \(migration \d{4}, ADR-\d{3}\)$/);
      expect(numbers.has(c[1]!.slice(18, 22)), c[0]).toBe(true);
    }
  });
});
