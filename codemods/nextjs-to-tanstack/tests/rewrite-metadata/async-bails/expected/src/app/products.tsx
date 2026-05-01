import { createFileRoute } from "@tanstack/react-router";

export async function generateMetadata(): Promise<{ title: string }> {
  const title = await fetchTitle();
  return { title };
}

async function fetchTitle() {
  return "hi";
}

function Products() {
  return <div>products</div>;
}

export const Route = createFileRoute("/products")({
  component: Products,
});
