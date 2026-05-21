/**
 * After a source file is renamed/moved, re-point `./` and `../` import specifiers
 * so they still resolve to the same absolute targets (Node `resolve` + `relative`).
 */

import { dirname, relative, resolve } from 'node:path'

import { normalizePath } from './paths.ts'

function normalizeRelativeImportSpecifier(spec: string): string {
  if (spec === '' || spec === '.') {
    return '.'
  }
  let out = normalizePath(spec)
  if (!out.startsWith('.')) {
    out = `./${out}`
  }
  return out
}

function relinkSpecifier(spec: string, oldDir: string, newDir: string): string {
  const trimmed = spec.trim()
  if (!trimmed.startsWith('.')) {
    return spec
  }
  let target: string
  try {
    target = resolve(oldDir, trimmed)
  } catch {
    return spec
  }
  let next = relative(newDir, target)
  next = normalizePath(next)
  if (next === '') {
    next = '.'
  }
  next = normalizeRelativeImportSpecifier(next)
  return next === trimmed ? spec : next
}

/**
 * @param oldFileAbs Absolute path to the file before `root.rename`.
 * @param newFileAbs Absolute path after rename (same as `resolveRenameTarget` output).
 */
export function rewriteRelativeImportsAfterFileMove(source: string, oldFileAbs: string, newFileAbs: string): string {
  const oldDir = dirname(normalizePath(oldFileAbs))
  const newDir = dirname(normalizePath(newFileAbs))
  if (oldDir === newDir) {
    return source
  }

  let s = source
  s = s.replaceAll(/\bfrom\s+(["'])(\.\.?\/[^"']+)\1/g, (full, q: string, spec: string) => {
    const n = relinkSpecifier(spec, oldDir, newDir)
    return n === spec ? full : `from ${q}${n}${q}`
  })
  s = s.replaceAll(/\bimport\s+(["'])(\.\.?\/[^"']+)\1/g, (full, q: string, spec: string) => {
    const n = relinkSpecifier(spec, oldDir, newDir)
    return n === spec ? full : `import ${q}${n}${q}`
  })
  s = s.replaceAll(/\bimport\s*\(\s*(["'])(\.\.?\/[^"']+)\1\s*\)/g, (full, q: string, spec: string) => {
    const n = relinkSpecifier(spec, oldDir, newDir)
    return n === spec ? full : `import(${q}${n}${q})`
  })
  s = s.replaceAll(/\brequire\s*\(\s*(["'])(\.\.?\/[^"']+)\1\s*\)/g, (full, q: string, spec: string) => {
    const n = relinkSpecifier(spec, oldDir, newDir)
    return n === spec ? full : `require(${q}${n}${q})`
  })
  return s
}
