// Evidence on the case (§24–§27). The register lists what RLS returned, offers upload to users the database
// allows (hidden ≠ forbidden: the server re-checks) and links each item to its own page (UX-075), where its
// versions, chain of custody and new versions live. Downloads go through the audited route. DEC-09: the item page
// says who on the team sees the item, and the leads may limit it to themselves or open it again.
import {
  EVIDENCE_TYPES,
  type CaseDetail,
  type EvidenceItem,
  type ReportAttachmentItem,
} from "@cdf/contracts";
import { ALLOWED_CONTENT_TYPES, evidenceDisplayNumber, formatBytes } from "@cdf/domain";
import { formatDateTime, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFCommandForm,
  CDFDescriptionList,
  CDFField,
  CDFTable,
  classificationTone,
  fieldIds,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { setEvidenceRestrictionAction, uploadEvidenceAction } from "./actions";

const ACCEPT = ALLOWED_CONTENT_TYPES.flatMap((t) => t.extensions.map((e) => `.${e}`)).join(",");

/** The item's own page (UX-075). By id, never by its display number; the page answers 404 for a hidden item. */
export const evidenceItemHref = (caseId: string, evidenceId: string) =>
  `/cases/${caseId}/evidence/items/${evidenceId}`;
const evidenceDownloadHref = (caseId: string, versionId: string) =>
  `/cases/${caseId}/evidence/${versionId}/download`;

function statusTone(status: string) {
  return status === "AVAILABLE" ? "success" : status === "REJECTED" ? "danger" : "neutral";
}

export function EvidencePanel({
  c,
  items,
  canUpload,
  canDownload,
  t,
}: {
  c: CaseDetail;
  items: EvidenceItem[];
  canUpload: boolean;
  canDownload: boolean;
  t: Translator;
}) {
  const downloadHref = (versionId: string) => evidenceDownloadHref(c.id, versionId);
  // From the case's level up to the caller's clearance, read with the case (UX-116); the database checks again.
  const levels = c.can.classifications;

  return (
    <CDFCard title={t("evidence.title")} testId="evidence-card">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("evidence.intro")}</p>
      <CDFTable<EvidenceItem>
        caption={t("evidence.tableCaption")}
        testId="evidence-table"
        rows={items}
        rowKey={(e) => e.id}
        empty={t("evidence.empty")}
        columns={[
          {
            header: t("evidence.number"),
            // One address per item (UX-075): the number opens the item's page.
            cell: (e) => (
              <a
                href={evidenceItemHref(c.id, e.id)}
                dir="ltr"
                className="font-semibold underline underline-offset-4"
                data-testid={`evidence-row-${e.sequenceNo}`}
              >
                {evidenceDisplayNumber(e.sequenceNo)}
              </a>
            ),
          },
          {
            header: t("evidence.itemTitle"),
            cell: (e) => (
              <>
                <span className="font-semibold">{e.title}</span>
                <br />
                <span className="text-cdf-text-secondary">
                  {t(`evidenceType.${e.evidenceType}` as MessageKey)}
                </span>
              </>
            ),
          },
          {
            header: t("evidence.file"),
            cell: (e) =>
              e.currentVersion ? (
                <>
                  <span dir="ltr">{e.currentVersion.originalFileName}</span>
                  <br />
                  <span className="text-cdf-text-secondary" dir="ltr">
                    {formatBytes(e.currentVersion.sizeBytes)} · v{e.currentVersion.versionNo}
                  </span>
                </>
              ) : (
                "—"
              ),
          },
          {
            header: t("evidence.classification"),
            cell: (e) => (
              <>
                <CDFBadge tone={classificationTone(e.classification)}>
                  {t(`classification.${e.classification}` as MessageKey)}
                </CDFBadge>
                {e.restriction === "LEADS" ? (
                  <>
                    {" "}
                    <span data-testid={`evidence-leads-${e.sequenceNo}`}>
                      <CDFBadge tone="warning">{t("evidence.restriction.leadsBadge")}</CDFBadge>
                    </span>
                  </>
                ) : null}
              </>
            ),
          },
          {
            header: t("evidence.status"),
            cell: (e) => (
              <CDFBadge tone={statusTone(e.status)}>{t(`evidenceStatus.${e.status}` as MessageKey)}</CDFBadge>
            ),
          },
          {
            header: t("evidence.addedBy"),
            cell: (e) => `${e.createdByName ?? "—"} · ${formatDateTime(t.locale, e.createdAt)}`,
          },
          {
            header: t("evidence.download"),
            cell: (e) =>
              canDownload && e.currentVersion?.status === "AVAILABLE" ? (
                <a
                  href={downloadHref(e.currentVersion.id)}
                  aria-label={t("evidence.downloadItem", { item: evidenceDisplayNumber(e.sequenceNo) })}
                  className="font-semibold underline underline-offset-4"
                  data-testid={`download-${e.currentVersion.id}`}
                >
                  {t("evidence.download")}
                </a>
              ) : (
                "—"
              ),
          },
        ]}
      />

      {canUpload ? (
        <div className="mt-4 border-t border-cdf-border pt-4">
          <h3 className="mb-1 font-semibold">{t("evidence.uploadTitle")}</h3>
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("evidence.uploadIntro")}</p>
          <CDFCommandForm
            action={uploadEvidenceAction.bind(null, c.id, null)}
            locale={t.locale}
            submitLabel={t("evidence.upload")}
            variant="secondary"
            testId="evidence-form"
            fieldLabels={{
              file: t("evidence.fileLabel"),
              title: t("evidence.titleLabel"),
              evidenceType: t("evidence.typeLabel"),
              description: t("evidence.descriptionLabel"),
              sourceDescription: t("evidence.sourceLabel"),
              collectedAt: t("evidence.collectedAtLabel"),
              classification: t("evidence.classificationLabel"),
            }}
            successMessage={t("evidence.uploaded", { sha: "{message}" })}
          >
            <CDFField id="file" label={t("evidence.fileLabel")} requiredLabel={t("common.required")}>
              <input id="file" name="file" type="file" accept={ACCEPT} className={inputClass} required />
            </CDFField>
            <CDFField
              id="evidenceTitle"
              label={t("evidence.titleLabel")}
              requiredLabel={t("common.required")}
            >
              <input
                id="evidenceTitle"
                name="title"
                className={inputClass}
                required
                minLength={3}
                maxLength={200}
              />
            </CDFField>
            <CDFField id="evidenceType" label={t("evidence.typeLabel")}>
              <select id="evidenceType" name="evidenceType" className={inputClass} defaultValue="DOCUMENT">
                {EVIDENCE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`evidenceType.${type}` as MessageKey)}
                  </option>
                ))}
              </select>
            </CDFField>
            <CDFField
              id="evidenceClassification"
              label={t("evidence.classificationLabel")}
              hint={t("evidence.classificationHint")}
            >
              <select
                id="evidenceClassification"
                name="classification"
                className={inputClass}
                defaultValue={c.classification}
                aria-describedby="evidenceClassification-hint"
              >
                {levels.map((l) => (
                  <option key={l} value={l}>
                    {t(`classification.${l}` as MessageKey)}
                  </option>
                ))}
              </select>
            </CDFField>
            <CDFField
              id="sourceDescription"
              label={t("evidence.sourceLabel")}
              hint={t("evidence.sourceHint")}
              optionalLabel={t("common.optional")}
            >
              <input
                id="sourceDescription"
                name="sourceDescription"
                className={inputClass}
                maxLength={500}
                aria-describedby="sourceDescription-hint"
              />
            </CDFField>
            <CDFField
              id="collectedAt"
              label={t("evidence.collectedAtLabel")}
              optionalLabel={t("common.optional")}
              hint={t("common.dateHint")}
            >
              <input
                {...fieldIds("collectedAt", { hint: t("common.dateHint") })}
                name="collectedAt"
                type="date"
                className={inputClass}
                dir="ltr"
              />
            </CDFField>
            <CDFField
              id="evidenceDescription"
              label={t("evidence.descriptionLabel")}
              optionalLabel={t("common.optional")}
            >
              <textarea
                id="evidenceDescription"
                name="description"
                className={textareaClass}
                maxLength={2000}
              />
            </CDFField>
          </CDFCommandForm>
        </div>
      ) : null}
    </CDFCard>
  );
}

/**
 * One evidence item's page (UX-075): what it is, its versions, who on the team sees it, its chain of custody and
 * a new version. What RLS returned for the caller; the page answers 404 for an item they may not see.
 */
export function EvidenceItemView({
  c,
  e,
  canUpload,
  canDownload,
  canRestrict,
  t,
}: {
  c: CaseDetail;
  e: EvidenceItem;
  canUpload: boolean;
  canDownload: boolean;
  canRestrict: boolean;
  t: Translator;
}) {
  const item = evidenceDisplayNumber(e.sequenceNo);
  return (
    <div data-testid="evidence-item">
      {/* The case header is the page's h1; the item is this tab's item (audit §22.1). */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-cdf-h2 font-semibold">
          <bdi dir="ltr">{item}</bdi> · <bdi dir="auto">{e.title}</bdi>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <CDFBadge tone={classificationTone(e.classification)}>
            {t(`classification.${e.classification}` as MessageKey)}
          </CDFBadge>
          {e.restriction === "LEADS" ? (
            <span data-testid={`evidence-leads-${e.sequenceNo}`}>
              <CDFBadge tone="warning">{t("evidence.restriction.leadsBadge")}</CDFBadge>
            </span>
          ) : null}
          <CDFBadge tone={statusTone(e.status)}>{t(`evidenceStatus.${e.status}` as MessageKey)}</CDFBadge>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          <CDFCard title={t("evidence.about")} testId="evidence-about">
            <CDFDescriptionList
              items={[
                { term: t("evidence.type"), value: t(`evidenceType.${e.evidenceType}` as MessageKey) },
                {
                  term: t("evidence.addedBy"),
                  value: `${e.createdByName ?? "—"} · ${formatDateTime(t.locale, e.createdAt)}`,
                },
                ...(e.sourceDescription
                  ? [{ term: t("evidence.sourceLabel"), value: <bdi dir="auto">{e.sourceDescription}</bdi> }]
                  : []),
                ...(e.collectedAt
                  ? [{ term: t("evidence.collectedAtLabel"), value: <span dir="ltr">{e.collectedAt}</span> }]
                  : []),
                ...(e.description
                  ? [{ term: t("evidence.descriptionLabel"), value: <bdi dir="auto">{e.description}</bdi> }]
                  : []),
              ]}
            />
          </CDFCard>

          <CDFCard title={t("evidence.versions")} testId={`evidence-versions-${e.sequenceNo}`}>
            {/* Long tokens (file names, the scanner's name) wrap instead of widening the page at 320 px. */}
            <ol className="space-y-3 break-words text-sm">
              {e.versions.map((v) => (
                <li key={v.id}>
                  <span className="font-semibold">{t("evidence.version", { no: v.versionNo })}</span> ·{" "}
                  <span dir="ltr">{v.originalFileName}</span> ·{" "}
                  <span dir="ltr">{formatBytes(v.sizeBytes)}</span> ·{" "}
                  <CDFBadge tone={statusTone(v.status)}>
                    {t(`versionStatus.${v.status}` as MessageKey)}
                  </CDFBadge>{" "}
                  {v.rejectionCode ? (
                    <span className="text-cdf-danger">
                      {t.code("codes", v.rejectionCode, "errors.CONFLICT")}
                    </span>
                  ) : null}
                  <br />
                  <span className="text-cdf-text-secondary">
                    {v.uploadedByName ?? "—"} · {formatDateTime(t.locale, v.uploadedAt)}
                    {v.scanner ? ` · ${t("evidence.scanner")}: ${v.scanner}` : ""}
                  </span>
                  <br />
                  <code className="break-all text-xs" dir="ltr">
                    {t("evidence.sha256")}: {v.sha256}
                  </code>
                  {canDownload && v.status === "AVAILABLE" ? (
                    <>
                      {" "}
                      <a
                        href={evidenceDownloadHref(c.id, v.id)}
                        aria-label={t("evidence.downloadVersion", { item, no: v.versionNo })}
                        className="underline underline-offset-4"
                        data-testid={`download-${v.id}`}
                      >
                        {t("evidence.download")}
                      </a>
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
          </CDFCard>

          <CDFCard title={t("evidence.custody")} testId={`custody-${e.sequenceNo}`}>
            <ol className="list-decimal break-words ps-5 text-sm">
              {e.custody.map((ev) => (
                <li key={ev.id}>
                  {t(`custodyEvent.${ev.eventType}` as MessageKey)} · {ev.actorName ?? "—"} ·{" "}
                  {formatDateTime(t.locale, ev.occurredAt)}
                </li>
              ))}
            </ol>
          </CDFCard>
        </div>

        <div className="min-w-0">
          <CDFCard title={t("evidence.restriction.title")}>
            <p className="text-sm" data-testid={`evidence-restriction-${e.sequenceNo}`}>
              {e.restriction === "LEADS" ? t("evidence.restriction.leads") : t("evidence.restriction.team")}
            </p>
            {canRestrict ? (
              <div className="mt-3">
                <CDFCommandForm
                  action={setEvidenceRestrictionAction.bind(
                    null,
                    c.id,
                    e.id,
                    e.restriction === "LEADS" ? "TEAM" : "LEADS",
                  )}
                  locale={t.locale}
                  submitLabel={
                    e.restriction === "LEADS"
                      ? t("evidence.restriction.open")
                      : t("evidence.restriction.limit")
                  }
                  submitName={t(
                    e.restriction === "LEADS"
                      ? "evidence.restriction.openItem"
                      : "evidence.restriction.limitItem",
                    { item },
                  )}
                  variant="secondary"
                  fieldLabels={{ reason: t("evidence.restriction.reason") }}
                  testId={`restriction-form-${e.sequenceNo}`}
                >
                  <CDFField
                    id="restrictionReason"
                    label={t("evidence.restriction.reason")}
                    hint={t("evidence.restriction.reasonHint")}
                    requiredLabel={t("common.required")}
                  >
                    <input
                      id="restrictionReason"
                      name="reason"
                      aria-describedby="restrictionReason-hint"
                      className={inputClass}
                      required
                      minLength={10}
                      maxLength={500}
                    />
                  </CDFField>
                </CDFCommandForm>
              </div>
            ) : null}
          </CDFCard>

          {canUpload ? (
            <CDFCard title={t("evidence.newVersionTitle")}>
              <CDFCommandForm
                action={uploadEvidenceAction.bind(null, c.id, e.id)}
                locale={t.locale}
                submitLabel={t("evidence.newVersion")}
                submitName={t("evidence.newVersionOf", { item })}
                variant="secondary"
                fieldLabels={{ file: t("evidence.fileLabel") }}
                testId={`new-version-form-${e.sequenceNo}`}
                successMessage={t("evidence.uploaded", { sha: "{message}" })}
              >
                <CDFField
                  id="newVersionFile"
                  label={t("evidence.fileLabel")}
                  requiredLabel={t("common.required")}
                >
                  <input
                    id="newVersionFile"
                    name="file"
                    type="file"
                    accept={ACCEPT}
                    className={inputClass}
                    required
                  />
                </CDFField>
              </CDFCommandForm>
            </CDFCard>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The reporter's files «ملفات المبلّغ» (ADR-015; DEC-09). What RLS returned: the investigation team's, and triage's
 * while its grant lasts. Opening one needs evidence download rights once a case exists; the route re-checks.
 */
export function ReporterFilesCard({
  files,
  canDownload,
  t,
}: {
  files: ReportAttachmentItem[];
  canDownload: boolean;
  t: Translator;
}) {
  return (
    <CDFCard title={t("evidence.reporterFiles.title")} testId="reporter-files">
      <p className="mb-2 text-sm text-cdf-text-secondary">{t("evidence.reporterFiles.intro")}</p>
      {files.length === 0 ? (
        <p data-testid="reporter-files-none">{t("intake.attachmentsNone")}</p>
      ) : (
        <ul className="space-y-2">
          {files.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-3"
              data-testid={`reporter-file-${a.displayName}`}
            >
              {canDownload && a.status === "AVAILABLE" ? (
                <a
                  href={`/intake/${a.reportId}/attachments/${a.id}`}
                  className="font-semibold underline"
                  aria-label={t("intake.attachmentDownload", { name: a.displayName })}
                  dir="ltr"
                >
                  {a.displayName}
                </a>
              ) : (
                <span className="font-semibold" dir="ltr">
                  {a.displayName}
                </span>
              )}
              <CDFBadge
                tone={a.status === "AVAILABLE" ? "success" : a.status === "REJECTED" ? "danger" : "warning"}
              >
                {t(`intake.attachmentStatus.${a.status}` as MessageKey)}
              </CDFBadge>
              <span className="text-sm text-cdf-text-secondary">
                {t(`intake.attachmentSource.${a.source}` as MessageKey)} · {formatBytes(a.sizeBytes)} ·{" "}
                {formatDateTime(t.locale, a.receivedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </CDFCard>
  );
}
