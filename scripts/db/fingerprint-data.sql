-- Reference-data fingerprint (roles, permissions, workflow definition, settings). Read-only.
-- Timestamps are excluded so two databases built from the same migrations compare equal.
select 'iam.role' as t, count(*) as n, md5(string_agg((to_jsonb(r) - 'created_at' - 'updated_at')::text, E'\n' order by (to_jsonb(r) - 'created_at' - 'updated_at')::text collate "C")) as fp from iam.role r
union all select 'iam.permission', count(*), md5(string_agg((to_jsonb(r) - 'created_at' - 'updated_at')::text, E'\n' order by (to_jsonb(r) - 'created_at' - 'updated_at')::text collate "C")) from iam.permission r
union all select 'iam.role_permission', count(*), md5(string_agg((to_jsonb(r) - 'created_at' - 'updated_at')::text, E'\n' order by (to_jsonb(r) - 'created_at' - 'updated_at')::text collate "C")) from iam.role_permission r
union all select 'workflow.workflow_definition', count(*), md5(string_agg((to_jsonb(r) - 'created_at' - 'updated_at')::text, E'\n' order by (to_jsonb(r) - 'created_at' - 'updated_at')::text collate "C")) from workflow.workflow_definition r
union all select 'workflow.workflow_state', count(*), md5(string_agg((to_jsonb(r) - 'created_at' - 'updated_at')::text, E'\n' order by (to_jsonb(r) - 'created_at' - 'updated_at')::text collate "C")) from workflow.workflow_state r
union all select 'workflow.workflow_transition_definition', count(*), md5(string_agg((to_jsonb(r) - 'created_at' - 'updated_at')::text, E'\n' order by (to_jsonb(r) - 'created_at' - 'updated_at')::text collate "C")) from workflow.workflow_transition_definition r
union all select 'config.setting', count(*), md5(string_agg((to_jsonb(r) - 'created_at' - 'updated_at')::text, E'\n' order by (to_jsonb(r) - 'created_at' - 'updated_at')::text collate "C")) from config.setting r
order by 1;
