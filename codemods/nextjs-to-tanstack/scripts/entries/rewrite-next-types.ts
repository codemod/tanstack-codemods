/**
 * Erase type-only surface from `next/types` and **type-only** `import type … from "next"`:
 * - Drop a sole unused `_*` parameter when typed with an imported name from those modules.
 * - Replace other uses of those names with `any` (and `Ns.prop` / `Ns.Sub` nested type paths with `any`).
 *   Each affected statement gets one `// TODO: … (R4j)` so `any` can be refined.
 * - Delete the matching import lines.
 *
 * Value imports from `next` or subpaths stay for other codemods / R10b.
 */

import type { Codemod, Edit, SgNode } from 'codemod:ast-grep'
import type TSX from 'codemod:ast-grep/langs/tsx'

import { hasTodoSentinel, insertTodoBefore } from '../utils/sentinels.ts'

const MODULE_TYPES = 'next/types'
const MODULE_NEXT = 'next'

const NEXT_TYPEONLY_SUBPATHS = new Set(['next/app', 'next/document', 'next/error'])

const R4J_NEEDLE = 'next/types erasure (R4j)'
const R4J_MSG = `\`${R4J_NEEDLE}\`: replace \`any\` with real types (\`Route.useParams\`, \`useLoaderData\`, \`FileRoutesByPath\`, etc.)`
const R4J_DOC = 'https://tanstack.com/router/latest/docs/framework/react/guide/router-context'

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root()
  const source = rootNode.text()

  const imports = rootNode.findAll({ rule: { kind: 'import_statement' } }).filter((s) => isNextTypesErasureImport(s))
  if (imports.length === 0) {
    return null
  }

  const typeNames = new Set<string>()
  const namespaceNames = new Set<string>()

  for (const stmt of imports) {
    if (stmt.find({ rule: { kind: 'namespace_import' } }) !== null) {
      const ns = stmt.find({ rule: { kind: 'namespace_import' } })
      const id = ns?.find({ rule: { kind: 'identifier' } })
      if (id) {
        namespaceNames.add(id.text())
      }
      continue
    }
    for (const nm of extractNamedAndDefaultLocals(stmt)) {
      typeNames.add(nm)
    }
  }

  if (typeNames.size === 0 && namespaceNames.size === 0) {
    return null
  }

  const importRanges = imports.map((i) => i.range())
  const insideImports = (n: SgNode<TSX>): boolean => {
    const r = n.range()
    for (const ir of importRanges) {
      if (r.start.index >= ir.start.index && r.end.index <= ir.end.index) {
        return true
      }
    }
    return false
  }

  const skipTypeNodeIds = unusedUnderscoreErasedTypeNodeIds(rootNode, typeNames)

  const edits: Edit[] = []

  if (typeNames.size > 0) {
    for (const ed of unusedUnderscoreTypedParamEdits(rootNode, typeNames)) {
      edits.push(ed)
    }
  }

  const anySites: SgNode<TSX>[] = []
  for (const name of typeNames) {
    const rx = `^${escapeRx(name)}$`
    for (const node of rootNode.findAll({ rule: { kind: 'type_identifier', regex: rx } })) {
      if (insideImports(node)) {
        continue
      }
      if (skipTypeNodeIds.has(node.id())) {
        continue
      }
      anySites.push(node)
    }
  }

  for (const nsName of namespaceNames) {
    const rx = `^${escapeRx(nsName)}$`
    for (const nid of rootNode.findAll({ rule: { kind: 'nested_type_identifier' } })) {
      if (insideImports(nid)) {
        continue
      }
      const mod = nid.child(0)
      if (mod?.kind() !== 'identifier' || mod.text() !== nsName) {
        continue
      }
      anySites.push(nid)
    }
    for (const mem of rootNode.findAll({
      rule: {
        kind: 'member_expression',
        has: { field: 'object', kind: 'identifier', regex: rx },
      },
    })) {
      if (insideImports(mem)) {
        continue
      }
      anySites.push(mem)
    }
  }

  const todoAnchorsSeen = new Set<number>()
  for (const site of anySites) {
    const anchor = statementAnchorForTodo(site)
    const a0 = anchor.range().start.index
    if (todoAnchorsSeen.has(a0)) {
      continue
    }
    todoAnchorsSeen.add(a0)
    if (!hasTodoSentinel(source, anchor, R4J_NEEDLE)) {
      edits.push(insertTodoBefore(anchor, R4J_MSG, R4J_DOC))
    }
  }

  for (const site of anySites) {
    edits.push(site.replace('any'))
  }

  for (const stmt of imports) {
    edits.push(blankImport(source, stmt))
  }

  if (edits.length === 0) {
    return null
  }
  edits.sort((a, b) => b.startPos - a.startPos)
  return rootNode.commitEdits(edits)
}

export default codemod

/** Type nodes erased by `_param` removal — do not rewrite to `any` / TODO. */
function unusedUnderscoreErasedTypeNodeIds(root: SgNode<TSX>, typeNames: Set<string>): Set<number> {
  const out = new Set<number>()
  const fnKinds = ['function_declaration', 'function_expression', 'arrow_function'] as const
  for (const fk of fnKinds) {
    for (const fn of root.findAll({ rule: { kind: fk } })) {
      const fp = fn.find({ rule: { kind: 'formal_parameters' } })
      if (!fp) {
        continue
      }
      const paramNodes: SgNode<TSX>[] = []
      for (const ch of fp.children()) {
        if (ch.kind() === 'required_parameter' || ch.kind() === 'optional_parameter') {
          paramNodes.push(ch)
        }
      }
      if (paramNodes.length !== 1) {
        continue
      }
      const p = paramNodes[0]
      if (p === undefined) {
        continue
      }
      const nameId = p.find({ rule: { kind: 'identifier' } })
      if (!nameId) {
        continue
      }
      const name = nameId.text()
      if (!/^_[a-zA-Z_]/.test(name)) {
        continue
      }

      const ta = p.find({ rule: { kind: 'type_annotation' } })
      const tid = ta?.find({ rule: { kind: 'type_identifier' } })
      const typeName = tid?.text()
      if (!typeName || !typeNames.has(typeName)) {
        continue
      }

      const body = fn.field('body')
      if (!body) {
        continue
      }
      if (identifierUsedInNodeOutsideRange(body, name, p.range())) {
        continue
      }

      if (tid) {
        out.add(tid.id())
      }
    }
  }
  return out
}

function statementAnchorForTodo(n: SgNode<TSX>): SgNode<TSX> {
  let cur: SgNode<TSX> = n
  for (;;) {
    const par: SgNode<TSX> | null = cur.parent()
    if (!par) {
      return cur
    }
    const pk = par.kind()
    if (pk === 'program' || pk === 'statement_block') {
      return cur
    }
    cur = par
  }
}

function isNextTypesErasureImport(stmt: SgNode<TSX>): boolean {
  const f = parseFrom(stmt)
  if (f === MODULE_TYPES) {
    return true
  }
  if (f === MODULE_NEXT && isTypeOnlyImportStatement(stmt)) {
    return true
  }
  if (f !== null && NEXT_TYPEONLY_SUBPATHS.has(f) && isTypeOnlyImportStatement(stmt)) {
    return true
  }
  return false
}

/** `import type …` / whole statement is type-erased at compile time — safe to map to `any`. */
function isTypeOnlyImportStatement(stmt: SgNode<TSX>): boolean {
  return /^\s*import\s+type\b/.test(stmt.text())
}

function parseFrom(stmt: SgNode<TSX>): string | null {
  const m = stmt.text().match(/from\s*["']([^"']+)["']/)
  return m?.[1] ?? null
}

function extractNamedAndDefaultLocals(stmt: SgNode<TSX>): string[] {
  const locals: string[] = []
  for (const spec of stmt.findAll({ rule: { kind: 'import_specifier' } })) {
    const ids = spec.findAll({ rule: { kind: 'identifier' } })
    if (ids.length === 0) {
      continue
    }
    const localName = ids.length >= 2 ? ids[1]?.text() : ids[0]?.text()
    if (localName !== undefined) {
      locals.push(localName)
    }
  }
  const clause = stmt.find({ rule: { kind: 'import_clause' } })
  if (clause) {
    for (const c of clause.children()) {
      if (c.kind() === 'named_imports' || c.kind() === 'namespace_import') {
        break
      }
      if (c.kind() === 'identifier') {
        locals.push(c.text())
        break
      }
    }
  }
  return locals
}

function unusedUnderscoreTypedParamEdits(root: SgNode<TSX>, typeNames: Set<string>): Edit[] {
  const edits: Edit[] = []
  const fnKinds = ['function_declaration', 'function_expression', 'arrow_function'] as const
  for (const fk of fnKinds) {
    for (const fn of root.findAll({ rule: { kind: fk } })) {
      const fp = fn.find({ rule: { kind: 'formal_parameters' } })
      if (!fp) {
        continue
      }
      const paramNodes: SgNode<TSX>[] = []
      for (const ch of fp.children()) {
        if (ch.kind() === 'required_parameter' || ch.kind() === 'optional_parameter') {
          paramNodes.push(ch)
        }
      }
      if (paramNodes.length !== 1) {
        continue
      }
      const p = paramNodes[0]
      if (p === undefined) {
        continue
      }
      const nameId = p.find({ rule: { kind: 'identifier' } })
      if (!nameId) {
        continue
      }
      const name = nameId.text()
      if (!/^_[a-zA-Z_]/.test(name)) {
        continue
      }

      const ta = p.find({ rule: { kind: 'type_annotation' } })
      const tid = ta?.find({ rule: { kind: 'type_identifier' } })
      const typeName = tid?.text()
      if (!typeName || !typeNames.has(typeName)) {
        continue
      }

      const body = fn.field('body')
      if (!body) {
        continue
      }
      if (identifierUsedInNodeOutsideRange(body, name, p.range())) {
        continue
      }

      edits.push(fp.replace('()'))
    }
  }
  return edits
}

function identifierUsedInNodeOutsideRange(
  scope: SgNode<TSX>,
  name: string,
  exclude: { start: { index: number }; end: { index: number } },
): boolean {
  const rx = `^${escapeRx(name)}$`
  for (const id of scope.findAll({ rule: { kind: 'identifier', regex: rx } })) {
    const r = id.range()
    if (r.start.index >= exclude.start.index && r.end.index <= exclude.end.index) {
      continue
    }
    return true
  }
  return false
}

function blankImport(source: string, stmt: SgNode<TSX>): Edit {
  let start = stmt.range().start.index
  const end = extendImportDeletionEnd(source, stmt.range().end.index)
  while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t')) {
    start--
  }
  return { startPos: start, endPos: end, insertedText: '' }
}

function extendImportDeletionEnd(source: string, stmtEnd: number): number {
  let end = stmtEnd
  while (end < source.length && (source[end] === ' ' || source[end] === '\t')) {
    end++
  }
  if (source[end] === '\r') {
    end++
  }
  if (source[end] === '\n') {
    end++
  }
  if (source[end] === '\r') {
    end++
  }
  if (source[end] === '\n') {
    end++
  }
  return end
}

function escapeRx(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
