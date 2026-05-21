/**
 * R3 — Rewrite Next.js dynamic route parameter destructures to TanStack
 * Route hooks.
 *
 * Runs on files already renamed by R2 (`src/app/**` / `*.tsx`, minus
 * `__root.tsx`). Scopes itself to files whose basename or path contains a
 * `$`-prefixed segment (i.e. is a dynamic or catch-all route); static pages
 * are silent no-ops.
 *
 * Transform:
 *   async function Page({ params }: { params: Promise<{ slug: string }> }) {
 *     const { slug } = await params;
 *     ...
 *   }
 * becomes:
 *   function Page() {
 *     const { slug } = Route.useParams();
 *     ...
 *   }
 *
 * For catch-all files (`$.tsx`), the destructured key is rewritten to
 * `_splat` — only when the original Next code used a single identifier. A
 * non-trivial destructure emits a short migration reminder.
 *
 * TanStack reference: splat / catch-all — https://tanstack.com/router/latest/docs/framework/react/routing/routing-concepts#splat--catch-all-routes
 */

import type { Codemod, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { getAppRelativePath } from "../utils/paths.ts";
import { insertReviewBefore } from "../utils/sentinels.ts";

const PARAMS_NAMES = ["params", "searchParams"] as const;

const codemod: Codemod<TSX> = async (root) => {
  const relative = getAppRelativePath(root);
  if (relative.endsWith("/__root.tsx") || /\/__root\.tsx?$/.test(relative)) {
    return null;
  }

  const rootNode = root.root();

  const pageFn = findPageComponentFunction(rootNode);
  if (!pageFn) return null;

  const source = rootNode.text();
  const edits: Edit[] = [];

  const { paramKind, paramEdits } = stripNextParamDestructure(pageFn, source);
  edits.push(...paramEdits);

  const awaitKind = new Map<string, "params" | "searchParams">();
  if (paramKind.has("params")) awaitKind.set("params", "params");
  if (paramKind.has("searchParams")) awaitKind.set("searchParams", "searchParams");

  // Orphaned `await params` / `await searchParams` inside the route component body
  // after the formal params were stripped (or when awaits appear only nested in calls
  // / spreads). Without this pass, `$slug.tsx`-style pages keep `await params` with no
  // binding and TypeScript collapses entirely.
  for (const name of PARAMS_NAMES) {
    if (awaitKind.has(name)) continue;
    if (countAwaitsOf(pageFn, name) > 0) {
      awaitKind.set(name, name === "searchParams" ? "searchParams" : "params");
    }
  }

  const isCatchAll = /\/\$\.tsx?$/.test(relative);

  let removedAwaits = 0;
  for (const [varName, kind] of awaitKind) {
    const awaitEdits = rewriteAwaitStatements(pageFn, varName, kind, isCatchAll, rootNode, source);
    edits.push(...awaitEdits);
    removedAwaits += countAwaitsOf(pageFn, varName);
  }

  // If every await in the body targeted params/searchParams, the function is
  // effectively synchronous now — strip the `async` keyword to match the
  // migration guide's target shape.
  const totalAwaits = pageFn.findAll({ rule: { kind: "await_expression" } }).length;
  const asyncKw = pageFn.children().find((c) => c.kind() === "async");
  if (asyncKw && totalAwaits === removedAwaits) {
    const src = rootNode.text();
    const range = asyncKw.range();
    let end = range.end.index;
    while (end < src.length && src[end] === " ") end++;
    edits.push({ startPos: range.start.index, endPos: end, insertedText: "" });
  }

  if (edits.length === 0) return null;
  return rootNode.commitEdits(edits);
};

function countAwaitsOf(fn: SgNode<TSX>, identName: string): number {
  return fn.findAll({
    rule: {
      kind: "await_expression",
      has: {
        kind: "identifier",
        regex: `^${identName}$`,
      },
    },
  }).length;
}

export default codemod;

function findPageComponentFunction(rootNode: SgNode<TSX>): SgNode<TSX> | null {
  // Resolve the identifier referenced by `createFileRoute(...)({ component: X })`.
  // Match the `component` property pair directly so we don't confuse it with a
  // local identifier of the same name elsewhere.
  const pair = rootNode.find({
    rule: {
      kind: "pair",
      has: {
        field: "key",
        regex: "^component$",
      },
      inside: {
        stopBy: "end",
        kind: "call_expression",
        has: {
          field: "function",
          any: [
            { kind: "identifier", regex: "^createFileRoute$" },
            {
              kind: "call_expression",
              has: {
                field: "function",
                kind: "identifier",
                regex: "^createFileRoute$",
              },
            },
          ],
        },
      },
    },
  });
  if (!pair) return null;
  const valueNode = pair.field("value");
  if (!valueNode) return null;
  const componentName = valueNode.text();

  for (const child of rootNode.children()) {
    if (child.kind() === "function_declaration") {
      if (child.field("name")?.text() === componentName) return child;
    }
  }
  return null;
}

interface ParamStripResult {
  paramKind: Set<"params" | "searchParams">;
  paramEdits: Edit[];
}

function stripNextParamDestructure(fn: SgNode<TSX>, _source: string): ParamStripResult {
  const paramKind = new Set<"params" | "searchParams">();
  const paramEdits: Edit[] = [];
  void _source;

  const formal = fn.field("parameters");
  if (!formal) return { paramKind, paramEdits };

  const requiredParams = formal.findAll({ rule: { kind: "required_parameter" } });
  for (const param of requiredParams) {
    const pattern = firstChildOfKind(param, "object_pattern");
    if (!pattern) continue;
    const keysFound: ("params" | "searchParams")[] = [];
    for (const keyNode of collectDestructureKeys(pattern)) {
      if ((PARAMS_NAMES as readonly string[]).includes(keyNode)) {
        keysFound.push(keyNode as "params" | "searchParams");
      }
    }
    if (keysFound.length === 0) continue;

    const patternKeys = collectDestructureKeys(pattern);
    const onlyNextKeys = patternKeys.every((k) => (PARAMS_NAMES as readonly string[]).includes(k));

    if (onlyNextKeys) {
      for (const k of keysFound) paramKind.add(k);
      paramEdits.push(param.replace("()"));
      // Leave the rest of formal_parameters unchanged; ast-grep replace
      // substitutes just the matched node.
      // But formal_parameters wraps the required_parameter with `(` and `)`;
      // replacing with `()` would result in `(())`. Instead we must target
      // the entire formal_parameters range.
      paramEdits.pop();
      paramEdits.push({
        startPos: formal.range().start.index,
        endPos: formal.range().end.index,
        insertedText: "()",
      });
    } else {
      // Mixed destructure (user also receives unrelated props) — can't safely
      // strip. Leave a review sentinel but don't rewrite the signature.
      paramEdits.push(
        insertReviewBefore(
          fn,
          "mixed destructure in page signature — verify Route.useParams() / Route.useSearch() usage by hand"
        )
      );
      for (const k of keysFound) paramKind.add(k);
    }
    break;
  }

  return { paramKind, paramEdits };
}

function collectDestructureKeys(pattern: SgNode<TSX>): string[] {
  const keys: string[] = [];
  for (const child of pattern.children()) {
    if (child.kind() === "shorthand_property_identifier_pattern") {
      keys.push(child.text());
    } else if (child.kind() === "pair_pattern") {
      const key = child.field("key");
      if (key) keys.push(key.text());
    }
  }
  return keys;
}

function firstChildOfKind(parent: SgNode<TSX>, kind: string): SgNode<TSX> | null {
  for (const child of parent.children()) {
    if (child.kind() === kind) return child;
  }
  return null;
}

function rewriteAwaitStatements(
  fn: SgNode<TSX>,
  varName: string,
  kind: "params" | "searchParams",
  isCatchAll: boolean,
  rootNode: SgNode<TSX>,
  source: string
): Edit[] {
  const edits: Edit[] = [];
  const handledDeclaratorAwaitIds = new Set<number>();

  // Match: `const { ... } = await <varName>;`
  const declarations = fn.findAll({
    rule: {
      kind: "variable_declarator",
      has: {
        field: "value",
        kind: "await_expression",
        has: {
          kind: "identifier",
          regex: `^${varName}$`,
        },
      },
    },
  });

  const hookName = kind === "searchParams" ? "Route.useSearch()" : "Route.useParams()";

  for (const decl of declarations) {
    const value = decl.field("value");
    if (!value) continue;
    if (isCatchAll && kind === "params") {
      const pattern = firstChildOfKind(decl, "object_pattern");
      if (pattern) {
        const keys = collectDestructureKeys(pattern);
        if (keys.length === 1) {
          const oldKey = keys[0];
          edits.push(pattern.replace("{ _splat }"));
          if (oldKey && oldKey !== "_splat") {
            edits.push(...rewriteCatchAllJoinedParamRefs(fn, oldKey));
            if (needsCatchAllArrayAliasAfterJoinRewrite(fn, oldKey, decl)) {
              edits.push(...insertCatchAllArrayAliasAfterDeclarator(decl, oldKey, source));
            }
          }
        } else {
          edits.push(
            insertReviewBefore(
              decl,
              "catch-all route destructure had multiple keys — rewrite to { _splat } by hand"
            )
          );
        }
      }
    }
    edits.push(value.replace(hookName));
    handledDeclaratorAwaitIds.add(value.id());
  }
  void rootNode;

  // Match: `const foo = await <varName>;`
  const declsSimple = fn.findAll({
    rule: {
      kind: "variable_declarator",
      has: {
        field: "name",
        kind: "identifier",
      },
      all: [
        {
          has: {
            field: "value",
            kind: "await_expression",
            has: {
              kind: "identifier",
              regex: `^${varName}$`,
            },
          },
        },
      ],
    },
  });
  for (const decl of declsSimple) {
    const value = decl.field("value");
    if (!value) continue;
    edits.push(value.replace(hookName));
    handledDeclaratorAwaitIds.add(value.id());
  }

  // Nested / argument-position awaits: `foo(await params)`, spreads, chains, …
  const bareAwaits = fn.findAll({
    rule: {
      kind: "await_expression",
      has: {
        kind: "identifier",
        regex: `^${varName}$`,
      },
    },
  });
  for (const aw of bareAwaits) {
    if (handledDeclaratorAwaitIds.has(aw.id())) continue;
    edits.push(aw.replace(hookName));
  }

  return edits;
}

function rewriteCatchAllJoinedParamRefs(pageFn: SgNode<TSX>, oldName: string): Edit[] {
  const edits: Edit[] = [];
  for (const call of pageFn.findAll({ rule: { kind: "call_expression" } })) {
    const callee = call.field("function");
    if (!callee || callee.kind() !== "member_expression") continue;
    const obj = callee.field("object");
    const prop = callee.field("property");
    if (!obj || obj.kind() !== "identifier" || obj.text() !== oldName) continue;
    if (!prop || prop.text() !== "join") continue;
    edits.push(call.replace("_splat"));
  }
  return edits;
}

/**
 * Next `params.slug` for `[...slug]` is `string[]`. TanStack exposes the splat
 * as `_splat` string — reintroduce the old binding as segment array when the
 * component still references it (e.g. `slug.map`, `slug.length`).
 */
function needsCatchAllArrayAliasAfterJoinRewrite(
  pageFn: SgNode<TSX>,
  oldKey: string,
  decl: SgNode<TSX>
): boolean {
  for (const id of pageFn.findAll({
    rule: { kind: "identifier", regex: `^${escapeRxIdent(oldKey)}$` },
  })) {
    if (isIdentifierInCatchAllDestructuringPattern(decl, id)) continue;
    if (isTypeOnlyIdentifierContext(id)) continue;
    if (isOldKeyOnlyUsedAsJoinReceiver(id)) continue;
    return true;
  }
  return false;
}

function escapeRxIdent(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isIdentifierInCatchAllDestructuringPattern(decl: SgNode<TSX>, id: SgNode<TSX>): boolean {
  const pat = decl.field("name");
  if (!pat || pat.kind() !== "object_pattern") return false;
  let cur: SgNode<TSX> | null = id.parent();
  while (cur) {
    if (cur.id() === pat.id()) return true;
    cur = cur.parent();
  }
  return false;
}

function isTypeOnlyIdentifierContext(id: SgNode<TSX>): boolean {
  let p: SgNode<TSX> | null = id.parent();
  while (p) {
    const k = p.kind();
    if (
      k === "type_annotation" ||
      k === "type_arguments" ||
      k === "type_parameter_declaration" ||
      k === "opting_type_annotation" ||
      k === "asserts_clause" ||
      k === "property_signature" ||
      k === "index_signature" ||
      k === "type_predicate"
    ) {
      return true;
    }
    p = p.parent();
  }
  return false;
}

/** True when `id` is the receiver of `<oldKey>.join(...)` (rewritten to `_splat` elsewhere). */
function isOldKeyOnlyUsedAsJoinReceiver(id: SgNode<TSX>): boolean {
  const p = id.parent();
  if (p?.kind() !== "member_expression") return false;
  if (p.field("object")?.id() !== id.id()) return false;
  if (p.field("property")?.text() !== "join") return false;
  const call = p.parent();
  return call?.kind() === "call_expression" && call.field("function")?.id() === p.id();
}

function insertCatchAllArrayAliasAfterDeclarator(
  decl: SgNode<TSX>,
  oldKey: string,
  source: string
): Edit[] {
  let stmt: SgNode<TSX> | null = decl.parent();
  while (stmt && stmt.kind() !== "lexical_declaration" && stmt.kind() !== "variable_declaration") {
    stmt = stmt.parent();
  }
  if (!stmt) return [];
  const indent = inferIndentAfterNewline(source, stmt.range().start.index);
  const insert = `\n${indent}const ${oldKey} = _splat.split("/").filter(Boolean);`;
  return [
    { startPos: stmt.range().end.index, endPos: stmt.range().end.index, insertedText: insert },
  ];
}

function inferIndentAfterNewline(source: string, stmtStart: number): string {
  let lineStart = stmtStart;
  while (lineStart > 0) {
    const c = source[lineStart - 1];
    if (c === "\n" || c === "\r") break;
    lineStart--;
  }
  const prefix = source.slice(lineStart, stmtStart);
  const m = /^(\s*)/.exec(prefix);
  return m?.[1] && m[1].length > 0 ? m[1] : "  ";
}
