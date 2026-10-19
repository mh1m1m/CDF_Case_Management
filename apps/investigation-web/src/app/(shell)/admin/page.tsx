// Administration «إدارة المنصة» (UX redesign S1; P12-8a, P12-8b): opens the first page the database opens to the
// caller (`api.my_admin_views`, F3; ADR-063), in the order api.my_areas picks the area's default view (2045). Without
// one it is the uniform not-found, like each page.
import { notFound, redirect } from "next/navigation";
import type { AdminView } from "@cdf/contracts";
import { administrationService, myShellAreas, requireActor } from "@/server/container";

export default async function AdminPage() {
  const { ctx } = await requireActor();
  const area = (await myShellAreas()).find((a) => a.area === "ADMINISTRATION");
  const views = await administrationService().views(ctx);
  if (!area || views.length === 0) notFound();
  const view = views.includes(area.defaultView as AdminView) ? area.defaultView : views[0]!;
  redirect(`/admin/${view}`);
}
