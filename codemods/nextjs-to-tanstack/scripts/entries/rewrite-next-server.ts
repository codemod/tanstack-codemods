/**
 * Best-effort `next/server` → Web Fetch API mapping:
 * - `NextRequest` / `NextResponse` identifiers (outside `import_specifier`) → `Request` / `Response`.
 * - Drops those names from `next/server` imports; keeps the rest (`userAgent`, `after`, …).
 *
 * **Skips the file** when:
 * - `NextResponse.next` (middleware-only),
 * - `NextRequest as …` / `NextResponse as …` (aliases need manual mapping),
 * - `import * as … from "next/server"`.
 *
 * `// TODO (R4h)` once when primitives were migrated.
 */

import type { Codemod, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { TODO_PREFIX } from "../utils/sentinels.ts";

const NEXT_SERVER = "next/server";
const R4H_SENTINEL = "next/server migration (R4h)";

const UNSUPPORTED = [
  /\bNextResponse\.next\b/,
];

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root();
  const source = rootNode.text();

  for (const re of UNSUPPORTED) {
    if (re.test(source)) return null;
  }
  if (/(?:NextRequest|NextResponse)\s+as\s+/.test(source)) return null;
  if (/\*\s*as\s+\w+\s+from\s*["']next\/server["']/.test(source)) return null;

  const importStmts = rootNode
    .findAll({ rule: { kind: "import_statement" } })
    .filter((s) => parseImportSource(s.text()) === NEXT_SERVER);
  if (importStmts.length === 0) return null;

  let stripNextPrimitivesFromImports = false;
  const edits: Edit[] = [];

  const takeBanner = todoBannerTake(source);

  for (const stmt of importStmts) {
    const plan = buildNextServerImportRewrite(stmt.text());
    if (plan === null) continue;
    if (plan.removedNextPrimitive) stripNextPrimitivesFromImports = true;

    const orig = stmt.text();
    const nl = /\r?\n$/.test(orig) ? "\n" : "";
    if (plan.kind === "delete") {
      edits.push(
        deleteImportStatement(source, stmt, `${takeBanner()}`),
      );
      continue;
    }

    if (plan.newText.trim() === orig.replace(/\r?\n$/, "").trim()) continue;
    edits.push({
      startPos: stmt.range().start.index,
      endPos: stmt.range().end.index,
      insertedText: `${takeBanner()}${plan.newText}${nl}`,
    });
  }

  if (!stripNextPrimitivesFromImports && edits.length === 0) return null;

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
    const argExpr = argsText.replace(/^\(\s*/, "").replace(/\s*\)$/, "").trim();
    if (!argExpr) continue;
    edits.push(
      call.replace(`Response.redirect(${argExpr}.toString(), 307)`),
    );
  }

  if (edits.length === 0) return null;
  edits.sort((a, b) => b.startPos - a.startPos);
  const out = rootNode.commitEdits(edits);
  const out2 = out
    .replace(
      /\b(?:NextResponse|Response)\.rewrite\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g,
      "Response.redirect($1.toString(), 307)",
    )
    .replace(
      /\b(?:NextResponse|Response)\.rewrite\(\s*new URL\(([^)]+)\)\s*\)/g,
      "Response.redirect(new URL($1).toString(), 307)",
    );
  return out2;
};

export default codemod;

function parseImportSource(t: string): string | null {
  const m = t.match(/from\s*["']([^"']+)["']/);
  return m?.[1] ?? null;
}

function todoBannerTake(source: string): () => string {
  if (source.includes(R4H_SENTINEL)) {
    return (): string => "";
  }
  let used = false;
  const line = `${TODO_PREFIX}${R4H_SENTINEL}: confirm \`Request\`/\`Response\` types match your runtime; port remaining \`next/server\` helpers — https://tanstack.com/start/latest/docs/framework/react/guide/server-routes\n`;
  return (): string => {
    if (used) return "";
    used = true;
    return `\n${line}`;
  };
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

function buildNextServerImportRewrite(stmtText: string): ImportPlan | null {
  const brace = stmtText.match(/\{\s*([^}]*)\s*\}\s*from/)?.[1];
  if (brace === null || brace === undefined) return null;

  const specs = splitSpecs(brace);
  if (specs.length === 0) return null;
  const kept: string[] = [];
  let removedNextPrimitive = false;

  for (const raw of specs) {
    const t = raw.trim();
    if (!t) continue;
    const p = parseSpecifier(t);
    const exported = p?.exported ?? "";
    if (exported === "NextRequest" || exported === "NextResponse") {
      removedNextPrimitive = true;
      continue;
    }
    kept.push(t);
  }

  if (kept.length === 0) {
    return { kind: "delete", removedNextPrimitive };
  }

  const isType = /^\s*import\s+type\b/.test(stmtText);
  const head = isType ? "import type" : "import";

  return {
    kind: "replace",
    newText: `${head} { ${kept.join(", ")} } from "${NEXT_SERVER}";`,
    removedNextPrimitive,
  };
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

function parseSpecifier(raw: string): { exported: string } | null {
  const t = raw.trim();
  const ta = /^type\s+([A-Za-z0-9_]+)(?:\s+as\s+(?:type\s+)?([A-Za-z0-9_]+))?$/.exec(t);
  if (ta) return { exported: ta[1]! };
  const id =
    /^([A-Za-z0-9_]+)(?:\s+as\s+(?:type\s+)?([A-Za-z0-9_]+))?$/.exec(t);
  if (!id) return null;
  return { exported: id[1]! };
}

function deleteImportStatement(source: string, stmt: SgNode<TSX>, insertedText: string): Edit {
  const start = stmt.range().start.index;
  let end = stmt.range().end.index;
  while (end < source.length && (source[end] === " " || source[end] === "\t")) end++;
  if (source[end] === "\r") end++;
  if (source[end] === "\n") end++;
  return { startPos: start, endPos: end, insertedText };
}

