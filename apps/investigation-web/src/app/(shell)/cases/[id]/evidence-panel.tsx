// Evidence panel on the case page (§24–§27). Lists what RLS returned, offers upload to users the database
// would allow (hidden ≠ forbidden: the server re-checks), and links downloads through the audited route.
// DEC-09: each item says who on the team sees it, and the leads may limit it to themselves or open it again.
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
  CDFField,
  CDFTable,
  classificationTone,
  fieldIds,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { setEvidenceRestrictionAction, uploadEvidenceAction } from "./actions";

const ACCEPT = ALLOWED_CONTENT_TYPES.flatMap((t) => t.extensions.map((e) => `.${e}`)).join(",");

function statusTone(status: string) {
  return status === "AVAILABLE" ? "success" : status === "REJECTED" ? "danger" : "neutral";
}

export function EvidencePanel({
  c,
  items,
  canUpload,
  canDownload,
  canRestrict,
  t,
}: {
  c: CaseDetail;
  items: EvidenceItem[];
  canUpload: boolean;
  canDownload: boolean;
  /** The case manager, owner or lead on a case whose content can still change (DEC-09). */
  canRestrict: boolean;
  t: Translator;
}) {
  const downloadHref = (versionId: string) => `/cases/${c.id}/evidence/${versionId}/download`;
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
            cell: (e) => (
              <span dir="ltr" className="font-semibold" data-testid={`evidence-row-${e.sequenceNo}`}>
                {evidenceDisplayNumber(e.sequenceNo)}
              </span>
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

      {items.map((e) => (
        <details
          key={e.id}
          className="mt-3 border-t border-cdf-border pt-3"
          data-testid={`evidence-versions-${e.sequenceNo}`}
        >
          <summary className="cursor-pointer font-semibold">
            <span dir="ltr">{evidenceDisplayNumber(e.sequenceNo)}</span> · {t("evidence.versions")}
          </summary>
          {e.description || e.sourceDescription || e.collectedAt ? (
            <p className="mt-2 text-sm">
              {e.description ? <span>{e.description} </span> : null}
              {e.sourceDescription ? (
                <span className="text-cdf-text-secondary">
                  {t("evidence.sourceLabel")}: {e.sourceDescription}{" "}
                </span>
              ) : null}
              {e.collectedAt ? (
                <span className="text-cdf-text-secondary">
                  {t("evidence.collectedAtLabel")}: <span dir="ltr">{e.collectedAt}</span>
                </span>
              ) : null}
            </p>
          ) : null}
          <ul className="mt-2 text-sm">
            {e.versions.map((v) => (
              <li key={v.id} className="mb-2">
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
                      href={downloadHref(v.id)}
                      aria-label={t("evidence.downloadVersion", {
                        item: evidenceDisplayNumber(e.sequenceNo),
                        no: v.versionNo,
                      })}
                      className="underline underline-offset-4"
                      data-testid={`download-${v.id}`}
                    >
                      {t("evidence.download")}
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          <h3 className="mt-2 font-semibold">{t("evidence.restriction.title")}</h3>
          <p className="text-sm" data-testid={`evidence-restriction-${e.sequenceNo}`}>
            {e.restriction === "LEADS" ? t("evidence.restriction.leads") : t("evidence.restriction.team")}
          </p>
          {canRestrict ? (
            <div className="mt-2">
              <CDFCommandForm
                action={setEvidenceRestrictionAction.bind(
                  null,
                  c.id,
                  e.id,
                  e.restriction === "LEADS" ? "TEAM" : "LEADS",
                )}
                locale={t.locale}
                submitLabel={
                  e.restriction === "LEADS" ? t("evidence.restriction.open") : t("evidence.restriction.limit")
                }
                submitName={t(
                  e.restriction === "LEADS"
                    ? "evidence.restriction.openItem"
                    : "evidence.restriction.limitItem",
                  { item: evidenceDisplayNumber(e.sequenceNo) },
                )}
                variant="secondary"
                fieldLabels={{ reason: t("evidence.restriction.reason") }}
                testId={`restriction-form-${e.sequenceNo}`}
              >
                <CDFField
                  id={`restrictionReason-${e.sequenceNo}`}
                  label={t("evidence.restriction.reasonFor", { item: evidenceDisplayNumber(e.sequenceNo) })}
                  hint={t("evidence.restriction.reasonHint")}
                  requiredLabel={t("common.required")}
                >
                  <input
                    id={`restrictionReason-${e.sequenceNo}`}
                    name="reason"
                    aria-describedby={`restrictionReason-${e.sequenceNo}-hint`}
                    className={inputClass}
                    required
                    minLength={10}
                    maxLength={500}
                  />
                </CDFField>
              </CDFCommandForm>
            </div>
          ) : null}
          <h3 className="mt-2 font-semibold">{t("evidence.custody")}</h3>
          <ol className="list-decimal ps-5 text-sm" data-testid={`custody-${e.sequenceNo}`}>
            {e.custody.map((ev) => (
              <li key={ev.id}>
                {t(`custodyEvent.${ev.eventType}` as MessageKey)} · {ev.actorName ?? "—"} ·{" "}
                {formatDateTime(t.locale, ev.occurredAt)}
              </li>
            ))}
          </ol>
          {canUpload ? (
            <div className="mt-3">
              <h3 className="mb-2 font-semibold">{t("evidence.newVersionTitle")}</h3>
              <CDFCommandForm
                action={uploadEvidenceAction.bind(null, c.id, e.id)}
                locale={t.locale}
                submitLabel={t("evidence.newVersion")}
                submitName={t("evidence.newVersionOf", { item: evidenceDisplayNumber(e.sequenceNo) })}
                variant="secondary"
                fieldLabels={{ file: t("evidence.fileLabel") }}
                testId={`new-version-form-${e.sequenceNo}`}
                successMessage={t("evidence.uploaded", { sha: "{message}" })}
              >
                <CDFField
                  id={`file-${e.sequenceNo}`}
                  label={t("evidence.fileFor", { item: evidenceDisplayNumber(e.sequenceNo) })}
                  requiredLabel={t("common.required")}
                >
                  <input
                    id={`file-${e.sequenceNo}`}
                    name="file"
                    type="file"
                    accept={ACCEPT}
                    className={inputClass}
                    required
                  />
                </CDFField>
              </CDFCommandForm>
            </div>
          ) : null}
        </details>
      ))}

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
