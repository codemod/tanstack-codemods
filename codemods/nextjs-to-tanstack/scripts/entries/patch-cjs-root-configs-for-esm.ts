/**
 * Next.js add-ons ship root configs such as `next-i18next.config.js` using
 * `module.exports`. When the app already has `"type": "module"`, Node treats
 * `*.js` as ESM and loading that file throws: "module is not defined".
 *
 * Runs after R11 (TanStack deps present). Converts a **single** top-level
 * `module.exports = …` assignment to `export default …`. Skips files that use
 * `module.exports.foo =` or multiple `module.exports =` assignments.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Codemod } from 'codemod:ast-grep'
import type JSON_TYPES from 'codemod:ast-grep/langs/json'

import { getFilename } from '../utils/paths.ts'

const TARGET = 'next-i18next.config.js'
const ASSIGN_RE = /\bmodule\.exports\s*=\s*/g
const NAMED_EXPORT_RE = /module\.exports\.\w+\s*=/

const codemod: Codemod<JSON_TYPES> = async (root) => {
  const file = getFilename(root)
  if (!file.endsWith('/package.json') && !file.endsWith('package.json')) {
    return null
  }

  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(root.root().text()) as Record<string, unknown>
  } catch {
    return null
  }

  const deps = {
    ...((pkg.dependencies ?? {}) as Record<string, string>),
    ...((pkg.devDependencies ?? {}) as Record<string, string>),
  }
  if (!deps['@tanstack/react-start']) {
    return null
  }

  if (pkg.type !== 'module') {
    return null
  }

  const rootDir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.'
  const configPath = join(rootDir, TARGET)

  let source: string
  try {
    source = readFileSync(configPath, 'utf8')
  } catch {
    return null
  }

  if (NAMED_EXPORT_RE.test(source)) {
    return null
  }

  const matches = source.match(ASSIGN_RE)
  if (matches?.length !== 1) {
    return null
  }

  const out = source.replace(ASSIGN_RE, 'export default ')
  if (out === source) {
    return null
  }

  writeFileSync(configPath, out)
  return null
}

export default codemod
