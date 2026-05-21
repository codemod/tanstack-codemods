/**
 * When Next.js `i18n` is configured, map TanStack file paths and route IDs to use an
 * optional locale segment: `src/app/about.tsx` → `src/app/{-$locale}/about.tsx`,
 * `createFileRoute("/about")` → `createFileRoute("/{-$locale}/about")`.
 *
 * API routes under `app/api/` and the root layout `__root` are left unchanged.
 */

import type { MetadataImageRouteResult, RoutePathResult, SpecialRouteFileResult } from './route-path.ts'

export const OPTIONAL_LOCALE_DIR = '{-$locale}' as const
const OPTIONAL_LOCALE_PREFIX = `/${OPTIONAL_LOCALE_DIR}`

/**
 * `true` when this file lives under `app/` but should not get a locale segment.
 */
export function shouldSkipLocalePrefixForAppPath(repoRelativeNewPath: string): boolean {
  const norm = repoRelativeNewPath.replaceAll('\\', '/')
  if (norm.includes(`/${OPTIONAL_LOCALE_DIR}/`) || norm.endsWith(`/${OPTIONAL_LOCALE_DIR}`)) {
    return true
  }
  const afterApp = segmentAfterApp(norm)
  if (afterApp === null) {
    return true
  }
  if (afterApp === 'api') {
    return true
  }
  if (afterApp.startsWith('api/')) {
    return true
  }
  if (afterApp.startsWith('__root.') || afterApp === '__root.tsx' || afterApp === '__root.jsx') {
    return true
  }
  return false
}

function segmentAfterApp(norm: string): string | null {
  const idx = norm.lastIndexOf('/app/')
  if (idx === -1) {
    return null
  }
  return norm.slice(idx + '/app/'.length)
}

/**
 * Insert `/{-$locale}/` after the `/app/` directory (first path segment under `app`).
 */
export function insertOptionalLocaleDirInAppPath(repoRelativeNewPath: string): string {
  if (shouldSkipLocalePrefixForAppPath(repoRelativeNewPath)) {
    return repoRelativeNewPath
  }
  return repoRelativeNewPath.replace(/\/app\//, `/app/${OPTIONAL_LOCALE_DIR}/`)
}

/**
 * Prefix TanStack route path strings (e.g. `/about` → `/{-$locale}/about`).
 */
export function prefixRouteIdWithOptionalLocale(routePath: string): string {
  if (routePath === '/') {
    return `${OPTIONAL_LOCALE_PREFIX}/`
  }
  if (routePath.startsWith(OPTIONAL_LOCALE_PREFIX)) {
    return routePath
  }
  return `${OPTIONAL_LOCALE_PREFIX}${routePath}`
}

export function applyOptionalLocaleToRoutePathResult(r: RoutePathResult): RoutePathResult {
  if (r.routePath === null) {
    return r
  }
  if (shouldSkipLocalePrefixForAppPath(r.newPath)) {
    return r
  }

  const newPath = insertOptionalLocaleDirInAppPath(r.newPath)
  const routePath = prefixRouteIdWithOptionalLocale(r.routePath)
  let optional = r.optionalCatchAllRedirect
  if (optional) {
    optional = {
      indexNewPath: insertOptionalLocaleDirInAppPath(optional.indexNewPath),
      indexRoutePath: prefixRouteIdWithOptionalLocale(optional.indexRoutePath),
      splatRoutePath: prefixRouteIdWithOptionalLocale(optional.splatRoutePath),
    }
  }
  return {
    ...r,
    newPath,
    routePath,
    optionalCatchAllRedirect: optional,
  }
}

export function applyOptionalLocaleToSpecialRouteFile(r: SpecialRouteFileResult): SpecialRouteFileResult {
  if (shouldSkipLocalePrefixForAppPath(r.newPath)) {
    return r
  }
  return {
    ...r,
    newPath: insertOptionalLocaleDirInAppPath(r.newPath),
    routePath: prefixRouteIdWithOptionalLocale(r.routePath),
  }
}

export function applyOptionalLocaleToMetadataImage(r: MetadataImageRouteResult): MetadataImageRouteResult {
  if (shouldSkipLocalePrefixForAppPath(r.newPath)) {
    return r
  }
  return {
    newPath: insertOptionalLocaleDirInAppPath(r.newPath),
    routePath: prefixRouteIdWithOptionalLocale(r.routePath),
  }
}
