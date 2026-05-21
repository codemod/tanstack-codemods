/**
 * Remove `next` / `next/*` import statements when every local binding from that
 * statement is unused in the file (identifiers, type identifiers, namespace
 * member bases).
 *
 * Runs after \`rewrite-next-types\` (\`next/types\` + type-only \`import type … from "next"\`) and before R10b TODO annotations so dead imports disappear cleanly.
 */

import type { Codemod, Edit, SgNode } from 'codemod:ast-grep'
import type TSX from 'codemod:ast-grep/langs/tsx'

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root()
  const source = rootNode.text()
  const edits: Edit[] = []

  for (const stmt of rootNode.findAll({ rule: { kind: 'import_statement' } })) {
    const from = parseImportSource(stmt)
    if (from === null || (from !== 'next' && !from.startsWith('next/'))) {
      continue
    }

    const bindings = extractImportBindings(stmt)
    if (bindings.length === 0) {
      continue
    }

    if (bindings.some((b) => isBindingUsed(rootNode, stmt, b))) {
      continue
    }

    let start = stmt.range().start.index
    const end = extendImportDeletionEnd(source, stmt.range().end.index)
    while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t')) {
      start--
    }
    edits.push({ startPos: start, endPos: end, insertedText: '' })
  }

  if (edits.length === 0) {
    return null
  }
  return rootNode.commitEdits(edits)
}

export default codemod

function parseImportSource(stmt: SgNode<TSX>): string | null {
  const m = stmt.text().match(/from\s*["']([^"']+)["']\s*;?/)
  return m?.[1] ?? null
}

function extractImportBindings(stmt: SgNode<TSX>): string[] {
  const locals: string[] = []
  const ns = stmt.find({ rule: { kind: 'namespace_import' } })
  if (ns) {
    const id = ns.find({ rule: { kind: 'identifier' } })
    if (id) {
      locals.push(id.text())
    }
    return locals
  }
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

function isBindingUsed(rootNode: SgNode<TSX>, importStmt: SgNode<TSX>, localName: string): boolean {
  const ir = importStmt.range()
  const rx = `^${escapeRegex(localName)}$`

  for (const kind of ['identifier', 'type_identifier'] as const) {
    for (const m of rootNode.findAll({ rule: { kind, regex: rx } })) {
      const r = m.range()
      if (r.start.index >= ir.start.index && r.end.index <= ir.end.index) {
        continue
      }
      return true
    }
  }

  for (const m of rootNode.findAll({
    rule: {
      kind: 'member_expression',
      has: {
        field: 'object',
        kind: 'identifier',
        regex: rx,
      },
    },
  })) {
    const r = m.range()
    if (r.start.index >= ir.start.index && r.end.index <= ir.end.index) {
      continue
    }
    return true
  }

  return false
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
  // Collapse a single blank line after the import (common style).
  if (source[end] === '\r') {
    end++
  }
  if (source[end] === '\n') {
    end++
  }
  return end
}

function escapeRegex(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
