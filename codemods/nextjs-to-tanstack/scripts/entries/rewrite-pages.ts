/**
 * R2 — Convert Next.js `page.tsx` files to their TanStack Start equivalent.
 *
 * Renames every `src/app/**` / `page.(t|j)sx` file using the route-path helper
 * and wraps its default-exported React component in
 * `export const Route = createFileRoute('<path>')({ component: <Name> })`.
 *
 * Structure only: parameter destructuring, metadata, and async data-fetching
 * are handled by later workflow nodes (R3, R7, R10) so this script stays
 * focused on the rename + shape change.
 */

import { writeFileSync, readFileSync } from 'node:fs'

import type { Codemod, Edit, SgNode } from 'codemod:ast-grep'
import type TSX from 'codemod:ast-grep/langs/tsx'

import { ensureParentDir, pruneEmptyAncestorsAfterRename } from '../utils/ensure-parent-dir.ts'
import { applyOptionalLocaleToRoutePathResult } from '../utils/i18n-optional-locale-path.ts'
import { addImport } from '../utils/imports.ts'
import { getAppRelativePath, getFilename, inferCodemodTargetDir, resolveRenameTarget } from '../utils/paths.ts'
import { readResolvedI18nConfig } from '../utils/read-next-i18n-config.ts'
import { rewriteRelativeImportsAfterFileMove } from '../utils/rewrite-relative-imports-after-move.ts'
import {
  computeRoutePath,
  detectNextFileKind,
  stripAppPrefix,
  stripPagesPrefix,
  type RoutePathResult,
} from '../utils/route-path.ts'
import { insertTodoBefore } from '../utils/sentinels.ts'

const TANSTACK_ROUTER = '@tanstack/react-router'
const PAGES_DOC = 'https://tanstack.com/router/latest/docs/framework/react/routing/file-based-routing'

const codemod: Codemod<TSX> = async (root) => {
  const relative = getAppRelativePath(root)
  if (stripAppPrefix(relative)) {
    if (detectNextFileKind(relative) !== 'page') {
      return null
    }
  } else if (stripPagesPrefix(relative)) {
    if (relative.includes('/pages/api/')) {
      return null
    }
    const leaf = relative.split('/').pop() ?? ''
    if (
      /^_(?:app|document|error|middleware)\.(t|j)sx?$/.test(leaf) ||
      (leaf.startsWith('_') && /\.(?:t|j)sx?$/.test(leaf))
    ) {
      return null
    }
  } else {
    return null
  }

  const rootNode = root.root()

  // Idempotency: already converted to createFileRoute.
  const alreadyMigrated = rootNode.find({
    rule: {
      kind: 'call_expression',
      has: {
        field: 'function',
        kind: 'identifier',
        regex: '^createFileRoute$',
      },
    },
  })
  if (alreadyMigrated) {
    return null
  }

  let routeInfo = computeRoutePath(relative, getFilename(root))
  if (!routeInfo || routeInfo.routePath === null) {
    return emitTodo(rootNode)
  }
  const pkgRoot = inferCodemodTargetDir(getFilename(root))
  const i18n = readResolvedI18nConfig(pkgRoot)
  if (i18n) {
    routeInfo = applyOptionalLocaleToRoutePathResult(routeInfo)
  }
  if (routeInfo.routePath === null) {
    return emitTodo(rootNode)
  }

  const defaultExport = findDefaultExport(rootNode)
  if (!defaultExport) {
    return null
  }

  const fn = firstChildOfKind(defaultExport, 'function_declaration')
  if (!fn) {
    // Support `export default IdentifierName` form by inserting a Route
    // declaration that references the identifier. Anything else → TODO.
    const ident = firstChildOfKind(defaultExport, 'identifier')
    if (!ident) {
      return emitTodo(rootNode, defaultExport)
    }
    return wrapIdentifierExport(root, rootNode, defaultExport, ident, routeInfo)
  }

  const fnName = fn.field('name')?.text()
  if (!fnName) {
    return emitTodo(rootNode, defaultExport)
  }

  const edits: Edit[] = []
  const source = rootNode.text()
  const hasAnyImport = rootNode.find({ rule: { kind: 'import_statement' } }) !== null

  const exportStart = defaultExport.range().start.index
  const fnStart = fn.range().start.index
  const fnEnd = fn.range().end.index
  const routeBlock = buildRouteBlock(routeInfo.routePath, fnName)

  // When the file has no imports yet, the export statement starts at
  // position 0. Splitting this into two edits (import at 0, strip prefix at
  // 0..fnStart) produces overlapping edits that commitEdits drops. Instead,
  // merge the whole thing into a single replacement covering the export_statement body.
  if (!hasAnyImport) {
    edits.push({
      startPos: exportStart,
      endPos: fnEnd,
      insertedText: `import { createFileRoute } from "${TANSTACK_ROUTER}";\n\n${source.slice(fnStart, fnEnd)}\n\n${routeBlock}`,
    })
  } else {
    edits.push({
      startPos: exportStart,
      endPos: fnStart,
      insertedText: '',
    })
    edits.push({
      startPos: fnEnd,
      endPos: fnEnd,
      insertedText: `\n\n${routeBlock}`,
    })
    const importEdit = addImport(rootNode, {
      type: 'named',
      specifiers: [{ name: 'createFileRoute' }],
      from: TANSTACK_ROUTER,
    })
    if (importEdit) {
      edits.push(importEdit)
    }
  }

  const newPath = resolveRenameTarget(root, routeInfo.newPath)
  ensureParentDir(newPath)
  const oldAbsPath = getFilename(root)
  let out = rootNode.commitEdits(edits)
  out = rewriteRelativeImportsAfterFileMove(out, oldAbsPath, newPath)
  root.rename(newPath)
  pruneEmptyAncestorsAfterRename(oldAbsPath)
  writeOptionalCatchAllIndex(root, routeInfo.optionalCatchAllRedirect)
  return out
}

export default codemod

function wrapIdentifierExport(
  root: Parameters<Codemod<TSX>>[0],
  rootNode: SgNode<TSX>,
  defaultExport: SgNode<TSX>,
  identifier: SgNode<TSX>,
  routeInfo: RoutePathResult,
): string {
  const name = identifier.text()
  const { routePath } = routeInfo
  if (routePath === null) {
    return rootNode.text()
  }
  const block = buildRouteBlock(routePath, name)
  const edits: Edit[] = []

  edits.push({
    startPos: defaultExport.range().start.index,
    endPos: extendToTrailingNewline(rootNode.text(), defaultExport.range().end.index),
    insertedText: `${block}\n`,
  })

  const hasAnyImport = rootNode.find({ rule: { kind: 'import_statement' } }) !== null
  if (hasAnyImport) {
    const importEdit = addImport(rootNode, {
      type: 'named',
      specifiers: [{ name: 'createFileRoute' }],
      from: TANSTACK_ROUTER,
    })
    if (importEdit) {
      edits.push(importEdit)
    }
  } else {
    edits.push({
      startPos: 0,
      endPos: 0,
      insertedText: `import { createFileRoute } from "${TANSTACK_ROUTER}";\n\n`,
    })
  }

  const renamed = resolveRenameTarget(root, routeInfo.newPath)
  ensureParentDir(renamed)
  const oldAbsPath = getFilename(root)
  let out = rootNode.commitEdits(edits)
  out = rewriteRelativeImportsAfterFileMove(out, oldAbsPath, renamed)
  root.rename(renamed)
  pruneEmptyAncestorsAfterRename(oldAbsPath)
  writeOptionalCatchAllIndex(root, routeInfo.optionalCatchAllRedirect)
  return out
}

function buildRouteBlock(routePath: string, componentName: string): string {
  return `export const Route = createFileRoute(${JSON.stringify(routePath)})({\n  component: ${componentName},\n});`
}

function findDefaultExport(rootNode: SgNode<TSX>): SgNode<TSX> | null {
  for (const stmt of rootNode.children()) {
    if (stmt.kind() !== 'export_statement') {
      continue
    }
    const hasDefault = stmt.children().some((c) => c.kind() === 'default' || c.text() === 'default')
    if (hasDefault) {
      return stmt
    }
  }
  return null
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

function emitTodo(rootNode: SgNode<TSX>, nearNode?: SgNode<TSX>): string {
  const target = nearNode ?? rootNode.children()[0]
  if (!target) {
    return rootNode.text()
  }
  const edit = insertTodoBefore(
    target,
    'page shape was not rewritten — wrap the default export with createFileRoute manually',
    PAGES_DOC,
  )
  return rootNode.commitEdits([edit])
}

function buildOptionalCatchAllIndexSource(indexRoutePath: string, splatRoutePath: string): string {
  return `import { createFileRoute, redirect } from "${TANSTACK_ROUTER}";\n\nexport const Route = createFileRoute(${JSON.stringify(indexRoutePath)})({\n  beforeLoad: () => {\n    throw redirect({\n      to: ${JSON.stringify(splatRoutePath)},\n      params: { _splat: "" },\n    });\n  },\n});\n`
}

function writeOptionalCatchAllIndex(
  root: Parameters<Codemod<TSX>>[0],
  redirectMeta: RoutePathResult['optionalCatchAllRedirect'],
): void {
  if (!redirectMeta) {
    return
  }
  const source = buildOptionalCatchAllIndexSource(redirectMeta.indexRoutePath, redirectMeta.splatRoutePath)
  const abs = resolveRenameTarget(root, redirectMeta.indexNewPath)
  ensureParentDir(abs)
  try {
    if (readFileSync(abs).toString() === source) {
      return
    }
  } catch {
    /* absent or unreadable — fall through */
  }
  writeFileSync(abs, source)
}
