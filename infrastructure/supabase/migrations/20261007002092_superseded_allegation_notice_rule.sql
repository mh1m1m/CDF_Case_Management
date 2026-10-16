-- =============================================================================
-- 2092 A superseded allegation needs no defence notice at adoption (CDF-236; ADR-059)
-- Requirements: AMB-026 (a sanction waits for its subject's defence notice, when the proceeding's rule snapshot says
-- so); AMB-027 and AMB-004 (2090: an allegation split, a case split and a subject correction supersede an allegation;
-- its successors carry it, and nothing new hangs off it); UX-116 (a capability is its command's answer). Linear CDF-236
-- (integrity LOW, fail-closed), found by governance's pre-check of #88 (2086). Number, ADR and ruling from the
-- coordinator (2026-10-16 05:29): "SUPERSEDED allegations are exempt from the requirement exactly as WITHDRAWN ones
-- are, because their successors carry it; successor allegations on the same case still count. Change the command and
-- 2086's package_capabilities mirror in that single migration."
--
-- Before: api.record_package_adoption (2030) asked, for each subject of an approved disciplinary sanction, for a
-- defence notice item on every allegation of the subject that was not WITHDRAWN (only the item's own allegations when
-- it names any). 2090 refuses a notice item on a SUPERSEDED allegation, so a sanction naming no allegation, on a
-- subject whose allegation was split or moved to another case before a notice covered it, could never be adopted
-- (DEFENCE_NOTICE_REQUIRED). decision.package_capabilities (2086) answered may_record_adoption the same way.
--
-- After: both leave out a SUPERSEDED allegation as they leave out a WITHDRAWN one. Its successors are live allegations
-- and are asked for as any other: on the same subject, on another subject of the case they were split onto, or on the
-- new case's subject after a case split. Every subject of the sanction still needs at least one defence notice, and an
-- allegation that is neither withdrawn nor superseded still needs its own.
--
-- Unreachable, unchanged: an allegation linked to an item is never superseded (ALLEGATION_IN_RECOMMENDATION) and a
-- superseded one is never linked, so items that name allegations answer as before; a MISIDENTIFIED subject is never
-- on an item (SUBJECT_MISIDENTIFIED, SUBJECT_IN_RECOMMENDATION).
--
-- Both functions are replaced with the same signature, owner and grants; each body is its predecessor's (2030; 2086)
-- with the one predicate changed and a comment line. No table, policy, grant or audit change; nothing is dropped or
-- renamed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The command (2030), the notice check
-- -----------------------------------------------------------------------------
create or replace function api.record_package_adoption(p_package_id uuid)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_p decision.recommendation_package;
  v_status text;
  v_approved int;
  v_notice_rule boolean;
begin
  perform api._actor();
  v_p := decision.lock_managed_package(p_package_id);
  if v_p.status <> 'VOTING' then perform api._fail('CONFLICT', 'PACKAGE_NOT_VOTING'); end if;
  if not exists (select 1 from committee.vote_item vi where vi.package_id = v_p.id and vi.package_round = v_p.round_no)
     or exists (select 1 from committee.vote_item vi
                where vi.package_id = v_p.id and vi.package_round = v_p.round_no and vi.status <> 'CLOSED') then
    perform api._fail('CONFLICT', 'VOTES_NOT_CLOSED');
  end if;
  if v_p.vote_granularity = 'PACKAGE' then
    update decision.recommendation_item i
       set committee_result = case when (select vi.result from committee.vote_item vi
                                         where vi.package_id = v_p.id and vi.package_round = v_p.round_no
                                           and vi.target_type = 'PACKAGE') = 'APPROVED' then 'APPROVED' else 'REJECTED' end
     where i.package_id = v_p.id and i.status = 'ACTIVE';
  else
    update decision.recommendation_item i
       set committee_result = case when vi.result = 'APPROVED' then 'APPROVED' else 'REJECTED' end
      from committee.vote_item vi
     where vi.recommendation_item_id = i.id and vi.package_round = v_p.round_no and i.package_id = v_p.id
       and i.status = 'ACTIVE';
  end if;
  select count(*) into v_approved from decision.recommendation_item i
  where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED';
  v_status := case when v_approved > 0 then 'ADOPTED' else 'DRAFT' end;

  if v_status = 'ADOPTED' then
    -- DEC-AMB-003: a result a now-conflicted voter took part in waits for the committee's resolution.
    if decision.package_tainted(v_p.id) then perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT'); end if;
    if exists (select 1 from decision.recommendation_item i
               where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
                 and i.sanction_code is not null and decision.catalogue_version_in_force(i.sanction_code) is null) then
      perform api._fail('CONFLICT', 'SANCTION_NOT_IN_FORCE');
    end if;
    select coalesce((cp.rule_snapshot ->> 'sanction_requires_defence_notice')::boolean, false) into v_notice_rule
    from committee.committee_proceeding cp where cp.id = v_p.committee_proceeding_id;
    -- Each subject of an adopted sanction, on each allegation of the item against that subject (all the subject's
    -- allegations when the item names none), has a defence notice; a subject with no allegation has at least one.
    -- A withdrawn or superseded allegation needs none: a superseded one's successors carry it (2092, CDF-236).
    if v_notice_rule and exists (
      select 1
      from decision.recommendation_item i
      join decision.recommendation_item_subject rs on rs.item_id = i.id
      where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
        and i.item_type = 'DISCIPLINARY_SANCTION'
        and (exists (select 1 from case_mgmt.allegation a
                     where a.subject_id = rs.subject_id and a.status not in ('WITHDRAWN', 'SUPERSEDED')
                       and (a.id in (select ra.allegation_id from decision.recommendation_item_allegation ra where ra.item_id = i.id)
                            or not exists (select 1 from decision.recommendation_item_allegation ra where ra.item_id = i.id))
                       and not exists (select 1 from grievance.defence_notice n
                                       join grievance.defence_notice_item ni on ni.notice_id = n.id
                                       where n.subject_id = rs.subject_id and n.kind = 'DEFENCE' and n.status <> 'WITHDRAWN'
                                         and ni.allegation_id = a.id))
             or not exists (select 1 from grievance.defence_notice n
                            where n.subject_id = rs.subject_id and n.kind = 'DEFENCE' and n.status <> 'WITHDRAWN'))
    ) then
      perform api._fail('CONFLICT', 'DEFENCE_NOTICE_REQUIRED');
    end if;
    insert into decision.item_adoption (item_id, package_id, package_round, catalogue_version_id, snapshot)
    select i.id, v_p.id, v_p.round_no, v.id,
           decision.item_snapshot(i.id) || decision.item_snapshot_extra(i.id)
           || jsonb_build_object('catalogue_version_id', v.id, 'catalogue_version_no', v.version_no,
                                 'catalogue_source_status', v.source_status,
                                 'catalogue_legal_basis', case when v.source_status = 'APPROVED' then v.legal_basis end,
                                 'catalogue_authority_type', v.authority_type,
                                 'catalogue_legal_review_requirement', v.legal_review_requirement)
    from decision.recommendation_item i
    left join decision.sanction_catalogue_version v on v.id = decision.catalogue_version_in_force(i.sanction_code)
    where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED';
  end if;

  update decision.recommendation_package
     set status = v_status, adopted_at = case when v_status = 'ADOPTED' then now() end,
         updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  perform audit.record_event(case when v_status = 'ADOPTED' then 'RECOMMENDATION_PACKAGE_ADOPTED' else 'RECOMMENDATION_PACKAGE_NOT_ADOPTED' end,
    'BUSINESS', 'SUCCESS', v_p.case_id, 'recommendation_package', v_p.id::text, null,
    jsonb_build_object('round_no', v_p.round_no, 'approved_items', v_approved,
                       'legal_review_required', decision.legal_review_required(v_p.id)));
  return v_status;
end;
$$;


-- -----------------------------------------------------------------------------
-- 2. Its capability flag (2086), the same check
-- -----------------------------------------------------------------------------
create or replace function decision.package_capabilities(p_package_id uuid)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_p decision.recommendation_package;
  v_manage boolean := decision.manages_package(p_package_id);
  v_editable boolean;
  v_approved uuid[];
  v_notice_rule boolean;
  v_adoption boolean := false;
begin
  select * into v_p from decision.recommendation_package p where p.id = p_package_id;
  -- api.add_recommendation_item, api.withdraw_recommendation_item and api.submit_package_for_vote:
  -- decision.lock_managed_package, then the package editable (PACKAGE_NOT_EDITABLE).
  v_editable := v_manage and v_p.status in ('DRAFT', 'RETURNED_BY_LEGAL', 'RETURNED_BY_AUTHORITY');
  -- api.record_package_adoption (2030): decision.lock_managed_package; VOTING (PACKAGE_NOT_VOTING); the round's votes
  -- opened and all closed (VOTES_NOT_CLOSED). The items it would approve are those whose vote it reads as APPROVED.
  -- Approving none returns the package to DRAFT, which nothing refuses. Approving any: no taint (TAINTED_BY_CONFLICT,
  -- and decision.block_tainted_progress on the update), every approved catalogue code in force
  -- (SANCTION_NOT_IN_FORCE), and the defence notices the rule snapshot asks for (DEFENCE_NOTICE_REQUIRED), where a
  -- withdrawn or superseded allegation needs none (2092).
  if v_manage and v_p.status = 'VOTING'
     and exists (select 1 from committee.vote_item vi where vi.package_id = v_p.id and vi.package_round = v_p.round_no)
     and not exists (select 1 from committee.vote_item vi
                     where vi.package_id = v_p.id and vi.package_round = v_p.round_no and vi.status <> 'CLOSED') then
    select coalesce(array_agg(i.id), '{}'::uuid[]) into v_approved
    from decision.recommendation_item i
    where i.package_id = v_p.id and i.status = 'ACTIVE'
      and case when v_p.vote_granularity = 'PACKAGE'
               then coalesce((select vi.result = 'APPROVED' from committee.vote_item vi
                              where vi.package_id = v_p.id and vi.package_round = v_p.round_no
                                and vi.target_type = 'PACKAGE'), false)
               else coalesce((select vi.result = 'APPROVED' from committee.vote_item vi
                              where vi.recommendation_item_id = i.id and vi.package_round = v_p.round_no),
                             i.committee_result = 'APPROVED', false) end;
    select coalesce((cp.rule_snapshot ->> 'sanction_requires_defence_notice')::boolean, false) into v_notice_rule
    from committee.committee_proceeding cp where cp.id = v_p.committee_proceeding_id;
    v_adoption := cardinality(v_approved) = 0
      or (not decision.package_tainted(v_p.id)
          and not exists (select 1 from decision.recommendation_item i
                          where i.id = any (v_approved) and i.sanction_code is not null
                            and decision.catalogue_version_in_force(i.sanction_code) is null)
          and not (v_notice_rule and exists (
            select 1
            from decision.recommendation_item i
            join decision.recommendation_item_subject rs on rs.item_id = i.id
            where i.id = any (v_approved) and i.item_type = 'DISCIPLINARY_SANCTION'
              and (exists (select 1 from case_mgmt.allegation a
                           where a.subject_id = rs.subject_id and a.status not in ('WITHDRAWN', 'SUPERSEDED')
                             and (a.id in (select ra.allegation_id from decision.recommendation_item_allegation ra
                                           where ra.item_id = i.id)
                                  or not exists (select 1 from decision.recommendation_item_allegation ra
                                                 where ra.item_id = i.id))
                             and not exists (select 1 from grievance.defence_notice n
                                             join grievance.defence_notice_item ni on ni.notice_id = n.id
                                             where n.subject_id = rs.subject_id and n.kind = 'DEFENCE'
                                               and n.status <> 'WITHDRAWN' and ni.allegation_id = a.id))
                   or not exists (select 1 from grievance.defence_notice n
                                  where n.subject_id = rs.subject_id and n.kind = 'DEFENCE'
                                    and n.status <> 'WITHDRAWN')))));
  end if;
  return jsonb_build_object(
    'may_add_item', coalesce(v_editable, false),
    -- api.submit_package_for_vote: at least one active item (PACKAGE_EMPTY).
    'may_submit_for_vote', coalesce(v_editable and exists (select 1 from decision.recommendation_item i
                                                         where i.package_id = v_p.id and i.status = 'ACTIVE'), false),
    'may_record_adoption', coalesce(v_adoption, false),
    -- api.return_package_to_committee (2030): decision.lock_managed_package, then ADOPTED (PACKAGE_NOT_ADOPTED).
    'may_return_to_committee', coalesce(v_manage and v_p.status = 'ADOPTED', false));
end;
$$;

