"use client";


// TODO: next/navigation migration (R4g): use `throw redirect()` in loaders / beforeLoad — client nav: `useNavigate()` — https://tanstack.com/router/latest/docs/framework/react/guide/navigation
import { useNavigate, createFileRoute } from "@tanstack/react-router";


export const Route = createFileRoute("/book/$bookingUid")({
  component: Page,
});

function Page() {
  const params = Route.useParams();
  const router = useNavigate();
  const uid = params.bookingUid;
  return (
    <button type="button" onClick={() => router({ to: "/x" })}>
      {uid}
    </button>
  );
}
