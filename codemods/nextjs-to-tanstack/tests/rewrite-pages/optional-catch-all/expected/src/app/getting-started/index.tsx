import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/getting-started")({
  beforeLoad: () => {
    throw redirect({
      to: "/getting-started/$",
      params: { _splat: "" },
    });
  },
});
