// Administration «إدارة المنصة» (UX redesign S1; P12-8a): opens the first page the caller's permissions open, in the
// order api.my_areas picks the area's default view (2045). Without one it is the uniform not-found, like each page.
import { notFound, redirect } from "next/navigation";
import { adminViews } from "@cdf/authorization";
import type { AdminView } from "@cdf/contracts";
import { myShellAreas, requireActor } from "@/server/container";

export default async function AdminPage() {
  const { actor } = await requireActor();
  const area = (await myShellAreas()).find((a) => a.area === "ADMINISTRATION");
  const views = adminViews(actor);
  if (!area || views.length === 0) notFound();
  const view = views.includes(area.defaultView as AdminView) ? area.defaultView : views[0]!;
  redirect(`/admin/${view}`);
}
