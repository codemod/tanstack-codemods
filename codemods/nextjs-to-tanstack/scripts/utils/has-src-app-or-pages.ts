/**
 * Mirrors scaffold-tanstack-files: use `src/` when the package has
 * `src/app` or `src/pages` (TanStack `srcDirectory: 'src'`).
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'

export function hasSrcAppOrPages(repoRoot: string): boolean {
  try {
    if (statSync(join(repoRoot, 'src', 'app')).isDirectory()) {
      return true
    }
  } catch {
    /* absent */
  }
  try {
    if (statSync(join(repoRoot, 'src', 'pages')).isDirectory()) {
      return true
    }
  } catch {
    /* absent */
  }
  return false
}
