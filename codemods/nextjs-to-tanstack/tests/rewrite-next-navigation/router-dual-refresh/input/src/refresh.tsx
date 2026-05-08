"use client";

import { useRouter } from "next/navigation";

export function X() {
  const router = useRouter();
  router.push("/x");
  router.refresh();
  router.back();
}
