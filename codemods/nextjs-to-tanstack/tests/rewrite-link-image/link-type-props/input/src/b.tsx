import type { LinkProps } from "next/link";

export function x(p: LinkProps): string {
  return String(p.to);
}
