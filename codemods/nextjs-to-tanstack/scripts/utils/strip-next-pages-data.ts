/**
 * Removes Pages Router data-fetching exports and related imports from route
 * modules migrated to TanStack Start (text + brace-balanced transforms).
 */

import { indexOfMatchingBrace } from './balanced-text-scan.ts'
import {
  applyNextI18nextToReactI18nextModuleRewrites,
  rewriteNextI18nextMainAndDynamicImports,
  stripNextI18nextServerSideTranslationsImport,
} from './rewrite-next-i18next-specifiers.ts'

const DATA_EXPORT_NAMES = ['getStaticProps', 'getStaticPaths', 'getServerSideProps']

const REMOVABLE_NEXT_IDENTIFIERS = new Set([
  'GetStaticProps',
  'GetStaticPaths',
  'GetStaticPathsContext',
  'GetStaticPropsContext',
  'GetServerSideProps',
  'GetServerSidePropsContext',
  'InferGetStaticPropsType',
  'InferGetServerSidePropsType',
  'NextPage',
  'PreviewData',
])

function findExportKeywordIndex(source: string, name: string): number {
  const patterns = [`export const ${name}`, `export async function ${name}`, `export function ${name}`]
  let best = -1
  for (const p of patterns) {
    const i = source.indexOf(p)
    if (i !== -1 && (best === -1 || i < best)) {
      best = i
    }
  }
  return best
}

/** Opening `{` of the async arrow body or `export async function` body. */
function findMainFunctionBodyBrace(source: string, exportStart: number): number {
  const slice = source.slice(exportStart)
  const arrowIdx = slice.indexOf('=>')
  if (arrowIdx !== -1) {
    const afterArrow = exportStart + arrowIdx + 2
    const br = source.indexOf('{', afterArrow)
    return br
  }
  const fnParen = source.indexOf(')', exportStart)
  if (fnParen !== -1) {
    const br = source.indexOf('{', fnParen)
    return br
  }
  return -1
}

/** Remove one `export const name …` or `export async function name …` declaration. */
export function stripOneDataExport(source: string, name: string): string {
  const exportStart = findExportKeywordIndex(source, name)
  if (exportStart === -1) {
    return source
  }
  const bodyOpen = findMainFunctionBodyBrace(source, exportStart)
  if (bodyOpen === -1) {
    return source
  }
  const closeBrace = indexOfMatchingBrace(source, bodyOpen)
  if (closeBrace === -1) {
    return source
  }

  let end = closeBrace + 1
  while (end < source.length) {
    const ch = source[end]
    if (ch === undefined || !/\s/.test(ch)) {
      break
    }
    end++
  }
  if (end < source.length && source[end] === ';') {
    end++
  }
  while (end < source.length && (source[end] === '\n' || source[end] === '\r')) {
    end++
  }
  return source.slice(0, exportStart) + source.slice(end)
}

export function stripNextDataExportDeclarations(source: string): string {
  let s = source
  for (const name of DATA_EXPORT_NAMES) {
    let prev = ''
    while (prev !== s) {
      prev = s
      s = stripOneDataExport(s, name)
    }
  }
  return s
}

/** Orphan tail: `) => { ... serverSideTranslations ... };` */
export function stripOrphanServerSideTranslationsTail(source: string): string {
  return source.replaceAll(/\n\) => \{\s*\n[\s\S]*?serverSideTranslations[\s\S]*?\n\};\s*/g, '\n')
}

export function stripNextTypeOnlyImports(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const m = line.match(/^(\s*)import\s+type\s+\{\s*([^}]+)\}\s+from\s+["']next["']\s*;?\s*$/)
    if (!m) {
      out.push(line)
      continue
    }
    const names = (m[2] ?? '')
      .split(',')
      .map((s) => s.trim())
      .map((part) => part.split(/\s+/)[0] ?? '')
      .filter(Boolean)
    const allRemovable = names.length > 0 && names.every((n) => REMOVABLE_NEXT_IDENTIFIERS.has(n))
    if (allRemovable) {
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

export function stripServerSideTranslationsImport(source: string): string {
  return stripNextI18nextServerSideTranslationsImport(source)
}

export function rewriteNextI18nextUseTranslation(source: string): string {
  return rewriteNextI18nextMainAndDynamicImports(source)
}

export function stripNextHeadImport(source: string): string {
  let s = source.replaceAll(/^\s*import\s+Head\s+from\s+["']next\/head["']\s*;?\s*\n/gm, '')
  s = s.replaceAll(/^\/\/\s*TODO: replace `next\/head`[^\n]*\n/gm, '')
  return s
}

function ensureUseEffectInReactImport(source: string): string {
  if (/\buseEffect\b/.test(source)) {
    return source
  }
  const reactImport = /import\s+\{([^}]*)\}\s+from\s+["']react["']/
  const m = reactImport.exec(source)
  if (m) {
    const inner = (m[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!inner.includes('useEffect')) {
      inner.unshift('useEffect')
      return source.replace(reactImport, `import { ${inner.join(', ')} } from "react"`)
    }
    return source
  }
  return `import { useEffect } from "react";\n${source}`
}

export function replaceNextHeadWithDocumentTitleEffect(source: string): string {
  const headRe = /<Head>\s*<title>([\s\S]*?)<\/title>\s*<\/Head>\s*/g
  const m = headRe.exec(source)
  if (!m) {
    return source
  }
  const titleInner = (m[1] ?? '').replaceAll(/\s+/g, ' ').trim()
  let without = source.replace(headRe, '')

  const calls = [...titleInner.matchAll(/\bt\(\s*(["'])([^"']*)\1\s*\)/g)].map(
    (x) => `t(${JSON.stringify(x[2] ?? '')})`,
  )

  if (!/\buseTranslation\b/.test(without)) {
    return without
  }

  let effect = ''
  if (calls.length > 0) {
    effect = `\n  useEffect(() => {\n    document.title = [${calls.join(', ')}].join(" - ");\n  }, [t]);\n`
  } else if (!titleInner.includes('{') && titleInner.length > 0) {
    effect = `\n  useEffect(() => {\n    document.title = ${JSON.stringify(titleInner)};\n  }, []);\n`
  }
  if (!effect) {
    return without
  }

  without = ensureUseEffectInReactImport(without)
  return without.replace(/(\bconst\s+{\s*t\s*}\s*=\s*useTranslation\([^)]*\);\s*\n)/, `$1${effect}`)
}

/**
 * When SSG stripping removes exports but leaves fragments after
 * `export const Route = createFileRoute(...)({ ... });`, the file becomes
 * invalid TS/JSX. Keep only the first Route declaration through its closing
 * `});` (and optional trailing `;`).
 */
export function truncateAfterFirstRouteDeclaration(source: string): string {
  const marker = 'export const Route = createFileRoute'
  const start = source.indexOf(marker)
  if (start === -1) {
    return source
  }
  const afterMarker = source.slice(start)
  /** End of `createFileRoute(...) (` — options object `{` must be the last `{` in the match. */
  const hook = /\)\s*\(\s*\{/.exec(afterMarker)
  if (!hook) {
    return source
  }
  const openBraceIdx = start + hook.index + hook[0].length - 1
  const closeBrace = indexOfMatchingBrace(source, openBraceIdx)
  if (closeBrace === -1) {
    return source
  }
  let j = closeBrace + 1
  while (j < source.length) {
    const ch = source[j]
    if (ch === undefined || !/\s/.test(ch)) {
      break
    }
    j++
  }
  if (j < source.length && source[j] === ')') {
    j++
  }
  while (j < source.length) {
    const ch = source[j]
    if (ch === undefined || !/\s/.test(ch)) {
      break
    }
    j++
  }
  if (j < source.length && source[j] === ';') {
    j++
  }
  return `${source.slice(0, j).trimEnd()}\n`
}

/**
 * Removes common partial-SSG tails that remain after bad edits (after `});` of Route).
 * Keeps the first Route block; safe to run after {@link truncateAfterFirstRouteDeclaration}.
 */
export function stripOrphanFragmentsAfterRouteClose(source: string): string {
  let s = source
  /** Orphan from `|| "fa"` when `...(` was stripped — line may start with `|` or partial `SideTranslations`. */
  const pipeTail = /\}\);\s*(?:\r?\n)+\s*(?:\|[^\n]*|\w*SideTranslations[\s\S]*)/.exec(s)
  if (pipeTail) {
    const local = s.slice(pipeTail.index)
    const m = local.match(/^\}\);\s*/)
    const cut = pipeTail.index + (m?.[0].length ?? 0)
    s = `${s.slice(0, cut).trimEnd()}\n`
  }
  s = s.replace(
    /\}\);\s*(?:\r?\n)+\s*\{\s*return\s*\{[\s\S]*?serverSideTranslations[\s\S]*?\}\s*;\s*\}\s*;?\s*/m,
    '});\n',
  )
  return s
}

/** Truncate + orphan cleanup (used by repair step and by R10a pipeline). */
export function applyRepairRouteTailPipeline(source: string): string {
  let out = source
  for (let i = 0; i < 8; i++) {
    const step = truncateAfterFirstRouteDeclaration(stripOrphanFragmentsAfterRouteClose(out))
    if (step === out) {
      break
    }
    out = step
  }
  return out
}

export function applyStripNextPagesDataPipeline(source: string): string {
  let s = source
  s = stripNextHeadImport(s)
  s = replaceNextHeadWithDocumentTitleEffect(s)
  s = applyNextI18nextToReactI18nextModuleRewrites(s)
  s = stripNextTypeOnlyImports(s)
  s = stripNextDataExportDeclarations(s)
  s = stripOrphanServerSideTranslationsTail(s)
  s = applyRepairRouteTailPipeline(s)
  return s
}
