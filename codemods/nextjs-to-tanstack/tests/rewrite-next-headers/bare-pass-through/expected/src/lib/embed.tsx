import { buildLegacyCtx } from "@lib/buildLegacyCtx";

// TODO: next/headers migration (R4f): `getCookie` / `getHeaders` / `setCookie` / `deleteCookie` / `getCookies` — TanStack Start server context only; `draftMode` / other `next/headers` usage — https://tanstack.com/start/latest/docs/framework/react/guide/server-functions
import { getCookies, getHeaders } from "@tanstack/start/server";


type ServerPageProps = { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> };

export default async function ServerPage({ params, searchParams }: ServerPageProps) {
  const context = buildLegacyCtx(new Headers(Object.entries(getHeaders()).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")] as [string, string])), { getAll: () => Object.entries(getCookies()).map(([name, value]) => ({ name, value: String(value ?? "") })) }, await params, await searchParams);
  return context.params.user;
}
