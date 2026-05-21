/**
 * Replacement for the finalize-cleanup shell node.
 *
 * Removes `.codemod/state.json` after font-related steps consume it.
 * Does not delete `.codemod/i18n.json` (optional-locale migration metadata).
 */

import { dirname, join } from 'node:path'

import type { Codemod } from 'codemod:ast-grep'
import type JSON_TYPES from 'codemod:ast-grep/langs/json'

import { getFilename } from '../utils/paths.ts'
import { safeRemoveFile } from '../utils/safe-remove.ts'

const codemod: Codemod<JSON_TYPES> = async (root) => {
  const file = getFilename(root)
  if (!file.endsWith('/package.json') && !file.endsWith('package.json')) {
    return null
  }

  const repoRoot = dirname(file)
  const stateDir = join(repoRoot, '.codemod')
  try {
    safeRemoveFile(join(stateDir, 'state.json'))
  } catch {
    // Already absent — fine.
  }
  return null
}

export default codemod
