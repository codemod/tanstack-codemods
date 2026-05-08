
// TODO: next/headers migration (R4f): `getCookie` / `getHeaders` / `setCookie` / `deleteCookie` / `getCookies` — TanStack Start server context only; `draftMode` / other `next/headers` usage — https://tanstack.com/start/latest/docs/framework/react/guide/server-functions
import { setCookie } from "@tanstack/start/server";


export async function pickDark() {
  setCookie("theme", "dark", { path: "/", maxAge: 60 * 60 * 24 * 365 });
}
