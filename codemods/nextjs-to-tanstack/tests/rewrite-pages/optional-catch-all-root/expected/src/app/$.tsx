import { createFileRoute } from "@tanstack/react-router";

function RootOptionalCatchAll() {
  return <main>root optional</main>;
}

export const Route = createFileRoute("/$")({
  component: RootOptionalCatchAll,
});
