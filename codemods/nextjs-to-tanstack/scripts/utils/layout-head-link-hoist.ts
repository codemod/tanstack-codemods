/**
 * Hoist `<link rel="stylesheet" | …>` tags from the root layout `<head>` in
 * `__root.tsx` into TanStack Router `head().links`, and strip them from JSX so
 * `HeadContent` is the single source of truth for those entries.
 */

import type { Edit, SgNode } from 'codemod:ast-grep'

import { findJsxOpeningElements, jsxAttributeName, jsxAttributeValue, jsxAttributes } from './jsx.ts'

export interface LayoutHeadLinkHoistResult {
  linkItems: string[]
  removals: Edit[]
}

/** `src/app/__root.tsx`, `app/__root.tsx`, etc. */
export function isTanstackAppRootFile(appRelativePath: string): boolean {
  const n = appRelativePath.replaceAll('\\', '/')
  return /(^|\/)__root\.(t|j)sx$/.test(n)
}

/**
 * Default import binding for `import <name> from "...css...?url"` (Vite URL
 * import). Returns the local identifier `name`, or null when absent.
 */
export function findCssUrlDefaultBinding(rootNode: SgNode): string | null {
  for (const stmt of rootNode.children()) {
    if (stmt.kind() !== 'import_statement') {
      continue
    }
    const spec = readImportModuleSpecifier(stmt)
    if (!spec || !isCssUrlImportSpecifier(spec)) {
      continue
    }
    const clause = stmt.find({ rule: { kind: 'import_clause' } })
    if (!clause) {
      continue
    }
    const binding = clause.find({ rule: { kind: 'identifier' } })?.text()
    if (binding) {
      return binding
    }
  }
  return null
}

function readImportModuleSpecifier(stmt: SgNode): string | null {
  const frags = stmt.findAll({ rule: { kind: 'string_fragment' } })
  if (frags.length === 0) {
    return null
  }
  return frags.map((f) => f.text()).join('')
}

function isCssUrlImportSpecifier(spec: string): boolean {
  return spec.includes('.css') && spec.includes('?url')
}

function stylesheetLinkFromBinding(binding: string): string {
  return `{ rel: "stylesheet", href: ${binding} }`
}

function hrefUsesBindingRegex(binding: string): RegExp {
  return new RegExp(`\\bhref:\\s*${escapeRegexIdent(binding)}\\b`)
}

function escapeRegexIdent(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function extractLayoutHeadStyleLinks(rootNode: SgNode, source: string): LayoutHeadLinkHoistResult {
  const linkItems: string[] = []
  const removals: Edit[] = []

  const linkOpens = findJsxOpeningElements(rootNode, 'link')
  const seen = new Set<number>()

  for (const open of linkOpens) {
    if (!isUnderHeadElement(open)) {
      continue
    }

    const attrs = jsxAttributes(open)
    const rel = readLowercaseStringAttr(attrs, 'rel')
    const asVal = readLowercaseStringAttr(attrs, 'as')
    if (!shouldHoistStyleLink(rel, asVal)) {
      continue
    }

    const built = buildLinkObjectFromAttributes(attrs)
    if (!built) {
      continue
    }

    linkItems.push(built)

    const rootEl = linkJsxRootNode(open)
    const id = rootEl.id()
    if (seen.has(id)) {
      continue
    }
    seen.add(id)

    const { start: lineStart, end: lineEnd } = extendRemovalToFullLines(
      source,
      rootEl.range().start.index,
      rootEl.range().end.index,
    )
    removals.push({
      startPos: lineStart,
      endPos: lineEnd,
      insertedText: '',
    })
  }

  return { linkItems, removals }
}

function extendRemovalToFullLines(
  source: string,
  elementStart: number,
  elementEnd: number,
): { start: number; end: number } {
  let start = elementStart
  while (start > 0) {
    const c = source[start - 1]
    if (c === '\n' || c === '\r') {
      break
    }
    start--
  }
  let end = elementEnd
  while (end < source.length) {
    const c = source[end]
    if (c === '\n' || c === '\r') {
      if (c === '\r' && source[end + 1] === '\n') {
        end += 2
      } else {
        end += 1
      }
      break
    }
    end++
  }
  return { start, end }
}

/** Append stylesheet `links` entry for the file's `*.css?url` default import binding. */
export function appendCssUrlStylesheetToLinkItems(linkItems: string[], rootNode: SgNode): void {
  const binding = findCssUrlDefaultBinding(rootNode)
  if (!binding) {
    return
  }
  const hrefRe = hrefUsesBindingRegex(binding)
  if (linkItems.some((s) => hrefRe.test(s))) {
    return
  }
  linkItems.push(stylesheetLinkFromBinding(binding))
}

/**
 * When `createRootRoute` already has `head: () => ({ ... })` but the route
 * config does not yet reference the `*.css?url` default import in `links`,
 * insert `links` or append to the existing `links` array.
 */
export function tryMergeCssUrlBindingIntoExistingHead(
  source: string,
  rootNode: SgNode,
  appRelativePath: string,
  configObj: SgNode,
): Edit | null {
  const binding = findCssUrlDefaultBinding(rootNode)
  if (!isTanstackAppRootFile(appRelativePath) || !binding) {
    return null
  }

  const cfgStart = configObj.range().start.index
  const cfgEnd = configObj.range().end.index
  const cfg = source.slice(cfgStart, cfgEnd)
  if (hrefUsesBindingRegex(binding).test(cfg)) {
    return null
  }

  const headRe = /head\s*:\s*\(\)\s*=>\s*\(\{/
  const m = headRe.exec(cfg)
  if (m?.index === undefined) {
    return null
  }

  const headObjOpenBrace = cfgStart + m.index + m[0].length - 1
  const headObjCloseBrace = findMatchingBraceClose(source, headObjOpenBrace, cfgEnd)
  if (headObjCloseBrace === null) {
    return null
  }

  const headInner = source.slice(headObjOpenBrace + 1, headObjCloseBrace)
  const linksKey = /\blinks\s*:\s*\[/.exec(headInner)
  const snippet = stylesheetLinkFromBinding(binding)
  if (!linksKey) {
    const insertAt = headObjOpenBrace + 1
    return {
      startPos: insertAt,
      endPos: insertAt,
      insertedText: `\n      links: [${snippet}],`,
    }
  }

  const matchStart = headObjOpenBrace + 1 + linksKey.index
  const absLinksBracket = matchStart + linksKey[0].length - 1
  const linksArrayClose = findMatchingBracketClose(source, absLinksBracket, cfgEnd)
  if (linksArrayClose === null) {
    return null
  }

  const inner = source.slice(absLinksBracket + 1, linksArrayClose)
  if (hrefUsesBindingRegex(binding).test(inner)) {
    return null
  }
  const sep = inner.trim().length === 0 ? '' : ', '
  return {
    startPos: linksArrayClose,
    endPos: linksArrayClose,
    insertedText: `${sep}${snippet}`,
  }
}

function findMatchingBraceClose(source: string, openBraceIdx: number, limit: number): number | null {
  let depth = 0
  for (let i = openBraceIdx; i < limit; i++) {
    const ch = source[i]
    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        return i
      }
    }
  }
  return null
}

function findMatchingBracketClose(source: string, openBracketIdx: number, limit: number): number | null {
  let depth = 0
  for (let i = openBracketIdx; i < limit; i++) {
    const ch = source[i]
    if (ch === '[') {
      depth++
    } else if (ch === ']') {
      depth--
      if (depth === 0) {
        return i
      }
    }
  }
  return null
}

function linkJsxRootNode(open: SgNode): SgNode {
  if (open.kind() === 'jsx_self_closing_element') {
    return open
  }
  const p = open.parent()
  if (p?.kind() === 'jsx_element') {
    return p
  }
  return open
}

function isUnderHeadElement(node: SgNode): boolean {
  let cur: SgNode | null = node.parent()
  while (cur) {
    if (cur.kind() === 'jsx_element') {
      const open = cur.children().find((c) => c.kind() === 'jsx_opening_element')
      const tag = open?.field('name')?.text()
      if (tag === 'head') {
        return true
      }
      if (tag === 'html') {
        return false
      }
    }
    cur = cur.parent()
  }
  return false
}

function shouldHoistStyleLink(rel: string | null, asVal: string | null): boolean {
  const r = rel ?? ''
  if (!r) {
    return false
  }
  const rl = r.toLowerCase()
  if (rl === 'stylesheet' || rl === 'preconnect' || rl === 'dns-prefetch') {
    return true
  }
  if (rl === 'preload' && (asVal ?? '').toLowerCase() === 'style') {
    return true
  }
  return false
}

function readLowercaseStringAttr(attrs: SgNode[], prop: string): string | null {
  const raw = readStringAttr(attrs, prop)
  return raw === null ? null : raw.toLowerCase()
}

function readStringAttr(attrs: SgNode[], prop: string): string | null {
  for (const attr of attrs) {
    const name = jsxAttributeName(attr)?.text()
    if (name !== prop) {
      continue
    }
    const val = jsxAttributeValue(attr)
    if (!val) {
      return null
    }
    if (val.kind() === 'string') {
      const frag = val.find({ rule: { kind: 'string_fragment' } })
      return frag ? frag.text() : ''
    }
    return null
  }
  return null
}

function buildLinkObjectFromAttributes(attrs: SgNode[]): string | null {
  const parts: string[] = []
  let hasHref = false

  for (const attr of attrs) {
    const name = jsxAttributeName(attr)?.text()
    if (!name || name === 'rel') {
      continue
    }
    const val = jsxAttributeValue(attr)
    if (!val) {
      continue
    }

    const key = htmlLinkAttrToJsKey(name)
    if (!key) {
      continue
    }

    const formatted = formatAttrForLinkObject(key, val)
    if (!formatted) {
      return null
    }
    if (key === 'href') {
      hasHref = true
    }
    parts.push(formatted)
  }

  const relStr = readStringAttr(attrs, 'rel')
  if (relStr) {
    parts.unshift(`rel: ${JSON.stringify(relStr)}`)
  }

  if (!hasHref) {
    return null
  }
  return `{ ${parts.join(', ')} }`
}

/** Map common HTML `<link>` attribute names to JS object keys TanStack accepts. */
function htmlLinkAttrToJsKey(htmlName: string): string | null {
  switch (htmlName) {
    case 'href':
    case 'hrefLang': {
      return htmlName
    }
    case 'crossOrigin':
    case 'integrity':
    case 'media':
    case 'type':
    case 'referrerPolicy':
    case 'imageSrcSet':
    case 'imageSizes':
    case 'as':
    case 'fetchPriority': {
      return htmlName
    }
    case 'crossorigin': {
      return 'crossOrigin'
    }
    case 'referrerpolicy': {
      return 'referrerPolicy'
    }
    case 'imagesrcset': {
      return 'imageSrcSet'
    }
    case 'imagesizes': {
      return 'imageSizes'
    }
    case 'fetchpriority': {
      return 'fetchPriority'
    }
    default: {
      return null
    }
  }
}

function formatAttrForLinkObject(key: string, val: SgNode): string | null {
  if (val.kind() === 'string') {
    const frag = val.find({ rule: { kind: 'string_fragment' } })
    const s = frag ? frag.text() : ''
    return `${key}: ${JSON.stringify(s)}`
  }
  if (val.kind() === 'jsx_expression') {
    const inner = jsxExpressionInnerSource(val)
    if (!inner) {
      return null
    }
    return `${key}: ${inner}`
  }
  return null
}

function jsxExpressionInnerSource(node: SgNode): string | null {
  const t = node.text()
  const m = /^\{\s*([\s\S]*?)\s*\}$/.exec(t)
  return m ? (m[1]?.trim() ?? null) : null
}
