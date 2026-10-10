-- Reference-data fingerprint (roles, permissions, workflow definition, settings, evidence content types,
-- form registry, retention classes). Read-only. Timestamps and generated row IDs are excluded so two
-- databases built from the same migrations compare equal.
select 'iam.role' as t, count(*) as n, md5(string_agg((to_jsonb(r) - 'created_at' - 'updated_at')::text, E'\n' order by (to_jsonb(r) - 'created_at' - 'updated_at')::text collate "C")) as fp from iam.role r
union all select 'iam.permission', count(*), md5(string_agg((to_jsonb(r) - 'created_at' - 'updated_at')::text, E'\n' order by (to_jsonb(r) - 'created_at' - 'updated_at')::text collate "C")) from iam.permission r
union all select 'iam.role_permission', count(*), md5(string_agg((to_jsonb(r) - 'created_at' - 'updated_at')::text, E'\n' order by (to_jsonb(r) - 'created_at' - 'updated_at')::text collate "C")) from iam.role_permission r
union all select 'workflow.workflow_definition', count(*), md5(string_agg((to_jsonb(r) - 'created_at' - 'updated_at')::text, E'\n' order by (to_jsonb(r) - 'created_at' - 'updated_at')::text collate "C")) from workflow.workflow_definition r
union all select 'workflow.workflow_state', count(*), md5(string_agg((to_jsonb(r) - 'created_at' - 'updated_at')::text, E'\n' order by (to_jsonb(r) - 'created_at' - 'updated_at')::text collate "C")) from workflow.workflow_state r
union all select 'workflow.workflow_transition_definition', count(*), md5(string_agg((to_jsonb(r) - 'created_at' - 'updated_at')::text, E'\n' order by (to_jsonb(r) - 'created_at' - 'updated_at')::text collate "C")) from workflow.workflow_transition_definition r
union all select 'config.setting', count(*), md5(string_agg((to_jsonb(r) - 'created_at' - 'updated_at')::text, E'\n' order by (to_jsonb(r) - 'created_at' - 'updated_at')::text collate "C")) from config.setting r
union all select 'evidence.allowed_content_type', count(*), md5(string_agg(to_jsonb(r)::text, E'\n' order by to_jsonb(r)::text collate "C")) from evidence.allowed_content_type r
union all select 'forms.form_definition', count(*), md5(string_agg((to_jsonb(r) - 'created_at' - 'updated_at')::text, E'\n' order by (to_jsonb(r) - 'created_at' - 'updated_at')::text collate "C")) from forms.form_definition r
union all select 'forms.form_definition_version', count(*), md5(string_agg((to_jsonb(r) - 'published_at')::text, E'\n' order by (to_jsonb(r) - 'published_at')::text collate "C")) from forms.form_definition_version r
union all select 'forms.form_field_definition', count(*), md5(string_agg((to_jsonb(r) - 'id')::text, E'\n' order by (to_jsonb(r) - 'id')::text collate "C")) from forms.form_field_definition r
union all select 'forms.form_entitlement', count(*), md5(string_agg(to_jsonb(r)::text, E'\n' order by to_jsonb(r)::text collate "C")) from forms.form_entitlement r
union all select 'records.retention_class', count(*), md5(string_agg((to_jsonb(r) - 'created_at' - 'updated_at')::text, E'\n' order by (to_jsonb(r) - 'created_at' - 'updated_at')::text collate "C")) from records.retention_class r
order by 1;
