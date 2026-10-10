-- =============================================================================
-- 1000 Private evidence buckets (Phase 7 storage; CDF-32 hosted DEV)
-- Requirements: §24–§27, §46; ADR-006; CEOM (storage configuration is Git-controlled).
--
-- The two buckets the EvidenceStorage adapter uses are declared here so that every environment
-- (local shim, Supabase CLI, hosted DEV/DEMO) gets them from Git. The adapter's runtime
-- ensureBuckets() remains a fallback only and is a no-op once this migration has run.
--
--   evidence-quarantine  uploads before the malware scan
--   evidence-vault       scanned, immutable versions
--
-- Both are private: no storage policy grants any application role access (storage-policy.spec.ts);
-- only server code holding the service-role key reads or writes objects, after the database has
-- authorised the action (api.register_evidence_version / api.open_evidence_version). Size limit
-- = EVIDENCE_MAX_BYTES (25 MiB, §25); accepted content types = evidence.allowed_content_type.
-- On plain PostgreSQL the compatibility shim provides storage.buckets (ADR-008).
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
select b.id, b.id, false, 26214400,
       (select array_agg(t.content_type order by t.content_type) from evidence.allowed_content_type t)
from (values ('evidence-quarantine'), ('evidence-vault')) as b (id)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Guard (§24: private evidence storage, ever): fail the migration if anything is off.
do $$
begin
  if (select count(*) from storage.buckets b
      where b.id in ('evidence-quarantine', 'evidence-vault')
        and not b.public and b.file_size_limit = 26214400
        and cardinality(b.allowed_mime_types) >= 1) <> 2 then
    raise exception 'evidence buckets are missing or misconfigured';
  end if;
end
$$;
