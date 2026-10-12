import type { ReactNode } from "react";
import { getTranslator } from "@/server/locale";
import { PublicChrome } from "../public-chrome";

export default async function PublicLayout({ children }: { children: ReactNode }) {
  return <PublicChrome t={await getTranslator()}>{children}</PublicChrome>;
}
