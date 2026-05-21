/**
 * Convert Next.js App Router or Pages Router file paths into TanStack Start equivalents.
 *
 * Rules (per the official migration guide):
 *   src/app/page.tsx                        → src/app/index.tsx             "/"
 *   src/app/posts/page.tsx                  → src/app/posts.tsx             "/posts"
 *   src/app/posts/page.tsx (sibling routes) → src/app/posts/index.tsx       "/posts"
 *   src/app/posts/[slug]/page.tsx           → src/app/posts/$slug.tsx       "/posts/$slug"
 *   src/app/posts/[...slug]/page.tsx        → src/app/posts/$.tsx           "/posts/$"
 *   src/app/prefix/[[...slug]]/page.tsx     → src/app/prefix/$.tsx + sibling index.tsx that redirects empty splat "/prefix/$"
 *   src/app/(marketing)/about/page.tsx      → src/app/about.tsx             "/about"
 *   src/app/api/hello/route.ts              → src/app/api/hello.ts          "/api/hello"
 *   src/app/layout.tsx                      → src/app/__root.tsx            (root)
 *
 * Pages Router (same TanStack `src/app` targets):
 *   src/pages/index.tsx                     → src/app/index.tsx             "/"
 *   src/pages/about.tsx                     → src/app/about.tsx             "/about"
 *   src/pages/blog/index.tsx (no siblings)   → src/app/blog.tsx           "/blog"
 *   src/pages/blog/index.tsx (sibling routes) → src/app/blog/index.tsx    "/blog"
 *   src/pages/blog/[slug].tsx             → src/app/blog/$slug.tsx        "/blog/$slug"
 *   src/pages/api/hello.ts                → src/app/api/hello.ts          "/api/hello"
 *
 * Everything operates on POSIX-style paths. When `computeRoutePath` is given the
 * absolute path to the source file, sibling route files under the same segment are
 * detected on disk so `page.tsx` maps to a folder `index.tsx` instead of a colliding flat `segment.tsx`.
 */

import { readdirSync, statSync, type Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export type NextFileKind = 'layout' | 'page' | 'route' | 'other'

export interface RoutePathResult {
  /** Target file path (POSIX) relative to repo root, with dynamic segments converted. */
  newPath: string
  /** Route path TanStack expects inside `createFileRoute(...)`, or null for layouts. */
  routePath: string | null
  /** Which Next convention was detected. */
  kind: NextFileKind
  /** True if the source file was a Next catch-all `[...slug]` segment. */
  wasCatchAll: boolean
  /** Original dynamic segment name, or null. Useful for R3 to restore user names. */
  dynamicSegmentName: string | null
  /**
   * Optional catch-all `[[...name]]` has no single-file equivalent: we emit the
   * splat route (`…/$.tsx`) plus a sibling `index.tsx` that redirects with an
   * empty `_splat` so the parent URL still resolves.
   * Omitted when the splat sits directly under `app/` (nothing to anchor an index sibling).
   */
  optionalCatchAllRedirect?: {
    indexNewPath: string
    indexRoutePath: string
    splatRoutePath: string
  }
}

const SEG_DYNAMIC = /^\[(?!\.\.\.)([^\]]+)\]$/
const SEG_CATCHALL = /^\[\.\.\.([^\]]+)\]$/
const SEG_GROUP = /^\(([^)]+)\)$/

const normalize = (path: string): string => path.replaceAll('\\', '/')

export const stripAppPrefix = (path: string): { head: string; rest: string[] } | null => {
  const parts = normalize(path).split('/').filter(Boolean)
  const appIdx = parts.lastIndexOf('app')
  if (appIdx === -1) {
    return null
  }

  const head = parts.slice(0, appIdx + 1).join('/')
  const rest = parts.slice(appIdx + 1)
  return { head, rest }
}

/** Same idea as `stripAppPrefix` but for the `pages/` directory (src/pages or root `pages`). */
export const stripPagesPrefix = (path: string): { head: string; rest: string[] } | null => {
  const parts = normalize(path).split('/').filter(Boolean)
  const pagesIdx = parts.lastIndexOf('pages')
  if (pagesIdx === -1) {
    return null
  }

  const head = parts.slice(0, pagesIdx + 1).join('/')
  const rest = parts.slice(pagesIdx + 1)
  return { head, rest }
}

function pagesHeadToAppHead(pagesHead: string): string {
  if (pagesHead === 'pages') {
    return 'app'
  }
  if (pagesHead.endsWith('/pages')) {
    return `${pagesHead.slice(0, -'/pages'.length)}/app`
  }
  return pagesHead.replace(/\/pages$/, '/app')
}

const detectKind = (fileName: string | undefined): NextFileKind => {
  if (!fileName) {
    return 'other'
  }
  if (/^layout\.(t|j)sx?$/.test(fileName)) {
    return 'layout'
  }
  if (/^page\.(t|j)sx?$/.test(fileName)) {
    return 'page'
  }
  if (/^route\.(t|j)sx?$/.test(fileName)) {
    return 'route'
  }
  return 'other'
}

/** Next App Router auxiliary files ported from next2tanstack-style transforms. */
export type SpecialRouteFileVariant = 'loading' | 'error' | 'not-found'

export interface SpecialRouteFileResult {
  /** Repo-relative posix path (`src/app/...`). */
  newPath: string
  routePath: string
  /** Key used in `createFileRoute(...)({ ... })`. */
  routeOptionProperty: 'pendingComponent' | 'errorComponent' | 'notFoundComponent'
  variant: SpecialRouteFileVariant
}

export function classifySpecialRouteFileBasename(fileName: string | undefined): SpecialRouteFileVariant | null {
  if (!fileName) {
    return null
  }
  if (/^loading\.(t|j)sx?$/.test(fileName)) {
    return 'loading'
  }
  if (/^error\.(t|j)sx?$/.test(fileName)) {
    return 'error'
  }
  if (/^not-found\.(t|j)sx?$/.test(fileName)) {
    return 'not-found'
  }
  return null
}

/** Next `opengraph-image` / `twitter-image` → TanStack server route path + on-disk path. */
export interface MetadataImageRouteResult {
  newPath: string
  routePath: string
}

interface SegmentTranslation {
  text: string | null
  dynamic: string | null
  catchAll: boolean
  optionalCatchAll: boolean
  group: boolean
}

const translateSegment = (seg: string): SegmentTranslation => {
  const group = SEG_GROUP.exec(seg)
  if (group) {
    return { text: null, dynamic: null, catchAll: false, optionalCatchAll: false, group: true }
  }

  const optionalCatchAll = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(seg)
  if (optionalCatchAll) {
    const name = optionalCatchAll[1] ?? ''
    return { text: '$', dynamic: name, catchAll: true, optionalCatchAll: true, group: false }
  }

  const catchAll = SEG_CATCHALL.exec(seg)
  if (catchAll) {
    return {
      text: '$',
      dynamic: catchAll[1] ?? null,
      catchAll: true,
      optionalCatchAll: false,
      group: false,
    }
  }

  const dynamic = SEG_DYNAMIC.exec(seg)
  if (dynamic) {
    const name = dynamic[1] ?? ''
    return {
      text: `$${name}`,
      dynamic: name,
      catchAll: false,
      optionalCatchAll: false,
      group: false,
    }
  }

  return { text: seg, dynamic: null, catchAll: false, optionalCatchAll: false, group: false }
}

const NEXT_METADATA_IMAGE_FILE = /^(opengraph-image|twitter-image)\.(m|c)?(t|j)sx?$/i

/**
 * Map `app/.../opengraph-image.tsx` (or `twitter-image`) to `app/.../opengraph.tsx`
 * (or `twitter.tsx`) with `$param` segments. Route id ends with `/opengraph` or `/twitter`.
 */
export function computeMetadataImageTransform(relativePath: string): MetadataImageRouteResult | null {
  const appSplit = stripAppPrefix(relativePath)
  if (!appSplit) {
    return null
  }
  const { head, rest } = appSplit
  const fileName = rest.at(-1)
  if (!fileName || !NEXT_METADATA_IMAGE_FILE.test(fileName)) {
    return null
  }

  const dirSegs = rest.slice(0, -1)
  for (const seg of dirSegs) {
    if (seg.startsWith('@')) {
      return null
    }
    if (/^\(\.{1,3}\)/.test(seg)) {
      return null
    }
  }
  if (dirSegs.length > 0 && dirSegs[0] === 'api') {
    return null
  }

  const m = NEXT_METADATA_IMAGE_FILE.exec(fileName)
  const kind = (m?.[1] ?? '').toLowerCase()
  const ext = fileName.slice(fileName.indexOf('.'))
  const routeLeaf = kind === 'opengraph-image' ? 'opengraph' : 'twitter'
  const outLeaf = `${routeLeaf}${ext}`

  const translated: string[] = []
  for (const seg of dirSegs) {
    const t = translateSegment(seg)
    if (t.group) {
      continue
    }
    if (t.text === null) {
      return null
    }
    translated.push(t.text)
  }

  const routePath = translated.length === 0 ? `/${routeLeaf}` : `/${translated.join('/')}/${routeLeaf}`
  const dirPart = translated.length ? `${translated.join('/')}/` : ''
  const newPath = `${head}/${dirPart}${outLeaf}`
  return { newPath, routePath }
}

const PAGE_FILE = /^page\.(m|c)?(t|j)sx?$/i
const LAYOUT_FILE = /^layout\.(m|c)?(t|j)sx?$/i
const ROUTE_HANDLER = /^route\.(m|c)?(t|j)sx?$/i
const COLLOCATED_ROUTE_MODULE = /^(loading|error|not-found|template|default|forbidden|unauthorized)\.(m|c)?(t|j)sx?$/i

/**
 * True when the folder containing this page module has other routable entries, so
 * TanStack should use `segment/index.tsx` instead of `segment.tsx`.
 */
function pageSourceDirHasTanStackRouteSiblings(pageSourceFileAbsolutePath: string): boolean {
  const dir = dirname(pageSourceFileAbsolutePath)
  const selfName = basename(pageSourceFileAbsolutePath)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return false
  }
  for (const name of names) {
    if (name === '.' || name === '..') {
      continue
    }
    if (name.startsWith('.')) {
      continue
    }
    if (name === selfName) {
      continue
    }

    const full = join(dir, name)
    let st: Stats
    try {
      st = statSync(full)
    } catch {
      continue
    }

    if (st.isDirectory()) {
      return true
    }
    if (PAGE_FILE.test(name) || LAYOUT_FILE.test(name)) {
      continue
    }
    if (ROUTE_HANDLER.test(name) || COLLOCATED_ROUTE_MODULE.test(name)) {
      return true
    }
    if (/\.(m|c)?tsx$/i.test(name) || /\.(m|c)?jsx$/i.test(name)) {
      return true
    }
  }
  return false
}

/**
 * Map `loading.tsx` / `error.tsx` / `not-found.tsx` to TanStack Start route
 * module files (`-pending.tsx`, `-error.tsx`, `-not-found.tsx`) while keeping the
 * same logical `createFileRoute` path as sibling `page.tsx` would have used.
 *
 * Mirrors conventions from `/Users/amir/Desktop/codemod/next2tanstack`.
 */
export function computeSpecialRouteFileTransform(relativePath: string): SpecialRouteFileResult | null {
  const appSplit = stripAppPrefix(relativePath)
  const pagesSplit = appSplit ? null : stripPagesPrefix(relativePath)
  const split = appSplit ?? pagesSplit
  if (!split) {
    return null
  }
  const { head: routerHead, rest } = split
  const head = pagesSplit ? pagesHeadToAppHead(routerHead) : routerHead

  const fileName = rest.at(-1)
  const variant = classifySpecialRouteFileBasename(fileName)
  if (!variant) {
    return null
  }

  const dirSegs = rest.slice(0, -1)
  const ext = fileName?.slice(fileName?.indexOf('.'))

  for (const seg of dirSegs) {
    if (seg.startsWith('@')) {
      return null
    }
    if (/^\(\.{1,3}\)/.test(seg)) {
      return null
    }
  }

  if (dirSegs.length > 0 && dirSegs[0] === 'api') {
    return null
  }

  const translated: string[] = []
  for (const seg of dirSegs) {
    const t = translateSegment(seg)
    if (t.group) {
      continue
    }
    if (t.text === null) {
      return null
    }
    translated.push(t.text)
  }

  const routePath = translated.length === 0 ? '/' : `/${translated.join('/')}`

  const leaf = variant === 'loading' ? `-pending${ext}` : variant === 'error' ? `-error${ext}` : `-not-found${ext}`
  const dirPart = translated.length ? `${translated.join('/')}/` : ''

  const routeOptionProperty =
    variant === 'loading' ? 'pendingComponent' : variant === 'error' ? 'errorComponent' : 'notFoundComponent'

  return {
    newPath: `${head}/${dirPart}${leaf}`,
    routePath,
    routeOptionProperty,
    variant,
  }
}

/**
 * Given the relative path of a Next.js App Router or Pages Router source file,
 * return the TanStack Start target path + route string.
 *
 * Returns null when the file doesn't live inside `app/` or `pages/`, or the
 * conversion is not supported (e.g. parallel/intercepting routes like
 * `@modal/` or `(.)foo`).
 */
export function computeRoutePath(relativePath: string, pageSourceAbsPath?: string): RoutePathResult | null {
  const appSplit = stripAppPrefix(relativePath)
  if (appSplit) {
    return computeAppRouterRoutePath(relativePath, appSplit, pageSourceAbsPath)
  }
  const pagesSplit = stripPagesPrefix(relativePath)
  if (pagesSplit) {
    return computePagesRouterRoutePath(pagesSplit, pageSourceAbsPath)
  }
  return null
}

function computeAppRouterRoutePath(
  _relativePath: string,
  split: { head: string; rest: string[] },
  pageSourceAbsPath?: string,
): RoutePathResult | null {
  const { head, rest } = split

  const fileName = rest.at(-1)
  const dirSegs = rest.slice(0, -1)
  const kind = detectKind(fileName)

  // `app/api/hello.ts`, `app/api/blog/$slug.ts` (TanStack/flat API modules — not `route.ts`)
  if (kind === 'other') {
    const ext = fileName?.slice(fileName?.indexOf('.'))
    if (dirSegs[0] === 'api' && fileName && ext && /\.(m|c)?tsx?$|\.(m|c)?jsx?$|\.(m)?ts$/.test(ext)) {
      return computeAppRouterApiLeafModule(head, dirSegs, fileName, ext)
    }
    return null
  }

  const ext = fileName?.slice(fileName?.indexOf('.'))

  if (kind === 'layout') {
    if (dirSegs.length !== 0) {
      return null
    } // nested layouts are not handled here
    return {
      newPath: `${head}/__root${ext}`,
      routePath: null,
      kind,
      wasCatchAll: false,
      dynamicSegmentName: null,
    }
  }

  // Parallel (`@foo`) / intercepting (`(.)foo` / `(...)foo`) routes — bail.
  for (const seg of dirSegs) {
    if (seg.startsWith('@')) {
      return null
    }
    if (/^\(\.{1,3}\)/.test(seg)) {
      return null
    }
  }

  const translated: string[] = []
  let wasCatchAll = false
  let dynamicName: string | null = null
  let hasOptionalCatchAll = false
  for (const seg of dirSegs) {
    const t = translateSegment(seg)
    if (t.group) {
      continue
    }
    if (t.text === null) {
      return null
    }
    translated.push(t.text)
    if (t.catchAll) {
      wasCatchAll = true
    }
    if (t.optionalCatchAll) {
      hasOptionalCatchAll = true
    }
    if (t.dynamic) {
      dynamicName = t.dynamic
    }
  }

  const parentDir = translated.slice(0, -1)
  const leaf = translated.at(-1)

  if (kind === 'page') {
    // `src/app/page.tsx` → `src/app/index.tsx`, route `/`.
    if (translated.length === 0) {
      return {
        newPath: `${head}/index${ext}`,
        routePath: '/',
        kind,
        wasCatchAll: false,
        dynamicSegmentName: null,
      }
    }
    const newDir = parentDir.length === 0 ? head : `${head}/${parentDir.join('/')}`
    const routeDir = parentDir.length === 0 ? '' : `/${parentDir.join('/')}`
    const splatRoutePath = `${routeDir}/${leaf}`
    const useFolderIndex =
      pageSourceAbsPath !== undefined &&
      pageSourceAbsPath.length > 0 &&
      pageSourceDirHasTanStackRouteSiblings(pageSourceAbsPath)
    const pageResult: RoutePathResult = useFolderIndex
      ? {
          newPath: `${head}/${translated.join('/')}/index${ext}`,
          routePath: splatRoutePath,
          kind,
          wasCatchAll,
          dynamicSegmentName: dynamicName,
        }
      : {
          newPath: `${newDir}/${leaf}${ext}`,
          routePath: splatRoutePath,
          kind,
          wasCatchAll,
          dynamicSegmentName: dynamicName,
        }
    if (hasOptionalCatchAll && parentDir.length > 0) {
      pageResult.optionalCatchAllRedirect = {
        indexNewPath: `${newDir}/index${ext}`,
        indexRoutePath: routeDir,
        splatRoutePath,
      }
    }
    return pageResult
  }

  // route.ts → <parent>.ts
  if (translated.length === 0) {
    return null
  } // route.ts at src/app root is meaningless in Next
  const newDir = parentDir.length === 0 ? head : `${head}/${parentDir.join('/')}`
  const routeDir = parentDir.length === 0 ? '' : `/${parentDir.join('/')}`
  return {
    newPath: `${newDir}/${leaf}${ext}`,
    routePath: `${routeDir}/${leaf}`,
    kind,
    wasCatchAll,
    dynamicSegmentName: dynamicName,
  }
}

/** `app/api/*.ts` modules (e.g. `hello.ts`, `blog/$slug.ts`) — not `route.ts`. */
function computeAppRouterApiLeafModule(
  head: string,
  dirSegs: string[],
  fileName: string,
  ext: string,
): RoutePathResult | null {
  const baseName = fileName.slice(0, fileName.indexOf('.'))
  const stemSegments = [...dirSegs, baseName]
  const translated: string[] = []
  let wasCatchAll = false
  let dynamicName: string | null = null
  for (const seg of stemSegments) {
    const t = translateSegment(seg)
    if (t.group) {
      return null
    }
    if (t.text === null) {
      return null
    }
    translated.push(t.text)
    if (t.catchAll) {
      wasCatchAll = true
    }
    if (t.dynamic) {
      dynamicName = t.dynamic
    }
  }
  const parentDir = translated.slice(0, -1)
  const leaf = translated.at(-1)
  if (leaf === undefined) {
    return null
  }
  const newDir = parentDir.length === 0 ? head : `${head}/${parentDir.join('/')}`
  const routeDir = parentDir.length === 0 ? '' : `/${parentDir.join('/')}`
  return {
    newPath: `${newDir}/${leaf}${ext}`,
    routePath: `${routeDir}/${leaf}`,
    kind: 'route',
    wasCatchAll,
    dynamicSegmentName: dynamicName,
  }
}

/**
 * Map `src/pages/**` or `pages/**` to the same `app` tree used by App Router output.
 */
function computePagesRouterRoutePath(
  split: {
    head: string
    rest: string[]
  },
  pageSourceAbsPath?: string,
): RoutePathResult | null {
  const { head, rest } = split
  if (rest.length === 0) {
    return null
  }

  const fileName = rest.at(-1)
  if (fileName === undefined) {
    return null
  }
  const dirSegs = rest.slice(0, -1)
  const ext = fileName.slice(fileName.indexOf('.'))
  const baseName = fileName.slice(0, fileName.indexOf('.'))

  if (/^(?:_app|_document|_middleware)$/.test(baseName) && /\.(?:t|j)sx?$/.test(ext)) {
    return null
  }

  if (/^_error$/.test(baseName) && /\.(?:t|j)sx?$/.test(ext)) {
    return null
  }

  if (baseName.startsWith('_')) {
    return null
  }

  const targetHead = pagesHeadToAppHead(head)

  // API routes: `pages/api/.../*.ts`
  if (dirSegs[0] === 'api') {
    if (!/\.(m|c)?tsx?$|\.(m|c)?jsx?$|\.(m)?ts$/.test(ext)) {
      return null
    }
    const stemSegments = [...dirSegs, baseName]
    const translated: string[] = []
    let wasCatchAll = false
    let dynamicName: string | null = null
    for (const seg of stemSegments) {
      const t = translateSegment(seg)
      if (t.group) {
        return null
      }
      if (t.text === null) {
        return null
      }
      translated.push(t.text)
      if (t.catchAll) {
        wasCatchAll = true
      }
      if (t.dynamic) {
        dynamicName = t.dynamic
      }
    }
    const parentDir = translated.slice(0, -1)
    const leaf = translated.at(-1)
    if (leaf === undefined) {
      return null
    }
    const newDir = parentDir.length === 0 ? targetHead : `${targetHead}/${parentDir.join('/')}`
    const routeDir = parentDir.length === 0 ? '' : `/${parentDir.join('/')}`
    return {
      newPath: `${newDir}/${leaf}${ext}`,
      routePath: `${routeDir}/${leaf}`,
      kind: 'route',
      wasCatchAll,
      dynamicSegmentName: dynamicName,
    }
  }

  if (!/\.(?:t|j)sx?$/.test(ext)) {
    return null
  }

  // `pages/index.tsx` → `app/index.tsx`
  if (baseName === 'index') {
    const translated: string[] = []
    let wasCatchAll = false
    let dynamicName: string | null = null
    let hasOptionalCatchAll = false
    for (const seg of dirSegs) {
      const t = translateSegment(seg)
      if (t.group) {
        return null
      }
      if (t.text === null) {
        return null
      }
      translated.push(t.text)
      if (t.catchAll) {
        wasCatchAll = true
      }
      if (t.optionalCatchAll) {
        hasOptionalCatchAll = true
      }
      if (t.dynamic) {
        dynamicName = t.dynamic
      }
    }
    if (translated.length === 0) {
      return {
        newPath: `${targetHead}/index${ext}`,
        routePath: '/',
        kind: 'page',
        wasCatchAll: false,
        dynamicSegmentName: null,
      }
    }
    const parentDir = translated.slice(0, -1)
    const leaf = translated.at(-1)
    if (leaf === undefined) {
      return null
    }
    const newDir = parentDir.length === 0 ? targetHead : `${targetHead}/${parentDir.join('/')}`
    const routeDir = parentDir.length === 0 ? '' : `/${parentDir.join('/')}`
    const splatRoutePath = `${routeDir}/${leaf}`
    const useFolderIndex =
      pageSourceAbsPath !== undefined &&
      pageSourceAbsPath.length > 0 &&
      pageSourceDirHasTanStackRouteSiblings(pageSourceAbsPath)
    const pageResult: RoutePathResult = useFolderIndex
      ? {
          newPath: `${targetHead}/${translated.join('/')}/index${ext}`,
          routePath: splatRoutePath,
          kind: 'page',
          wasCatchAll,
          dynamicSegmentName: dynamicName,
        }
      : {
          newPath: `${newDir}/${leaf}${ext}`,
          routePath: splatRoutePath,
          kind: 'page',
          wasCatchAll,
          dynamicSegmentName: dynamicName,
        }
    if (hasOptionalCatchAll && parentDir.length > 0) {
      pageResult.optionalCatchAllRedirect = {
        indexNewPath: `${newDir}/index${ext}`,
        indexRoutePath: routeDir,
        splatRoutePath,
      }
    }
    return pageResult
  }

  // `pages/about.tsx`, `pages/docs/a.tsx`, `pages/blog/[slug].tsx`
  const stemSegments = [...dirSegs, baseName]
  const translated: string[] = []
  let wasCatchAll = false
  let dynamicName: string | null = null
  let hasOptionalCatchAll = false
  for (const seg of stemSegments) {
    const t = translateSegment(seg)
    if (t.group) {
      return null
    }
    if (t.text === null) {
      return null
    }
    translated.push(t.text)
    if (t.catchAll) {
      wasCatchAll = true
    }
    if (t.optionalCatchAll) {
      hasOptionalCatchAll = true
    }
    if (t.dynamic) {
      dynamicName = t.dynamic
    }
  }

  const parentDir = translated.slice(0, -1)
  const leaf = translated.at(-1)
  if (leaf === undefined || translated.length === 0) {
    return null
  }

  const newDir = parentDir.length === 0 ? targetHead : `${targetHead}/${parentDir.join('/')}`
  const routeDir = parentDir.length === 0 ? '' : `/${parentDir.join('/')}`
  const splatRoutePath = `${routeDir}/${leaf}`
  const pageResult: RoutePathResult = {
    newPath: `${newDir}/${leaf}${ext}`,
    routePath: splatRoutePath,
    kind: 'page',
    wasCatchAll,
    dynamicSegmentName: dynamicName,
  }
  if (hasOptionalCatchAll && parentDir.length > 0) {
    pageResult.optionalCatchAllRedirect = {
      indexNewPath: `${newDir}/index${ext}`,
      indexRoutePath: routeDir,
      splatRoutePath,
    }
  }
  return pageResult
}

/**
 * Quick classifier used by entry scripts to short-circuit files that fall
 * outside their intended scope. The workflow's `include:` already filters
 * most cases; this is belt-and-braces.
 */
export function detectNextFileKind(relativePath: string): NextFileKind {
  const fileName = normalize(relativePath).split('/').at(-1)
  return detectKind(fileName)
}
