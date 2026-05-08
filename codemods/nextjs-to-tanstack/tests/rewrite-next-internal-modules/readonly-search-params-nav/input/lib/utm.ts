import type { ReadonlyURLSearchParams } from "next/navigation";

export function f(u: ReadonlyURLSearchParams) {
  return u.get("x");
}
