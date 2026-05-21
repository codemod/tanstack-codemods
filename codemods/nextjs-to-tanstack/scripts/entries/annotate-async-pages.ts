/**
 * R10 — Move sequential top-level `await` data fetching from async route components
 * into `createFileRoute({ … }).loader`, and wire the component with
 * `Route.useLoaderData()` (TanStack Router data loading).
 *
 * Safe subset: a `function` / block-bodied `component:` arrow whose body is a single
 * `return` preceded only by `const`/`let` declarations (simple identifier bindings),
 * `expression_statement`s (e.g. `console.log`, `await axios.get(...)`), and empty
 * statements — no JSX, no React hook calls, and no `if`/`for`/`try`/etc. Every
 * top-level `await` in the component must live in that prefix (everything before
 * `return`). Two or more `const`/`let` bindings in that block produce
 * `return { … }` from `loader` and `const { … } = Route.useLoaderData()`.
 * Expression-only loaders (no bindings) return `{}` and omit `useLoaderData`.
 * Nested `await` inside inner functions still does not count as top-level.
 */

import type { Codemod, Edit, SgNode } from 'codemod:ast-grep'
import type TSX from 'codemod:ast-grep/langs/tsx'
import { useMetricAtom } from 'codemod:metrics'

import { tanstackRouterNamedImportCommaFixEdits } from '../utils/imports.ts'
import { utf16IndexToUtf8ByteOffset, utf8ByteOffsetToUtf16Index } from '../utils/js-string-utf8-offsets.ts'
import { bumpR10, relPathUnderPkg } from '../utils/migration-run-report.ts'
import { getFilename } from '../utils/paths.ts'
import { hasTodoSentinel, insertTodoBefore } from '../utils/sentinels.ts'
import {
  closingBraceIndexOfObjectLiteral,
  objectLiteralNeedsCommaAfterLastProperty,
  objectLiteralOpenBraceIndex,
} from '../utils/tsx-object-literal.ts'

const LOADER_DOC = 'https://tanstack.com/router/latest/docs/framework/react/guide/data-loading'

const TODO_NEEDLE = 'Route.loader'

const r10Metric = useMetricAtom('nextjs-to-tanstack-r10-async-await')

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root()
  const source = rootNode.text()

  if (!/\bcreateFileRoute\b/.test(source)) {
    return null
  }

  const file = getFilename(root)
  if (/\/middleware\.tsx?$/i.test(file)) {
    return null
  }

  const candidates = collectAsyncRouteComponents(rootNode)

  const edits: Edit[] = []
  for (const configObj of collectCreateFileRouteConfigObjects(rootNode)) {
    if (!getObjectPairValue(configObj, 'loader')) {
      continue
    }
    const repair = stripStandaloneCommaLineBeforeLoaderEdit(source, configObj)
    if (repair) {
      edits.push(repair)
    }
  }
  if (candidates.length === 0) {
    if (edits.length === 0) {
      return null
    }
    edits.push(...tanstackRouterNamedImportCommaFixEdits(rootNode))
    edits.sort((a, b) => b.startPos - a.startPos)
    return rootNode.commitEdits(edits)
  }

  for (const { fn, configObj } of candidates) {
    if (!functionBodyUsesTopLevelAwait(fn)) {
      continue
    }

    if (getObjectPairValue(configObj, 'loader')) {
      if (!hasTodoSentinel(source, fn, TODO_NEEDLE)) {
        edits.push(
          insertTodoBefore(
            fn,
            `move async data fetching into ${TODO_NEEDLE} (or a server function); avoid heavy awaits in route components`,
            LOADER_DOC,
            ' - ',
          ),
        )
      }
      continue
    }

    const migrated = tryBuildLoaderMigrationEdits(source, fn, configObj)
    if (migrated && migrated.length > 0) {
      edits.push(...migrated)
      r10Metric.increment({ file: relPathUnderPkg(file) }, 1)
      continue
    }

    if (hasTodoSentinel(source, fn, TODO_NEEDLE)) {
      continue
    }

    edits.push(
      insertTodoBefore(
        fn,
        `move async data fetching into ${TODO_NEEDLE} (or a server function); avoid heavy awaits in route components`,
        LOADER_DOC,
        ' - ',
      ),
    )
  }

  edits.push(...tanstackRouterNamedImportCommaFixEdits(rootNode))

  if (edits.length === 0) {
    return null
  }

  const absFile = getFilename(root)
  const todoCount = edits.filter((e) => e.insertedText?.includes(TODO_NEEDLE)).length
  if (todoCount > 0) {
    bumpR10(absFile, todoCount)
    r10Metric.increment({ file: relPathUnderPkg(absFile) }, todoCount)
  }

  edits.sort((a, b) => b.startPos - a.startPos)
  return rootNode.commitEdits(edits)
}

export default codemod

interface RouteCandidate {
  fn: SgNode<TSX>
  configObj: SgNode<TSX>
}

function collectAsyncRouteComponents(rootNode: SgNode<TSX>): RouteCandidate[] {
  const seen = new Set<number>()
  const out: RouteCandidate[] = []

  const innerCalls = rootNode.findAll({
    rule: {
      kind: 'call_expression',
      has: {
        field: 'function',
        kind: 'identifier',
        regex: '^createFileRoute$',
      },
    },
  })

  for (const inner of innerCalls) {
    const parent = inner.parent()
    if (parent?.kind() !== 'call_expression') {
      continue
    }
    const configObj = getSingleObjectArg(parent)
    if (!configObj) {
      continue
    }
    const comp = getObjectPairValue(configObj, 'component')
    if (!comp) {
      continue
    }
    const fn = resolveAsyncComponentFunction(rootNode, comp)
    if (!fn) {
      continue
    }
    const id = fn.id()
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    out.push({ fn, configObj })
  }

  return out
}

/** Every `createFileRoute(...)({ ... })` config object (deduped by node id). */
function collectCreateFileRouteConfigObjects(rootNode: SgNode<TSX>): SgNode<TSX>[] {
  const seen = new Set<number>()
  const out: SgNode<TSX>[] = []

  const innerCalls = rootNode.findAll({
    rule: {
      kind: 'call_expression',
      has: {
        field: 'function',
        kind: 'identifier',
        regex: '^createFileRoute$',
      },
    },
  })

  for (const inner of innerCalls) {
    const parent = inner.parent()
    if (parent?.kind() !== 'call_expression') {
      continue
    }
    const configObj = getSingleObjectArg(parent)
    if (!configObj) {
      continue
    }
    const id = configObj.id()
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    out.push(configObj)
  }

  return out
}

/**
 * Removes a mistaken extra line that is only a comma between the last property and
 * `loader:` (bug from an older R10 insert when a trailing comma was already present).
 *
 * Uses a `createFileRoute(…) ({ … })`–anchored regex on `source` (UTF-16 indices) and
 * converts span boundaries to UTF-8 byte offsets for `commitEdits`.
 */
function stripStandaloneCommaLineBeforeLoaderEdit(source: string, configObj: SgNode<TSX>): Edit | null {
  if (!getObjectPairValue(configObj, 'loader')) {
    return null
  }
  const re =
    /(\bcreateFileRoute\s*\([^)]*\)\s*\(\s*\{\s*\n\s*component:\s*[A-Za-z_$][\w$]*\s*,)(\s*\r?\n\s*,\s*\r?\n)(\s*loader\s*:)/
  const m = re.exec(source)
  if (m?.[1] === undefined || m[2] === undefined) {
    return null
  }
  const startUtf16 = m.index + m[1].length
  const endUtf16 = startUtf16 + m[2].length
  return {
    startPos: utf16IndexToUtf8ByteOffset(source, startUtf16),
    endPos: utf16IndexToUtf8ByteOffset(source, endUtf16),
    insertedText: '\n',
  }
}

function resolveAsyncComponentFunction(rootNode: SgNode<TSX>, value: SgNode<TSX>): SgNode<TSX> | null {
  if (value.kind() === 'identifier') {
    const fn = findFunctionDeclaration(rootNode, value.text())
    if (fn && isAsyncFunctionNode(fn)) {
      return fn
    }
    return null
  }
  if (value.kind() === 'arrow_function' || value.kind() === 'function_expression') {
    return isAsyncFunctionNode(value) ? value : null
  }
  return null
}

function findFunctionDeclaration(rootNode: SgNode<TSX>, name: string): SgNode<TSX> | null {
  for (const fn of rootNode.findAll({ rule: { kind: 'function_declaration' } })) {
    const nameNode = fn.field('name')
    if (nameNode?.text() === name) {
      return fn
    }
  }
  return null
}

function isAsyncFunctionNode(n: SgNode<TSX>): boolean {
  return n.children().some((c) => c.kind() === 'async')
}

function getSingleObjectArg(call: SgNode<TSX>): SgNode<TSX> | null {
  const args = extractCallArgs(call)
  if (args.length !== 1) {
    return null
  }
  const a = args[0]
  return a?.kind() === 'object' ? a : null
}

function extractCallArgs(call: SgNode<TSX>): SgNode<TSX>[] {
  const list = call.field('arguments')
  if (!list) {
    return []
  }
  const out: SgNode<TSX>[] = []
  for (const ch of list.children()) {
    if (ch.kind() === '(' || ch.kind() === ')' || ch.kind() === ',') {
      continue
    }
    out.push(ch)
  }
  return out
}

function getObjectPair(obj: SgNode<TSX>, wantKey: string): SgNode<TSX> | null {
  for (const pair of obj.findAll({ rule: { kind: 'pair' } })) {
    if (pair.parent()?.id() !== obj.id()) {
      continue
    }
    const keyNode = pair.field('key')
    const keyText =
      keyNode?.kind() === 'property_identifier'
        ? keyNode.text()
        : (keyNode?.text().replaceAll(/['"]/g, '').trim() ?? '')
    if (keyText !== wantKey) {
      continue
    }
    return pair
  }
  return null
}

function getObjectPairValue(obj: SgNode<TSX>, wantKey: string): SgNode<TSX> | null {
  return getObjectPair(obj, wantKey)?.field('value') ?? null
}

function functionBodyUsesTopLevelAwait(fn: SgNode<TSX>): boolean {
  const body = fn.field('body')
  if (!body) {
    return false
  }

  const awaited = body.findAll({
    rule: {
      kind: 'await_expression',
    },
  })

  for (const aw of awaited) {
    if (awaitDepthWithinAsyncBoundary(aw, fn) === 0) {
      return true
    }
  }
  return false
}

function awaitDepthWithinAsyncBoundary(node: SgNode<TSX>, stopAncestor: SgNode<TSX>): number {
  let depth = 0
  let cur: SgNode<TSX> | null = node.parent()
  while (cur && cur.id() !== stopAncestor.id()) {
    const kind = cur.kind()
    if (kind === 'arrow_function' || kind === 'function_expression' || kind === 'function_declaration') {
      depth++
    }
    cur = cur.parent()
  }
  return depth
}

/**
 * Remove a prior `// TODO: … Route.loader …` line (and its trailing newline) found
 * immediately above blank lines before `fn`, so re-runs after an older codemod can
 * still apply loader extraction.
 */
function removePriorRouteLoaderTodoEdit(source: string, fn: SgNode<TSX>): Edit | null {
  let lineStart = findLineStart(source, utf8ByteOffsetToUtf16Index(source, fn.range().start.index))
  for (let depth = 0; depth < 10; depth++) {
    const above = lineRangeAbove(source, lineStart)
    if (!above) {
      return null
    }
    const { ls, lineEnd } = above
    const trimmed = source.slice(ls, lineEnd).trim()
    if (trimmed === '') {
      lineStart = ls
      continue
    }
    if (trimmed.startsWith('// TODO:') && trimmed.includes(TODO_NEEDLE)) {
      const endExclusive = lineEnd < source.length ? lineEnd + 1 : lineEnd
      return {
        startPos: utf16IndexToUtf8ByteOffset(source, ls),
        endPos: utf16IndexToUtf8ByteOffset(source, endExclusive),
        insertedText: '',
      }
    }
    return null
  }
  return null
}

function findLineStart(source: string, idx: number): number {
  const nl = source.lastIndexOf('\n', idx - 1)
  return nl === -1 ? 0 : nl + 1
}

/** The line strictly above the line that starts at `currentLineStart`. */
function lineRangeAbove(source: string, currentLineStart: number): { ls: number; lineEnd: number } | null {
  if (currentLineStart === 0) {
    return null
  }
  const prevEnd = currentLineStart - 1
  if (source[prevEnd] !== '\n') {
    return null
  }
  const ls = findLineStart(source, prevEnd)
  const nl = source.indexOf('\n', ls)
  const lineEnd = nl === -1 ? source.length : nl
  return { ls, lineEnd }
}

function tryBuildLoaderMigrationEdits(source: string, fn: SgNode<TSX>, configObj: SgNode<TSX>): Edit[] | null {
  const body = fn.field('body')
  if (body?.kind() !== 'statement_block') {
    return null
  }

  const split = splitLoaderBlockBeforeReturn(body)
  if (!split || split.loaderStmts.length === 0) {
    return null
  }
  const { loaderStmts, ret } = split

  if (!declaratorsAreSimpleBindings(loaderStmts)) {
    return null
  }

  for (const aw of ret.findAll({ rule: { kind: 'await_expression' } })) {
    if (awaitDepthWithinAsyncBoundary(aw, fn) === 0) {
      return null
    }
  }

  for (const aw of body.findAll({ rule: { kind: 'await_expression' } })) {
    if (awaitDepthWithinAsyncBoundary(aw, fn) !== 0) {
      continue
    }
    if (!loaderStmts.some((stmt) => rangeContainsNode(stmt, aw))) {
      return null
    }
  }

  for (const s of loaderStmts) {
    for (const aw of s.findAll({ rule: { kind: 'await_expression' } })) {
      if (awaitDepthWithinAsyncBoundary(aw, fn) !== 0) {
        return null
      }
    }
  }

  const declared = collectDeclaredNames(loaderStmts)
  if (declared.length === 0 && !loaderBlockHasTopLevelAwait(loaderStmts, fn)) {
    return null
  }

  const declSet = new Set(declared)
  const usedInSuffix = new Set<string>()
  for (const id of collectIdentifiersUsedFromOuterBindings(ret, declSet)) {
    usedInSuffix.add(id)
  }

  const ordered = usedInSuffix.size > 0 ? declared.filter((n) => usedInSuffix.has(n)) : [...declared]

  /** Two+ declarations in the loader block → always return a loader object (fetch + json chain, etc.). */
  const exportKeys = declared.length >= 2 ? declared : ordered
  if (declared.length > 0 && exportKeys.length === 0) {
    return null
  }

  const loaderReturn =
    exportKeys.length === 0
      ? 'return {};'
      : exportKeys.length === 1
        ? `return ${exportKeys[0] ?? ''};`
        : `return { ${exportKeys.join(', ')} };`

  const loaderBodyLines = loaderStmts.map((s: SgNode<TSX>) => s.text().trimEnd())
  const loaderInner = [...loaderBodyLines, loaderReturn].join('\n')

  const objOpenIdx = objectLiteralOpenBraceIndex(source, configObj)
  const closeBrace = closingBraceIndexOfObjectLiteral(source, configObj)
  if (closeBrace === null) {
    return null
  }

  const baseIndent = indentForNode(source, objOpenIdx)
  const configSlice = source.slice(objOpenIdx, closeBrace + 1)
  const pairIndentMatch = /\n(\s+)component\s*:/.exec(configSlice)
  const pairIndent = pairIndentMatch?.[1] ?? `${baseIndent}  `
  const loaderInnerIndent = `${pairIndent}  `
  const loaderIndented = loaderInner
    .split('\n')
    .map((line) => (line.length > 0 ? `${loaderInnerIndent}${line}` : ''))
    .join('\n')

  let needsComma = objectLiteralNeedsCommaAfterLastProperty(source, configObj, closeBrace)
  /** AST scan can miss a trailing comma on `component:` in very large TSX; never insert `,` before `loader:` when that line already ends with `,`. */
  const configTail = source.slice(Math.max(0, closeBrace - 4096), closeBrace)
  if (/\bcomponent\s*:\s*[A-Za-z_$][\w$]*\s*,\s*$/m.test(configTail.trimEnd())) {
    needsComma = false
  }

  const hookLine =
    exportKeys.length === 0
      ? ''
      : exportKeys.length === 1
        ? `const ${exportKeys[0] ?? ''} = Route.useLoaderData();`
        : `const { ${exportKeys.join(', ')} } = Route.useLoaderData();`

  const firstLoader = loaderStmts[0]
  const lastLoader = loaderStmts.at(-1)
  if (firstLoader === undefined || lastLoader === undefined) {
    return null
  }
  const loader0 = utf8ByteOffsetToUtf16Index(source, firstLoader.range().start.index)
  const leadingStart = source.lastIndexOf('\n', loader0 - 1) + 1
  let leadingEnd = utf8ByteOffsetToUtf16Index(source, lastLoader.range().end.index)
  if (source.slice(leadingEnd, leadingEnd + 2) === '\r\n') {
    leadingEnd += 2
  } else if (source[leadingEnd] === '\n') {
    leadingEnd += 1
  }
  leadingEnd = Math.min(leadingEnd, utf8ByteOffsetToUtf16Index(source, ret.range().start.index))
  const stmtIndent = indentForNode(source, loader0)
  const hookText = hookLine ? `${stmtIndent}${hookLine}\n` : ''

  const edits: Edit[] = []

  const loaderInsert = `${needsComma ? ',' : ''}\n${pairIndent}loader: async () => {\n${loaderIndented}\n${pairIndent}},\n`
  edits.push({
    startPos: utf16IndexToUtf8ByteOffset(source, closeBrace),
    endPos: utf16IndexToUtf8ByteOffset(source, closeBrace),
    insertedText: loaderInsert,
  })

  const stripTodo = removePriorRouteLoaderTodoEdit(source, fn)
  const fnStartU16 = utf8ByteOffsetToUtf16Index(source, fn.range().start.index)
  const fnLineStart = findLineStart(source, fnStartU16)
  const fnDeclIndent = source.slice(fnLineStart, fnStartU16)
  const fnName = fn.field('name')?.text() ?? 'Page'

  if (stripTodo && stripTodo.startPos < utf16IndexToUtf8ByteOffset(source, leadingStart)) {
    const mergedOpen = `${fnDeclIndent}function ${fnName}() {\n${hookText}`
    edits.push({
      startPos: stripTodo.startPos,
      endPos: utf16IndexToUtf8ByteOffset(source, leadingEnd),
      insertedText: mergedOpen,
    })
  } else {
    edits.push({
      startPos: utf16IndexToUtf8ByteOffset(source, leadingStart),
      endPos: utf16IndexToUtf8ByteOffset(source, leadingEnd),
      insertedText: hookText,
    })

    const asyncKw = findAsyncKeyword(fn)
    if (asyncKw) {
      const asyncStart = utf8ByteOffsetToUtf16Index(source, asyncKw.range().start.index)
      const end = utf8ByteOffsetToUtf16Index(source, asyncKw.range().end.index)
      const eatSpace = source[end] === ' ' ? end + 1 : end
      edits.push({
        startPos: utf16IndexToUtf8ByteOffset(source, asyncStart),
        endPos: utf16IndexToUtf8ByteOffset(source, eatSpace),
        insertedText: '',
      })
    }
  }

  return edits
}

function findAsyncKeyword(fn: SgNode<TSX>): SgNode<TSX> | null {
  for (const ch of fn.children()) {
    if (ch.kind() === 'async') {
      return ch
    }
  }
  return null
}

function indentForNode(source: string, index: number): string {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1
  const lineEnd = source.indexOf('\n', index)
  const line = lineEnd === -1 ? source.slice(lineStart) : source.slice(lineStart, lineEnd)
  const m = /^(\s*)/.exec(line)
  return m?.[1] ?? ''
}

function statementBlockStatements(block: SgNode<TSX>): SgNode<TSX>[] {
  return block.children().filter((c) => {
    const k = c.kind()
    return k !== '{' && k !== '}'
  })
}

const ALLOWED_LOADER_STMT_KINDS = new Set(['lexical_declaration', 'expression_statement', 'empty_statement'])

function splitLoaderBlockBeforeReturn(block: SgNode<TSX>): { loaderStmts: SgNode<TSX>[]; ret: SgNode<TSX> } | null {
  const stmts = statementBlockStatements(block)
  let retIndex = -1
  for (let i = stmts.length - 1; i >= 0; i--) {
    if (stmts[i]?.kind() === 'return_statement') {
      retIndex = i
      break
    }
  }
  if (retIndex === -1) {
    return null
  }
  const ret = stmts[retIndex]
  if (ret === undefined) {
    return null
  }
  const loaderStmts = stmts.slice(0, retIndex)
  if (loaderStmts.length === 0) {
    return null
  }

  for (const s of loaderStmts) {
    if (!ALLOWED_LOADER_STMT_KINDS.has(s.kind())) {
      return null
    }
    if (statementContainsJsx(s)) {
      return null
    }
    if (statementContainsReactHookCall(s)) {
      return null
    }
  }

  return { loaderStmts, ret }
}

function loaderBlockHasTopLevelAwait(loaderStmts: SgNode<TSX>[], fn: SgNode<TSX>): boolean {
  for (const s of loaderStmts) {
    for (const aw of s.findAll({ rule: { kind: 'await_expression' } })) {
      if (awaitDepthWithinAsyncBoundary(aw, fn) === 0) {
        return true
      }
    }
  }
  return false
}

function statementContainsJsx(stmt: SgNode<TSX>): boolean {
  const stack: SgNode<TSX>[] = [stmt]
  while (stack.length > 0) {
    const n = stack.pop()
    if (n === undefined) {
      break
    }
    const k = n.kind()
    if (k === 'jsx_element' || k === 'jsx_self_closing_element' || k === 'jsx_fragment') {
      return true
    }
    for (const c of n.children()) {
      stack.push(c)
    }
  }
  return false
}

function statementContainsReactHookCall(stmt: SgNode<TSX>): boolean {
  for (const call of stmt.findAll({ rule: { kind: 'call_expression' } })) {
    const fnNode = call.field('function')
    if (fnNode?.kind() === 'identifier' && /^use[A-Z]/.test(fnNode.text())) {
      return true
    }
  }
  return false
}

function rangeContainsNode(ancestor: SgNode<TSX>, inner: SgNode<TSX>): boolean {
  const ar = ancestor.range()
  const ir = inner.range()
  return ir.start.index >= ar.start.index && ir.end.index <= ar.end.index
}

function declaratorsAreSimpleBindings(leading: SgNode<TSX>[]): boolean {
  for (const s of leading) {
    if (s.kind() !== 'lexical_declaration') {
      continue
    }
    for (const d of s.findAll({ rule: { kind: 'variable_declarator' } })) {
      const name = d.field('name')
      if (!name?.is('identifier')) {
        return false
      }
    }
  }
  return true
}

function collectDeclaredNames(leading: SgNode<TSX>[]): string[] {
  const names: string[] = []
  for (const s of leading) {
    if (s.kind() !== 'lexical_declaration') {
      continue
    }
    for (const d of s.findAll({ rule: { kind: 'variable_declarator' } })) {
      const name = d.field('name')
      if (name?.is('identifier')) {
        names.push(name.text())
      }
    }
  }
  return names
}

/**
 * Identifiers in `node` that refer to `outerBindings` (not shadowed by params /
 * inner functions). Used for the `return` when deciding which loader keys the
 * component still needs via `Route.useLoaderData()`.
 */
function collectIdentifiersUsedFromOuterBindings(node: SgNode<TSX>, outerBindings: Set<string>): Set<string> {
  const used = new Set<string>()

  function walk(n: SgNode<TSX>, locals: Set<string>) {
    const k = n.kind()

    if (k === 'arrow_function' || k === 'function_expression') {
      const params = collectParamNames(n)
      const next = new Set([...locals, ...params])
      const sub = n.field('body')
      if (sub) {
        walk(sub, next)
      }
      return
    }

    if (k === 'function_declaration') {
      const name = n.field('name')?.text()
      const params = collectParamNames(n)
      const next = new Set([...locals, ...params, ...(name ? [name] : [])])
      const sub = n.field('body')
      if (sub) {
        walk(sub, next)
      }
      return
    }

    if (k === 'identifier') {
      const t = n.text()
      if (outerBindings.has(t) && !locals.has(t)) {
        used.add(t)
      }
      return
    }

    for (const ch of n.children()) {
      walk(ch, locals)
    }
  }

  walk(node, new Set())
  return used
}

function collectParamNames(fnLike: SgNode<TSX>): string[] {
  const params = fnLike.field('parameters')
  if (!params) {
    return []
  }
  const names: string[] = []
  for (const ch of params.children()) {
    if (ch.kind() === 'required_parameter' || ch.kind() === 'optional_parameter') {
      const id = firstBindingIdentifierInParameter(ch)
      if (id) {
        names.push(id)
      }
    }
  }
  return names
}

function firstBindingIdentifierInParameter(param: SgNode<TSX>): string | null {
  for (const c of param.children()) {
    if (c.kind() === 'identifier') {
      return c.text()
    }
    if (c.kind() === 'assignment_pattern') {
      const left = c.field('left')
      if (left?.is('identifier')) {
        return left.text()
      }
    }
  }
  return null
}
