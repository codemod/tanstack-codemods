/**
 * R1 — Convert `src/app/layout.tsx` or `pages/_app.tsx` to `…/app/__root.tsx`.
 *
 * Scope: workflow `include:` for root layouts and the Pages Router shell.
 * The transform:
 *   1. Replaces the default-exported React component with
 *      `export const Route = createRootRoute({ component: RootLayout })` +
 *      a plain `function RootLayout()` whose body contains the rewritten
 *      `<html>` tree (HeadContent, Outlet, Scripts injected), or for
 *      `pages/_app.tsx` rewrites `<Component {...pageProps} />` to `<Outlet />`.
 *   2. Adds the necessary imports from `@tanstack/react-router` and
 *      `globals.css` (or `src/styles/globals.css`, etc.) as a `?url` import.
 *   3. Renames the file to `src/app/__root.tsx` (or `app/__root.tsx`).
 *
 * Explicit non-goals for this step:
 *   - Metadata handling (see R7).
 *   - Default exports that are not `function …` or `hoc(Inner)` where `Inner`
 *     names a top-level `function` (arrow expressions, re-exports, connect()()).
 *     Those are annotated with a Tier-2 TODO and left alone.
 */

import type { Codemod, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { addDefaultImport, addImport } from "../utils/imports.ts";
import { ensureParentDir, pruneEmptyAncestorsAfterRename } from "../utils/ensure-parent-dir.ts";
import {
  getAppRelativePath,
  getFilename,
  inferCodemodTargetDir,
  resolveRenameTarget,
} from "../utils/paths.ts";
import { insertTodoBefore } from "../utils/sentinels.ts";
import { resolveGlobalsCssUrlImport } from "../utils/globals-css-path.ts";
import {
  readResolvedI18nConfig,
  type NextI18nCodemodConfig,
} from "../utils/read-next-i18n-config.ts";

const TANSTACK_ROUTER = "@tanstack/react-router";
const ROOT_ROUTE_DOC =
  "https://tanstack.com/router/latest/docs/framework/react/api/router/createRootRouteFunction";

const codemod: Codemod<TSX> = async (root) => {
  const relative = getAppRelativePath(root);
  const isLayout = /\/layout\.(t|j)sx$|^layout\.(t|j)sx$/.test(relative);
  const isPagesApp = /\/_app\.(t|j)sx$|^_app\.(t|j)sx$/.test(relative);
  if (!isLayout && !isPagesApp) {
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

  const defaultValue = getDefaultExportValue(defaultExport);
  if (!defaultValue) return null;

  const fn = resolveRootLayoutFunction(rootNode, defaultValue);
  if (!fn) {
    return emitTodo(rootNode, defaultExport);
  }

  const fnName = fn.field("name")?.text() ?? "RootLayout";

  const newRelative = isPagesApp
    ? pagesShellToAppRootPath(relative)
    : relative.replace(/layout\.(t|j)sx$/, "__root.$1sx");
  const target = resolveRenameTarget(root, newRelative);
  const globalsUrl = resolveGlobalsCssUrlImport(target, rootNode.text(), getFilename(root));

  if (isPagesApp) {
    return transformPagesAppRoot(
      root,
      rootNode,
      defaultExport,
      fn,
      fnName,
      relative,
      globalsUrl,
      defaultValue.kind() === "call_expression"
    );
  }

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

  const isHocDefault = defaultValue.kind() === "call_expression";
  const replacement = buildReplacement(
    fnName,
    newJsx,
    hasAnyImport ? "" : buildPreludeImports(globalsUrl)
  );
  if (isHocDefault) {
    const start = Math.min(fn.range().start.index, defaultExport.range().start.index);
    const end = Math.max(fn.range().end.index, defaultExport.range().end.index);
    edits.push({
      startPos: start,
      endPos: end,
      insertedText: replacement,
    });
  } else {
    edits.push({
      startPos: defaultExport.range().start.index,
      endPos: defaultExport.range().end.index,
      insertedText: replacement,
    });
  }

  if (hasAnyImport) {
    const importEdits = collectImports(rootNode, globalsUrl);
    edits.push(...importEdits);
  }

  ensureParentDir(target);
  const oldAbsPath = getFilename(root);
  const out = rootNode.commitEdits(edits);
  root.rename(target);
  pruneEmptyAncestorsAfterRename(oldAbsPath);
  return out;
};

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

function getDefaultExportValue(exportStmt: SgNode<TSX>): SgNode<TSX> | null {
  for (const child of exportStmt.children()) {
    const k = child.kind();
    if (k === "export" || k === "default") continue;
    if (k === ";") continue;
    return child;
  }
  return null;
}

function resolveRootLayoutFunction(rootNode: SgNode<TSX>, value: SgNode<TSX>): SgNode<TSX> | null {
  if (value.kind() === "function_declaration") {
    return value;
  }
  if (value.kind() === "call_expression") {
    const inner = unwrapHocCallToFunction(rootNode, value);
    if (inner) return inner;
  }
  return null;
}

function unwrapHocCallToFunction(rootNode: SgNode<TSX>, callExpr: SgNode<TSX>): SgNode<TSX> | null {
  const arg = firstCallArgument(callExpr);
  if (!arg) return null;
  if (arg.kind() === "identifier") {
    return findFunctionDeclarationByName(rootNode, arg.text());
  }
  return null;
}

function firstCallArgument(callExpr: SgNode<TSX>): SgNode<TSX> | null {
  const args = callExpr.field("arguments");
  if (!args) return null;
  for (const c of args.children()) {
    const k = c.kind();
    if (k === "(" || k === ")" || k === ",") continue;
    return c;
  }
  return null;
}

function findFunctionDeclarationByName(rootNode: SgNode<TSX>, name: string): SgNode<TSX> | null {
  for (const stmt of rootNode.children()) {
    if (stmt.kind() !== "function_declaration") continue;
    if (stmt.field("name")?.text() === name) return stmt;
  }
  return null;
}

function buildPreludeImports(globalsUrl: string): string {
  return `import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";\nimport appCss from "${globalsUrl}";\n\n`;
}

function findReturnedRootJsx(fn: SgNode<TSX>): SgNode<TSX> | null {
  const ret = findReturnJsxElement(fn);
  if (!ret) return null;
  const open = directChildByKind(ret, "jsx_opening_element");
  if (open?.field("name")?.text() !== "html") return null;
  return ret;
}

/** First JSX element returned from a function (used for `pages/_app.tsx`). */
function findReturnedAnyJsx(fn: SgNode<TSX>): SgNode<TSX> | null {
  return findReturnJsxElement(fn);
}

function findReturnJsxElement(fn: SgNode<TSX>): SgNode<TSX> | null {
  const body = fn.field("body");
  if (!body) return null;
  const ret = body.find({ rule: { kind: "return_statement" } });
  if (!ret) return null;
  for (const child of ret.children()) {
    if (
      child.kind() === "jsx_element" ||
      child.kind() === "jsx_fragment" ||
      child.kind() === "jsx_self_closing_element"
    ) {
      return child;
    }
    if (child.kind() === "parenthesized_expression") {
      for (const ic of child.children()) {
        if (
          ic.kind() === "jsx_element" ||
          ic.kind() === "jsx_fragment" ||
          ic.kind() === "jsx_self_closing_element"
        ) {
          return ic;
        }
      }
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
  const bodyContents =
    normalisedInner.length > 0
      ? `\n        ${normalisedInner}\n        <Scripts />\n      `
      : "\n        <Outlet />\n        <Scripts />\n      ";
  const newBody = `${bodyOpen.text()}${bodyContents}${bodyClose.text()}`;

  // Reconstruct children of <html>: keep everything before <body>, insert/merge
  // <head>, keep everything after <body> (excluding <body> itself, replaced).
  const openText = openEl.text();
  const closeText = closeEl.text();

  const existingHead = findDirectJsxChild(htmlEl, "head");
  const newHeadBlock = existingHead
    ? rebuildHeadWithContent(source, existingHead)
    : "<head>\n        <HeadContent />\n      </head>";

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
  const injected =
    trimmed.length > 0
      ? `\n        <HeadContent />\n        ${trimmed}\n      `
      : "\n        <HeadContent />\n      ";
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

function buildReplacement(fnName: string, newJsx: string, preludeImports: string): string {
  return `${preludeImports}export const Route = createRootRoute({\n  component: ${fnName},\n});\n\nfunction ${fnName}() {\n  return (\n    ${newJsx}\n  );\n}`;
}

function collectImports(rootNode: SgNode<TSX>, globalsUrl: string): Edit[] {
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

  const cssImport = addDefaultImport(rootNode, globalsUrl, "appCss");
  if (cssImport) edits.push(cssImport);

  return edits;
}

/** `src/pages/_app.tsx` → `src/app/__root.tsx` (and root `pages/` → `app/`). */
function pagesShellToAppRootPath(relative: string): string {
  const withApp = relative.includes("/pages/")
    ? relative.replace(/\/pages\//, "/app/")
    : relative.replace(/^pages\//, "app/");
  return withApp.replace(/_app\.(t|j)sx$/, "__root.$1sx");
}

function rebuildPagesAppJsx(source: string, jsxRoot: SgNode<TSX>): string | null {
  const r = jsxRoot.range();
  const frag = source.slice(r.start.index, r.end.index);
  const next = frag
    .replace(/<Component\s*\{\s*\.\.\.\s*pageProps\s*\}\s*\/>/g, "<Outlet />")
    .replace(/<Component\s*\{\s*\.\.\.\s*pageProps\s*\}\s*>\s*<\/Component>/g, "<Outlet />")
    .replace(/<Component\s*\/>/g, "<Outlet />");
  if (next === frag) {
    return null;
  }
  return next;
}

function transformPagesAppRoot(
  root: Parameters<Codemod<TSX>>[0],
  rootNode: SgNode<TSX>,
  defaultExport: SgNode<TSX>,
  fn: SgNode<TSX>,
  fnName: string,
  relative: string,
  globalsUrl: string,
  isHocDefault: boolean
): string {
  const returnedJsx = findReturnedAnyJsx(fn);
  if (!returnedJsx) {
    return emitTodo(rootNode, defaultExport);
  }
  const source = rootNode.text();
  const newJsx = rebuildPagesAppJsx(source, returnedJsx);
  if (!newJsx) {
    return emitTodo(rootNode, defaultExport);
  }
  const edits: Edit[] = [];
  const hasAnyImport = rootNode.find({ rule: { kind: "import_statement" } }) !== null;
  const prelude = hasAnyImport ? "" : buildPreludeImports(globalsUrl);
  const inner = buildReplacement(fnName, newJsx, prelude);

  if (isHocDefault) {
    const start = Math.min(fn.range().start.index, defaultExport.range().start.index);
    const end = Math.max(fn.range().end.index, defaultExport.range().end.index);
    edits.push({
      startPos: start,
      endPos: end,
      insertedText: inner,
    });
  } else {
    edits.push({
      startPos: defaultExport.range().start.index,
      endPos: defaultExport.range().end.index,
      insertedText: inner,
    });
  }

  if (hasAnyImport) {
    edits.push(...collectImports(rootNode, globalsUrl));
  }
  const newRelative = pagesShellToAppRootPath(relative);
  const target = resolveRenameTarget(root, newRelative);
  ensureParentDir(target);
  const oldAbsPath = getFilename(root);
  let out = rootNode.commitEdits(edits);
  out = stripAppWithTranslationImport(out);
  const cfg = readResolvedI18nConfig(inferCodemodTargetDir(getFilename(root)));
  if (cfg) {
    out = patchNextI18NextDirAttribute(out, cfg);
  }
  root.rename(target);
  pruneEmptyAncestorsAfterRename(oldAbsPath);
  return out;
}

function stripAppWithTranslationImport(source: string): string {
  return source.replace(
    /^\s*import\s+\{\s*appWithTranslation\s*\}\s+from\s+["']next-i18next["']\s*;?\s*\r?\n?/m,
    ""
  );
}

/**
 * `dir={pageProps._nextI18Next?.initialLocale === …}` → pathname-derived locale
 * (Next.js default locale is omitted from the URL; one other locale is usually prefixed).
 */
function patchNextI18NextDirAttribute(source: string, cfg: NextI18nCodemodConfig): string {
  const nonDefault = cfg.locales.find((l) => l !== cfg.defaultLocale);
  if (!nonDefault) return source;
  return source.replace(
    /dir=\{\s*pageProps\._nextI18Next\?\.\s*initialLocale\s*===\s*["']([^"']+)["']\s*\?\s*["']([^"']+)["']\s*:\s*["']([^"']+)["']\s*\}/g,
    (_, ifLocale, thenDir, elseDir) => {
      return `dir={(() => {\n  const p = typeof window === "undefined" ? "" : (window.location.pathname.split("/").filter(Boolean)[0] ?? "");\n  const locale = p === ${JSON.stringify(nonDefault)} ? ${JSON.stringify(nonDefault)} : ${JSON.stringify(cfg.defaultLocale)};\n  return locale === ${JSON.stringify(ifLocale)} ? ${JSON.stringify(thenDir)} : ${JSON.stringify(elseDir)};\n})()}`;
    }
  );
}

function emitTodo(rootNode: SgNode<TSX>, defaultExport: SgNode<TSX>): string {
  const edit = insertTodoBefore(
    defaultExport,
    "root layout shape not supported; convert manually to createRootRoute",
    ROOT_ROUTE_DOC
  );
  return rootNode.commitEdits([edit]);
}
