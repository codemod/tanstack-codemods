/**
 * Best-effort `next/server` → Web Fetch API + small runtime shims (aligned with Next's `server.d.ts` surface):
 * - `NextRequest` / `NextResponse` / `NextURL` identifiers → `Request` / `Response` / `URL`.
 * - `*.nextUrl` → `new URL(<receiver>.url)`.
 * - `userAgent` / `userAgentFromString` → `@edge-runtime/user-agent`.
 * - `ImageResponse` → `next/og` (same export Next re-exports; consumed by R4i `rewrite-next-og`).
 * - `URLPattern` import dropped — use global `URLPattern` (Node 19+ / modern runtimes).
 * - `after` / `connection` → file-local Promise-queue / async no-op shims + TODO.
 * - Common **type-only** exports (`NextMiddleware`, `ImageResponseOptions`, …) → `unknown` aliases + TODO.
 *
 * **Skips the file** when:
 * - `NextResponse.next` (middleware-only),
 * - `NextRequest as …` / `NextResponse as …` / `NextURL as …` (aliases need manual mapping),
 * - `import * as … from "next/server"`.
 */

import type { Codemod, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { TODO_PREFIX } from "../utils/sentinels.ts";

const NEXT_SERVER = "next/server";
const EDGE_USER_AGENT = "@edge-runtime/user-agent";
const NEXT_OG = "next/og";

/** Type re-exports from `next/server` that apps typically only need as erased placeholders post-migration. */
const TYPE_STUB_EXPORTS = new Set([
  "NextMiddleware",
  "MiddlewareConfig",
  "NextFetchEvent",
  "NextProxy",
  "ProxyConfig",
  "ImageResponseOptions",
]);

const UNSUPPORTED = [/\bNextResponse\.next\b/];

type StripAccumulator = {
  afterLocals: Set<string>;
  connectionLocals: Set<string>;
};

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root();
  const source = rootNode.text();

  for (const re of UNSUPPORTED) {
    if (re.test(source)) return null;
  }
  if (/(?:NextRequest|NextResponse|NextURL)\s+as\s+/.test(source)) return null;
  if (/\*\s*as\s+\w+\s+from\s*["']next\/server["']/.test(source)) return null;

  const importStmts = rootNode
    .findAll({ rule: { kind: "import_statement" } })
    .filter((s) => parseImportSource(s.text()) === NEXT_SERVER);
  if (importStmts.length === 0) return null;

  const acc: StripAccumulator = {
    afterLocals: new Set(),
    connectionLocals: new Set(),
  };

  let stripNextPrimitivesFromImports = false;
  const edits: Edit[] = [];

  for (const stmt of importStmts) {
    const plan = buildNextServerImportRewrite(stmt.text(), acc);
    if (plan === null) continue;
    if (plan.removedNextPrimitive) stripNextPrimitivesFromImports = true;

    const orig = stmt.text();
    const nl = /\r?\n$/.test(orig) ? "\n" : "";
    if (plan.kind === "delete") {
      edits.push(deleteImportStatement(source, stmt));
      continue;
    }

    if (plan.newText.trim() === orig.replace(/\r?\n$/, "").trim()) continue;
    edits.push({
      startPos: stmt.range().start.index,
      endPos: stmt.range().end.index,
      insertedText: `${plan.newText}${nl}`,
    });
  }

  if (stripNextPrimitivesFromImports) {
    for (const id of rootNode.findAll({
      rule: { kind: "identifier", regex: "^NextRequest$" },
    })) {
      if (isUnderImportSpecifier(id)) continue;
      edits.push(id.replace("Request"));
    }
    for (const id of rootNode.findAll({
      rule: { kind: "identifier", regex: "^NextResponse$" },
    })) {
      if (isUnderImportSpecifier(id)) continue;
      edits.push(id.replace("Response"));
    }
    for (const id of rootNode.findAll({
      rule: { kind: "type_identifier", regex: "^NextRequest$" },
    })) {
      if (isUnderImportSpecifier(id)) continue;
      edits.push(id.replace("Request"));
    }
    for (const id of rootNode.findAll({
      rule: { kind: "type_identifier", regex: "^NextResponse$" },
    })) {
      if (isUnderImportSpecifier(id)) continue;
      edits.push(id.replace("Response"));
    }
    for (const id of rootNode.findAll({
      rule: { kind: "identifier", regex: "^NextURL$" },
    })) {
      if (isUnderImportSpecifier(id)) continue;
      edits.push(id.replace("URL"));
    }
    for (const id of rootNode.findAll({
      rule: { kind: "type_identifier", regex: "^NextURL$" },
    })) {
      if (isUnderImportSpecifier(id)) continue;
      edits.push(id.replace("URL"));
    }
  }

  for (const mem of rootNode.findAll({
    rule: {
      kind: "member_expression",
      has: { field: "property", regex: "^nextUrl$" },
    },
  })) {
    if (mem.text().includes("?.")) continue;
    const obj = mem.field("object");
    const prop = mem.field("property");
    if (!obj || !prop || prop.text() !== "nextUrl") continue;
    edits.push(mem.replace(`new URL(${obj.text()}.url)`));
  }

  for (const call of rootNode.findAll({ rule: { kind: "call_expression" } })) {
    const fn = call.field("function");
    if (!fn || fn.kind() !== "member_expression") continue;
    const obj = fn.field("object");
    const prop = fn.field("property")?.text();
    if (obj?.kind() !== "identifier") continue;
    if (obj.text() !== "NextResponse" && obj.text() !== "Response") continue;
    if (prop !== "rewrite") continue;
    const argsText = call.field("arguments")?.text() ?? "";
    const argExpr = argsText
      .replace(/^\(\s*/, "")
      .replace(/\s*\)$/, "")
      .trim();
    if (!argExpr) continue;
    edits.push(call.replace(`Response.redirect(${argExpr}.toString(), 307)`));
  }

  if (acc.afterLocals.size > 0 || acc.connectionLocals.size > 0) {
    const pos = indexAfterLastImport(rootNode, source);
    edits.push({
      startPos: pos,
      endPos: pos,
      insertedText: buildServerRuntimeShimBlock(acc),
    });
  }

  if (edits.length === 0) return null;
  edits.sort((a, b) => b.startPos - a.startPos);
  const out = rootNode.commitEdits(edits);
  const out2 = out
    .replace(
      /\b(?:NextResponse|Response)\.rewrite\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g,
      "Response.redirect($1.toString(), 307)"
    )
    .replace(
      /\b(?:NextResponse|Response)\.rewrite\(\s*new URL\(([^)]+)\)\s*\)/g,
      "Response.redirect(new URL($1).toString(), 307)"
    );
  return stripLeadingBlankLines(out2);
};

export default codemod;

function buildServerRuntimeShimBlock(acc: StripAccumulator): string {
  const doc = "https://tanstack.com/start/latest/docs/framework/react/guide/server-routes";
  const lines: string[] = [];
  lines.push(
    `${TODO_PREFIX}next/server \`after\` / \`connection\` — minimal Promise shims; verify semantics vs Next (logging, dynamic rendering) — ${doc}\n`
  );

  for (const name of [...acc.afterLocals].sort()) {
    lines.push(`const ${name} = (cb: () => unknown) => { void Promise.resolve().then(cb); };`);
  }

  for (const name of [...acc.connectionLocals].sort()) {
    lines.push(`async function ${name}(): Promise<void> {}`);
  }

  return `\n${lines.join("\n")}\n`;
}

function indexAfterLastImport(rootNode: SgNode<TSX>, source: string): number {
  const imports = rootNode.findAll({ rule: { kind: "import_statement" } });
  if (imports.length === 0) return 0;
  let maxEnd = 0;
  for (const imp of imports) {
    let end = imp.range().end.index;
    while (end < source.length && (source[end] === " " || source[end] === "\t")) end++;
    if (source[end] === "\r") end++;
    if (source[end] === "\n") end++;
    if (end > maxEnd) maxEnd = end;
  }
  return maxEnd;
}

function stripLeadingBlankLines(s: string): string {
  return s.replace(/^(\r?\n[\t ]*)+/, "");
}

function parseImportSource(t: string): string | null {
  const m = t.match(/from\s*["']([^"']+)["']/);
  return m?.[1] ?? null;
}

function isUnderImportSpecifier(n: SgNode<TSX>): boolean {
  let x: SgNode<TSX> | null = n.parent();
  while (x) {
    if (x.kind() === "import_specifier") return true;
    if (x.kind() === "program") break;
    x = x.parent();
  }
  return false;
}

type ImportPlan =
  | { kind: "delete"; removedNextPrimitive: boolean }
  | { kind: "replace"; newText: string; removedNextPrimitive: boolean };

function buildNextServerImportRewrite(stmtText: string, acc: StripAccumulator): ImportPlan | null {
  const brace = stmtText.match(/\{\s*([^}]*)\s*\}\s*from/)?.[1];
  if (brace === null || brace === undefined) return null;

  const specs = splitSpecs(brace);
  if (specs.length === 0) return null;

  const isType = /^\s*import\s+type\b/.test(stmtText);
  const head = isType ? "import type" : "import";

  if (isType) {
    return buildTypeImportRewrite(stmtText, specs, head);
  }

  const uaSpecs: string[] = [];
  const imgSpecs: string[] = [];
  const keptOther: string[] = [];
  let removedNextPrimitive = false;

  for (const raw of specs) {
    const t = raw.trim();
    if (!t) continue;
    const meta = specifierMeta(t);
    if (!meta) continue;
    const { exported, local } = meta;

    if (exported === "NextRequest" || exported === "NextResponse" || exported === "NextURL") {
      removedNextPrimitive = true;
      continue;
    }
    if (
      exported === "userAgent" ||
      exported === "userAgentFromString" ||
      exported === "UserAgent"
    ) {
      uaSpecs.push(t);
      continue;
    }
    if (exported === "ImageResponse") {
      imgSpecs.push(t);
      continue;
    }
    if (exported === "URLPattern") {
      continue;
    }
    if (exported === "after") {
      acc.afterLocals.add(local);
      continue;
    }
    if (exported === "connection") {
      acc.connectionLocals.add(local);
      continue;
    }

    keptOther.push(t);
  }

  const lines: string[] = [];
  if (uaSpecs.length > 0) {
    lines.push(`import { ${uaSpecs.join(", ")} } from "${EDGE_USER_AGENT}";`);
  }
  if (imgSpecs.length > 0) {
    lines.push(`import { ${imgSpecs.join(", ")} } from "${NEXT_OG}";`);
  }
  if (keptOther.length > 0) {
    lines.push(`${head} { ${keptOther.join(", ")} } from "${NEXT_SERVER}";`);
  }

  if (lines.length === 0) {
    return { kind: "delete", removedNextPrimitive };
  }

  return {
    kind: "replace",
    newText: lines.join("\n"),
    removedNextPrimitive,
  };
}

function buildTypeImportRewrite(stmtText: string, specs: string[], head: string): ImportPlan {
  const stubs: { exported: string; local: string }[] = [];
  const remainder: string[] = [];
  let removedNextPrimitive = false;

  for (const raw of specs) {
    const t = raw.trim();
    if (!t) continue;
    const meta = specifierMeta(t);
    if (!meta) continue;
    const { exported, local } = meta;

    if (exported === "NextRequest" || exported === "NextResponse" || exported === "NextURL") {
      removedNextPrimitive = true;
      continue;
    }
    if (TYPE_STUB_EXPORTS.has(exported)) {
      stubs.push({ exported, local });
      continue;
    }
    remainder.push(t);
  }

  const doc = "https://tanstack.com/start/latest/docs/framework/react/guide/server-routes";

  if (remainder.length === 0 && stubs.length === 0) {
    return { kind: "delete", removedNextPrimitive };
  }

  if (remainder.length === 0 && stubs.length > 0) {
    const names = stubs.map((s) => s.exported).join(", ");
    const todo = `${TODO_PREFIX}next/server type stubs (${names}) — replace with TanStack / Web types — ${doc}\n`;
    const stubLines = stubs.map((s) => `type ${s.local} = unknown;`).join("\n");
    return {
      kind: "replace",
      newText: `${todo}${stubLines}`,
      removedNextPrimitive,
    };
  }

  if (remainder.length > 0 && stubs.length > 0) {
    const todo = `${TODO_PREFIX}next/server type stubs — replace with TanStack / Web types — ${doc}\n`;
    const stubLines = stubs.map((s) => `type ${s.local} = unknown;`).join("\n");
    const importLine = `${head} { ${remainder.join(", ")} } from "${NEXT_SERVER}";`;
    return {
      kind: "replace",
      newText: `${todo}${stubLines}\n${importLine}`,
      removedNextPrimitive,
    };
  }

  return {
    kind: "replace",
    newText: `${head} { ${remainder.join(", ")} } from "${NEXT_SERVER}";`,
    removedNextPrimitive,
  };
}

function specifierMeta(raw: string): { exported: string; local: string } | null {
  const t = raw.trim();
  const ta = /^type\s+([A-Za-z0-9_]+)(?:\s+as\s+(?:type\s+)?([A-Za-z0-9_]+))?$/.exec(t);
  if (ta) {
    const exported = ta[1] ?? "";
    return { exported, local: ta[2] ?? exported };
  }
  const id = /^([A-Za-z0-9_]+)(?:\s+as\s+(?:type\s+)?([A-Za-z0-9_]+))?$/.exec(t);
  if (!id) return null;
  const exported = id[1] ?? "";
  return { exported, local: id[2] ?? exported };
}

function splitSpecs(inner: string): string[] {
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

function deleteImportStatement(source: string, stmt: SgNode<TSX>): Edit {
  const start = stmt.range().start.index;
  let end = stmt.range().end.index;
  while (end < source.length && (source[end] === " " || source[end] === "\t")) end++;
  if (source[end] === "\r") end++;
  if (source[end] === "\n") end++;
  return { startPos: start, endPos: end, insertedText: "" };
}
