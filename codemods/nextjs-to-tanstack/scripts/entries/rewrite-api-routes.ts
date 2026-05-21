/**
 * R6 — Convert App Router `route.ts` or Pages Router `pages/api/*.ts` into
 * TanStack server route files under `app/**`.
 *
 * App Router: find `export async function <HTTP_METHOD>` and hoist into
 * `createFileRoute` server handlers.
 *
 * Pages Router: named HTTP exports; or default `NextApiRequest`/`NextApiResponse`
 * handlers are converted to `server.handlers` (GET/POST/…) with Web `Response` when the
 * pattern is simple (no unresolved `req.` / `res.` usage). Files under `src/app/api` that cannot
 * be migrated automatically receive the same TODO as `pages/api` routes.
 */

import type { Codemod, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { readFileSync } from "fs";
import { addImport } from "../utils/imports.ts";
import {
  computeRoutePath,
  detectNextFileKind,
  stripAppPrefix,
  stripPagesPrefix,
} from "../utils/route-path.ts";
import { ensureParentDir, pruneEmptyAncestorsAfterRename } from "../utils/ensure-parent-dir.ts";
import { getAppRelativePath, getFilename, resolveRenameTarget } from "../utils/paths.ts";
import {
  extractNextPagesApiDefaultHandlerBodyInner,
  inferDefaultExportPagesApiKind,
  isMultiMethodNextHandler,
  transformNextApiDefaultHandlerBody,
} from "../utils/next-api-default-to-tanstack.ts";
import { insertTodoBefore } from "../utils/sentinels.ts";
import { rewriteRelativeImportsAfterFileMove } from "../utils/rewrite-relative-imports-after-move.ts";

/** TanStack route present and no leftover Next default API handler to migrate. */
function isCompleteApiRouteModule(source: string): boolean {
  if (!/\bexport\s+const\s+Route\s*=\s*createFileRoute\s*\(/.test(source)) {
    return false;
  }
  if (/\bexport\s+default\s+(?:async\s+)?function\s+handler\b/.test(source)) {
    return false;
  }
  return true;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

const TANSTACK_ROUTER = "@tanstack/react-router";
const API_ROUTES_DOC = "https://tanstack.com/start/latest/docs/framework/react/guide/server-routes";

interface Handler {
  method: string;
  exportStmt: SgNode<TSX>;
  fn: SgNode<TSX>;
  isAsync: boolean;
}

/** Best-effort: grab `import … from '…'` blocks without parsing (fallback when AST ops throw). */
function collectNonNextImportsFromSource(source: string): string {
  const parts: string[] = [];
  const re = /\bimport\s+(?:type\s+)?[\s\S]*?\bfrom\s+["']([^"']+)["']\s*;?/g;
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    const mod = m[1] ?? "";
    if (mod === "next" || mod.startsWith("next/")) {
      continue;
    }
    parts.push(m[0].replace(/;?\s*$/, "").trim());
    m = re.exec(source);
  }
  return parts.join("\n");
}

/**
 * When the QuickJS/JSSG runtime fails on very large API modules (deep template literals),
 * rewrite the default Next.js API handler using plain `fs` + string transforms.
 */
function migrateDefaultExportPagesApiViaFs(
  root: Parameters<Codemod<TSX>>[0],
  routeInfo: NonNullable<ReturnType<typeof computeRoutePath>>,
  isPagesApi: boolean,
  appApiLeaf: boolean
): string | null {
  if (!isPagesApi && !appApiLeaf) {
    return null;
  }
  const abs = getFilename(root);
  let source: string;
  try {
    source = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  if (isCompleteApiRouteModule(source)) {
    return null;
  }
  const bodyInner = extractNextPagesApiDefaultHandlerBodyInner(source);
  if (!bodyInner) {
    return null;
  }
  if (!/NextApiRequest/.test(source) || !/NextApiResponse/.test(source)) {
    return null;
  }
  const kind = inferDefaultExportPagesApiKind(bodyInner);
  if (kind === "GET" && isMultiMethodNextHandler(bodyInner)) {
    return null;
  }
  const routePath = routeInfo.routePath;
  if (!routePath) {
    return null;
  }
  const hasPathParams = /\$[a-zA-Z0-9_]/.test(routePath);
  const transformed = transformNextApiDefaultHandlerBody(bodyInner, { hasPathParams }, kind);
  if (/\bres\./.test(transformed) || /\breq\./.test(transformed)) {
    return null;
  }
  const imports = collectNonNextImportsFromSource(source);
  const usesRequest = /\brequest\./.test(transformed) || kind === "POST";
  const usesParams = hasPathParams && /\bparams\./.test(transformed);
  let handlerParams = "()";
  if (usesParams && usesRequest) {
    handlerParams = "({ request, params }: { request: Request; params: Record<string, string> })";
  } else if (usesParams) {
    handlerParams = "({ params }: { params: Record<string, string> })";
  } else if (usesRequest) {
    handlerParams = "({ request }: { request: Request })";
  }
  const httpMethod = kind === "POST" ? "POST" : "GET";
  const asyncKw = kind === "POST" || /\bawait\b/.test(transformed) ? "async " : "";
  const newFile = `${imports ? `${imports}\n\n` : ""}import { createFileRoute } from "@tanstack/react-router";\n\nexport const Route = createFileRoute(${JSON.stringify(routePath)})({\n  server: {\n    handlers: {\n      ${httpMethod}: ${asyncKw}${handlerParams} => {\n${indent(transformed, 8)}\n      },\n    },\n  },\n});\n`;
  const newPath = resolveRenameTarget(root, routeInfo.newPath);
  ensureParentDir(newPath);
  const oldAbsPath = getFilename(root);
  root.rename(newPath);
  pruneEmptyAncestorsAfterRename(oldAbsPath);
  return rewriteRelativeImportsAfterFileMove(newFile, abs, newPath);
}

function rewriteApiRoutesAst(
  root: Parameters<Codemod<TSX>>[0],
  _relative: string,
  routeInfo: NonNullable<ReturnType<typeof computeRoutePath>>,
  isPagesApi: boolean,
  appApiLeaf: boolean
): string | null {
  const rootNode = root.root();
  const source0 = rootNode.text();

  if (isCompleteApiRouteModule(source0)) {
    return null;
  }

  const handlers = collectHandlers(rootNode);
  if (handlers.length === 0) {
    const migrated = tryMigrateDefaultExportPagesApi(root, rootNode, routeInfo);
    if (migrated !== null) {
      return migrated;
    }
    if (isPagesApi || appApiLeaf) {
      return migratePagesApiWithTodo(root, rootNode, routeInfo);
    }
    return null;
  }

  const hasAnyImport = rootNode.find({ rule: { kind: "import_statement" } }) !== null;
  const routePath = routeInfo.routePath;
  if (!routePath) return null;
  const block = buildRouteBlock(routePath, handlers, !hasAnyImport);
  const edits: Edit[] = [];

  const firstExport = handlers[0]?.exportStmt;
  if (!firstExport) return null;

  edits.push({
    startPos: firstExport.range().start.index,
    endPos: firstExport.range().start.index,
    insertedText: `${block}\n\n`,
  });

  for (const handler of handlers) {
    edits.push({
      startPos: handler.exportStmt.range().start.index,
      endPos: extendToTrailingNewline(rootNode.text(), handler.exportStmt.range().end.index),
      insertedText: "",
    });
  }

  if (hasAnyImport) {
    const importEdit = addImport(rootNode, {
      type: "named",
      specifiers: [{ name: "createFileRoute" }],
      from: TANSTACK_ROUTER,
    });
    if (importEdit) edits.push(importEdit);
  }

  const newPath = resolveRenameTarget(root, routeInfo.newPath);
  ensureParentDir(newPath);
  const oldAbsPath = getFilename(root);
  let out = rootNode.commitEdits(edits);
  out = rewriteRelativeImportsAfterFileMove(out, oldAbsPath, newPath);
  root.rename(newPath);
  pruneEmptyAncestorsAfterRename(oldAbsPath);

  return out;
}

const codemod: Codemod<TSX> = async (root) => {
  const relative = getAppRelativePath(root);
  const isPagesApi = Boolean(stripPagesPrefix(relative)) && relative.includes("/pages/api/");
  const appApiLeaf = isAppApiLeafModule(relative);
  if (!isPagesApi && !appApiLeaf && detectNextFileKind(relative) !== "route") {
    return null;
  }

  const routeInfo = computeRoutePath(relative);
  if (!routeInfo || routeInfo.routePath === null) {
    try {
      return emitTodo(root.root());
    } catch {
      return null;
    }
  }

  try {
    return rewriteApiRoutesAst(root, relative, routeInfo, isPagesApi, appApiLeaf);
  } catch {
    return migrateDefaultExportPagesApiViaFs(root, routeInfo, isPagesApi, appApiLeaf);
  }
};

export default codemod;

function isAppApiLeafModule(relative: string): boolean {
  const split = stripAppPrefix(relative);
  if (!split) return false;
  const { rest } = split;
  if (rest.length < 2 || rest[0] !== "api") return false;
  const leaf = rest.at(-1) ?? "";
  if (/^route\.(t|j)sx?$/.test(leaf)) return false;
  return /\.(m|c)?tsx?$|\.(m)?ts$/.test(leaf);
}

function getDefaultExportValue(exportStmt: SgNode<TSX>): SgNode<TSX> | null {
  for (const child of exportStmt.children()) {
    const k = child.kind();
    if (k === "export" || k === "default") continue;
    if (k === ";") continue;
    return child;
  }
  return null;
}

function normalizeDefaultExportFn(exportStmt: SgNode<TSX>): SgNode<TSX> | null {
  const v = getDefaultExportValue(exportStmt);
  if (!v) return null;
  if (v.kind() === "function_declaration") return v;
  if (v.kind() === "arrow_function") return v;
  if (v.kind() === "parenthesized_expression") {
    const inner = v.children().find((c) => c.kind() === "arrow_function") ?? null;
    if (inner) return inner;
  }
  return null;
}

function findExportWithDefaultFn(rootNode: SgNode<TSX>): SgNode<TSX> | null {
  for (const stmt of rootNode.children()) {
    if (stmt.kind() !== "export_statement") continue;
    if (!stmt.text().includes("default")) continue;
    if (normalizeDefaultExportFn(stmt)) return stmt;
  }
  return null;
}

function looksLikeNextPagesApiHandler(fn: SgNode<TSX>, fileSource: string): boolean {
  const paramText = fn.field("parameters")?.text() ?? "";
  if (/NextApiRequest/.test(paramText) && /NextApiResponse/.test(paramText)) {
    return true;
  }
  return /NextApiRequest/.test(fileSource) && /NextApiResponse/.test(fileSource);
}

function collectNonNextImports(rootNode: SgNode<TSX>): string {
  const parts: string[] = [];
  for (const stmt of rootNode.children()) {
    if (stmt.kind() !== "import_statement") continue;
    const text = stmt.text();
    if (/from\s*["']next["']/.test(text)) continue;
    if (/from\s*["']next\//.test(text)) continue;
    parts.push(text);
  }
  return parts.join("\n");
}

function tryMigrateDefaultExportPagesApi(
  root: Parameters<Codemod<TSX>>[0],
  rootNode: SgNode<TSX>,
  routeInfo: NonNullable<ReturnType<typeof computeRoutePath>>
): string | null {
  const source = rootNode.text();
  const exportStmt = findExportWithDefaultFn(rootNode);
  if (!exportStmt) return null;
  const fn = normalizeDefaultExportFn(exportStmt);
  if (!fn) return null;
  if (fn.kind() !== "function_declaration" && fn.kind() !== "arrow_function") {
    return null;
  }
  if (!looksLikeNextPagesApiHandler(fn, source)) return null;

  const bodyNode = fn.field("body");
  if (!bodyNode || bodyNode.kind() !== "statement_block") return null;
  const bodyText = bodyNode?.text() ?? "{}";
  const bodyInner =
    bodyText.startsWith("{") && bodyText.endsWith("}") ? bodyText.slice(1, -1).trim() : bodyText;

  const kind = inferDefaultExportPagesApiKind(bodyInner);
  if (kind === "GET" && isMultiMethodNextHandler(bodyInner)) return null;

  const routePath = routeInfo.routePath;
  if (!routePath) return null;

  const hasPathParams = /\$[a-zA-Z0-9_]/.test(routePath);
  const transformed = transformNextApiDefaultHandlerBody(bodyInner, { hasPathParams }, kind);

  if (/\bres\./.test(transformed) || /\breq\./.test(transformed)) {
    return null;
  }

  const imports = collectNonNextImports(rootNode);
  const usesRequest = /\brequest\./.test(transformed) || kind === "POST";
  const usesParams = hasPathParams && /\bparams\./.test(transformed);

  let handlerParams = "()";
  if (usesParams && usesRequest) {
    handlerParams = "({ request, params }: { request: Request; params: Record<string, string> })";
  } else if (usesParams) {
    handlerParams = "({ params }: { params: Record<string, string> })";
  } else if (usesRequest) {
    handlerParams = "({ request }: { request: Request })";
  }

  const httpMethod = kind === "POST" ? "POST" : "GET";
  const asyncKw = kind === "POST" || /\bawait\b/.test(transformed) ? "async " : "";

  const newFile = `${imports ? `${imports}\n\n` : ""}import { createFileRoute } from "@tanstack/react-router";\n\nexport const Route = createFileRoute(${JSON.stringify(routePath)})({\n  server: {\n    handlers: {\n      ${httpMethod}: ${asyncKw}${handlerParams} => {\n${indent(transformed, 8)}\n      },\n    },\n  },\n});\n`;

  const newPath = resolveRenameTarget(root, routeInfo.newPath);
  ensureParentDir(newPath);
  const oldAbsPath = getFilename(root);
  const { start, end } = rootNode.range();
  const out = rootNode.commitEdits([
    { startPos: start.index, endPos: end.index, insertedText: newFile },
  ]);
  const fixed = rewriteRelativeImportsAfterFileMove(out, oldAbsPath, newPath);
  root.rename(newPath);
  pruneEmptyAncestorsAfterRename(oldAbsPath);
  return fixed;
}

function collectHandlers(rootNode: SgNode<TSX>): Handler[] {
  const handlers: Handler[] = [];
  for (const child of rootNode.children()) {
    if (child.kind() !== "export_statement") continue;
    const fromFn = handlerFromFunctionMethodExport(child);
    if (fromFn) {
      handlers.push(fromFn);
      continue;
    }
    const fromConst = handlerFromConstMethodExport(child);
    if (fromConst) handlers.push(fromConst);
  }
  return handlers;
}

/** `export async function GET(...) { ... }` / `export function POST(...)`. */
function handlerFromFunctionMethodExport(exportStmt: SgNode<TSX>): Handler | null {
  const fn = firstChildOfKind(exportStmt, "function_declaration");
  if (!fn) return null;
  const name = fn.field("name")?.text();
  if (!name || !HTTP_METHODS.has(name)) return null;
  const isAsync = fn.children().some((c) => c.kind() === "async");
  return { method: name, exportStmt, fn, isAsync };
}

/**
 * App / Pages routes sometimes use `export const POST = async (req, res) => { … }`.
 * Treat like a named HTTP export so we hoist instead of fragile fallbacks.
 */
function handlerFromConstMethodExport(exportStmt: SgNode<TSX>): Handler | null {
  const lex =
    firstChildOfKind(exportStmt, "lexical_declaration") ??
    firstChildOfKind(exportStmt, "variable_declaration");
  if (!lex) return null;
  const declarator = firstChildOfKind(lex, "variable_declarator");
  if (!declarator) return null;
  const nameNode = declarator.field("name");
  if (!nameNode || nameNode.kind() !== "identifier") return null;
  const method = nameNode.text();
  if (!HTTP_METHODS.has(method)) return null;
  const value = declarator.field("value");
  if (!value) return null;
  const fn = normalizeCallableHttpHandlerValue(value);
  if (!fn) return null;
  const isAsync = fn.children().some((c) => c.kind() === "async");
  return { method, exportStmt, fn, isAsync };
}

function normalizeCallableHttpHandlerValue(value: SgNode<TSX>): SgNode<TSX> | null {
  if (value.kind() === "arrow_function" || value.kind() === "function_expression") {
    return value;
  }
  if (value.kind() === "parenthesized_expression") {
    const inner =
      value
        .children()
        .find((c) => c.kind() === "arrow_function" || c.kind() === "function_expression") ?? null;
    return inner;
  }
  return null;
}

function buildRouteBlock(routePath: string, handlers: Handler[], inlineImport: boolean): string {
  const importLine = inlineImport
    ? `import { createFileRoute } from "@tanstack/react-router";\n\n`
    : "";
  const body = handlers.map(formatHandler).join(",\n");
  return `${importLine}export const Route = createFileRoute(${JSON.stringify(routePath)})({\n  server: {\n    handlers: {\n${indent(body, 6)},\n    },\n  },\n});`;
}

function formatHandler(handler: Handler): string {
  const params = handler.fn.field("parameters")?.text() ?? "()";
  const body = handler.fn.field("body")?.text() ?? "{}";
  const asyncKw = handler.isAsync ? "async " : "";
  return `${handler.method}: ${asyncKw}${params} => ${body}`;
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${pad}${line}` : line))
    .join("\n");
}

function firstChildOfKind(parent: SgNode<TSX>, kind: string): SgNode<TSX> | null {
  for (const child of parent.children()) {
    if (child.kind() === kind) return child;
  }
  return null;
}

function extendToTrailingNewline(source: string, end: number): number {
  let i = end;
  while (i < source.length) {
    const ch = source[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "\n") {
      i++;
      break;
    }
    if (ch === "\r") {
      i++;
      if (source[i] === "\n") i++;
      break;
    }
    break;
  }
  // Consume additional blank lines that follow (up to the next non-blank).
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\n" || ch === "\r" || ch === " " || ch === "\t") {
      i++;
      continue;
    }
    break;
  }
  return i;
}

function emitTodo(rootNode: SgNode<TSX>): string {
  const firstChild = rootNode.children()[0];
  if (!firstChild) return rootNode.text();
  const edit = insertTodoBefore(
    firstChild,
    "route.ts path could not be mapped to a TanStack route — migrate by hand",
    API_ROUTES_DOC
  );
  return rootNode.commitEdits([edit]);
}

function migratePagesApiWithTodo(
  root: Parameters<Codemod<TSX>>[0],
  rootNode: SgNode<TSX>,
  routeInfo: NonNullable<ReturnType<typeof computeRoutePath>>
): string {
  const firstChild = rootNode.children()[0];
  if (!firstChild) return rootNode.text();
  const edit = insertTodoBefore(
    firstChild,
    "Next.js pages/api route — convert the handler to TanStack Start server route handlers (Web Request/Response)",
    API_ROUTES_DOC
  );
  const newPath = resolveRenameTarget(root, routeInfo.newPath);
  ensureParentDir(newPath);
  const oldAbsPath = getFilename(root);
  const out = rootNode.commitEdits([edit]);
  const fixed = rewriteRelativeImportsAfterFileMove(out, oldAbsPath, newPath);
  root.rename(newPath);
  pruneEmptyAncestorsAfterRename(oldAbsPath);
  return fixed;
}
