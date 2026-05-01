/**
 * R7 — Convert `export const metadata` objects into TanStack route `head()` config.
 *
 * Runs on `__root.tsx` and every renamed page file after R1/R2. Locates the
 * `metadata` export, maps its fields through `utils/metadata.ts`, and folds
 * the result into the route config:
 *
 *   export const Route = createRootRoute({ component: X })
 * becomes:
 *   export const Route = createRootRoute({ head: () => ({...}), component: X })
 *
 * The original `export const metadata = {...}` declaration is removed, as is
 * the `import type { Metadata } from "next"` if present.
 *
 * Dynamic / async `generateMetadata` exports are intentionally skipped until a
 * human wires them through `Route` loaders + `head()` — the AST alone cannot
 * faithfully relocate request-time promises.
 */

import type { Codemod, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { removeImport } from "../utils/imports.ts";
import { metadataObjectToHead } from "../utils/metadata.ts";
import { getAppRelativePath } from "../utils/paths.ts";
import { insertReviewBefore } from "../utils/sentinels.ts";

const codemod: Codemod<TSX> = async (root) => {
  const relative = getAppRelativePath(root);
  // Don't touch non-route files (anything outside src/app/).
  if (!relative.includes("/app/") && !relative.startsWith("app/")) {
    return null;
  }

  const rootNode = root.root();

  // Bail on dynamic metadata.
  const generateFn = rootNode.find({
    rule: {
      kind: "function_declaration",
      has: {
        field: "name",
        regex: "^generateMetadata$",
      },
    },
  });
  // Dynamic metadata requires manual coordination with loaders + head().
  if (generateFn) return null;

  const metadataExport = findMetadataExport(rootNode);
  if (!metadataExport) return null;

  const { lex, objNode } = metadataExport;

  const head = metadataObjectToHead(objNode);
  if (head.bail) return null;

  const routeCall = findRouteCallExpression(rootNode);
  if (!routeCall) return null;

  const configObj = findRouteConfigObject(routeCall);
  if (!configObj) return null;

  const edits: Edit[] = [];
  const source = rootNode.text();

  // Inject `head: () => (...)` as the first property in the route config
  // object. We splice right after the opening `{`.
  const firstBrace = source.indexOf("{", configObj.range().start.index);
  if (firstBrace < 0) return null;

  const headLines = head.headOption.replace(/\n/g, "\n    ");
  const indented = `\n    ${headLines},`;

  edits.push({
    startPos: firstBrace + 1,
    endPos: firstBrace + 1,
    insertedText: indented,
  });

  // Remove the metadata declaration and any type import for `Metadata` from "next".
  edits.push({
    startPos: lex.range().start.index,
    endPos: extendToTrailingNewline(source, lex.range().end.index),
    insertedText: "",
  });

  const metadataTypeImport = removeImport(rootNode, {
    type: "named",
    specifiers: ["Metadata"],
    from: "next",
  });
  if (metadataTypeImport) edits.push(metadataTypeImport);

  for (const warning of head.unmapped) {
    edits.push(
      insertReviewBefore(
        routeCall,
        `metadata.${warning} could not be mapped automatically`,
      ),
    );
  }

  return rootNode.commitEdits(edits);
};

export default codemod;

interface MetadataExport {
  /** The enclosing `export_statement` (for full-line removal). */
  lex: SgNode<TSX>;
  /** The metadata object literal. */
  objNode: SgNode<TSX>;
}

function findMetadataExport(rootNode: SgNode<TSX>): MetadataExport | null {
  for (const child of rootNode.children()) {
    if (child.kind() !== "export_statement") continue;
    const decl = firstChildOfKind(child, "lexical_declaration")
      ?? firstChildOfKind(child, "variable_declaration");
    if (!decl) continue;
    const declarator = firstChildOfKind(decl, "variable_declarator");
    if (!declarator) continue;
    const nameNode = declarator.field("name");
    if (nameNode?.text() !== "metadata") continue;
    const value = declarator.field("value");
    if (!value || !value.is("object")) continue;
    return { lex: child, objNode: value };
  }
  return null;
}

function findRouteCallExpression(rootNode: SgNode<TSX>): SgNode<TSX> | null {
  return rootNode.find({
    rule: {
      kind: "call_expression",
      has: {
        field: "function",
        kind: "identifier",
        regex: "^createFileRoute$|^createRootRoute$",
      },
    },
  });
}

function findRouteConfigObject(routeCall: SgNode<TSX>): SgNode<TSX> | null {
  // createFileRoute('path')(config) — the config is inside the second call.
  // createRootRoute(config) — the config is the first argument.
  // Walk upward from routeCall to find the containing call_expression that
  // has a parenthesised object argument.
  let cursor: SgNode<TSX> = routeCall;
  // Ascend through any chained `createFileRoute(...)` pattern.
  while (true) {
    const parent: SgNode<TSX> | null = cursor.parent();
    if (!parent) break;
    if (parent.kind() === "call_expression") {
      cursor = parent;
      continue;
    }
    break;
  }
  const args = cursor.field("arguments");
  if (!args) return null;
  for (const child of args.children()) {
    if (child.kind() === "object") return child;
  }
  return null;
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
