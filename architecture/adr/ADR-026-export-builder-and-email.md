# ADR-026: Export Builder and external email

- **Status:** Proposed (2026-10-12); implemented in migration 1930 pending review (ADR-032). Linear CDF-196; the P12-6b-1 amendment CDF-258 (2026-10-18). Security-sensitive.
- **Protocol:** §19, §29, §40, §46, §82–§83, §87; owner Q&A Q99.

## Decision

1. Schema `exchange`: `export_request` (format PDF / XLSX / EMAIL, purpose, justification, classification, status), `export_item` (object type + id), `export_recipient` (INTERNAL / EXTERNAL), `export_approval`.
2. Authorization is checked **per item at build time** with the same `authz.*` predicates as the UI; refused items are listed as withheld, never silently dropped.
3. Every export has a preview (hash recorded) and an audit trail (EXPORT_REQUESTED, EXPORT_APPROVED, EXPORT_GENERATED, EXPORT_SENT).
4. External email always requires a justification and a classification check; a second approval is required when a configurable rule matches (classification, content type, recipient type, scope).
5. Protected identity is never exportable. Rendering runs server-side; files are written to private storage with random keys.

## Requirements

Q99; negative tests N16, N19.

## Implementation

Migration 1930 (Phase 9). How approvals stay bound to the approved content, how rules are versioned, separation of duties and the generation step are recorded in [ADR-032](ADR-032-export-approval-binding.md).

## P12-6b-1 amendment: the export's pages (2026-10-18)

UX redesign Phase 12, slice P12-6b-1 (Linear CDF-258), with no migration: the pages read `api.export_request_view`
(2040) and run the 1930 and 2040 commands. The coordinator's ruling of 2026-10-18 (12:18) settles the forks F1 to F13 of
the P12-6b domain map. Who may read an export and what each command accepts are unchanged. Each form shows only where
the view says its command would accept the caller now (UX-116), and runs its `api.*` command in the caller's security
context through the export service, which validates with the shared schema and pre-checks the role permission first
(`EXPORT_REQUEST` to ask for, prepare, submit, generate or cancel; `EXPORT_APPROVE` or `EXPORT_SECOND_APPROVE` to give
a stage; `RESTRICTED_CASE_AUTHORITY` to consent); the database decides again on submit.

- **Asking for an export** (`/cases/{id}/export`; F1). The case's overflow menu offers it to a holder of
  `EXPORT_REQUEST`, and the page mirrors the command's own checks in its order: the case opens as every case page does
  (the uniform 404 for a case the reader may not see), then `EXPORT_REQUEST`; anyone else gets the same 404. The form
  asks for the format, the audience, a purpose of the governed catalogue's active ones (DEC-F21) named in the reader's
  language, the outside party and, where the purpose asks for one, a justification. It narrows the command while
  internal recipients wait for their candidate read (F9): an email export goes to external addresses only, so no
  draft is made that could never be sent. The new draft opens on its own page.
- **The export's page** (`/exports/{id}`). Its requester, an approver once it is submitted, and the restricted case's
  authority read what it is for, its items (an item the reader may not see now keeps its place, N16), its recipients,
  its approval stages and the authority's decision with each reason, and the rules matched at submission with their
  source (every seeded rule is SOURCE_REQUIRED). Anyone else, and an id that names nothing or a malformed one, get the
  same 404, with ACCESS_DENIED recorded. The view never gives the content, the file or its storage key, and reading the
  page records nothing. A guide says where the export stands, who acts next and what the reader can do; a person is
  "you", the directory's name in the reader's language, or "an account". Why it waits is said in words: the rule that
  refuses it, items withheld from the reader, and an export of a restricted case asked for by the case's own authority,
  who may not consent to it (CDF-208).
- **Preparing a draft.** The requester adds the summary of the export's own case (the only kind of item this page
  offers, F9) and, for an email, an external address typed twice (AMB-187): two that differ are refused before anything
  is sent, and the database keeps the address trimmed and in lower case. Adding an address asks first.
- **The preview** (`/exports/{id}/preview`). The only page that shows what the export holds. Opening it runs
  `api.preview_export`, which records EXPORT_PREVIEWED and, for a draft, stores the hash a submission is bound to, so
  it is a page of its own, linked without prefetch and run once per visit; an item the reader may not see now is listed
  without its content. It says what the export needs now: its stages, the authority's consent and the rules this
  preview matches. On it the requester submits, confirming the classification the preview shows (F11); an approver
  approves or rejects their stage; and the restricted case's authority consents or refuses, apart from the stages
  (DEC-F23). Each is bound to this preview's hash, and the command compares it with the export as it stands
  (PREVIEW_CHANGED). Each asks first. The requester is never offered a decision (DEC-F24), and an approver who gave a
  stage gives no other.
- **Generating and cancelling.** Once an email export is approved, its requester generates it and hands it to the mail
  relay (a stub; PRODUCTION_SUBSTITUTION_REQUIRED), after a confirmation; an accepted delivery is SENT. An email the
  relay did not accept stays GENERATED, and the page shows its status only (F7). A PDF or Excel export is not generated
  from this page until a download read exists (F6): its requester reads that the file waits. The stub rendering
  carries its generation date Gregorian first and Hijri second (DEC-51, F10); the database's hash binds the document,
  not the file. The requester cancels an open export with a reason, after a red confirmation.
- **My Work.** EXPORT_TO_APPROVE opens the export's page, and `/exports` joins the live purpose roots.
- **Audit.** The commands record EXPORT_REQUESTED, EXPORT_ITEM_ADDED, EXPORT_RECIPIENT_ADDED, EXPORT_PREVIEWED,
  EXPORT_SUBMITTED, EXPORT_APPROVED or EXPORT_REJECTED, RESTRICTED_EXPORT_APPROVED or RESTRICTED_EXPORT_REJECTED,
  EXPORT_GENERATED, EXPORT_SENT and EXPORT_CANCELLED as before; an external address never enters the ledger. A refused
  command is recorded as COMMAND_DENIED with the command and outcome only.
- **Not in this change** (the P12-6b read-model migration, numbered at its turn): item kinds other than the case
  summary and internal recipients (F9), lists of exports (F8), the requester's fact that no approver is eligible (F5;
  DEC-F24's warning is administrative and goes to P12-8), downloads (F6) and recording a delivery made another way (F7).
  The request offers the catalogue's active purposes that the contracts' list names, so a purpose the catalogue gains
  later waits for that list: recorded debt until the database judges a purpose's shape, before the catalogue's Add
  purpose ships (P12-8).
- **Tests.** Unit: the page's words for every status, step, item kind, purpose, rule and refusal in both languages,
  who a line names, where the export stands, and an identifier as long as a UUID that wraps anywhere so a phone never
  scrolls sideways (`exports/labels.test.ts`); the request, recipient and submit schemas
  (`validation/src/exports.test.ts`); the gateway's view and reference rows; the service's uniform not-found with
  ACCESS_DENIED; the stub rendering's dual date; the confirmations and the route. `tests/e2e/exports.spec.ts` (+4): the
  journey from the case to a sent email, with two approvers each giving a stage from My Work on the preview, in Arabic
  at 390 px and English at 1280 px, with the preview recorded once per reader and never by the export's page; on a
  restricted case the authority's consent apart from the stage, and the approved PDF that waits for its file, at
  320 px; a draft that its approvers may not read, an investigator on the case who may not ask for an export, and the
  same 404 for an id that names nothing and a malformed one. `tests/accessibility/exports.spec.ts` (+4): the request
  page and its error summary, a draft and a refused address, the preview with the submission's confirmation, an
  approver's page and preview with the approval's confirmation, and the authority's consent with its confirmation, at
  1280, 390 and 320 px in both languages.
