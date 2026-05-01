import { createFileRoute } from "@tanstack/react-router";

function DashboardLoading() {
  return <p>Loading…</p>;
}


export const Route = createFileRoute("/dashboard")({
  pendingComponent: DashboardLoading,
});
