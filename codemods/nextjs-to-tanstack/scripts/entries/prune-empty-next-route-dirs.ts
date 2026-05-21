/**
 * After App Router pages move out of `[param]` / `[...slug]` folders into flat
 * TanStack route files, delete any **empty** leftover segment directories under
 * `src/app` or `app` whose names look like Next.js dynamic segments (`[...]`).
 *
 * Triggered from `package.json` (same pattern as other package-root FS steps).
 */

import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Codemod } from 'codemod:ast-grep'
import type JSON_TYPES from 'codemod:ast-grep/langs/json'

import { pruneEmptyNextBracketSegmentDirsUnderApp } from '../utils/ensure-parent-dir.ts'
import { hasSrcAppOrPages } from '../utils/has-src-app-or-pages.ts'
import { getFilename, normalizePath } from '../utils/paths.ts'

const codemod: Codemod<JSON_TYPES> = async (root) => {
  const file = getFilename(root)
  if (!file.endsWith('/package.json') && !file.endsWith('package.json')) {
    return null
  }

  const pkgRoot = dirname(file)
  const useSrc = hasSrcAppOrPages(pkgRoot)
  const appDir = useSrc ? join(pkgRoot, 'src', 'app') : join(pkgRoot, 'app')

  try {
    if (!statSync(appDir).isDirectory()) {
      return null
    }
  } catch {
    return null
  }

  pruneEmptyNextBracketSegmentDirsUnderApp(normalizePath(appDir))
  return null
}

export default codemod
