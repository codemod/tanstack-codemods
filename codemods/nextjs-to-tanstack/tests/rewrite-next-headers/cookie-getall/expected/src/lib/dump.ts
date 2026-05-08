
// TODO: next/headers migration (R4f): `getCookie` / `getHeaders` / `setCookie` / `deleteCookie` / `getCookies` — TanStack Start server context only; `draftMode` / other `next/headers` usage — https://tanstack.com/start/latest/docs/framework/react/guide/server-functions
import { getCookies } from "@tanstack/start/server";


export async function allCookies() {
  return Object.entries(getCookies()).map(([name, value]) => ({ name, value }));
}
