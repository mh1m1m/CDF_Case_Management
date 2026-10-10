// CDF-66: the foreign keys that application queries search by lead a full index, so those searches never
// scan the table. The other foreign keys flagged by the Supabase advisor ("unindexed_foreign_keys") stay
// unindexed on purpose; 20261007001800_fk_indexes.sql gives the reasons.
import { describe, expect, it } from "vitest";
import { admin } from "../support/db";

const SEARCHED_FOREIGN_KEYS = [
  // api.request_identity_reveal, api.list_identity_reveal_requests, api.resolve_reporter_identity
  { table: "protected_identity.reveal_request", columns: ["case_id"] },
  // RLS policy person_read on case_mgmt.person
  { table: "case_mgmt.case_person", columns: ["person_id"] },
  // api.request_break_glass: one open request per user and case
  { table: "case_mgmt.break_glass_access", columns: ["requested_by"] },
];

describe("foreign-key indexes", () => {
  for (const { table, columns } of SEARCHED_FOREIGN_KEYS) {
    it(`${table} (${columns.join(", ")}) is a foreign key that leads a full index`, async () => {
      const [row] = await admin<{ foreignKey: boolean; indexed: boolean }[]>`
        with fk as (
          select c.conrelid, c.conkey
          from pg_constraint c
          where c.contype = 'f' and c.conrelid = ${table}::regclass
            and array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum, ord)
                      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
                      order by k.ord) = ${columns}::text[]
        )
        select exists (select 1 from fk) as "foreignKey",
               exists (select 1 from fk join pg_index i on i.indrelid = fk.conrelid
                       where i.indisvalid and i.indpred is null
                         and (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(fk.conkey)] @> fk.conkey
                         and (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(fk.conkey)] <@ fk.conkey) as indexed`;
      expect(row).toEqual({ foreignKey: true, indexed: true });
    });
  }
});
