// TODO: next/dist migration (R4dist): `import("next/headers")` in types → `getHeaders` / `getCookies` from @tanstack/start/server — verify `ReturnType`
export type HeaderBag = Awaited<ReturnType<typeof import("@tanstack/start/server").getHeaders>>;
export type CookieBag = Awaited<ReturnType<typeof import("@tanstack/start/server").getCookies>>;
