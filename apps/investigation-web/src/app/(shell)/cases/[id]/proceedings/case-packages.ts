// A recommendation package of this case, found through the case (UX redesign Phase 12 P12-3a; ADR-057): R2 of each of
// the case's Investigation Committee proceedings, as the case team reads it. The case's own pages for a package (the
// restricted case's approval of a legal review, a packet) start here, so that an id from another case is the same 404
// as one that names nothing.
import "server-only";
import type { CaseStructure, RecommendationPackageView } from "@cdf/contracts";
import { committeeProceedingsService, type RequestScope } from "@/server/container";

export async function findCasePackage(
  ctx: RequestScope["ctx"],
  s: CaseStructure,
  match: (pkg: RecommendationPackageView) => boolean,
): Promise<{ committeeProceedingId: string; pkg: RecommendationPackageView } | null> {
  for (const cp of s.committeeProceedings) {
    if (s.committees.find((k) => k.id === cp.committeeId)?.kind !== "INVESTIGATION") continue;
    const items = await committeeProceedingsService().items(ctx, cp.id);
    const pkg = items?.packages.find(match);
    if (pkg) return { committeeProceedingId: cp.id, pkg };
  }
  return null;
}
