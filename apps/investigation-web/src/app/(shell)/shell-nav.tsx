"use client";
// Marks the area the current page belongs to; the items themselves come from the server (layout.tsx).
import { usePathname } from "next/navigation";
import type { WorkArea } from "@cdf/contracts";
import { CDFSideNav, type CDFNavItem } from "@cdf/ui";
import { areaOfPath } from "@/server/work-routes";

export function ShellNav({ label, items }: { label: string; items: (CDFNavItem & { area: WorkArea })[] }) {
  const current = areaOfPath(usePathname() || "/");
  return <CDFSideNav label={label} items={items} current={items.find((i) => i.area === current)?.key} />;
}
