/**
 * Ensure the parent directory exists before a codemod rename moves a file into
 * a flattened route path (TanStack colocates `page.tsx` into `segment.tsx`,
 * which must not fail with ENOENT).
 */

import { mkdirSync } from "fs";
import { dirname } from "path";

export function ensureParentDir(absFilePath: string): void {
  const dir = dirname(absFilePath);
  if (dir === "." || dir === "/") return;
  mkdirSync(dir, { recursive: true });
}
