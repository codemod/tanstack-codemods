/**
 * R4i — `next/og` → `satori` + `@resvg/resvg-js` + Web `Response` (Vite / TanStack Start).
 *
 * Rewrites `new ImageResponse(…)` to a small async pipeline: JSX → SVG (`satori`) → PNG (`Resvg`)
 * → `new Response(…, { headers: { "Content-Type": "image/png" } })`.
 *
 * R11 adds `satori` and `@resvg/resvg-js` when those imports appear in the package tree.
 * Also matches `ImageResponse` imported from `next/server` (Next re-exports the same helper).
 */

import type { Codemod, Edit, SgNode } from 'codemod:ast-grep'
import type TSX from 'codemod:ast-grep/langs/tsx'

import { getFilename } from '../utils/paths.ts'

const FROM_OG = 'next/og'
const FROM_NEXT_SERVER = 'next/server'

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root()
  const file = getFilename(root)
  const isTsx = file.endsWith('.tsx') || file.endsWith('.jsx')

  const valueImports: SgNode<TSX>[] = []
  const typeOnlyImports: SgNode<TSX>[] = []
  const imageLocals = new Set<string>()

  for (const stmt of rootNode.findAll({ rule: { kind: 'import_statement' } })) {
    const src = parseImportSource(stmt.text())
    if (src !== FROM_OG && src !== FROM_NEXT_SERVER) {
      continue
    }

    const text = stmt.text()
    if (/^\s*import\s+type\b/.test(text)) {
      typeOnlyImports.push(stmt)
      continue
    }

    let picksImage = false
    for (const spec of stmt.findAll({ rule: { kind: 'import_specifier' } })) {
      const pair = parseImportSpecifier(spec)
      if (pair?.imported === 'ImageResponse') {
        imageLocals.add(pair.local)
        picksImage = true
      }
    }

    if (src === FROM_OG) {
      valueImports.push(stmt)
    } else if (src === FROM_NEXT_SERVER && picksImage) {
      valueImports.push(stmt)
    }
  }

  if (valueImports.length === 0 && typeOnlyImports.length === 0 && imageLocals.size === 0) {
    return null
  }

  let needsCreateElement = false
  const bodyEdits: Edit[] = []
  const asyncFnIds = new Set<number>()
  let ogCounter = 0

  if (imageLocals.size > 0) {
    for (const nx of rootNode.findAll({ rule: { kind: 'new_expression' } })) {
      const ctor = newExpressionConstructor(nx)
      if (!ctor || !imageLocals.has(ctor.text())) {
        continue
      }

      const args = listNewArgs(nx)
      const arg0 = args[0] ? unwrapExpr(args[0]) : undefined
      if (!isTsx && elementNeedsCreateElement(arg0)) {
        needsCreateElement = true
      }

      const elem = buildSatoriElementSrc(arg0, isTsx)
      const opts = buildSatoriOptionsSrc(args[1])
      const i = ogCounter++
      const inner = bridgeInner(i, elem, opts)
      const replacement = `(await (async (): Promise<Response> => {\n${inner}\n  })())`

      const fn = enclosingAsyncBoundaryFunction(nx)
      if (fn && !asyncFnIds.has(fn.id())) {
        ensureAsyncFn(fn, bodyEdits)
        asyncFnIds.add(fn.id())
      }

      bodyEdits.push({
        startPos: nx.range().start.index,
        endPos: nx.range().end.index,
        insertedText: replacement,
      })
    }
  }

  const source = rootNode.text()

  const importEdits: Edit[] = []
  for (const stmt of typeOnlyImports) {
    importEdits.push(stmtDelete(stmt, source))
  }
  for (const stmt of valueImports) {
    importEdits.push(valueImportReplacementEdit(stmt, source, needsCreateElement))
  }

  const edits = [...bodyEdits, ...importEdits].sort((a, b) => b.startPos - a.startPos)
  if (edits.length === 0) {
    return null
  }
  return rootNode.commitEdits(edits)
}

export default codemod

function stmtDelete(stmt: SgNode<TSX>, source: string): Edit {
  return {
    startPos: stmt.range().start.index,
    endPos: consumeFollowingBlankLines(stmt, source),
    insertedText: '',
  }
}

function valueImportReplacementEdit(stmt: SgNode<TSX>, source: string, needsCreateElement: boolean): Edit {
  return {
    startPos: stmt.range().start.index,
    endPos: consumeFollowingBlankLines(stmt, source),
    insertedText: runtimeImportBlock(needsCreateElement),
  }
}

/**
 * Extend past the import statement to include one or two newline bytes so typical
 * `import …;\n\nexport` collapses to exactly one blank line after replacement.
 */
function consumeFollowingBlankLines(stmt: SgNode<TSX>, source: string): number {
  let e = stmt.range().end.index
  if (source[e] === '\r') {
    e++
  }
  if (source[e] === '\n') {
    e++
    if (source[e] === '\n') {
      e++
    }
  }
  return e
}

function runtimeImportBlock(needsCreateElement: boolean): string {
  const lines: string[] = []
  if (needsCreateElement) {
    lines.push(`import { createElement } from "react";`)
  }
  lines.push(`import satori from "satori";`)
  lines.push(`import { Resvg } from "@resvg/resvg-js";`)
  return `${lines.join('\n')}\n\n`
}

function bridgeInner(i: number, elem: string, opts: string): string {
  return `    const __ogSvg${i} = await satori(${elem}, ${opts});\n    const __ogPng${i} = new Resvg(__ogSvg${i}).render().asPng();\n    return new Response(__ogPng${i}, { headers: { "Content-Type": "image/png" } });`
}

function buildSatoriOptionsSrc(second: SgNode<TSX> | undefined): string {
  if (!second) {
    return '{ width: 1200, height: 630, fonts: [] }'
  }
  return `{ ...{ width: 1200, height: 630, fonts: [] }, ...(${second.text()}) }`
}

function elementNeedsCreateElement(arg0: SgNode<TSX> | undefined): boolean {
  if (!arg0) {
    return true
  }
  const k = arg0.kind()
  return k !== 'jsx_element' && k !== 'jsx_self_closing_element'
}

function buildSatoriElementSrc(arg0: SgNode<TSX> | undefined, isTsx: boolean): string {
  if (!arg0) {
    return isTsx ? '<div />' : `createElement("div", null)`
  }
  const k = arg0.kind()
  if (k === 'jsx_element' || k === 'jsx_self_closing_element') {
    return arg0.text()
  }
  if (isTsx) {
    if (k === 'string') {
      return `<div>{${arg0.text()}}</div>`
    }
    if (k === 'string_fragment') {
      return `<div>${arg0.text()}</div>`
    }
    return `<div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>{${arg0.text()}}</div>`
  }
  if (k === 'string' || k === 'string_fragment') {
    return `createElement("div", null, ${arg0.text()})`
  }
  return `createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "center" } }, ${arg0.text()})`
}

function newExpressionConstructor(nx: SgNode<TSX>): SgNode<TSX> | null {
  let seenNew = false
  for (const ch of nx.children()) {
    if (ch.text() === 'new') {
      seenNew = true
      continue
    }
    if (seenNew && ch.kind() === 'identifier') {
      return ch
    }
    if (ch.kind() === 'arguments') {
      break
    }
  }
  return null
}

function listNewArgs(nx: SgNode<TSX>): SgNode<TSX>[] {
  const out: SgNode<TSX>[] = []
  const args = nx.children().find((c) => c.kind() === 'arguments')
  if (!args) {
    return out
  }
  for (const ch of args.children()) {
    const k = ch.kind()
    if (k === '(' || k === ')' || k === ',') {
      continue
    }
    out.push(ch)
  }
  return out
}

function unwrapExpr(n: SgNode<TSX>): SgNode<TSX> {
  let x: SgNode<TSX> = n
  for (;;) {
    if (x.kind() !== 'parenthesized_expression') {
      return x
    }
    const inner = x.children().find((c) => c.kind() !== '(' && c.kind() !== ')')
    if (!inner) {
      return x
    }
    x = inner
  }
}

function parseImportSpecifier(spec: SgNode<TSX>): { imported: string; local: string } | null {
  const ids = spec.findAll({ rule: { kind: 'identifier' } })
  if (ids.length === 2) {
    const imported = ids[0]?.text()
    const local = ids[1]?.text()
    if (imported === undefined || local === undefined) {
      return null
    }
    return { imported, local }
  }
  if (ids.length === 1) {
    const t = ids[0]?.text()
    if (t === undefined) {
      return null
    }
    return { imported: t, local: t }
  }
  return null
}

function enclosingAsyncBoundaryFunction(nx: SgNode<TSX>): SgNode<TSX> | null {
  let cur: SgNode<TSX> | null = nx.parent()
  while (cur) {
    const k = cur.kind()
    if (k === 'function_declaration' || k === 'function_expression' || k === 'arrow_function') {
      return cur
    }
    if (k === 'program') {
      return null
    }
    cur = cur.parent()
  }
  return null
}

function ensureAsyncFn(fn: SgNode<TSX>, edits: Edit[]): void {
  const t = fn.text()
  if (/\basync\b/.test(t.slice(0, Math.min(48, t.length)))) {
    return
  }

  if (fn.kind() === 'arrow_function') {
    const params = fn.field('parameters')
    if (params) {
      edits.push({
        startPos: params.range().start.index,
        endPos: params.range().start.index,
        insertedText: 'async ',
      })
    }
    return
  }

  const fnKw = fn.children().find((c) => c.kind() === 'function' && c.text() === 'function')
  if (fnKw) {
    edits.push({
      startPos: fnKw.range().start.index,
      endPos: fnKw.range().start.index,
      insertedText: 'async ',
    })
  }
}

function parseImportSource(s: string): string | null {
  const m = s.match(/from\s*["']([^"']+)["']/)
  return m?.[1] ?? null
}
