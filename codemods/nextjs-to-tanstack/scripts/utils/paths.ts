/**
 * Path helpers. We deliberately avoid `SgRoot.relativeFilename()` because
 * it is not available in every JSSG runtime version; instead we derive the
 * app-relative path from the absolute filename by locating the last
 * `src/app/`, `src/pages/`, or root `app/` / `pages/`. Every other path helper
 * normalises slashes so the same code paths work on Windows hosts.
 */

import { dirname } from 'node:path'

import type { SgRoot, TypesMap } from 'codemod:ast-grep'

const SRC_APP = '/src/app/'
const SRC_PAGES = '/src/pages/'

export function normalizePath(path: string): string {
  return path.replaceAll('\\', '/')
}

/** True for POSIX absolute paths or Windows `C:/...` after normalization. */
export function isAbsoluteNormalizedPath(path: string): boolean {
  const n = normalizePath(path)
  return n.startsWith('/') || /^[A-Za-z]:\//.test(n)
}

/**
 * Directory where `.codemod/state.json` should live: the package root (parent
 * of `src/` or of root `app/` / `pages/` when there is no `src/` prefix).
 */
export function inferCodemodTargetDir(fileAbs: string): string {
  const n = normalizePath(fileAbs)
  const srcIdx = n.lastIndexOf('/src/')
  if (srcIdx > 0) {
    return n.slice(0, srcIdx)
  }
  const appIdx = n.lastIndexOf('/app/')
  const pagesIdx = n.lastIndexOf('/pages/')
  const routerIdx = Math.max(appIdx, pagesIdx)
  if (routerIdx > 0) {
    return n.slice(0, routerIdx)
  }
  return dirname(fileAbs)
}

export function getFilename<T extends TypesMap>(root: SgRoot<T>): string {
  return normalizePath(root.filename())
}

/**
 * Returns the path slice starting at `src/app/...`, `src/pages/...`, or
 * root-level `app/...` / `pages/...` when present; otherwise the full
 * (slash-normalised) absolute path.
 *
 * This is what the entry scripts use to classify layout/page/route files;
 * the workflow's `include:` globs guarantee the file shape but we still
 * match defensively in case the step is run standalone.
 */
export function getAppRelativePath<T extends TypesMap>(root: SgRoot<T>): string {
  const file = getFilename(root)
  for (const marker of [SRC_APP, SRC_PAGES]) {
    const idx = file.lastIndexOf(marker)
    if (idx !== -1) {
      return file.slice(idx + 1)
    }
  }
  const pagesIdx = file.lastIndexOf('/pages/')
  const appIdx = file.lastIndexOf('/app/')
  const idx = Math.max(pagesIdx, appIdx)
  if (idx !== -1) {
    return file.slice(idx + 1)
  }
  return file
}

/**
 * Best-effort label for docs: path relative to the workflow target (`-t`), or the
 * absolute path when the package lives outside that root.
 */
export function relativeToTargetDir(pathAbs: string, targetDir: string): string {
  const p = normalizePath(pathAbs)
  const t = normalizePath(targetDir)
  if (p === t) {
    return '.'
  }
  const prefix = `${t}/`
  if (p.startsWith(prefix)) {
    return p.slice(prefix.length)
  }
  return p
}

/**
 * The repo-root-relative new path for a renamed file. Falls back to the
 * current file's directory when the input isn't under a known router tree so
 * tests that live outside the conventional tree still function.
 */
export function resolveRenameTarget<T extends TypesMap>(root: SgRoot<T>, computedNewPath: string): string {
  const normalized = normalizePath(computedNewPath)
  if (isAbsoluteNormalizedPath(normalized)) {
    return normalized
  }
  const file = getFilename(root)
  for (const marker of [SRC_APP, SRC_PAGES]) {
    const idx = file.lastIndexOf(marker)
    if (idx !== -1) {
      const baseAbs = file.slice(0, idx + 1)
      return `${baseAbs}${computedNewPath}`
    }
  }
  const pagesIdx = file.lastIndexOf('/pages/')
  const appIdx = file.lastIndexOf('/app/')
  const idx = Math.max(pagesIdx, appIdx)
  if (idx !== -1) {
    const baseAbs = file.slice(0, idx + 1)
    return `${baseAbs}${computedNewPath}`
  }
  const dir = file.slice(0, file.lastIndexOf('/'))
  const leaf = computedNewPath.split('/').pop() ?? computedNewPath
  return `${dir}/${leaf}`
}
