import type { ReadonlyURLSearchParams } from "next/navigation";

export function v(sp: ReadonlyURLSearchParams): string {
  return sp.get("x") ?? "";
}
