// My Committees «لجاني» (UX redesign Phase 12 P12-2b; ADR-055). The committees where the caller holds a seat now, from
// api.my_committees: the seat basis only, never the case team's view of a case, and counts of the caller's own open
// proceedings and active meetings, never a case count. Like every area, it answers the uniform 404 to a caller who
// has none of it: without a current seat there is no committee here. Each row opens the committee's page, which
// re-checks the seat in the database.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { MyCommitteeRow } from "@cdf/contracts";
import { formatDate, isolate, type Translator } from "@cdf/i18n";
import { CDFPageHeader, CDFWorkItem, CDFWorkList } from "@cdf/ui";
import { committeesService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.committees") };
}

export default async function MyCommitteesPage() {
  const { ctx } = await requireActor();
  const [t, rows] = await Promise.all([getTranslator(), committeesService().myCommittees(ctx)]);
  if (rows.length === 0) notFound();
  return (
    <>
      <CDFPageHeader title={t("committees.title")} intro={t("committees.intro")} />
      <CDFWorkList label={t("committees.listLabel")} testId="my-committees">
        {rows.map((c) => (
          <CommitteeRow key={c.committeeId} t={t} c={c} />
        ))}
      </CDFWorkList>
    </>
  );
}

function CommitteeRow({ t, c }: { t: Translator; c: MyCommitteeRow }) {
  const date = (iso: string) => isolate(formatDate(t.locale, iso));
  const seat = t.code("committeeSeat", c.seat, "common.none");
  return (
    <CDFWorkItem
      href={`/committees/${c.committeeId}`}
      action={t.code("committeeName", c.code, "common.none")}
      reference={
        <span data-testid={`committee-${c.code}-seat`}>
          {t("committees.rowSeat", { seat })}
          {c.isActive ? null : ` · ${t("committees.inactive")}`}
        </span>
      }
      detail={
        <span data-testid={`committee-${c.code}-counts`}>
          {t("committees.openProceedings", { count: c.openProceedings })} ·{" "}
          {t("committees.activeMeetings", { count: c.activeMeetings })}
        </span>
      }
      since={
        c.effectiveTo
          ? t("committees.rowPeriod", { from: date(c.effectiveFrom), to: date(c.effectiveTo) })
          : t("committees.rowSince", { date: date(c.effectiveFrom) })
      }
      testId={`committee-${c.code}`}
    />
  );
}
