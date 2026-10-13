-- =============================================================================
-- 1980 Preliminary review closure outcomes (Business Architecture Rebase phase 11, gap P11-G1; CDF-198, CDF-190)
-- Requirements: §19, §29, §87; owner Q&A Q11–Q20 (Q12 above all); ADR-017, ADR-035, ADR-036
--
-- The preliminary review exists to verify a report initially, assess its completeness and seriousness and identify
-- whether it may be malicious or insufficient (Q12). Its recommendation accepted seven outcomes; the owner's CRM
-- catalogues route five more closures through it, which its check refused (gap P11-G1, FORM_CATALOGUE_RATIONALIZATION
-- §6). This migration lets the preliminary recommendation carry them:
--   NOT_SERIOUS              Q12 "assess ... seriousness"                                  OWNER_DEFAULT
--   CHANNEL_ABUSE            Q12 "whether the report may be malicious"                     OWNER_DEFAULT
--   NOT_SUBSTANTIATED        Q12 "verify the report initially"                             OWNER_DEFAULT
--   NOT_FEASIBLE             owner catalogues only (S045, S134; CRM-F146, CRM-F147)        SOURCE_REQUIRED
--   NO_PERSONAL_JURISDICTION owner catalogues only (S114; CRM-F120)                        SOURCE_REQUIRED
-- All five are existing OUTCOME_CODE values (config.status_code, migration 1870).
--
-- Controls:
--   * Additive: the outcome check is widened (dropped and re-added under the same name, as 1930–1960 did for
--     notification object types); every existing row and caller stays valid. Nothing else in the command changes:
--     the same permission, case access, case and proceeding state checks, maker / reviewer / approver separation
--     (Q13–Q19), versioning and audit event. Approval still concludes the PRELIMINARY_REVIEW proceeding with the
--     recommended outcome; closing the case stays with CDF_CASE_V1 (gap P11-G2).
--   * The two outcomes without an owner answer are accepted and marked SOURCE_REQUIRED in the catalogue
--     (config.status_dimension_value); the owner may withdraw them later by deactivation, never deletion.
--   * The 1970 catalogue follows: five ACTIVE values on PRELIMINARY_OUTCOME, the P11-G1 references cleared and their
--     notes updated, and the close-outcome module records this migration.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The recommendation's outcome vocabulary
-- -----------------------------------------------------------------------------
alter table case_mgmt.preliminary_recommendation drop constraint preliminary_recommendation_recommended_outcome_check;
alter table case_mgmt.preliminary_recommendation add constraint preliminary_recommendation_recommended_outcome_check
  check (recommended_outcome in (
    'NO_ACTION', 'OUT_OF_SCOPE', 'DUPLICATE', 'TRANSFERRED', 'NON_PROCESSABLE', 'INVESTIGATION_WARRANTED',
    'REFERRED_TO_COMMITTEE', 'NOT_SERIOUS', 'NOT_SUBSTANTIATED', 'CHANNEL_ABUSE', 'NOT_FEASIBLE',
    'NO_PERSONAL_JURISDICTION'));

-- Same body as 1880 except the accepted outcomes. create or replace keeps the owner and the EXECUTE grant.
create or replace function api.prepare_preliminary_recommendation(p_case_id uuid, p_recommended_outcome text, p_rationale text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_p case_mgmt.proceeding;
  v_role text;
  v_review boolean;
  v_version int;
  v_id uuid;
  v_rationale text;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('PRELIMINARY_PREPARE') then perform api._fail('FORBIDDEN'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;
  if v_case.records_state <> 'ACTIVE' then perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE'); end if;
  -- Direct referrals and grievances go straight to their committee (Q4, Q41).
  if v_case.source_type in ('DIRECT_REFERRAL', 'DIRECT_GRIEVANCE') then
    perform api._fail('CONFLICT', 'PRELIMINARY_NOT_APPLICABLE');
  end if;
  if p_recommended_outcome is null or p_recommended_outcome not in (
       'NO_ACTION', 'OUT_OF_SCOPE', 'DUPLICATE', 'TRANSFERRED', 'NON_PROCESSABLE', 'INVESTIGATION_WARRANTED',
       'REFERRED_TO_COMMITTEE', 'NOT_SERIOUS', 'NOT_SUBSTANTIATED', 'CHANNEL_ABUSE', 'NOT_FEASIBLE',
       'NO_PERSONAL_JURISDICTION') then
    perform api._fail('INVALID', 'recommended_outcome');
  end if;
  perform case_mgmt.require_status_code('OUTCOME_CODE', p_recommended_outcome, 'recommended_outcome');
  v_rationale := api._require_text(p_rationale, 'rationale', 10, 8000);

  select * into v_p from case_mgmt.proceeding p
  where p.case_id = p_case_id and p.proceeding_type = 'PRELIMINARY_REVIEW' and p.status not in ('CONCLUDED', 'CANCELLED')
  for update;
  if v_p.id is null then
    v_p := case_mgmt.insert_proceeding(p_case_id, 'PRELIMINARY_REVIEW', null, v_actor);
    perform audit.record_event('PROCEEDING_OPENED', 'BUSINESS', 'SUCCESS', p_case_id, 'proceeding', v_p.id::text, null,
      jsonb_build_object('proceeding_type', 'PRELIMINARY_REVIEW', 'sequence_no', v_p.sequence_no, 'parent_proceeding_id', null));
  end if;
  if v_p.status = 'SUSPENDED' then perform api._fail('CONFLICT', 'PROCEEDING_SUSPENDED'); end if;
  if exists (select 1 from case_mgmt.preliminary_recommendation r
             where r.proceeding_id = v_p.id and r.status in ('AWAITING_REVIEW', 'AWAITING_APPROVAL')) then
    perform api._fail('CONFLICT', 'RECOMMENDATION_PENDING');
  end if;

  v_role := case
    when authz.user_has_role(v_actor, 'GRC_DIRECTOR') then 'GRC_DIRECTOR'
    when authz.user_has_role(v_actor, 'COMPLIANCE_SECTION_MANAGER') then 'COMPLIANCE_SECTION_MANAGER'
    when authz.user_has_role(v_actor, 'LEAD_INVESTIGATOR') then 'LEAD_INVESTIGATOR'
    else 'INVESTIGATOR' end;
  -- Q15: no self-review step when the preparer holds the review authority.
  v_review := not authz.user_has_permission(v_actor, 'PRELIMINARY_REVIEW');
  select coalesce(max(r.version_no), 0) + 1 into v_version
  from case_mgmt.preliminary_recommendation r where r.proceeding_id = v_p.id;

  insert into case_mgmt.preliminary_recommendation (case_id, proceeding_id, version_no, recommended_outcome, rationale,
                                                    status, prepared_by, prepared_role, review_required)
  values (p_case_id, v_p.id, v_version, p_recommended_outcome, v_rationale,
          case when v_review then 'AWAITING_REVIEW' else 'AWAITING_APPROVAL' end, v_actor, v_role, v_review)
  returning id into v_id;
  update case_mgmt.proceeding
     set status = case when v_review then 'AWAITING_REVIEW' else 'AWAITING_APPROVAL' end, waiting_reason = null,
         updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  perform audit.record_event('PRELIMINARY_RECOMMENDATION_PREPARED', 'BUSINESS', 'SUCCESS', p_case_id,
    'preliminary_recommendation', v_id::text, null,
    jsonb_build_object('proceeding_id', v_p.id, 'version_no', v_version, 'recommended_outcome', p_recommended_outcome,
                       'prepared_role', v_role, 'review_required', v_review));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- The form and status catalogue (migration 1970) follows the schema
-- -----------------------------------------------------------------------------
insert into config.status_dimension_value (dimension, value, state, derivation, source_status) values
  ('PRELIMINARY_OUTCOME', 'CHANNEL_ABUSE',            'ACTIVE', null, 'OWNER_DEFAULT'),
  ('PRELIMINARY_OUTCOME', 'NOT_SERIOUS',              'ACTIVE', null, 'OWNER_DEFAULT'),
  ('PRELIMINARY_OUTCOME', 'NOT_SUBSTANTIATED',        'ACTIVE', null, 'OWNER_DEFAULT'),
  ('PRELIMINARY_OUTCOME', 'NOT_FEASIBLE',             'ACTIVE', null, 'SOURCE_REQUIRED'),
  ('PRELIMINARY_OUTCOME', 'NO_PERSONAL_JURISDICTION', 'ACTIVE', null, 'SOURCE_REQUIRED');

update config.legacy_status_map
   set notes = regexp_replace(notes, 'GAP P11-G1: [^.]*\.', 'A preliminary recommendation outcome since migration 1980 (P11-G1 closed).'),
       gap_ref = null
 where gap_ref = 'P11-G1';
update config.legacy_form_map set gap_ref = null where gap_ref = 'P11-G1';

update config.target_module
   set delivered_in = delivered_in || '1980'::text,
       notes = 'Recommended closures (not serious, not substantiated, channel abuse, not feasible, no personal '
               'jurisdiction, out of scope, duplicate, non-processable, transferred): outcome codes of one recommendation.'
 where code = 'PRELIM_CLOSE_OUTCOME';
