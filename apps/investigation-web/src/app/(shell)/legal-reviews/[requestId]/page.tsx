// A legal review assigned to the caller «المراجعة القانونية» (UX redesign Phase 12 P12-3a; ADR-057; DEC-62, AMB-115,
// AMB-117): a purpose route that reads api.legal_review_view (L1) and nothing of the case. The request is the
// reviewer's while it is assigned to them and its packet is theirs to read: anyone else, a cancelled request and an id
// that names nothing get the same 404, and the refusal is recorded (ACCESS_DENIED). The packet opens on a page of its
// own, so that only opening it is recorded as a read of the packet. Each opinion form shows only where its command
// would accept the caller now (UX-116), with the reason in words where it would not; each command checks again.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LEGAL_OPINIONS, type LegalReviewView } from "@cdf/contracts";
import { formatDateTime, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFAlert,
  CDFBreadcrumbs,
  CDFCard,
  CDFCommandForm,
  CDFDescriptionList,
  CDFField,
  CDFFieldError,
  CDFPageHeader,
  CDFPurposeBanner,
  CDFStatusBadge,
  textareaClass,
  type CDFCommandFormProps,
} from "@cdf/ui";
import { legalReviewsService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { actLabel, confirmation } from "../../confirmations";
import { LEGAL_CODES, accountName, codeText } from "../labels";
import { giveOpinionAction, giveSupersedingOpinionAction } from "./actions";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or committee content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.legalReview") };
}

const UUID = /^[0-9a-f-]{36}$/i;

export default async function LegalReviewPage({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  if (!UUID.test(requestId)) notFound();
  const { ctx } = await requireActor();
  const t = await getTranslator();
  const r = await legalReviewsService().review(ctx, requestId);
  if (!r) notFound();
  const at = (iso: string) => isolate(formatDateTime(t.locale, iso));

  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={[
          { label: t("shell.area.MY_WORK"), href: "/my-work" },
          { label: t("legalReviews.breadcrumb") },
        ]}
      />
      <CDFPageHeader
        title={t("legalReviews.title")}
        actions={
          <CDFStatusBadge domain="legalReview" status={r.status} testId="legal-review-status">
            {t(`legalReviews.status.${r.status}` as MessageKey)}
          </CDFStatusBadge>
        }
      />
      <CDFPurposeBanner
        title={t("legalReviews.purposeTitle")}
        purpose={t("legalReviews.purposeBody")}
        notShown={t("legalReviews.purposeNotShown")}
        testId="legal-review-purpose-banner"
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          <CDFCard title={t("legalReviews.requestTitle")} testId="legal-review-request">
            <div className="mb-4">
              <CDFDescriptionList
                items={[
                  { term: t("legalReviews.roundLabel"), value: String(r.packageRound) },
                  {
                    term: t("legalReviews.basisLabel"),
                    value: t(`legalReviews.basis.${r.basis}` as MessageKey),
                  },
                  {
                    term: t("legalReviews.askedByLabel"),
                    value: (
                      <bdi>
                        {r.requestedBy ? accountName(t, r.requestedBy) : t("legalReviews.theSecretary")}
                      </bdi>
                    ),
                  },
                  { term: t("legalReviews.askedOnLabel"), value: formatDateTime(t.locale, r.requestedAt) },
                  {
                    term: t("legalReviews.reasonTitle"),
                    value: (
                      <bdi dir="auto" data-testid="legal-review-reason">
                        {r.reason}
                      </bdi>
                    ),
                  },
                ]}
              />
            </div>
            <p className="mb-1">
              <Link
                href={`/legal-reviews/${r.requestId}/packet`}
                className="font-semibold underline underline-offset-4"
                data-testid="legal-review-packet-link"
              >
                {t("legalReviews.packetLink")}
              </Link>
            </p>
            <p className="text-sm text-cdf-text-secondary">{t("legalReviews.packetHint")}</p>
          </CDFCard>

          <CDFCard title={t("legalReviews.opinionTitle")} testId="legal-review-opinion">
            {r.opinion ? (
              <ol className="grid gap-4">
                <OpinionEntry
                  testId="legal-review-opinion-1"
                  title={t(`legalReviews.opinion.${r.opinion}` as MessageKey)}
                  givenOn={r.opinionAt ? t("legalReviews.givenOn", { date: at(r.opinionAt) }) : null}
                  text={r.opinionText}
                />
                {r.revisions.map((v) => (
                  <OpinionEntry
                    key={v.revisionId}
                    testId={`legal-review-revision-${v.revisionNo - 1}`}
                    title={`${t("legalReviews.laterOpinion", { n: v.revisionNo - 1 })} · ${t(`legalReviews.opinion.${v.opinion}` as MessageKey)}`}
                    givenOn={t("legalReviews.givenOn", { date: at(v.givenAt) })}
                    text={v.opinionText}
                  />
                ))}
              </ol>
            ) : (
              <p className="text-cdf-text-secondary" data-testid="legal-review-no-opinion">
                {t("legalReviews.noOpinion")}
              </p>
            )}
          </CDFCard>
        </div>

        <div className="min-w-0">
          <OpinionForms t={t} r={r} />
        </div>
      </div>
    </>
  );
}

function OpinionEntry({
  testId,
  title,
  givenOn,
  text,
}: {
  testId: string;
  title: string;
  givenOn: string | null;
  text: string | null;
}) {
  return (
    <li className="border-b border-cdf-border pb-4 last:border-0 last:pb-0" data-testid={testId}>
      <h3 className="font-semibold">{title}</h3>
      {givenOn ? <p className="text-sm text-cdf-text-secondary">{givenOn}</p> : null}
      {text ? (
        <p className="mt-1 whitespace-pre-wrap break-words">
          <bdi dir="auto">{text}</bdi>
        </p>
      ) : null}
    </li>
  );
}

/**
 * The opinion, while the request waits for it, and a later opinion once it is given, each where its command would
 * accept the caller now (L1's capabilities); where it would not, why, in words (L1's blocks).
 */
function OpinionForms({ t, r }: { t: Translator; r: LegalReviewView }) {
  const cap = r.capabilities;
  if (cap.mayGiveOpinion)
    return (
      <CDFCard title={t("legalReviews.giveTitle")} testId="legal-review-give">
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("legalReviews.giveIntro")}</p>
        <OpinionForm t={t} id="give" action={giveOpinionAction.bind(null, r.requestId)} superseding={false} />
      </CDFCard>
    );
  if (cap.mayGiveSupersedingOpinion)
    return (
      <CDFCard title={t("legalReviews.supersedeTitle")} testId="legal-review-supersede">
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("legalReviews.supersedeIntro")}</p>
        <OpinionForm
          t={t}
          id="supersede"
          action={giveSupersedingOpinionAction.bind(null, r.requestId)}
          superseding
        />
      </CDFCard>
    );
  const block = r.status === "ASSIGNED" ? r.opinionBlock : r.supersedingOpinionBlock;
  return block ? (
    <CDFAlert tone="info" title={t("legalReviews.refusedTitle")} testId="legal-review-blocked">
      <p>{codeText(t, ["legalReviews.opinionBlock", ...LEGAL_CODES], block)}</p>
    </CDFAlert>
  ) : null;
}

function OpinionForm({
  t,
  id,
  action,
  superseding,
}: {
  t: Translator;
  id: string;
  action: CDFCommandFormProps["action"];
  superseding: boolean;
}) {
  const act = superseding ? "giveSupersedingLegalOpinion" : "giveLegalOpinion";
  return (
    <CDFCommandForm
      action={action}
      locale={t.locale}
      submitLabel={actLabel(t, act)}
      variant="primary"
      testId={`${id}-opinion-form`}
      successMessage={superseding ? t("legalReviews.superseded") : t("legalReviews.given")}
      codeSections={LEGAL_CODES}
      fieldLabels={{
        opinion: t("legalReviews.opinionLabel"),
        opinionText: t("legalReviews.opinionTextLabel"),
      }}
      confirm={confirmation(t, act)}
    >
      <fieldset className="mb-4">
        <legend className="mb-1 font-semibold">{t("legalReviews.opinionLabel")}</legend>
        {LEGAL_OPINIONS.map((o) => (
          <div key={o} className="mb-2 flex items-start gap-2">
            <input
              id={`${id}-opinion-${o}`}
              type="radio"
              name="opinion"
              value={o}
              className="mt-1 size-5"
              required
              aria-describedby={`${id}-opinion-${o}-hint`}
              data-testid={`${id}-opinion-${o}`}
            />
            <div>
              <label htmlFor={`${id}-opinion-${o}`}>{t(`legalReviews.opinion.${o}` as MessageKey)}</label>
              <p id={`${id}-opinion-${o}-hint`} className="text-sm text-cdf-text-secondary">
                {t(`legalReviews.opinionHint.${o}` as MessageKey)}
              </p>
            </div>
          </div>
        ))}
        <CDFFieldError id={`${id}-opinion-${LEGAL_OPINIONS[0]}`} />
      </fieldset>
      <CDFField
        id={`${id}-opinion-text`}
        label={t("legalReviews.opinionTextLabel")}
        hint={t("legalReviews.opinionTextHint")}
      >
        <textarea
          id={`${id}-opinion-text`}
          name="opinionText"
          className={textareaClass}
          aria-describedby={`${id}-opinion-text-hint`}
          maxLength={8000}
          data-testid={`${id}-opinion-text`}
        />
      </CDFField>
    </CDFCommandForm>
  );
}
