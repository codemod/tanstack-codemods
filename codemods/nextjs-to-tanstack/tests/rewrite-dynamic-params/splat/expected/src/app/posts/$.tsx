import { createFileRoute } from "@tanstack/react-router";

function PostsCatchAll() {
  const { _splat } = Route.useParams();
  return <div>Catch: {_splat}</div>;
}

export const Route = createFileRoute("/posts/$")({
  component: PostsCatchAll,
});
