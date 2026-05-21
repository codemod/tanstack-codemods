/**
 * R4i-bis — Next.js `opengraph-image.tsx` / `twitter-image.tsx` file conventions →
 * TanStack Start `createFileRoute` server `GET` handlers.
 *
 * Example: `app/posts/[slug]/opengraph-image.tsx` → `app/posts/$slug/opengraph.tsx`
 * with route id `/posts/$slug/opengraph`.
 *
 * Depends on R4i (`next/og` → satori) so the default export body already returns a Web
 * `Response`. Removes Next-only `alt` / `contentType` exports and `Props` types that only
 * wrapped `params: Promise<…>`.
 */

import type { Codemod, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { ensureParentDir, pruneEmptyAncestorsAfterRename } from "../utils/ensure-parent-dir.ts";
import { applyOptionalLocaleToMetadataImage } from "../utils/i18n-optional-locale-path.ts";
import {
  getAppRelativePath,
  getFilename,
  inferCodemodTargetDir,
  normalizePath,
  resolveRenameTarget,
} from "../utils/paths.ts";
import { readResolvedI18nConfig } from "../utils/read-next-i18n-config.ts";
import { computeMetadataImageTransform } from "../utils/route-path.ts";
import { rewriteRelativeImportsAfterFileMove } from "../utils/rewrite-relative-imports-after-move.ts";

const TANSTACK_ROUTER = "@tanstack/react-router";

const codemod: Codemod<TSX> = async (root) => {
  const relative = coerceAppRouterRelative(getAppRelativePath(root), getFilename(root));
  let routeInfo = computeMetadataImageTransform(relative);
  if (!routeInfo) return null;

  const pkgRoot = inferCodemodTargetDir(getFilename(root));
  if (readResolvedI18nConfig(pkgRoot)) {
    routeInfo = applyOptionalLocaleToMetadataImage(routeInfo);
  }

  const rootNode = root.root();
  const source0 = rootNode.text();
  if (/\bexport\s+const\s+Route\s*=\s*createFileRoute\s*\(/.test(source0)) {
    return null;
  }

  const defaultExport = findDefaultExportStmt(rootNode);
  if (!defaultExport) return null;

  const fn = extractDefaultAsyncFunction(defaultExport);
  if (!fn) return null;

  const paramNames = pathParamsFromRoutePath(routeInfo.routePath);
  const bodyInner = extractFunctionBodyInner(fn);
  if (bodyInner === null) return null;

  const cleanedBody = stripAwaitParamsDestructures(bodyInner);

  const getSig =
    paramNames.length === 0 ? "async ()" : "async ({ params }: { params: Record<string, string> })";

  const paramPrologue =
    paramNames.length === 0 ? "" : `        const { ${paramNames.join(", ")} } = params;\n`;

  const { importLines, restBlock } = buildPreservedParts(rootNode, defaultExport);
  const needsRouterImport =
    !importLines.join("\n").includes("createFileRoute") &&
    !importLines.join("\n").includes(TANSTACK_ROUTER);
  const routerImport = needsRouterImport
    ? `import { createFileRoute } from "${TANSTACK_ROUTER}";`
    : "";

  const importBlock = mergeRouterImportLine(importLines, routerImport);
  const preserved = [importBlock, restBlock].filter(Boolean).join("\n\n");

  const newFile = `${preserved.trimEnd()}\n\nexport const Route = createFileRoute(${JSON.stringify(routeInfo.routePath)})({\n  server: {\n    handlers: {\n      GET: ${getSig} => {\n${paramPrologue}${indent(dedentCommonMinimum(cleanedBody.trimEnd()), 8)}\n      },\n    },\n  },\n});\n`;

  const newPath = resolveRenameTarget(root, routeInfo.newPath);
  ensureParentDir(newPath);
  const oldAbsPath = getFilename(root);
  const { start, end } = rootNode.range();
  let out = rootNode.commitEdits([
    { startPos: start.index, endPos: end.index, insertedText: newFile },
  ]);
  out = rewriteRelativeImportsAfterFileMove(out, oldAbsPath, newPath);
  root.rename(newPath);
  pruneEmptyAncestorsAfterRename(oldAbsPath);
  return out;
};

export default codemod;

function findDefaultExportStmt(rootNode: SgNode<TSX>): SgNode<TSX> | null {
  for (const stmt of rootNode.children()) {
    if (stmt.kind() !== "export_statement") continue;
    const hasDefault = stmt
      .children()
      .some((c) => c.kind() === "default" || c.text() === "default");
    if (hasDefault) return stmt;
  }
  return null;
}

function extractDefaultAsyncFunction(exportStmt: SgNode<TSX>): SgNode<TSX> | null {
  const exportAsync = exportStmt.children().some((c) => c.kind() === "async");
  for (const child of exportStmt.children()) {
    if (child.kind() !== "function_declaration") continue;
    const fnAsync = exportAsync || child.children().some((c) => c.kind() === "async");
    if (!fnAsync) return null;
    return child;
  }
  return null;
}

function extractFunctionBodyInner(fn: SgNode<TSX>): string | null {
  const body = fn.field("body");
  if (!body || body.kind() !== "statement_block") return null;
  const full = body.text();
  if (!full.startsWith("{") || !full.endsWith("}")) return null;
  return full.slice(1, -1).trim();
}

function pathParamsFromRoutePath(routePath: string): string[] {
  const names: string[] = [];
  const re = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m: RegExpExecArray | null = re.exec(routePath);
  while (m !== null) {
    const cap = m[1];
    if (cap !== undefined) names.push(cap);
    m = re.exec(routePath);
  }
  return names;
}

function stripAwaitParamsDestructures(body: string): string {
  return body
    .replace(/^\s*const\s+\{[^}]*\}\s*=\s*await\s+params\s*;\s*\r?\n/gm, "")
    .replace(/^\s*const\s+\w+\s*=\s*await\s+params\s*;\s*\r?\n/gm, "");
}

function buildPreservedParts(
  rootNode: SgNode<TSX>,
  defaultExport: SgNode<TSX>
): { importLines: string[]; restBlock: string } {
  const skipStart = defaultExport.range().start.index;
  const imports: string[] = [];
  const rest: string[] = [];

  for (const stmt of rootNode.children()) {
    if (stmt.range().start.index === skipStart) continue;

    const raw = stmt.text();
    const t = raw.trimStart();

    if (/^export\s+const\s+alt\s*=/.test(t)) continue;
    if (/^export\s+const\s+contentType\s*=/.test(t)) continue;
    if (/^export\s+type\s+Props\b/.test(t)) continue;
    if (/^type\s+Props\b/.test(t)) continue;
    if (/^export\s+interface\s+Props\b/.test(t)) continue;
    if (/^interface\s+Props\b/.test(t)) continue;

    if (stmt.kind() === "import_statement") {
      imports.push(raw);
    } else {
      rest.push(raw);
    }
  }

  return {
    importLines: imports,
    restBlock: rest.join("\n\n"),
  };
}

function mergeRouterImportLine(importLines: string[], routerLine: string): string {
  if (!routerLine) return importLines.join("\n");
  const relIdx = importLines.findIndex((line) => /\bfrom\s+["']\.\.?[/]/.test(line));
  if (relIdx === -1) {
    return [...importLines, routerLine].join("\n");
  }
  const copy = importLines.slice();
  copy.splice(relIdx, 0, routerLine);
  return copy.join("\n");
}

function dedentCommonMinimum(text: string): string {
  const lines = text.split("\n");
  const nonempty = lines.filter((l) => l.trim().length > 0);
  if (nonempty.length === 0) return text;
  const minIndent = Math.min(...nonempty.map((l) => (l.match(/^\s*/) ?? [""])[0].length));
  return lines.map((l) => (l.trim().length === 0 ? l : l.slice(minIndent))).join("\n");
}

function coerceAppRouterRelative(appRel: string, absFile: string): string {
  const n = normalizePath(appRel);
  if (n.startsWith("src/app/") || n.startsWith("app/")) return n;

  const fromAbs = normalizePath(absFile);
  const srcIdx = fromAbs.lastIndexOf("/src/app/");
  if (srcIdx !== -1) {
    return fromAbs.slice(srcIdx + 1);
  }
  const appIdx = fromAbs.lastIndexOf("/app/");
  if (appIdx !== -1) {
    return fromAbs.slice(appIdx + 1);
  }
  return n;
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${pad}${line}` : line))
    .join("\n");
}
