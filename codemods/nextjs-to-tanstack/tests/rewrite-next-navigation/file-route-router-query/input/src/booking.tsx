"use client";

import { useRouter } from "next/router";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/book/$bookingUid")({
  component: Page,
});

function Page() {
  const router = useRouter();
  const uid = router.query.bookingUid;
  return (
    <button type="button" onClick={() => router.push("/x")}>
      {uid}
    </button>
  );
}
