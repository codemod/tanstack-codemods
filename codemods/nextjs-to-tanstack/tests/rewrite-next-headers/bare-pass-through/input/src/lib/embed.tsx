import { buildLegacyCtx } from "@lib/buildLegacyCtx";
import { cookies, headers } from "next/headers";

type ServerPageProps = { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> };

export default async function ServerPage({ params, searchParams }: ServerPageProps) {
  const context = buildLegacyCtx(await headers(), await cookies(), await params, await searchParams);
  return context.params.user;
}
