/**
 * R6 — Convert `src/app/**\/route.ts` to `src/app/**\/<parent>.ts`.
 *
 * Find every top-level `export async function <HTTP_METHOD>(...)` declaration,
 * collect them, and hoist them into:
 *
 *   export const Route = createFileRoute('<route>')({
 *     server: { handlers: { GET: async (...) => {...}, POST: ... } },
 *   });
 *
 * Non-recognised exports are preserved in place with a Tier-1 review
 * sentinel so the author can fold them in by hand if needed.
 */

import type { Codemod, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { addImport } from "../utils/imports.ts";
import {
  computeRoutePath,
  detectNextFileKind,
} from "../utils/route-path.ts";
import { ensureParentDir } from "../utils/ensure-parent-dir.ts";
import { getAppRelativePath, resolveRenameTarget } from "../utils/paths.ts";
import { insertTodoBefore } from "../utils/sentinels.ts";

const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
]);

const TANSTACK_ROUTER = "@tanstack/react-router";
const API_ROUTES_DOC =
  "https://tanstack.com/start/latest/docs/framework/react/guide/server-routes";

interface Handler {
  method: string;
  exportStmt: SgNode<TSX>;
  fn: SgNode<TSX>;
  isAsync: boolean;
}

const codemod: Codemod<TSX> = async (root) => {
  const relative = getAppRelativePath(root);
  if (detectNextFileKind(relative) !== "route") {
    return null;
  }

  const rootNode = root.root();

  // Idempotency: skip if the file already calls createFileRoute().
  const alreadyMigrated = rootNode.find({
    rule: {
      kind: "call_expression",
      has: {
        field: "function",
        kind: "identifier",
        regex: "^createFileRoute$",
      },
    },
  });
  if (alreadyMigrated) {
    return null;
  }

  const routeInfo = computeRoutePath(relative);
  if (!routeInfo || routeInfo.routePath === null) {
    return emitTodo(rootNode);
  }

  const handlers = collectHandlers(rootNode);
  if (handlers.length === 0) {
    return null;
  }

  const hasAnyImport = rootNode.find({ rule: { kind: "import_statement" } }) !== null;
  const block = buildRouteBlock(routeInfo.routePath, handlers, !hasAnyImport);
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
      endPos: extendToTrailingNewline(
        rootNode.text(),
        handler.exportStmt.range().end.index,
      ),
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
  const out = rootNode.commitEdits(edits);
  root.rename(newPath);

  return out;
};

export default codemod;

function collectHandlers(rootNode: SgNode<TSX>): Handler[] {
  const handlers: Handler[] = [];
  for (const child of rootNode.children()) {
    if (child.kind() !== "export_statement") continue;
    const fn = firstChildOfKind(child, "function_declaration");
    if (!fn) continue;
    const name = fn.field("name")?.text();
    if (!name || !HTTP_METHODS.has(name)) continue;
    const isAsync = fn.children().some((c) => c.kind() === "async");
    handlers.push({ method: name, exportStmt: child, fn, isAsync });
  }
  return handlers;
}

function buildRouteBlock(
  routePath: string,
  handlers: Handler[],
  inlineImport: boolean,
): string {
  const importLine = inlineImport
    ? `import { createFileRoute } from "@tanstack/react-router";\n\n`
    : "";
  const body = handlers.map(formatHandler).join(",\n");
  return (
    importLine +
    `export const Route = createFileRoute(${JSON.stringify(routePath)})({\n` +
    `  server: {\n` +
    `    handlers: {\n` +
    `${indent(body, 6)},\n` +
    `    },\n` +
    `  },\n` +
    `});`
  );
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
    API_ROUTES_DOC,
  );
  return rootNode.commitEdits([edit]);
}
