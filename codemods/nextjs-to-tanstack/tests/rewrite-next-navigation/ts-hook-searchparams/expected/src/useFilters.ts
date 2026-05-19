"use client";

import { useLocation, useSearch } from "@tanstack/react-router";


export function useFilters() {
  const pathname = useLocation().pathname;
  const searchParams = useSearch();
  const filter = searchParams?.get("filter");
  return { pathname, filter };
}
