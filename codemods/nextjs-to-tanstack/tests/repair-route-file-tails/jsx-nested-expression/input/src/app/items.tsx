import { createFileRoute } from "@tanstack/react-router";

const items = ["a", "b"];

/** Route options include JSX with embedded `{…}` — brace repair must not truncate here. */
export const Route = createFileRoute("/items")({
  component: () => (
    <ul>
      {items.map((id) => (
        <li key={id}>{id}</li>
      ))}
    </ul>
  ),
});
