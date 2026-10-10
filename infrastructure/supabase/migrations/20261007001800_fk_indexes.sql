-- CDF-66: indexes for the foreign keys that application queries search by (Supabase performance advisor
-- "unindexed_foreign_keys", INFO). The advisor flags every foreign key whose columns lead no index: 96 on main
-- after 1720. Most need none in this schema:
--   * no application path deletes a referenced row or changes its key (the only DELETEs remove rate-limit
--     buckets), so foreign-key checks never search the referencing table;
--   * audit columns (*_by, actor_id) and pointers to a current version are written, then read with their own
--     row; joins from them use the referenced table's primary key;
--   * reference data (roles, permissions, workflow states and transitions, retention classes, content types)
--     is small and fixed;
--   * searches that name the foreign key together with a column leading an existing composite or partial index
--     use that index, for example conflict checks by case and user (conflict_check_current) and access grants
--     by user and case (case_access_grant_user);
--   * no query searches by a case's owner, by the case a report became (the case reaches its report through
--     case_record.source_report_id), or by a workflow instance's state or id (instances and their history are
--     read by case).
-- The three below are searches by the foreign key that no existing index serves. Plain CREATE INDEX:
-- migrations run in one transaction, and the tables are small.

-- Requesting, listing and using a reporter-identity reveal search a case's requests
-- (api.request_identity_reveal, api.list_identity_reveal_requests, api.resolve_reporter_identity); the table
-- had only its primary key.
create index reveal_request_case on protected_identity.reveal_request (case_id);

-- RLS on case_mgmt.person (person_read) checks each person row read for a case the caller can view:
-- exists (select 1 from case_mgmt.case_person cp where cp.person_id = person.id and ...). The unique
-- (case_id, person_id, role) index leads with the case.
create index case_person_person on case_mgmt.case_person (person_id);

-- api.request_break_glass refuses a second open request by the same user for the same case. Its check also
-- matches REQUESTED rows, which the partial index break_glass_case_user (ACTIVE rows only) cannot serve.
create index break_glass_requester on case_mgmt.break_glass_access (requested_by, case_id);
