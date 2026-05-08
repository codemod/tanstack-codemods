
// TODO: next/headers migration (R4f): `getCookie` / `getHeaders` / `setCookie` / `deleteCookie` / `getCookies` — TanStack Start server context only; `draftMode` / other `next/headers` usage — https://tanstack.com/start/latest/docs/framework/react/guide/server-functions
import { getCookie } from "@tanstack/start/server";
import { draftMode } from "next/headers";


export async function maybePreview() {
  const draft = await draftMode();
  const sid = getCookie("session");
  return { preview: draft.isEnabled, sid };
}
