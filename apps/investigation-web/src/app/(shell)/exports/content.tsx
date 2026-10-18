// What an export holds, as the audited preview gives it (UX redesign Phase 12 P12-6b-1; ADR-026). The database renders
// each item with the same predicates as its own reads (exchange.render_item) and leaves out the content of an item the
// reader may not see now. The page shows every field the preview returns, named in the reader's language where the
// catalogue has words for it, and nothing else: no field is dropped, so an approver reads exactly what they approve.
import type { ReactNode } from "react";
import type { ExportDocumentItem, ExportObjectType } from "@cdf/contracts";
import { formatDateTime, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import { CDFDescriptionList, CDFIdentifier } from "@cdf/ui";
import { itemKind } from "./labels";

const INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * The catalogue sections that name a coded field's values, tried in order; a field's meaning can depend on the item's
 * kind. A category is a person's (subjectCategory) or an allegation's (category): their codes never overlap.
 */
function codeSections(type: ExportObjectType, field: string): readonly string[] {
  switch (field) {
    case "classification":
      return ["classification"];
    case "priority":
      return ["priority"];
    case "case_type":
      return ["exports.caseType"];
    case "result":
      return ["findingResult"];
    case "allegation_category":
      return ["category"];
    case "category":
      return ["subjectCategory", "category"];
    case "item_type":
      return ["committeeProceedings.itemType"];
    case "committee_result":
      return ["committeeProceedings.itemResult"];
    case "authority_type":
      return ["legalReviews.authorityType"];
    case "outcome":
      return ["legalReviews.outcome"];
    case "status":
      return type === "RECOMMENDATION_PACKAGE"
        ? ["committeeProceedings.packageStatus"]
        : type === "MINUTES"
          ? ["minutes.status"]
          : [];
    default:
      return [];
  }
}

/** Fields that are identifiers: written left to right, never translated. */
const IDENTIFIERS = new Set(["case_number"]);
/** Identifiers as long as a UUID, or longer: they wrap anywhere, so a phone never scrolls sideways. */
const LONG_IDENTIFIERS = new Set(["source_document_reference", "item_id", "subject_id", "allegation_id"]);

/** A field's name in the reader's language, else the field's own code. */
function fieldLabel(t: Translator, field: string): string {
  const key = `exports.field.${field}`;
  const label = t(key as MessageKey);
  return label !== key ? label : field;
}

function value(t: Translator, type: ExportObjectType, field: string, v: unknown, depth: number): ReactNode {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return t(v ? "common.yes" : "common.no");
  if (typeof v === "number") return isolate(String(v));
  if (typeof v === "string") {
    const sections = codeSections(type, field);
    if (sections.length > 0) {
      for (const section of sections) {
        const key = `${section}.${v}`;
        const named = t(key as MessageKey);
        if (named !== key) return named;
      }
      return <CDFIdentifier>{v}</CDFIdentifier>;
    }
    if (IDENTIFIERS.has(field)) return <CDFIdentifier>{v}</CDFIdentifier>;
    if (LONG_IDENTIFIERS.has(field)) return <CDFIdentifier variant="hash">{v}</CDFIdentifier>;
    if (INSTANT.test(v) && !Number.isNaN(Date.parse(v))) return isolate(formatDateTime(t.locale, v));
    return (
      <bdi dir="auto" className="whitespace-pre-wrap break-words">
        {v}
      </bdi>
    );
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return t("exports.noEntries");
    return (
      <ol className="grid gap-2 ps-4">
        {v.map((x, k) => (
          <li key={k} className="list-decimal">
            {value(t, type, field, x, depth + 1)}
          </li>
        ))}
      </ol>
    );
  }
  if (typeof v === "object")
    return <Fields t={t} type={type} content={v as Record<string, unknown>} depth={depth + 1} />;
  return isolate(String(v));
}

function Fields({
  t,
  type,
  content,
  depth,
}: {
  t: Translator;
  type: ExportObjectType;
  content: Record<string, unknown>;
  depth: number;
}) {
  return (
    <CDFDescriptionList
      stacked={depth > 0}
      items={Object.entries(content).map(([field, v]) => ({
        term: fieldLabel(t, field),
        value: <span data-field={field}>{value(t, type, field, v, depth)}</span>,
      }))}
    />
  );
}

/** One item of the document: its kind and place, and its content, or why the reader does not see it. */
export function ExportItemContent({ t, item }: { t: Translator; item: ExportDocumentItem }) {
  return (
    <li
      className="border-b border-cdf-border pb-4 last:border-0 last:pb-0"
      data-testid={`export-document-item-${item.position}`}
      data-included={item.included ? "true" : "false"}
    >
      <h3 className="mb-2 font-semibold">
        {t("exports.itemHeading", { n: item.position, kind: itemKind(t, item) })}
      </h3>
      {item.included && item.content ? (
        <Fields t={t} type={item.objectType} content={item.content} depth={0} />
      ) : (
        <p className="text-sm" data-testid={`export-document-item-${item.position}-withheld`}>
          {t("exports.withheldContent")}
        </p>
      )}
    </li>
  );
}
