/**
 * Rewrites `next/navigation` to `@tanstack/react-router` where safe:
 * - `usePathname` → `useLocation` + `usePathname()` → `useLocation().pathname`
 * - `useSearchParams` → `useSearch` + call sites → `useSearch()`
 * - `useParams` → TanStack `useParams` (same call sites; valid under `RouterProvider`
 *   like `useNavigate` / `useLocation`).
 * - `redirect` / `permanentRedirect` → `redirect` from TanStack; single-arg calls become
 *   `throw redirect({ to | href: … })` and permanent → `statusCode: 308` (external URLs
 *   use `href` when the literal looks like http(s)).
 * - `useRouter().push` / `.replace` and binding `const r = useRouter(); r.push` / `.replace`
 *   → `useNavigate()` / binding holds the navigate fn: `const r = useNavigate(); r({ … })`.
 * - When `.refresh` / `.back` / `.forward` appear **without** `.prefetch` or `.events`:
 *   `const navigate = useNavigate(); const router = useRouter()`, `router.push/replace`
 *   → `navigate({ … })`; `refresh` → `invalidate()`; `back`/`forward` → `history.back/forward`.
 * - `next/router` (Pages Router) and `next/compat/router` — same rules; **skipped** when the binding touches
 *   `.prefetch` or `.events`. When the file uses **`createFileRoute("/…/$param")`** and `router.query` only
 *   reads those params, **`router.query` → `Route.useParams()`** (plus `useNavigate()` for push/replace).
 *
 * `ReadonlyURLSearchParams` from `next/navigation` is removed and replaced with
 * `type ReadonlyURLSearchParams = URLSearchParams` plus a TODO (narrow to route search types when you can).
 *
 * `useRouter()` call sites rely on splitting URL into `to` / `params` / `search` / `hash`
 * where safe; otherwise `to: <original expr>` per TanStack navigation docs.
 *
 * - `notFound` from Next → `@tanstack/react-router` (`throw notFound()` in loaders).
 *
 * `// TODO (R4g)` once when `redirect`/router navigation call patterns are rewritten.
 * Other hook import moves (pathname/search only) do not add R4g.
 * */

import type { Codemod, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { TODO_PREFIX } from "../utils/sentinels.ts";

const NEXT_NAV = "next/navigation";
const NEXT_PAGES_ROUTER = "next/router";
/** Same hook semantics as `next/router` for migration; quoted verbatim when imports must stay on Next temporarily. */
const NEXT_COMPAT_ROUTER = "next/compat/router";
const TANSTACK = "@tanstack/react-router";

const READONLY_URL_SEARCH_PARAMS = "ReadonlyURLSearchParams";
const NEXT_REDIRECT_TYPE = "RedirectType";

const R4G_SENTINEL = "next/navigation migration (R4g)";

/** When present on the router binding, do not migrate that file's imperative router APIs. */
const ROUTER_HARD_SKIP_MEMBERS = new Set(["prefetch", "events"]);

/** Members allowed while auto-migrating `router.query` to `Route.useParams()` for TanStack file routes. */
const ROUTER_OK_WITH_FILE_ROUTE_QUERY = new Set(["query", "push", "replace", "isReady"]);

/** With these, migrate using dual hooks `useNavigate` + TanStack `useRouter`. */
const ROUTER_DUAL_HOOK_MEMBERS = new Set(["refresh", "back", "forward"]);

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root();
  const source = rootNode.text();

  const analyze = analyzeUseRouterBindings(rootNode, source);
  const skipUseRouterCallMigrate = analyze.hardSkipped;

  const fileRouteQueryEdits: Edit[] = [];
  if (analyze.fileRouteQueryBindings.size > 0) {
    fileRouteQueryEdits.push(
      ...insertRouteUseParamsHooks(rootNode, source, analyze.fileRouteQueryBindings)
    );
    fileRouteQueryEdits.push(
      ...replaceRouterQueryWithParams(rootNode, analyze.fileRouteQueryBindings)
    );
  }

  const redirectKinds = new Map<string, "plain" | "permanent">();
  const redirectTypeLocals = new Set<string>();
  const typeOnlyUseRouterLocals = new Set<string>();
  const notFoundImports = new Set<string>();
  let needsUseLocation = false;
  let needsUseSearch = false;

  const importStmts = rootNode.findAll({
    rule: {
      kind: "import_statement",
      regex: "next/(navigation|router|compat/router)",
    },
  });

  const importPlan: {
    stmt: SgNode<TSX>;
    text: string;
  }[] = [];
  let routerTypeAliasInsertedInImportPlan = false;

  let needsReadonlyUrlSearchParamsAlias = false;

  for (const stmt of importStmts) {
    const text = stmt.text();
    const navMod = /from\s*["']next\/navigation["']/.exec(text);
    const routerMod = /from\s*["']next\/router["']/.exec(text);
    const compatMod = /from\s*["']next\/compat\/router["']/.exec(text);
    if (!navMod && !routerMod && !compatMod) continue;

    const fromModule = routerMod !== null || compatMod !== null ? NEXT_PAGES_ROUTER : NEXT_NAV;
    const importSourceLiteral =
      navMod !== null ? NEXT_NAV : compatMod !== null ? NEXT_COMPAT_ROUTER : NEXT_PAGES_ROUTER;

    const specText = extractNamedSpecifiersBrace(text);
    if (specText === null) continue;

    const specs = splitImportSpecifiers(specText);
    if (specs.length === 0) continue;

    const keepNext: string[] = [];
    const tanstackFromStmt: string[] = [];

    const needsTanStackRouterHook = !skipUseRouterCallMigrate && analyze.dualHookBindings.size > 0;

    for (const raw of specs) {
      const s = raw.trim();
      if (!s) continue;

      const rp = parseImportSpecifier(s);
      if (
        fromModule === NEXT_NAV &&
        rp?.exported === "useRouter" &&
        /^\s*import\s+type\b/.test(text)
      ) {
        typeOnlyUseRouterLocals.add(rp.local);
        continue;
      }
      if (fromModule === NEXT_NAV && rp?.exported === "redirect") {
        redirectKinds.set(rp.local, "plain");
        tanstackFromStmt.push(rp.local === "redirect" ? "redirect" : `redirect as ${rp.local}`);
        continue;
      }
      if (fromModule === NEXT_NAV && rp?.exported === "permanentRedirect") {
        redirectKinds.set(rp.local, "permanent");
        tanstackFromStmt.push(`redirect as ${rp.local}`);
        continue;
      }

      if (fromModule === NEXT_NAV && rp?.exported === "notFound") {
        notFoundImports.add(rp.local);
        tanstackFromStmt.push(rp.local === "notFound" ? "notFound" : `notFound as ${rp.local}`);
        continue;
      }
      if (fromModule === NEXT_NAV && rp?.exported === NEXT_REDIRECT_TYPE) {
        redirectTypeLocals.add(rp.local);
        continue;
      }

      if (/^useRouter\b/.test(s)) {
        if (skipUseRouterCallMigrate) {
          keepNext.push(s);
        } else if (needsTanStackRouterHook) {
          tanstackFromStmt.push("useNavigate");
          tanstackFromStmt.push("useRouter");
        } else {
          tanstackFromStmt.push(s.replace(/^useRouter\b/, "useNavigate"));
        }
        continue;
      }
      if (fromModule === NEXT_NAV && /^usePathname\b/.test(s)) {
        tanstackFromStmt.push(s.replace(/^usePathname\b/, "useLocation"));
        needsUseLocation = true;
        continue;
      }
      if (fromModule === NEXT_NAV && /^useSearchParams\b/.test(s)) {
        tanstackFromStmt.push(s.replace(/^useSearchParams\b/, "useSearch"));
        needsUseSearch = true;
        continue;
      }
      if (fromModule === NEXT_NAV && /^useParams\b/.test(s)) {
        tanstackFromStmt.push(s);
        continue;
      }

      if (fromModule === NEXT_NAV && rp?.exported === READONLY_URL_SEARCH_PARAMS) {
        needsReadonlyUrlSearchParamsAlias = true;
        continue;
      }

      keepNext.push(s);
    }

    const mergedTanstack = mergeTanstackImports(tanstackFromStmt);

    const replacementLines: string[] = [];
    if (keepNext.length > 0) {
      replacementLines.push(`import { ${keepNext.join(", ")} } from "${importSourceLiteral}";`);
    }
    if (mergedTanstack.length > 0) {
      replacementLines.push(`import { ${mergedTanstack.join(", ")} } from "${TANSTACK}";`);
    }

    const insertedBase = replacementLines.length > 0 ? `${replacementLines.join("\n")}\n` : "";

    let inserted = insertedBase;
    const onlyReadonlyNavigationImport =
      navMod !== null && inserted === "" && specsAreOnlyReadonlyUrlSearchParams(specText);
    const onlyTypeUseRouterImport =
      navMod !== null &&
      /^\s*import\s+type\b/.test(text) &&
      inserted === "" &&
      specsAreOnlyTypeUseRouter(specText);

    if (onlyReadonlyNavigationImport) {
      inserted = `${READONLY_SEARCH_ALIAS.trimEnd()}\n`;
      needsReadonlyUrlSearchParamsAlias = false;
    }
    if (onlyTypeUseRouterImport) {
      inserted = `${ROUTER_TYPE_ALIAS.trimEnd()}\n`;
      routerTypeAliasInsertedInImportPlan = true;
    }

    if (
      inserted.replace(/\s+$/, "") === text.replace(/\s+$/, "") &&
      !onlyReadonlyNavigationImport
    ) {
      continue;
    }
    importPlan.push({ stmt, text: inserted });
  }

  coalesceAdjacentTanstackImports(importPlan, source);
  coalesceFollowingUnchangedTanstackImport(rootNode, importPlan, source);

  const dualLexicalRanges =
    analyze.dualHookBindings.size > 0 && !skipUseRouterCallMigrate
      ? dualHookLexicalRanges(source, rootNode, analyze.dualHookBindings)
      : [];

  const edits: Edit[] = [...fileRouteQueryEdits];

  let routerNavEdits = 0;
  if (!skipUseRouterCallMigrate) {
    /** Declarator split: dual hooks before member + bare call rewrites skew positions. */
    for (const decl of collectDualHookDeclarators(rootNode, analyze.dualHookBindings)) {
      const lexical = nearestLexicalDeclaration(decl);
      if (!lexical || countVariableDeclarators(lexical) !== 1) continue;
      const name = declaratorBindingName(decl);
      if (!name) continue;
      const imperativeVar = imperativeNavIdentifier(name);
      const init = decl.field("value");
      const initTxt = init?.text() ?? "";
      if (!/^\s*useRouter\s*\(\s*\)\s*$/.test(initTxt)) continue;
      const lineStart = lineStartIndex(source, lexical.range().start.index);
      let p = lineStart;
      while (p < source.length && (source[p] === " " || source[p] === "\t")) p++;
      const lineWs = source.slice(lineStart, p);
      edits.push({
        startPos: lineStart,
        endPos: lexical.range().end.index,
        insertedText: `${lineWs}const ${imperativeVar} = useNavigate();\n${lineWs}const ${name} = useRouter();`,
      });
      routerNavEdits++;
    }

    const navCalleeForBinding = (bindingName: string): string =>
      analyze.dualHookBindings.has(bindingName)
        ? imperativeNavIdentifier(bindingName)
        : bindingName;

    for (const call of inlineUseRouterNavCalls(rootNode)) {
      const prop = navProp(call);
      if (!prop) continue;
      const inner = useRouterCalleeCall(call);
      if (!inner) continue;
      const arg = firstCallArg(call.field("arguments"));
      if (!arg) continue;
      edits.push(
        call.replace(buildImperativeNavigationCall("useNavigate()", arg, prop === "replace"))
      );
      routerNavEdits++;
    }

    for (const name of collectUseRouterBindingNames(rootNode)) {
      const calleeName = navCalleeForBinding(name);
      for (const mem of rootNode.findAll({
        rule: {
          kind: "member_expression",
          has: {
            field: "object",
            kind: "identifier",
            regex: `^${escapeRx(name)}$`,
          },
        },
      })) {
        const p = mem.field("property")?.text();
        const parent = mem.parent();
        if (
          p !== undefined &&
          ROUTER_DUAL_HOOK_MEMBERS.has(p) &&
          parent?.kind() === "call_expression" &&
          parent.field("function")?.id() === mem.id()
        ) {
          edits.push(parent.replace(historyLikeRouterCallRewrite(p, name)));
          routerNavEdits++;
          continue;
        }
        if (p !== "push" && p !== "replace") continue;
        if (!parent || parent.kind() !== "call_expression") continue;
        if (parent.field("function")?.id() !== mem.id()) continue;
        const arg = firstCallArg(parent.field("arguments"));
        if (!arg) continue;
        edits.push(parent.replace(buildImperativeNavigationCall(calleeName, arg, p === "replace")));
        routerNavEdits++;
      }
    }
  }

  let redirectEdits = 0;
  for (const [local, kind] of redirectKinds) {
    for (const call of rootNode.findAll({
      rule: {
        kind: "call_expression",
        has: {
          field: "function",
          kind: "identifier",
          regex: `^${escapeRx(local)}$`,
        },
      },
    })) {
      const args = call.field("arguments");
      const a0 = firstCallArg(args);
      if (!a0) continue;
      const a1 = firstCallArgAfter(args, a0);
      const a2 = a1 ? firstCallArgAfter(args, a1) : null;
      if (a2) continue;

      const toOrHref = redirectToPayload(a0);
      if (!toOrHref) continue;
      const replace = isRedirectReplaceArg(a1, redirectTypeLocals);

      const opts =
        kind === "permanent"
          ? `{ ${toOrHref.key}: ${toOrHref.expr}, statusCode: 308${replace ? ", replace: true" : ""} }`
          : `{ ${toOrHref.key}: ${toOrHref.expr}${replace ? ", replace: true" : ""} }`;
      const newCall = `${local}(${opts})`;
      const e = buildRedirectThrowEdit(call, newCall, source);
      if (e) {
        edits.push(e);
        redirectEdits++;
      }
    }
  }

  if (!skipUseRouterCallMigrate) {
    for (const call of rootNode.findAll({
      rule: {
        kind: "call_expression",
        has: {
          field: "function",
          kind: "identifier",
          regex: "^useRouter$",
        },
      },
    })) {
      if (!shouldReplaceBareUseRouterCall(call, analyze)) continue;
      const r = call.range();
      if (
        dualLexicalRanges.some((lex) =>
          overlapsRange({ start: r.start.index, end: r.end.index }, lex)
        )
      ) {
        continue;
      }
      edits.push(call.replace("useNavigate()"));
    }
  }

  let notFoundEdits = 0;
  for (const local of notFoundImports) {
    for (const call of rootNode.findAll({
      rule: {
        kind: "call_expression",
        has: {
          field: "function",
          kind: "identifier",
          regex: `^${escapeRx(local)}$`,
        },
      },
    })) {
      const args = call.field("arguments");
      if (firstCallArg(args) !== null) continue;
      const e = buildRedirectThrowEdit(call, `${local}()`, source);
      if (!e) continue;
      edits.push(e);
      notFoundEdits++;
    }
  }

  const needsR4gBanner = redirectEdits > 0 || routerNavEdits > 0 || notFoundEdits > 0;
  const takeBanner = needsR4gBanner ? todoBannerTake(source) : (): string => "";

  for (const { stmt, text } of importPlan) {
    if (text === "") {
      let end = stmt.range().end.index;
      if (end < source.length && source[end] === "\r") end++;
      if (end < source.length && source[end] === "\n") end++;
      edits.push({
        startPos: stmt.range().start.index,
        endPos: end,
        insertedText: "",
      });
      continue;
    }
    edits.push({
      startPos: stmt.range().start.index,
      endPos: stmt.range().end.index,
      insertedText: `${takeBanner()}${text}`,
    });
  }

  if (needsReadonlyUrlSearchParamsAlias && !/\btype\s+ReadonlyURLSearchParams\b/.test(source)) {
    const aliasEdit = insertAfterImportsBlock(rootNode, source, READONLY_SEARCH_ALIAS);
    if (aliasEdit) edits.push(aliasEdit);
  }
  const needsRouterTypeAlias = typeOnlyUseRouterLocals.size > 0;
  if (
    needsRouterTypeAlias &&
    !routerTypeAliasInsertedInImportPlan &&
    !source.includes("type NextNavigationRouterLike = {")
  ) {
    const aliasEdit = insertAfterImportsBlock(rootNode, source, ROUTER_TYPE_ALIAS);
    if (aliasEdit) edits.push(aliasEdit);
  }
  if (needsRouterTypeAlias) {
    for (const local of typeOnlyUseRouterLocals) {
      for (const node of rootNode.findAll({
        rule: { kind: "type_query", regex: `typeof\\s+${escapeRx(local)}` },
      })) {
        const par = node.parent();
        if (par?.kind() === "type_arguments" && par.parent()?.kind() === "generic_type") {
          const gt = par.parent();
          if (gt === null || gt === undefined) continue;
          if (gt.field("name")?.text() === "ReturnType") {
            edits.push(gt.replace("NextNavigationRouterLike"));
          }
        }
      }
    }
  }

  if (needsUseLocation) {
    for (const call of rootNode.findAll({
      rule: {
        kind: "call_expression",
        has: {
          field: "function",
          kind: "identifier",
          regex: "^usePathname$",
        },
      },
    })) {
      edits.push(call.replace("useLocation().pathname"));
    }
  }

  if (needsUseSearch) {
    for (const call of rootNode.findAll({
      rule: {
        kind: "call_expression",
        has: {
          field: "function",
          kind: "identifier",
          regex: "^useSearchParams$",
        },
      },
    })) {
      edits.push(call.replace("useSearch()"));
    }
  }

  if (edits.length === 0) return null;
  edits.sort((a, b) => b.startPos - a.startPos);
  return rootNode.commitEdits(edits);
};

export default codemod;

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const READONLY_SEARCH_ALIAS = `${TODO_PREFIX}ReadonlyURLSearchParams — narrow to TanStack Route search types (best-effort alias): https://tanstack.com/router/latest/docs/framework/react/guide/search-params\ntype ReadonlyURLSearchParams = URLSearchParams;\n`;
const ROUTER_TYPE_ALIAS = `${TODO_PREFIX}next/navigation type-only useRouter (R4g): switched ReturnType<typeof useRouter> to a local router-like type; prefer passing \`useNavigate()\` directly where possible\ntype NextNavigationRouterLike = {\n  push: (to: string) => unknown;\n  replace: (to: string) => unknown;\n};\n`;

function insertAfterImportsBlock(
  rootNode: SgNode<TSX>,
  source: string,
  inserted: string
): Edit | null {
  if (source.includes("ReadonlyURLSearchParams = URLSearchParams")) return null;
  const imports = rootNode.findAll({ rule: { kind: "import_statement" } });
  if (imports.length === 0) {
    return { startPos: 0, endPos: 0, insertedText: `${inserted}\n` };
  }
  const last = imports.at(-1);
  if (last === undefined) return null;
  const pos = last.range().end.index;
  return { startPos: pos, endPos: pos, insertedText: `\n${inserted}` };
}

function specsAreOnlyReadonlyUrlSearchParams(specText: string): boolean {
  const specs = splitImportSpecifiers(specText);
  if (specs.length === 0) return false;
  return specs.every((raw) => parseImportSpecifier(raw)?.exported === READONLY_URL_SEARCH_PARAMS);
}

function specsAreOnlyTypeUseRouter(specText: string): boolean {
  const specs = splitImportSpecifiers(specText);
  if (specs.length === 0) return false;
  return specs.every((raw) => parseImportSpecifier(raw)?.exported === "useRouter");
}

function parseImportSpecifier(raw: string): { exported: string; local: string } | null {
  const t = raw.trim().replace(/^type\s+/, "");
  const am = /^([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)$/.exec(t);
  if (am) return { exported: am[1] ?? "", local: am[2] ?? "" };
  const id = /^([A-Za-z0-9_]+)$/.exec(t);
  if (!id) return null;
  return { exported: id[1] ?? "", local: id[1] ?? "" };
}

function todoBannerTake(source: string): () => string {
  if (source.includes(R4G_SENTINEL)) {
    return (): string => "";
  }
  let used = false;
  const line = `${TODO_PREFIX}${R4G_SENTINEL}: use \`throw redirect()\` in loaders / beforeLoad — client nav: \`useNavigate()\` — https://tanstack.com/router/latest/docs/framework/react/guide/navigation\n`;
  return (): string => {
    if (used) return "";
    used = true;
    return `\n${line}`;
  };
}

function collectUseRouterBindingNames(root: SgNode<TSX>): Set<string> {
  const out = new Set<string>();
  for (const decl of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const id = decl.field("name");
    const init = decl.field("value");
    if (!init || init.kind() !== "call_expression") continue;
    const callee = init.field("function");
    if (callee?.kind() !== "identifier" || callee.text() !== "useRouter") continue;
    if (id?.kind() !== "identifier") continue;
    out.add(id.text());
  }
  return out;
}

/** Dynamic segments from `createFileRoute("/a/$id")` → `["id"]`. */
function inferCreateFileRouteParamNames(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/createFileRoute\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const path = m[1];
    if (path === undefined) continue;
    for (const seg of path.split("/")) {
      if (seg.startsWith("$") && seg.length > 1) out.push(seg.slice(1));
    }
  }
  return out;
}

function collectRouterQueryKeysFromSource(source: string, routerName: string): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(`\\b${escapeRx(routerName)}\\.query\\.([a-zA-Z_$][a-zA-Z0-9_$]*)`, "g");
  let mm: RegExpExecArray | null = re.exec(source);
  while (mm !== null) {
    const cap = mm[1];
    if (cap !== undefined) out.add(cap);
    mm = re.exec(source);
  }
  return out;
}

function canMigrateFileRouteQuery(
  source: string,
  bindingName: string,
  members: Set<string>
): boolean {
  if (!members.has("query")) return false;
  const params = inferCreateFileRouteParamNames(source);
  if (params.length === 0) return false;
  const extra = [...members].filter((m) => !ROUTER_OK_WITH_FILE_ROUTE_QUERY.has(m));
  if (extra.length > 0) return false;
  const qKeys = collectRouterQueryKeysFromSource(source, bindingName);
  if (qKeys.size === 0) return false;
  return [...qKeys].every((k) => params.includes(k));
}

function findEnclosingStatementBlock(decl: SgNode<TSX>): SgNode<TSX> | null {
  let n: SgNode<TSX> | null = decl.parent();
  while (n) {
    if (n.kind() === "statement_block") return n;
    if (n.kind() === "program") return null;
    n = n.parent();
  }
  return null;
}

function lineIndentAtSourceIndex(source: string, index: number): string {
  let lineStart = index;
  while (lineStart > 0 && source[lineStart - 1] !== "\n") lineStart--;
  const lineEnd = source.indexOf("\n", lineStart);
  const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
  const m = /^(\s*)/.exec(line);
  return m?.[1] ?? "";
}

function insertRouteUseParamsHooks(root: SgNode<TSX>, source: string, names: Set<string>): Edit[] {
  const edits: Edit[] = [];
  const seenBlock = new Set<number>();
  for (const decl of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const id = declaratorBindingName(decl);
    if (!id || !names.has(id)) continue;
    const init = decl.field("value");
    if (!init || init.kind() !== "call_expression") continue;
    const callee = init.field("function");
    if (callee?.kind() !== "identifier" || callee.text() !== "useRouter") continue;
    const block = findEnclosingStatementBlock(decl);
    if (!block) continue;
    const k = block.id();
    if (seenBlock.has(k)) continue;
    seenBlock.add(k);
    const r = block.range();
    const braceIdx = source.indexOf("{", r.start.index);
    if (braceIdx === -1 || braceIdx >= r.end.index) continue;
    const indent = lineIndentAtSourceIndex(source, decl.range().start.index);
    const insert = `\n${indent}const params = Route.useParams();`;
    edits.push({
      startPos: braceIdx + 1,
      endPos: braceIdx + 1,
      insertedText: insert,
    });
  }
  return edits;
}

function replaceRouterQueryWithParams(root: SgNode<TSX>, names: Set<string>): Edit[] {
  const edits: Edit[] = [];
  for (const me of root.findAll({ rule: { kind: "member_expression" } })) {
    const prop = me.field("property")?.text();
    if (!prop) continue;
    const obj = me.field("object");
    if (!obj || obj.kind() !== "member_expression") continue;
    if (obj.field("property")?.text() !== "query") continue;
    const base = obj.field("object");
    if (!base || base.kind() !== "identifier") continue;
    if (!names.has(base.text())) continue;
    const r = me.range();
    edits.push({
      startPos: r.start.index,
      endPos: r.end.index,
      insertedText: `params.${prop}`,
    });
  }
  return edits;
}

function analyzeUseRouterBindings(
  root: SgNode<TSX>,
  source: string
): {
  hardSkipped: boolean;
  dualHookBindings: Set<string>;
  fileRouteQueryBindings: Set<string>;
} {
  const empty = {
    hardSkipped: true as boolean,
    dualHookBindings: new Set<string>(),
    fileRouteQueryBindings: new Set<string>(),
  };
  if (hasInlineNextRouterRisk(root)) {
    return empty;
  }
  const bindings = collectUseRouterBindingNames(root);
  if (bindings.size > 1) {
    return empty;
  }
  let hardSkipped = false;
  const dualHookBindings = new Set<string>();
  const fileRouteQueryBindings = new Set<string>();
  for (const name of bindings) {
    const members = routerMemberProperties(root, name);
    if (canMigrateFileRouteQuery(source, name, members)) {
      fileRouteQueryBindings.add(name);
    } else {
      if (members.has("query")) hardSkipped = true;
      for (const m of members) {
        if (ROUTER_HARD_SKIP_MEMBERS.has(m)) hardSkipped = true;
      }
    }
    for (const m of members) {
      if (ROUTER_DUAL_HOOK_MEMBERS.has(m)) dualHookBindings.add(name);
    }
  }
  return { hardSkipped, dualHookBindings, fileRouteQueryBindings };
}

function routerMemberProperties(root: SgNode<TSX>, bindingName: string): Set<string> {
  const out = new Set<string>();
  for (const mem of root.findAll({
    rule: {
      kind: "member_expression",
      has: {
        field: "object",
        kind: "identifier",
        regex: `^${escapeRx(bindingName)}$`,
      },
    },
  })) {
    const p = mem.field("property")?.text();
    if (p) out.add(p);
  }
  return out;
}

/** Inline `useRouter().x` where `x` is not push/replace — cannot mechanically port without a binding. */
function hasInlineNextRouterRisk(root: SgNode<TSX>): boolean {
  for (const mem of root.findAll({ rule: { kind: "member_expression" } })) {
    const obj = mem.field("object");
    if (!obj || obj.kind() !== "call_expression") continue;
    const c = obj.field("function");
    if (c?.kind() !== "identifier" || c.text() !== "useRouter") continue;
    const p = mem.field("property")?.text();
    if (!p || p === "push" || p === "replace") continue;
    return true;
  }
  return false;
}

function collectDualHookDeclarators(root: SgNode<TSX>, dualNames: Set<string>): SgNode<TSX>[] {
  const out: SgNode<TSX>[] = [];
  for (const decl of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const id = decl.field("name");
    if (id?.kind() !== "identifier") continue;
    if (!dualNames.has(id.text())) continue;
    const init = decl.field("value");
    if (!init || init.kind() !== "call_expression") continue;
    const callee = init.field("function");
    if (callee?.kind() !== "identifier" || callee.text() !== "useRouter") continue;
    out.push(decl);
  }
  return out;
}

function imperativeNavIdentifier(routerBinding: string): string {
  return routerBinding === "navigate" ? "tsNavigate" : "navigate";
}

function nearestLexicalDeclaration(decl: SgNode<TSX>): SgNode<TSX> | null {
  let n: SgNode<TSX> | null = decl.parent();
  while (n) {
    if (n.kind() === "lexical_declaration") return n;
    n = n.parent();
  }
  return null;
}

function countVariableDeclarators(lex: SgNode<TSX>): number {
  let n = 0;
  for (const c of lex.children()) {
    if (c.kind() === "variable_declarator") n++;
  }
  return n;
}

function declaratorBindingName(decl: SgNode<TSX>): string | null {
  const id = decl.field("name");
  return id?.kind() === "identifier" ? id.text() : null;
}

type IndexSpan = { start: number; end: number };

function dualHookLexicalRanges(
  source: string,
  root: SgNode<TSX>,
  dualNames: Set<string>
): IndexSpan[] {
  const spans: IndexSpan[] = [];
  const seenLex = new Set<number>();
  for (const decl of collectDualHookDeclarators(root, dualNames)) {
    const lex = nearestLexicalDeclaration(decl);
    if (!lex || countVariableDeclarators(lex) !== 1) continue;
    const k = lex.id();
    if (seenLex.has(k)) continue;
    seenLex.add(k);
    const r = lex.range();
    spans.push({
      start: lineStartIndex(source, r.start.index),
      end: r.end.index,
    });
  }
  return spans;
}

function overlapsRange(call: IndexSpan, lex: IndexSpan): boolean {
  return call.start <= lex.end && call.end >= lex.start;
}

function lineStartIndex(source: string, index: number): number {
  let s = Math.min(index, source.length);
  while (s > 0 && source[s - 1] !== "\n") s--;
  return s;
}

function historyLikeRouterCallRewrite(prop: string, routerBinding: string): string {
  if (prop === "refresh") return `${routerBinding}.invalidate()`;
  if (prop === "back") return `${routerBinding}.history.back()`;
  if (prop === "forward") return `${routerBinding}.history.forward()`;
  return `${routerBinding}.${prop}()`;
}

function inlineUseRouterNavCalls(root: SgNode<TSX>): SgNode<TSX>[] {
  const out: SgNode<TSX>[] = [];
  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const fn = call.field("function");
    if (!fn || fn.kind() !== "member_expression") continue;
    const prop = fn.field("property")?.text();
    if (prop !== "push" && prop !== "replace") continue;
    const obj = fn.field("object");
    if (!obj || obj.kind() !== "call_expression") continue;
    const c = obj.field("function");
    if (c?.kind() !== "identifier" || c.text() !== "useRouter") continue;
    out.push(call);
  }
  return out;
}

function useRouterCalleeCall(maybeMemberCall: SgNode<TSX>): SgNode<TSX> | null {
  const fn = maybeMemberCall.field("function");
  if (!fn || fn.kind() !== "member_expression") return null;
  const obj = fn.field("object");
  if (!obj || obj.kind() !== "call_expression") return null;
  return obj;
}

function navProp(maybeMemberCall: SgNode<TSX>): "push" | "replace" | null {
  const fn = maybeMemberCall.field("function");
  if (!fn || fn.kind() !== "member_expression") return null;
  const p = fn.field("property")?.text();
  return p === "push" || p === "replace" ? p : null;
}

function firstCallArg(args: SgNode<TSX> | null): SgNode<TSX> | null {
  if (!args) return null;
  for (const ch of args.children()) {
    const k = ch.kind();
    if (k === "(" || k === ")" || k === ",") continue;
    return ch as SgNode<TSX>;
  }
  return null;
}

function firstCallArgAfter(args: SgNode<TSX> | null, first: SgNode<TSX>): SgNode<TSX> | null {
  if (!args) return null;
  let seen = false;
  let next = false;
  for (const ch of args.children()) {
    const k = ch.kind();
    if (k === "(" || k === ")") continue;
    if (k === ",") {
      if (seen) next = true;
      continue;
    }
    if (next) return ch as SgNode<TSX>;
    if (ch.id() === first.id()) seen = true;
  }
  return null;
}

type ToOrHref = { key: "to" | "href"; expr: string };

function redirectToPayload(arg: SgNode<TSX>): ToOrHref | null {
  const k = arg.kind();
  if (k === "string_literal" || k === "string" || k === "template_string") {
    const t = arg.text();
    if ((t.startsWith('"') || t.startsWith("'")) && /^["']https?:\/\//i.test(t)) {
      return { key: "href", expr: arg.text() };
    }
    if (k === "template_string") {
      return { key: "to", expr: arg.text() };
    }
    const inner = t.slice(1, -1);
    if (/^https?:\/\//i.test(inner)) return { key: "href", expr: arg.text() };
    return { key: "to", expr: arg.text() };
  }
  if (k === "identifier") return { key: "to", expr: arg.text() };
  return null;
}

function buildRedirectThrowEdit(
  call: SgNode<TSX>,
  newRedirectCall: string,
  source: string
): Edit | null {
  const p = call.parent();
  if (p?.kind() === "throw_statement") {
    return {
      startPos: call.range().start.index,
      endPos: call.range().end.index,
      insertedText: newRedirectCall,
    };
  }

  if (p?.kind() === "return_statement") {
    const r = p.range();
    const seg = source.slice(r.start.index, r.end.index).trimEnd();
    const semi = seg.endsWith(";") ? ";" : "";
    return {
      startPos: r.start.index,
      endPos: r.end.index,
      insertedText: `throw ${newRedirectCall}${semi}`,
    };
  }

  if (p?.kind() === "expression_statement") {
    const stmt = p.range();
    const semi = source.slice(stmt.start.index, stmt.end.index).trimEnd().endsWith(";") ? ";" : "";
    return {
      startPos: stmt.start.index,
      endPos: stmt.end.index,
      insertedText: `throw ${newRedirectCall}${semi}`,
    };
  }

  return {
    startPos: call.range().start.index,
    endPos: call.range().end.index,
    insertedText: `throw ${newRedirectCall}`,
  };
}

function extractNamedSpecifiersBrace(importText: string): string | null {
  const m = importText.match(/\{([^}]*)\}\s*from/);
  return m?.[1] ?? null;
}

function splitImportSpecifiers(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "{" || ch === "(" || ch === "<") depth++;
    if (ch === "}" || ch === ")" || ch === ">") depth = Math.max(0, depth - 1);

    if (ch === "," && depth === 0) {
      if (cur.trim().length) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim().length) out.push(cur.trim());
  return out;
}

function mergeTanstackImports(specs: string[]): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const s of specs) {
    const key = s.replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    list.push(key);
  }
  return list;
}

/** Merge back-to-back `import { … } from "@tanstack/react-router"` plans into one line. */
function coalesceAdjacentTanstackImports(
  plan: { stmt: SgNode<TSX>; text: string }[],
  source: string
): void {
  if (plan.length < 2) return;
  const ordered = plan
    .map((p, idx) => ({ ...p, idx }))
    .sort((a, b) => a.stmt.range().start.index - b.stmt.range().start.index);
  const drop = new Set<number>();
  for (let j = 0; j < ordered.length - 1; j++) {
    const a = ordered[j];
    const b = ordered[j + 1];
    if (a === undefined || b === undefined) continue;
    if (drop.has(a.idx)) continue;
    const specsA = parseNamedImportSpecsFromTanstackLine(a.text);
    const specsB = parseNamedImportSpecsFromTanstackLine(b.text);
    if (!specsA || !specsB) continue;
    const gap = source.slice(a.stmt.range().end.index, b.stmt.range().start.index);
    if (!/^\s*$/.test(gap)) continue;
    const planEntry = plan[a.idx];
    if (planEntry === undefined) continue;
    planEntry.text = `import { ${mergeTanstackImports([...specsA, ...specsB]).join(", ")} } from "${TANSTACK}";\n`;
    drop.add(b.idx);
  }
  for (let i = plan.length - 1; i >= 0; i--) {
    if (drop.has(i)) plan.splice(i, 1);
  }
}

/** Merge a rewritten TanStack import with the next unchanged `import … @tanstack/react-router` in the file. */
function coalesceFollowingUnchangedTanstackImport(
  rootNode: SgNode<TSX>,
  plan: { stmt: SgNode<TSX>; text: string }[],
  source: string
): void {
  const inPlan = new Set(plan.map((p) => p.stmt.id()));
  const imports = rootNode
    .findAll({ rule: { kind: "import_statement" } })
    .sort((a, b) => a.range().start.index - b.range().start.index);
  for (let i = 0; i < imports.length - 1; i++) {
    const aStmt = imports[i];
    const bStmt = imports[i + 1];
    if (aStmt === undefined || bStmt === undefined) continue;
    const aEntry = plan.find((p) => p.stmt.id() === aStmt.id());
    if (!aEntry) continue;
    if (inPlan.has(bStmt.id())) continue;
    const specsA = parseNamedImportSpecsFromTanstackLine(aEntry.text);
    const specsB = parseNamedImportSpecsFromTanstackLine(bStmt.text());
    if (!specsA || !specsB) continue;
    const gap = source.slice(aStmt.range().end.index, bStmt.range().start.index);
    if (!/^\s*$/.test(gap)) continue;
    aEntry.text = `import { ${mergeTanstackImports([...specsA, ...specsB]).join(", ")} } from "${TANSTACK}";\n`;
    plan.push({ stmt: bStmt, text: "" });
    inPlan.add(bStmt.id());
  }
}

function parseNamedImportSpecsFromTanstackLine(text: string): string[] | null {
  const m =
    /^\s*import\s+\{\s*([^}]+)\s*\}\s*from\s*["']@tanstack\/react-router["']\s*;?\s*$/m.exec(
      text.trim()
    );
  if (!m?.[1]) return null;
  return splitImportSpecifiers(m[1]);
}

/**
 * Imperative navigation target for migrated `router.push` / `router.replace`.
 * Uses structured `to` + `params` + `search` + `hash` when the URL can be split safely;
 * see https://tanstack.com/router/latest/docs/framework/react/guide/navigation
 */
function buildImperativeNavigationCall(callee: string, arg: SgNode<TSX>, replace: boolean): string {
  const body = tryStructuredNavigateArg(arg) ?? `to: ${arg.text()}`;
  const suffix = replace ? ", replace: true" : "";
  return `${callee}({ ${body}${suffix} })`;
}

function tryStructuredNavigateArg(arg: SgNode<TSX>): string | null {
  const k = arg.kind();
  if (k === "string_literal" || k === "string") {
    const inner = stringLiteralInner(arg.text());
    if (/^https?:\/\//i.test(inner)) return null;
    return tryStructuredStaticPathQueryHash(inner);
  }
  if (k === "template_string") {
    return tryStructuredTemplateUrl(arg);
  }
  return null;
}

function stringLiteralInner(raw: string): string {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function tryStructuredStaticPathQueryHash(inner: string): string | null {
  const hashIdx = inner.indexOf("#");
  let pathQuery = inner;
  let hash: string | null = null;
  if (hashIdx >= 0) {
    pathQuery = inner.slice(0, hashIdx);
    hash = inner.slice(hashIdx + 1);
  }
  const qIdx = pathQuery.indexOf("?");
  const path = qIdx >= 0 ? pathQuery.slice(0, qIdx) : pathQuery;
  const query = qIdx >= 0 ? pathQuery.slice(qIdx + 1) : "";
  if (!path.startsWith("/")) return null;
  const parts: string[] = [`to: ${JSON.stringify(path)}`];
  if (query.length > 0) {
    const s = parseQueryToSearchObjectLiteral(query);
    if (!s) return null;
    parts.push(`search: ${s}`);
  }
  if (hash !== null && hash.length > 0) {
    parts.push(`hash: ${JSON.stringify(hash)}`);
  }
  return parts.join(", ");
}

type TemplatePiece = { kind: "str"; text: string } | { kind: "sub"; expr: SgNode<TSX> };

function collectTemplatePieces(node: SgNode<TSX>): TemplatePiece[] | null {
  if (node.kind() !== "template_string") return null;
  const out: TemplatePiece[] = [];
  let buf = "";
  for (const c of node.children()) {
    const k = c.kind();
    if (k === "`") continue;
    if (k === "string_fragment") {
      buf += c.text();
    } else if (k === "escape_sequence") {
      buf += c.text();
    } else if (k === "template_substitution") {
      if (buf.length) {
        out.push({ kind: "str", text: buf });
        buf = "";
      }
      const expr = templateSubstitutionExpr(c);
      if (!expr) return null;
      out.push({ kind: "sub", expr });
    }
  }
  if (buf.length) out.push({ kind: "str", text: buf });
  return out;
}

function templateSubstitutionExpr(sub: SgNode<TSX>): SgNode<TSX> | null {
  for (const c of sub.children()) {
    const k = c.kind();
    if (k === "${" || k === "}" || k === "$") continue;
    return c as SgNode<TSX>;
  }
  return null;
}

function simpleSubstitutionBinding(expr: SgNode<TSX>): { param: string; exprText: string } | null {
  if (expr.kind() !== "identifier") return null;
  const t = expr.text();
  return { param: t, exprText: t };
}

function tryStructuredTemplateUrl(node: SgNode<TSX>): string | null {
  const pieces = collectTemplatePieces(node);
  if (pieces === null) return null;

  type PathTok = { t: "s"; v: string } | { t: "p"; param: string; exprText: string };

  const pathToks: PathTok[] = [];
  let queryBuf = "";
  let hashBuf = "";
  let phase: "path" | "query" | "hash" = "path";

  for (const p of pieces) {
    if (p.kind === "sub") {
      if (phase !== "path") return null;
      const b = simpleSubstitutionBinding(p.expr);
      if (!b) return null;
      pathToks.push({ t: "p", param: b.param, exprText: b.exprText });
    } else {
      const text = p.text;
      if (phase === "path") {
        const qAt = text.indexOf("?");
        const hAt = text.indexOf("#");
        if (hAt >= 0 && (qAt < 0 || hAt < qAt)) {
          if (hAt > 0) pathToks.push({ t: "s", v: text.slice(0, hAt) });
          phase = "hash";
          hashBuf += text.slice(hAt + 1);
          continue;
        }
        if (qAt >= 0) {
          if (qAt > 0) pathToks.push({ t: "s", v: text.slice(0, qAt) });
          phase = "query";
          queryBuf += text.slice(qAt + 1);
          continue;
        }
        pathToks.push({ t: "s", v: text });
      } else if (phase === "query") {
        if (/[?#]/.test(text)) return null;
        queryBuf += text;
      } else {
        hashBuf += text;
      }
    }
  }

  let toPat = "";
  const paramsOrder: string[] = [];
  const paramToExpr = new Map<string, string>();
  for (const t of pathToks) {
    if (t.t === "s") {
      toPat += t.v;
    } else {
      toPat += `$${t.param}`;
      if (!paramToExpr.has(t.param)) {
        paramsOrder.push(t.param);
        paramToExpr.set(t.param, t.exprText);
      }
    }
  }

  if (!toPat.startsWith("/")) return null;

  const out: string[] = [`to: ${JSON.stringify(toPat)}`];
  if (paramsOrder.length > 0) {
    const entries = paramsOrder.map((k) => {
      const ex = paramToExpr.get(k) ?? k;
      return k === ex ? k : `${k}: ${ex}`;
    });
    out.push(`params: { ${entries.join(", ")} }`);
  }
  if (queryBuf.length > 0) {
    const s = parseQueryToSearchObjectLiteral(queryBuf);
    if (!s) return null;
    out.push(`search: ${s}`);
  }
  if (hashBuf.length > 0) {
    out.push(`hash: ${JSON.stringify(hashBuf)}`);
  }
  return out.join(", ");
}

function searchKeyFragment(key: string): string | null {
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) return key;
  try {
    return JSON.stringify(key);
  } catch {
    return null;
  }
}

function parseQueryToSearchObjectLiteral(query: string): string | null {
  const parts = query.split("&").filter((p) => p.length > 0);
  const props: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      const kf = searchKeyFragment(part);
      if (!kf) return null;
      props.push(`${kf}: true`);
    } else {
      const key = part.slice(0, eq);
      const val = part.slice(eq + 1);
      const kf = searchKeyFragment(key);
      if (!kf) return null;
      props.push(`${kf}: ${JSON.stringify(val)}`);
    }
  }
  return `{ ${props.join(", ")} }`;
}

function isRedirectReplaceArg(arg: SgNode<TSX> | null, redirectTypeLocals: Set<string>): boolean {
  if (!arg || redirectTypeLocals.size === 0) return false;
  if (arg.kind() !== "member_expression") return false;
  const obj = arg.field("object");
  const prop = arg.field("property");
  if (obj?.kind() !== "identifier" || prop?.text() !== "replace") return false;
  return redirectTypeLocals.has(obj.text());
}

/** `useRouter` call site: omit bare replace when it initializes a TanStack `useRouter()` (dual-hook layout). */
function shouldReplaceBareUseRouterCall(
  call: SgNode<TSX>,
  analyze: { dualHookBindings: Set<string> }
): boolean {
  const p = call.parent();
  if (p?.kind() === "variable_declarator") {
    const name = p.field("name");
    const init = p.field("value");
    if (
      init?.kind() === "call_expression" &&
      init.field("function")?.id() === call.id() &&
      name?.kind() === "identifier" &&
      analyze.dualHookBindings.has(name.text())
    ) {
      return false;
    }
  }

  if (p?.kind() !== "member_expression") return true;
  if (p.field("object")?.id() !== call.id()) return true;
  const prop = p.field("property")?.text();
  return prop !== "push" && prop !== "replace";
}
