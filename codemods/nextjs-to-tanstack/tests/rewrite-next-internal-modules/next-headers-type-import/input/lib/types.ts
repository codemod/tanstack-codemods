export type HeaderBag = Awaited<ReturnType<typeof import("next/headers").headers>>;
export type CookieBag = Awaited<ReturnType<typeof import("next/headers").cookies>>;
