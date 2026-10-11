// The landing (UX redesign S1; audit §20.6, CDF-118): by where the caller's work is, never by role name.
import { redirect } from "next/navigation";
import { myShellAreas } from "@/server/container";
import { landingFor } from "@/server/work-routes";

export default async function Home() {
  redirect(landingFor(await myShellAreas()));
}
