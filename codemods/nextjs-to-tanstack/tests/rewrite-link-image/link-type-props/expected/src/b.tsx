import type { LinkProps } from "@tanstack/react-router";

export function x(p: LinkProps): string {
  return String(p.to);
}
