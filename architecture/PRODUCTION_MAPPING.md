# Prototype-to-Production Mapping

Protocol §6, §67, §94. Every row marked **PRODUCTION_SUBSTITUTION_REQUIRED** is a simulation that must not be presented as a production control (§68).

| Prototype component | Production equivalent | Gap | Migration strategy | Status |
|---|---|---|---|---|
| Supabase Postgres | Alibaba RDS PostgreSQL (Riyadh) | Saudi residency, HA, backup/PITR policy, encryption with CDF keys, network isolation | Apply the same migrations; recreate `cdf_bff`/`cdf_portal` login roles and `anon`/`authenticated` group roles; schema already proven on vanilla PostgreSQL | Portable by design |
| Supabase Auth (`SupabaseIdentityProvider`) | CDF corporate IdP via OIDC (`CdfOidcIdentityProvider`) | Enterprise identity lifecycle, MFA, conditional access, joiner/mover/leaver | Replace the IdentityProvider adapter; map IdP `sub` to `iam.user_profile.id`; roles stay in `iam` | PRODUCTION_SUBSTITUTION_REQUIRED |
| `LocalDevIdentityProvider` | none | Not an identity provider | Delete; refuses to run outside local/test | PRODUCTION_SUBSTITUTION_REQUIRED |
| Supabase Storage (`SupabaseEvidenceStorage`) | Alibaba OSS | WORM/retention lock, KMS SSE, private endpoints | Replace adapter with `AlibabaOssEvidenceStorage`; object key scheme unchanged | PRODUCTION_SUBSTITUTION_REQUIRED |
| Application immutability (no overwrite/delete paths) | OSS retention policy / WORM | Storage-level immutability | Enable OSS compliance retention per retention class | PRODUCTION_SUBSTITUTION_REQUIRED |
| `MockMalwareScanner` | Approved malware scanning service | No real scanning | Replace `MalwareScanner` adapter | PRODUCTION_SUBSTITUTION_REQUIRED |
| `PrototypeKeyProvider` (HMAC/keys from env) | Alibaba KMS / HSM | Key custody, rotation, separation of duties | Replace `KeyManagementProvider` adapter; re-key report-secret HMACs on cutover | PRODUCTION_SUBSTITUTION_REQUIRED |
| `PostgresAuditSink` + `audit.audit_event` | Application audit table + Alibaba SLS → CDF SIEM | External immutability, SOC alerting, retention | Add `AlibabaSlsSecurityEventSink`; stream audit rows; anchor chain heads | PRODUCTION_SUBSTITUTION_REQUIRED (SIEM) |
| Postgres-backed `RateLimiter` | WAF / API gateway rate limiting + bot protection | Volumetric protection | Move to edge controls; keep app limiter as second layer | PRODUCTION_SUBSTITUTION_REQUIRED |
| Vercel (two projects) | Alibaba ACK/ECS (two workloads), CDF-controlled ingress | Residency, network zoning, WAF | Standard Node.js runtime; containerise each app | PRODUCTION_SUBSTITUTION_REQUIRED |
| Next.js BFF | Next.js presentation + ASP.NET Core API | Enterprise API layer | Commands already in SQL (`api.*`); ASP.NET Core calls them with the same session context | Planned |
| GitHub Actions security scans | CDF DevSecOps toolchain | Enterprise SAST/DAST, signing | Re-point pipeline | Planned |
| No PAM | Enterprise PAM for DB/admin access | Privileged session control | Out of prototype scope | PRODUCTION_SUBSTITUTION_REQUIRED |
| Supabase managed backups | Approved BCDR (RDS backups, cross-zone, tested restores) | RPO/RTO commitments | Out of prototype scope | PRODUCTION_SUBSTITUTION_REQUIRED |
| Email notifications (none sent in prototype) | CDF mail gateway | Delivery, DLP | `NotificationSender` adapter; content-free templates unchanged | Planned |
