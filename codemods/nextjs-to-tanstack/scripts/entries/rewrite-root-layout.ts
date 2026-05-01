/**
 * R1 — Convert `src/app/layout.tsx` to `src/app/__root.tsx`.
 *
 * Scope: workflow's `include:` guarantees this script only sees root layouts.
 * The transform:
 *   1. Replaces the default-exported React component with
 *      `export const Route = createRootRoute({ component: RootLayout })` +
 *      a plain `function RootLayout()` whose body contains the rewritten
 *      `<html>` tree (HeadContent, Outlet, Scripts injected).
 *   2. Adds the necessary imports from `@tanstack/react-router` and
 *      `./globals.css?url`.
 *   3. Renames the file to `src/app/__root.tsx`.
 *
 * Explicit non-goals for this step:
 *   - Metadata handling (see R7).
 *   - Non-function default exports (arrow expressions, re-exports). Those are
 *     annotated with a Tier-2 TODO and left alone.
 */

import type { Codemod, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import {
  addDefaultImport,
  addImport,
} from "../utils/imports.ts";
import { ensureParentDir } from "../utils/ensure-parent-dir.ts";
import { getAppRelativePath, resolveRenameTarget } from "../utils/paths.ts";
import { insertTodoBefore } from "../utils/sentinels.ts";

const TANSTACK_ROUTER = "@tanstack/react-router";
const ROOT_ROUTE_DOC =
  "https://tanstack.com/router/latest/docs/framework/react/api/router/createRootRouteFunction";

const codemod: Codemod<TSX> = async (root) => {
  const relative = getAppRelativePath(root);
  if (!/\/layout\.(t|j)sx$|^layout\.(t|j)sx$/.test(relative)) {
    return null;
  }
  const rootNode = root.root();

  const alreadyMigrated = rootNode.find({
    rule: {
      kind: "call_expression",
      has: {
        field: "function",
        kind: "identifier",
        regex: "^createRootRoute$",
      },
    },
  });
  if (alreadyMigrated) {
    return null;
  }

  const defaultExport = findDefaultExport(rootNode);
  if (!defaultExport) return null;

  const fn = findExportedFunction(defaultExport);
  if (!fn) {
    return emitTodo(rootNode, defaultExport);
  }

  const fnName = fn.field("name")?.text() ?? "RootLayout";
  const returnedJsx = findReturnedRootJsx(fn);
  if (!returnedJsx) {
    return emitTodo(rootNode, defaultExport);
  }

  const source = rootNode.text();
  const newJsx = rebuildRootJsx(source, returnedJsx);
  if (!newJsx) {
    return emitTodo(rootNode, defaultExport);
  }

  const edits: Edit[] = [];

  // If the file has no imports yet, `addImport` would insert at position 0,
  // which overlaps our export-replacement edit (also at position 0). Merge
  // the new imports into the replacement text instead.
  const hasAnyImport = rootNode.find({ rule: { kind: "import_statement" } }) !== null;

  const replacement = buildReplacement(fnName, newJsx, hasAnyImport ? "" : PRELUDE_IMPORTS);
  edits.push({
    startPos: defaultExport.range().start.index,
    endPos: defaultExport.range().end.index,
    insertedText: replacement,
  });

  if (hasAnyImport) {
    const importEdits = collectImports(rootNode);
    edits.push(...importEdits);
  }

  const newRelative = relative.replace(/layout\.(t|j)sx$/, "__root.$1sx");
  const target = resolveRenameTarget(root, newRelative);
  ensureParentDir(target);
  const out = rootNode.commitEdits(edits);
  root.rename(target);
  return out;
};

const PRELUDE_IMPORTS =
  `import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";\n` +
  `import appCss from "./globals.css?url";\n\n`;

export default codemod;

function findDefaultExport(rootNode: SgNode<TSX>): SgNode<TSX> | null {
  for (const stmt of rootNode.children()) {
    if (stmt.kind() !== "export_statement") continue;
    for (const child of stmt.children()) {
      if (child.kind() === "default" || child.text() === "default") {
        return stmt;
      }
    }
  }
  return null;
}

function findExportedFunction(exportStmt: SgNode<TSX>): SgNode<TSX> | null {
  for (const child of exportStmt.children()) {
    if (child.kind() === "function_declaration") return child;
  }
  return null;
}

function findReturnedRootJsx(fn: SgNode<TSX>): SgNode<TSX> | null {
  const body = fn.field("body");
  if (!body) return null;
  const ret = body.find({ rule: { kind: "return_statement" } });
  if (!ret) return null;
  for (const child of ret.children()) {
    if (child.kind() === "jsx_element") return child;
    if (child.kind() === "parenthesized_expression") {
      const inner = child.find({ rule: { kind: "jsx_element" } });
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * Rebuild the root `<html>` JSX to include `<HeadContent />` and `<Scripts />`
 * while replacing `{children}` with `<Outlet />`. We operate on the original
 * source text between the opening and closing tags so that any user JSX
 * (providers, scripts, class names, etc.) is preserved verbatim.
 */
function rebuildRootJsx(_source: string, htmlEl: SgNode<TSX>): string | null {
  const source = _source;
  const openEl = directChildByKind(htmlEl, "jsx_opening_element");
  const closeEl = directChildByKind(htmlEl, "jsx_closing_element");
  if (!openEl || !closeEl) return null;
  if (openEl.field("name")?.text() !== "html") return null;

  const bodyEl = findDirectJsxChild(htmlEl, "body");
  if (!bodyEl) return null;

  const bodyOpen = directChildByKind(bodyEl, "jsx_opening_element");
  const bodyClose = directChildByKind(bodyEl, "jsx_closing_element");
  if (!bodyOpen || !bodyClose) return null;

  const innerStart = bodyOpen.range().end.index;
  const innerEnd = bodyClose.range().start.index;
  const originalBody = source.slice(innerStart, innerEnd);

  const bodyInnerRewritten = replaceChildrenWithOutlet(originalBody);
  const normalisedInner = bodyInnerRewritten.trim();
  const bodyContents = normalisedInner.length > 0
    ? `\n        ${normalisedInner}\n        <Scripts />\n      `
    : `\n        <Outlet />\n        <Scripts />\n      `;
  const newBody = `${bodyOpen.text()}${bodyContents}${bodyClose.text()}`;

  // Reconstruct children of <html>: keep everything before <body>, insert/merge
  // <head>, keep everything after <body> (excluding <body> itself, replaced).
  const openText = openEl.text();
  const closeText = closeEl.text();

  const existingHead = findDirectJsxChild(htmlEl, "head");
  const newHeadBlock = existingHead
    ? rebuildHeadWithContent(source, existingHead)
    : `<head>\n        <HeadContent />\n      </head>`;

  const htmlInner = assembleHtmlInner({
    source,
    htmlEl,
    bodyEl,
    existingHead,
    newHeadBlock,
    newBody,
  });

  return `${openText}\n      ${htmlInner}\n    ${closeText}`;
}

function rebuildHeadWithContent(source: string, headEl: SgNode<TSX>): string {
  const openEl = directChildByKind(headEl, "jsx_opening_element");
  const closeEl = directChildByKind(headEl, "jsx_closing_element");
  if (!openEl || !closeEl) return "<head><HeadContent /></head>";

  const innerStart = openEl.range().end.index;
  const innerEnd = closeEl.range().start.index;
  const originalInner = source.slice(innerStart, innerEnd);

  if (/<HeadContent\s*\/>/.test(originalInner)) {
    return headEl.text();
  }
  const trimmed = originalInner.trim();
  const injected = trimmed.length > 0
    ? `\n        <HeadContent />\n        ${trimmed}\n      `
    : `\n        <HeadContent />\n      `;
  return `${openEl.text()}${injected}${closeEl.text()}`;
}

function assembleHtmlInner(args: {
  source: string;
  htmlEl: SgNode<TSX>;
  bodyEl: SgNode<TSX>;
  existingHead: SgNode<TSX> | null;
  newHeadBlock: string;
  newBody: string;
}): string {
  const { htmlEl, bodyEl, existingHead, newHeadBlock, newBody } = args;
  const directChildren = directJsxChildrenOf(htmlEl);

  const parts: string[] = [];
  let headInjected = false;

  for (const child of directChildren) {
    if (existingHead && child.id() === existingHead.id()) {
      parts.push(newHeadBlock);
      headInjected = true;
      continue;
    }
    if (child.id() === bodyEl.id()) {
      if (!headInjected) {
        parts.push(newHeadBlock);
        headInjected = true;
      }
      parts.push(newBody);
      continue;
    }
    if (child.kind() === "jsx_text" && child.text().trim() === "") continue;
    parts.push(child.text());
  }
  if (!headInjected) {
    parts.unshift(newHeadBlock);
  }
  return parts.join("\n      ");
}

function findDirectJsxChild(parent: SgNode<TSX>, tag: string): SgNode<TSX> | null {
  for (const child of parent.children()) {
    if (child.kind() !== "jsx_element") continue;
    const open = directChildByKind(child, "jsx_opening_element");
    if (open?.field("name")?.text() === tag) return child;
  }
  return null;
}

function directChildByKind(parent: SgNode<TSX>, kind: string): SgNode<TSX> | null {
  for (const child of parent.children()) {
    if (child.kind() === kind) return child;
  }
  return null;
}

function directJsxChildrenOf(parent: SgNode<TSX>): SgNode<TSX>[] {
  const result: SgNode<TSX>[] = [];
  for (const child of parent.children()) {
    const k = child.kind();
    if (
      k === "jsx_element" ||
      k === "jsx_self_closing_element" ||
      k === "jsx_text" ||
      k === "jsx_expression" ||
      k === "jsx_fragment"
    ) {
      result.push(child);
    }
  }
  return result;
}

/**
 * Replace the first `{children}` expression with `<Outlet />`. We deliberately
 * do this at the string level on the pre-extracted body-inner slice to keep the
 * rest of the body verbatim; the `{children}` identifier comes from a known
 * source (the Next.js convention), so the AST-level risk of collision is zero.
 */
function replaceChildrenWithOutlet(bodyInner: string): string {
  return bodyInner.replace(/\{\s*children\s*\}/, "<Outlet />");
}

function buildReplacement(
  fnName: string,
  newJsx: string,
  preludeImports: string,
): string {
  return (
    preludeImports +
    `export const Route = createRootRoute({\n  component: ${fnName},\n});\n\n` +
    `function ${fnName}() {\n  return (\n    ${newJsx}\n  );\n}`
  );
}

function collectImports(rootNode: SgNode<TSX>): Edit[] {
  const edits: Edit[] = [];
  const routerImport = addImport(rootNode, {
    type: "named",
    specifiers: [
      { name: "Outlet" },
      { name: "createRootRoute" },
      { name: "HeadContent" },
      { name: "Scripts" },
    ],
    from: TANSTACK_ROUTER,
  });
  if (routerImport) edits.push(routerImport);

  const cssImport = addDefaultImport(rootNode, "./globals.css?url", "appCss");
  if (cssImport) edits.push(cssImport);

  return edits;
}

function emitTodo(rootNode: SgNode<TSX>, defaultExport: SgNode<TSX>): string {
  const edit = insertTodoBefore(
    defaultExport,
    "root layout shape not supported; convert manually to createRootRoute",
    ROOT_ROUTE_DOC,
  );
  return rootNode.commitEdits([edit]);
}
