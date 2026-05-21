/**
 * Migrates `next/cache` usages toward TanStack Query patterns:
 * - `revalidateTag(expr)` → `queryClient.invalidateQueries({ queryKey: ['next-cache', 'tag', expr] })`
 * - `revalidatePath(path, type?)` → `… queryKey: ['next-cache', 'path', path]` or includes `type` when present
 * - `unstable_cache` / `cache(fn, …)` → unwrap to `fn`; when the call is \`export const name = …\`,
 *   also emits \`export const nameQueryOptions = { queryKey, queryFn: name, staleTime? }\` for TanStack Query.
 * - `unstable_noStore()` → removed (`staleTime: 0` per-query replaces it)
 *
 * Replaces `next/cache` import lines: adds `queryClient` from a relative path to the shared
 * singleton written by `scaffold-tanstack-files` (`src/query-client.ts` or `query-client.ts`).
 * Inserts one \`// TODO:\` banner per file (unless \`next/cache migration (R4e)\` is already present).
 * Banner is **short** when the file only unwraps \`cache\`/\`unstable_cache\` or strips \`unstable_noStore\`;
 * **long** when it emits \`invalidateQueries\`. Legacy \`unstable_cache\` metadata may still appear in an end-of-line
 * \`// TODO\` when the call is not a simple \`export const x = …\` binding.
 */

import type { Codemod, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { dirname, join, relative } from "path";
import { inferCodemodTargetDir, normalizePath } from "../utils/paths.ts";
import { hasSrcAppOrPages } from "../utils/has-src-app-or-pages.ts";
import { TODO_PREFIX } from "../utils/sentinels.ts";

const NEXT_CACHE = "next/cache";

const R4E_TODO_SENTINEL = "next/cache migration (R4e)";
const R4E_TODO_DOC =
  "https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation";
const R4E_CACHING_DOC = "https://tanstack.com/query/latest/docs/framework/react/guides/caching";

type Builtin = "revalidateTag" | "revalidatePath" | "unstable_cache" | "cache" | "unstable_noStore";

type ImportSpecPiece = {
  exported: string;
  local: string;
  raw: string;
};

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root();
  const source = rootNode.text();
  const edits: Edit[] = [];

  const fileAbs = normalizePath(root.filename());
  const pkgRoot = inferCodemodTargetDir(fileAbs);
  const qcSpecifier = queryClientSpecifierForFile(pkgRoot, fileAbs);

  const nextCacheImports = rootNode.findAll({ rule: { kind: "import_statement" } }).filter((s) => {
    const m = s.text().match(/from\s*["']([^"']+)["']/);
    return m?.[1] === NEXT_CACHE;
  });

  const builtinLocals = extractBuiltinBindings(nextCacheImports);
  if (builtinLocals.size === 0) {
    return null;
  }

  /** Count invalidation calls before we rewrite imports that depend on invalidateCount */
  let invalidateCount = 0;
  const preScanCalls = rootNode.findAll({
    rule: {
      kind: "call_expression",
      has: { field: "function", kind: "identifier" },
    },
  });
  for (const call of preScanCalls) {
    const fnId = immediateCallIdentifier(call);
    const builtin = fnId ? builtinLocals.get(fnId) : undefined;
    if (builtin !== "revalidateTag" && builtin !== "revalidatePath") continue;
    if (firstArgumentListExpr(call)) invalidateCount++;
  }

  const hasInvalidation = invalidateCount > 0;
  const nextTodoLead = todoLeadAppender(source, hasInvalidation);

  for (const stmt of nextCacheImports) {
    const plan = planNextCacheImportRewrite(
      stmt,
      invalidateCount > 0 && qcSpecifier != null,
      qcSpecifier
    );
    if (plan.kind === "noop") continue;

    const nl = /\r?\n$/.exec(stmt.text())?.[0] ?? "\n";

    if (plan.kind === "delete") edits.push(removeStatementSpan(source, stmt, nextTodoLead()));
    else if (plan.body + nl !== stmt.text()) {
      edits.push(stmt.replace(`${nextTodoLead()}${plan.body}${nl}`));
    }
  }

  const callSites = rootNode.findAll({
    rule: {
      kind: "call_expression",
      has: { field: "function", kind: "identifier" },
    },
  });

  for (const call of callSites) {
    const fnId = immediateCallIdentifier(call);
    if (!fnId) continue;
    const builtin = builtinLocals.get(fnId);
    if (!builtin) continue;

    if (builtin === "unstable_noStore") {
      const estmt = ascendToExpressionStatement(call);
      if (estmt) edits.push(removeStatementSpan(source, estmt, nextTodoLead()));
      else edits.push(call.replace("undefined"));
      continue;
    }

    if (builtin === "unstable_cache" || builtin === "cache") {
      const fst = firstArgumentListExpr(call);
      if (!fst) continue;
      const args = extractCallArgs(call);
      const bindName = variableDeclaratorIdentForRhs(call);
      const tail = builtin === "unstable_cache" && !bindName ? unstableCacheTrailingHint(args) : "";
      edits.push(call.replace(`${nextTodoLead()}${fst.text()}${tail}`));
      const qoInsert = queryOptionsInsertAfterExport(source, call, bindName, args, builtin);
      if (qoInsert) edits.push(qoInsert);
      continue;
    }

    if (builtin === "revalidatePath") {
      const args = extractCallArgs(call);
      const path = args[0];
      const typ = args[1];
      if (!path) continue;
      const keyInner =
        typ != null
          ? `'next-cache', 'path', ${path.text()}, ${typ.text()}`
          : `'next-cache', 'path', ${path.text()}`;
      edits.push(
        call.replace(`${nextTodoLead()}queryClient.invalidateQueries({ queryKey: [${keyInner}] })`)
      );
      continue;
    }

    const arg = firstArgumentListExpr(call);
    if (!arg) continue;

    edits.push(
      call.replace(
        `${nextTodoLead()}queryClient.invalidateQueries({ queryKey: ['next-cache', 'tag', ${arg.text()}] })`
      )
    );
  }

  if (edits.length === 0) return null;

  edits.sort((a, b) => b.startPos - a.startPos);
  return rootNode.commitEdits(edits);
};

export default codemod;

/** One migration banner appended to the first structural edit (imports or call replace). */
function todoLeadAppender(source: string, hasInvalidation: boolean): () => string {
  if (source.includes(R4E_TODO_SENTINEL)) {
    return (): string => "";
  }
  let used = false;
  const bannerInvalidate = `\n${TODO_PREFIX}${R4E_TODO_SENTINEL}: wire \`queryClient\` through QueryClientProvider or your app root; align \`useQuery({ queryKey })\` with \`['next-cache', 'tag', …]\` / \`['next-cache', 'path', …]\` from \`revalidateTag\` / \`revalidatePath\`; former \`unstable_cache\` / \`cache\` TTL/tags → \`staleTime\` / \`gcTime\` / loaders; if you relied on \`unstable_noStore\`, use \`staleTime: 0\` (or refetch) for that data — ${R4E_TODO_DOC}\n`;
  const bannerCacheOnly = `\n${TODO_PREFIX}${R4E_TODO_SENTINEL}: unwrap + optional \`*QueryOptions\` for \`useQuery\`/\`ensureQueryData\`; align with \`invalidateQueries\` / route loaders — ${R4E_CACHING_DOC} · ${R4E_TODO_DOC}\n`;
  const banner = hasInvalidation ? bannerInvalidate : bannerCacheOnly;
  return (): string => {
    if (used) return "";
    used = true;
    return banner;
  };
}

function queryOptionsInsertAfterExport(
  source: string,
  call: SgNode<TSX>,
  bindName: string | null,
  args: SgNode<TSX>[],
  builtin: "cache" | "unstable_cache"
): Edit | null {
  if (!bindName) return null;
  const optName = `${bindName}QueryOptions`;
  if (new RegExp(`\\b${escapeReg(optName)}\\b`).test(source)) return null;

  const container =
    ascendToKind(call, "export_statement") ?? ascendToKind(call, "lexical_declaration");
  if (!container) return null;

  const queryKeyTs = buildQueryKeyTypeScript(bindName, args[1], builtin);
  const st = staleTimeMsFromUnstableOpts(args[2]);
  const staleLine = st != null ? `  staleTime: ${st},\n` : "";

  const block = `export const ${optName} = {
  queryKey: ${queryKeyTs},
  queryFn: ${bindName},
${staleLine}};`;

  const end = container.range().end.index;
  const nl = source.slice(end, end + 2) === "\r\n" ? "\r\n" : "\n";
  return { startPos: end, endPos: end, insertedText: `${nl}${nl}${block}` };
}

function variableDeclaratorIdentForRhs(call: SgNode<TSX>): string | null {
  const p = call.parent();
  if (p?.kind() !== "variable_declarator") return null;
  const val = p.field("value");
  if (!val || val.id() !== call.id()) return null;
  const name = p.field("name");
  if (!name || name.kind() !== "identifier") return null;
  return name.text();
}

function ascendToKind(node: SgNode<TSX>, kind: string): SgNode<TSX> | null {
  let cur: SgNode<TSX> | null = node.parent();
  while (cur) {
    if (cur.kind() === kind) return cur;
    cur = cur.parent();
  }
  return null;
}

function buildQueryKeyTypeScript(
  bindName: string,
  keyArg: SgNode<TSX> | undefined,
  builtin: "cache" | "unstable_cache"
): string {
  if (builtin === "unstable_cache" && keyArg) {
    const strings = stringLiteralsFromArrayExpression(keyArg);
    if (strings !== null && strings.length > 0) {
      return `['next-cache', ${strings.join(", ")}] as const`;
    }
  }
  return `['next-cache', '${bindName}'] as const`;
}

function stringLiteralsFromArrayExpression(node: SgNode<TSX>): string[] | null {
  const k = node.kind();
  if (k !== "array_expression" && k !== "array") return null;
  const out: string[] = [];
  for (const ch of node.children()) {
    const ck = ch.kind();
    if (ck === "[" || ck === "]" || ck === ",") continue;
    if (ck !== "string") return null;
    out.push(ch.text());
  }
  return out.length > 0 ? out : null;
}

function staleTimeMsFromUnstableOpts(opts: SgNode<TSX> | undefined): number | null {
  if (!opts) return null;
  const rev = /revalidate\s*:\s*(\d+)/.exec(opts.text());
  if (!rev) return null;
  const sec = Number(rev[1]);
  return Number.isNaN(sec) ? null : sec * 1000;
}

/**
 * Inline hint when `unstable_cache` is not a simple `export const name = …` binding.
 */
function unstableCacheTrailingHint(args: SgNode<TSX>[]): string {
  if (args.length <= 1) return "";
  const keyText = args[1]?.text().trim() ?? "";
  const optsText = args[2]?.text().trim() ?? "";
  const parts: string[] = [];
  if (keyText) parts.push(`unstable_cache keys ${keyText}`);
  const rev = /revalidate\s*:\s*(\d+)/.exec(optsText);
  if (rev) {
    const sec = Number(rev[1]);
    if (!Number.isNaN(sec)) parts.push(`revalidate ${sec}s → staleTime: ${sec * 1000}`);
  }
  const tags = /tags\s*:\s*\[([^\]]*)\]/.exec(optsText);
  if (tags?.[1]) parts.push(`tags [${tags[1].trim()}]`);
  if (parts.length === 0) return "";
  return ` ${TODO_PREFIX}${R4E_TODO_SENTINEL}: ${parts.join("; ")}`;
}

function queryClientSpecifierForFile(pkgRoot: string, fileAbs: string): string | null {
  const useSrc = hasSrcAppOrPages(pkgRoot);
  const qcAbsTs = join(pkgRoot, useSrc ? join("src", "query-client.ts") : "query-client.ts");
  const base = qcAbsTs.replace(/\\/g, "/").replace(/\.ts$/, "");
  let rel = relative(dirname(fileAbs), base).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return normalizePath(rel);
}

function immediateCallIdentifier(call: SgNode<TSX>): string | null {
  const fn = call.field("function");
  if (!fn || fn.kind() !== "identifier") return null;
  return fn.text();
}

function extractCallArgs(call: SgNode<TSX>): SgNode<TSX>[] {
  const list = call.field("arguments");
  if (!list) return [];
  const out: SgNode<TSX>[] = [];
  for (const ch of list.children()) {
    const k = ch.kind();
    if (k === "(" || k === ")" || k === ",") continue;
    out.push(ch as SgNode<TSX>);
  }
  return out;
}

function firstArgumentListExpr(call: SgNode<TSX>): SgNode<TSX> | null {
  const args = extractCallArgs(call);
  return args[0] ?? null;
}

function ascendToExpressionStatement(node: SgNode<TSX>): SgNode<TSX> | null {
  let cur: SgNode<TSX> | null = node.parent();
  while (cur && cur.kind() !== "expression_statement") {
    cur = cur.parent();
  }
  return cur;
}

function removeStatementSpan(source: string, stmt: SgNode<TSX>, insertedText = ""): Edit {
  const start = stmt.range().start.index;
  let end = stmt.range().end.index;
  while (end < source.length && (source[end] === " " || source[end] === "\t")) end++;
  if (source[end] === "\r") end++;
  if (source[end] === "\n") end++;
  return { startPos: start, endPos: end, insertedText };
}

function extractBuiltinBindings(importStmts: SgNode<TSX>[]): Map<string, Builtin> {
  const out = new Map<string, Builtin>();
  for (const stmt of importStmts) {
    const brace = extractNamedBrace(stmt.text());
    if (brace === null) continue;
    for (const raw of splitImportSpecifiers(brace)) {
      const p = parseImportPiece(raw);
      if (!p) continue;
      const b = builtinForExported(p.exported);
      if (b) out.set(p.local, b);
    }
  }
  return out;
}

function builtinForExported(name: string): Builtin | null {
  if (
    name === "revalidateTag" ||
    name === "revalidatePath" ||
    name === "unstable_cache" ||
    name === "cache" ||
    name === "unstable_noStore"
  ) {
    return name;
  }
  return null;
}

function parseImportPiece(raw: string): ImportSpecPiece | null {
  const t = raw.trim();
  const asMatch = /^([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)$/.exec(t);
  if (asMatch) return { exported: asMatch[1] ?? "", local: asMatch[2] ?? "", raw: t };
  const id = /^([A-Za-z0-9_]+)$/.exec(t);
  if (!id) return null;
  return { exported: id[1] ?? "", local: id[1] ?? "", raw: t };
}

type ImportRewritePlan = { kind: "noop" } | { kind: "delete" } | { kind: "replace"; body: string };

function planNextCacheImportRewrite(
  stmt: SgNode<TSX>,
  needsQc: boolean,
  qcSpecifier: string | null
): ImportRewritePlan {
  const src = stmt.text();
  const brace = extractNamedBrace(src);
  if (brace === null) return { kind: "noop" };

  const kept: string[] = [];
  for (const raw of splitImportSpecifiers(brace)) {
    const p = parseImportPiece(raw);
    if (!p) {
      kept.push(raw.trim());
      continue;
    }
    if (builtinForExported(p.exported)) continue;
    kept.push(p.raw);
  }

  const lines: string[] = [];
  if (needsQc && qcSpecifier && !sourceStmtHasQueryImport(src, qcSpecifier))
    lines.push(`import { queryClient } from "${qcSpecifier}";`);
  if (kept.length > 0) lines.push(`import { ${kept.join(", ")} } from "${NEXT_CACHE}";`);

  if (lines.length === 0) return { kind: "delete" };
  return { kind: "replace", body: lines.join("\n") };
}

function sourceStmtHasQueryImport(stmtText: string, qcSpecifier: string): boolean {
  const q = escapeReg(qcSpecifier);
  return new RegExp(`import\\s+\\{[^}]*\\bqueryClient\\b[^}]*}\\s*from\\s*["']${q}["']`).test(
    stmtText
  );
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractNamedBrace(text: string): string | null {
  const m = text.match(/\{\s*([^}]*)\s*\}\s*from/);
  return m?.[1] ?? null;
}

function splitImportSpecifiers(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "{" || ch === "(" || ch === "<") depth++;
    else if (ch === "}" || ch === ")" || ch === ">") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
