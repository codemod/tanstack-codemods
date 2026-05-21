/**
 * R8 — Convert files marked with `"use server"` into TanStack Start
 * `createServerFn()` exports.
 *
 *   "use server";
 *
 *   export const create = async (x: Input) => { ... }
 *   export async function remove(id: string) { ... }
 *
 *   becomes:
 *
 *   import { createServerFn } from "@tanstack/react-start";
 *
 *   export const create = createServerFn().handler(async (x: Input) => { ... });
 *   export const remove = createServerFn().handler(async (id: string) => { ... });
 *
 * A concise migration reminder is optionally placed above rewritten exports when
 * the handler accepts runtime parameters — authors can attach a TanStack
 * `.validator(...)` alongside `.handler(...)`.
 */

import type { Codemod, Edit, SgNode } from 'codemod:ast-grep'
import type TSX from 'codemod:ast-grep/langs/tsx'

import { addImport } from '../utils/imports.ts'
import { REVIEW_PREFIX } from '../utils/sentinels.ts'

const TANSTACK_START = '@tanstack/react-start'

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root()

  const directive = findUseServerDirective(rootNode)
  if (!directive) {
    return null
  }

  const edits: Edit[] = []
  const source = rootNode.text()
  const hasAnyImport = rootNode.find({ rule: { kind: 'import_statement' } }) !== null

  // Replace the directive with (optionally) the createServerFn import. This
  // avoids overlapping edits when the directive + import insert both land at
  // position 0.
  const directiveStart = directive.range().start.index
  const directiveEnd = extendToTrailingNewline(source, directive.range().end.index)
  edits.push({
    startPos: directiveStart,
    endPos: directiveEnd,
    insertedText: hasAnyImport ? '' : `import { createServerFn } from "${TANSTACK_START}";\n\n`,
  })

  let rewrittenCount = 0

  for (const stmt of rootNode.children()) {
    if (stmt.kind() !== 'export_statement') {
      continue
    }

    const lex = firstChildOfKind(stmt, 'lexical_declaration') ?? firstChildOfKind(stmt, 'variable_declaration')

    if (lex) {
      const declarator = firstChildOfKind(lex, 'variable_declarator')
      if (!declarator) {
        continue
      }
      const value = declarator.field('value')
      if (!value) {
        continue
      }
      if (!value.is('arrow_function') && !value.is('function_expression')) {
        continue
      }
      const arrowEdits = wrapArrow(stmt, value)
      edits.push(...arrowEdits)
      rewrittenCount++
      continue
    }

    const fn = firstChildOfKind(stmt, 'function_declaration')
    if (fn) {
      const fnEdit = wrapFunctionDeclaration(stmt, fn)
      if (fnEdit) {
        edits.push(fnEdit)
        rewrittenCount++
      }
    }
  }

  if (rewrittenCount === 0) {
    return null
  }

  if (hasAnyImport) {
    const importEdit = addImport(rootNode, {
      type: 'named',
      specifiers: [{ name: 'createServerFn' }],
      from: TANSTACK_START,
    })
    if (importEdit) {
      edits.push(importEdit)
    }
  }

  return rootNode.commitEdits(edits)
}

export default codemod

function findUseServerDirective(rootNode: SgNode<TSX>): SgNode<TSX> | null {
  const first = rootNode.children()[0]
  if (!first) {
    return null
  }
  if (first.kind() !== 'expression_statement') {
    return null
  }
  const inner = first.child(0)
  if (!inner || !inner.is('string')) {
    return null
  }
  const fragment = inner.find({ rule: { kind: 'string_fragment' } })
  if (fragment?.text() !== 'use server') {
    return null
  }
  return first
}

const VALIDATOR_NOTE = 'server handler — add `.validator(...)` before `.handler(...)` when this accepts runtime inputs'

/** True when parentheses contain anything other than pure whitespace */
function paramsNeedValidatorHint(parametersText: string): boolean {
  const t = parametersText.trim()
  if (!(t.startsWith('(') && t.endsWith(')'))) {
    return true
  }
  return t.slice(1, -1).trim().length > 0
}

function validatorLeadLine(anchor: SgNode<TSX>, parameterText: string): string {
  if (!paramsNeedValidatorHint(parameterText)) {
    return ''
  }
  const { column } = anchor.range().start
  const indent = ' '.repeat(column)
  return `${REVIEW_PREFIX}${VALIDATOR_NOTE}\n${indent}`
}

function wrapArrow(exportStmt: SgNode<TSX>, arrow: SgNode<TSX>): Edit[] {
  const parameterText = arrow.field('parameters')?.text() ?? '()'
  const lead = validatorLeadLine(exportStmt, parameterText)

  const edits: Edit[] = []
  if (lead.length > 0) {
    edits.push({
      startPos: exportStmt.range().start.index,
      endPos: exportStmt.range().start.index,
      insertedText: lead,
    })
  }
  edits.push(
    {
      startPos: arrow.range().start.index,
      endPos: arrow.range().start.index,
      insertedText: 'createServerFn().handler(',
    },
    {
      startPos: arrow.range().end.index,
      endPos: arrow.range().end.index,
      insertedText: ')',
    },
  )
  return edits
}

function wrapFunctionDeclaration(exportStmt: SgNode<TSX>, fn: SgNode<TSX>): Edit | null {
  const fnName = fn.field('name')?.text()
  const params = fn.field('parameters')?.text() ?? '()'
  const body = fn.field('body')?.text() ?? '{}'
  if (!fnName) {
    return null
  }

  const isAsync = fn.children().some((c) => c.kind() === 'async')
  const asyncKw = isAsync ? 'async ' : ''

  const reviewLead = validatorLeadLine(exportStmt, params)

  const replacement =
    `${reviewLead}` + `export const ${fnName} = createServerFn().handler(${asyncKw}${params} => ${body});`

  return {
    startPos: exportStmt.range().start.index,
    endPos: exportStmt.range().end.index,
    insertedText: replacement,
  }
}

function firstChildOfKind(parent: SgNode<TSX>, kind: string): SgNode<TSX> | null {
  for (const child of parent.children()) {
    if (child.kind() === kind) {
      return child
    }
  }
  return null
}

function extendToTrailingNewline(source: string, end: number): number {
  if (source.slice(end, end + 2) === '\r\n') {
    return end + 2
  }
  if (source[end] === '\n') {
    return end + 1
  }
  if (source[end] === '\r') {
    return end + 1
  }
  return end
}
