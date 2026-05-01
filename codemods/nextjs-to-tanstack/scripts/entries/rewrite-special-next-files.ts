/**
 * Migrates Next.js App Router auxiliary routes — `loading.tsx`, `error.tsx`,
 * `not-found.tsx`, and annotated `template.tsx` — using patterns from the
 * standalone `next2tanstack` codemod.
 *
 * - `loading.tsx` → `-pending.tsx` with `createFileRoute(...)({ pendingComponent })`
 * - `error.tsx` → `-error.tsx` with `errorComponent`
 * - `not-found.tsx` → `-not-found.tsx` with `notFoundComponent`
 * - `template.tsx` → review comment only (no direct TanStack analogue)
 */

import type { Codemod, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { addImport } from "../utils/imports.ts";
import { ensureParentDir } from "../utils/ensure-parent-dir.ts";
import { getAppRelativePath, resolveRenameTarget } from "../utils/paths.ts";
import {
  classifySpecialRouteFileBasename,
  computeSpecialRouteFileTransform,
} from "../utils/route-path.ts";
import { hasReviewSentinel, insertReviewBefore } from "../utils/sentinels.ts";

const TANSTACK_ROUTER = "@tanstack/react-router";
const TEMPLATE_RE = /^template\.(t|j)sx?$/;

const codemod: Codemod<TSX> = async (root) => {
  const relative = getAppRelativePath(root);
  const base = relative.split("/").at(-1) ?? relative;

  if (TEMPLATE_RE.test(base)) {
    return annotateTemplate(root);
  }

  if (!classifySpecialRouteFileBasename(base)) return null;

  const routeInfo = computeSpecialRouteFileTransform(relative);
  if (!routeInfo) return null;

  const rootNode = root.root();

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
  if (alreadyMigrated) return null;

  const defaultExport = findDefaultExport(rootNode);
  if (!defaultExport) return null;

  const fn = firstChildOfKind(defaultExport, "function_declaration");
  if (!fn) return null;

  const fnName = fn.field("name")?.text();
  if (!fnName) return null;

  const edits: Edit[] = [];
  const source = rootNode.text();
  const hasAnyImport = rootNode.find({ rule: { kind: "import_statement" } }) !== null;

  const exportStart = defaultExport.range().start.index;
  const fnStart = fn.range().start.index;
  const fnEnd = fn.range().end.index;
  const routeBlock = buildSpecialRouteBlock(
    routeInfo.routePath,
    fnName,
    routeInfo.routeOptionProperty,
  );

  if (!hasAnyImport) {
    edits.push({
      startPos: exportStart,
      endPos: fnEnd,
      insertedText:
        `import { createFileRoute } from "${TANSTACK_ROUTER}";\n\n` +
        source.slice(fnStart, fnEnd) +
        `\n\n${routeBlock}`,
    });
  } else {
    edits.push({
      startPos: exportStart,
      endPos: fnStart,
      insertedText: "",
    });
    edits.push({
      startPos: fnEnd,
      endPos: fnEnd,
      insertedText: `\n\n${routeBlock}`,
    });
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

function annotateTemplate(root: Parameters<Codemod<TSX>>[0]): string | null {
  const relative = getAppRelativePath(root);
  if (/api\//.test(relative)) return null;

  const rootNode = root.root();
  const source = rootNode.text();
  const firstStmt = rootNode.children()[0];
  if (!firstStmt) return null;
  if (hasReviewSentinel(source, firstStmt, "template.tsx")) return null;

  const edit = insertReviewBefore(
    firstStmt,
    "Next.js template.tsx has no direct TanStack Start equivalent — refactor manually",
  );
  return rootNode.commitEdits([edit]);
}

function buildSpecialRouteBlock(
  routePath: string,
  componentName: string,
  routeOptionProperty: "pendingComponent" | "errorComponent" | "notFoundComponent",
): string {
  return (
    `export const Route = createFileRoute(${JSON.stringify(routePath)})({\n` +
    `  ${routeOptionProperty}: ${componentName},\n` +
    `});`
  );
}

function findDefaultExport(rootNode: SgNode<TSX>): SgNode<TSX> | null {
  for (const stmt of rootNode.children()) {
    if (stmt.kind() !== "export_statement") continue;
    const hasDefault = stmt.children().some((c) => c.kind() === "default" || c.text() === "default");
    if (hasDefault) return stmt;
  }
  return null;
}

function firstChildOfKind(parent: SgNode<TSX>, kind: string): SgNode<TSX> | null {
  for (const child of parent.children()) {
    if (child.kind() === kind) return child;
  }
  return null;
}
