"use client";

import { usePathname, useSearchParams } from "next/navigation";

export function useFilters() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filter = searchParams?.get("filter");
  return { pathname, filter };
}
