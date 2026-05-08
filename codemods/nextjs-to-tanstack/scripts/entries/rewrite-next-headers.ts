/**
 * Best-effort migration of `next/headers` `cookies` and `headers`:
 * - `cookies().get(name)` / `(await cookies()).get(name)` → `getCookie(name)` (+ optional `.value` strip)
 * - `cookies().set(name, value, opts?)` → `setCookie(name, value, opts?)`
 * - `cookies().delete(name)` → `deleteCookie(name)`
 * - `cookies().has(name)` → `Boolean(getCookie(name))`
 * - `cookies().getAll()` → `Object.entries(getCookies()).map(([name, value]) => ({ name, value }))`
 * - `headers().get(name)` / `(await headers()).get(name)` → `getHeaders()[name]`
 *
 * A leading `// TODO: … (R4f)` banner is inserted once (unless already present). Helpers come from
 * `@tanstack/start/server` — loaders, `createServerFn`, server routes only.
 *
 * Bare factories (e.g. `buildLegacyCtx(await headers(), await cookies(), …)`) become Start-compatible
 * values: `new Headers(…)` from `getHeaders()` and a `{ getAll() {…} }` shim from `getCookies()`.
 *
 * `draftMode` and other exports stay on a reduced `next/headers` import. If a `cookies()` / `headers()`
 * call is **not** supported above or bare as defined here (e.g. stored then used for other methods), the file is skipped.
 */

import type { Codemod, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { TODO_PREFIX } from "../utils/sentinels.ts";

const NEXT_HEADERS = "next/headers";
const START_SERVER = "@tanstack/start/server";

const R4F_SENTINEL = "next/headers migration (R4f)";

const COOKIE_STORE_METHODS = new Set(["get", "set", "delete", "has", "getAll"]);
const HEADER_STORE_METHODS = new Set(["get"]);

type Builtin = "cookies" | "headers" | "draftMode";

type Needs = {
  getCookie: boolean;
  getHeaders: boolean;
  setCookie: boolean;
  deleteCookie: boolean;
  getCookies: boolean;
};

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root();
  const source = rootNode.text();

  const hdrImports = rootNode
    .findAll({ rule: { kind: "import_statement" } })
    .filter((s) => parseImportSource(s.text()) === NEXT_HEADERS);

  const locals = extractBindings(hdrImports);
  if (locals.size === 0) return null;

  const cookiesNm = [...locals.entries()].find(([, b]) => b === "cookies")?.[0];
  const headersNm = [...locals.entries()].find(([, b]) => b === "headers")?.[0];

  if (!cookiesNm && !headersNm) return null;

  if (cookiesNm && unsupportedCookiesFactories(rootNode, cookiesNm)) return null;
  if (headersNm && unsupportedHeadersFactories(rootNode, headersNm)) return null;

  const cookieBindingsNeedValueStrip = cookiesNm ? cookieGetBindingNames(rootNode, cookiesNm) : new Set<string>();

  const needs = scanNeeds(rootNode, cookiesNm, headersNm);
  if (
    !needs.getCookie &&
    !needs.getHeaders &&
    !needs.setCookie &&
    !needs.deleteCookie &&
    !needs.getCookies
  ) {
    return null;
  }

  const take = todoBannerTake(source);
  const edits: Edit[] = [];

  for (const stmt of hdrImports) {
    const plan = buildImportRewrite(stmt.text(), locals, needs);
    if (plan === null) continue;
    const nl = /\r?\n$/.exec(stmt.text())?.[0] ?? "\n";

    if (plan.kind === "delete") edits.push(blankStmt(source, stmt));
    else if (plan.text + nl !== stmt.text()) edits.push(stmt.replace(`${take()}${plan.text}${nl}`));
  }

  for (const outer of rootNode.findAll({ rule: { kind: "call_expression" } })) {
    const fn = outer.field("function");
    if (!fn || fn.kind() !== "member_expression") continue;
    const prop = fn.field("property")?.text();
    if (!prop) continue;
    const obj = fn.field("object");
    if (!obj) continue;

    const cookiesRoot = unwrapToCookiesFactory(obj, cookiesNm);
    if (cookiesRoot) {
      if (!COOKIE_STORE_METHODS.has(prop)) continue;

      if (prop === "get") {
        const a0 = firstArg(outer.field("arguments"));
        if (!a0) continue;
        const a0t = a0.text();
        let target: SgNode<TSX> = outer;
        const up = outer.parent();
        if (
          up?.kind() === "member_expression" &&
          up.field("property")?.text() === "value" &&
          up.field("object")?.id() === outer.id()
        ) {
          target = up;
        }
        edits.push(target.replace(`${take()}getCookie(${a0t})`));
        continue;
      }

      if (prop === "set") {
        const args = listArgs(outer.field("arguments"));
        if (args.length < 2) continue;
        const inner = args.map((n) => n.text()).join(", ");
        edits.push(outer.replace(`${take()}setCookie(${inner})`));
        continue;
      }

      if (prop === "delete") {
        const a0 = firstArg(outer.field("arguments"));
        if (!a0) continue;
        edits.push(outer.replace(`${take()}deleteCookie(${a0.text()})`));
        continue;
      }

      if (prop === "has") {
        const a0 = firstArg(outer.field("arguments"));
        if (!a0) continue;
        edits.push(outer.replace(`${take()}Boolean(getCookie(${a0.text()}))`));
        continue;
      }

      if (prop === "getAll") {
        edits.push(
          outer.replace(
            `${take()}Object.entries(getCookies()).map(([name, value]) => ({ name, value }))`,
          ),
        );
        continue;
      }
    }

    const headersRoot = unwrapToHeadersFactory(obj, headersNm);
    if (headersRoot && prop === "get") {
      const a0 = firstArg(outer.field("arguments"));
      if (!a0) continue;
      edits.push(outer.replace(`${take()}getHeaders()[${a0.text()}]`));
    }
  }

  if (cookiesNm) {
    for (const c of rootNode.findAll({
      rule: {
        kind: "call_expression",
        has: { field: "function", kind: "identifier", regex: `^${escapeRx(cookiesNm)}$` },
      },
    })) {
      if (!isZeroArgCall(c)) continue;
      if (isSupportedCookieFactoryRoot(c)) continue;
      if (!isBareHeadersCookiesFactory(c)) continue;
      const tgt = bareReplacementTarget(c);
      edits.push(
        tgt.replace(
          `${take()}{ getAll: () => Object.entries(getCookies()).map(([name, value]) => ({ name, value: String(value ?? "") })) }`,
        ),
      );
    }
  }

  if (headersNm) {
    for (const h of rootNode.findAll({
      rule: {
        kind: "call_expression",
        has: { field: "function", kind: "identifier", regex: `^${escapeRx(headersNm)}$` },
      },
    })) {
      if (!isZeroArgCall(h)) continue;
      if (isSupportedHeadersFactoryRoot(h)) continue;
      if (!isBareHeadersCookiesFactory(h)) continue;
      const tgt = bareReplacementTarget(h);
      edits.push(
        tgt.replace(
          `${take()}new Headers(Object.entries(getHeaders()).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")] as [string, string]))`,
        ),
      );
    }
  }

  if (cookieBindingsNeedValueStrip.size > 0) {
    for (const mem of rootNode.findAll({ rule: { kind: "member_expression" } })) {
      if (mem.field("property")?.text() !== "value") continue;
      const o = mem.field("object");
      if (!o || o.kind() !== "identifier") continue;
      if (!cookieBindingsNeedValueStrip.has(o.text())) continue;
      edits.push(mem.replace(`${take()}${o.text()}`));
    }
  }

  if (edits.length === 0) return null;

  edits.sort((a, b) => b.startPos - a.startPos);
  return rootNode.commitEdits(edits);
};

export default codemod;

function scanNeeds(
  rootNode: SgNode<TSX>,
  cookiesNm: string | undefined,
  headersNm: string | undefined,
): Needs {
  const needs: Needs = {
    getCookie: false,
    getHeaders: false,
    setCookie: false,
    deleteCookie: false,
    getCookies: false,
  };

  for (const outer of rootNode.findAll({ rule: { kind: "call_expression" } })) {
    const fn = outer.field("function");
    if (!fn || fn.kind() !== "member_expression") continue;
    const prop = fn.field("property")?.text();
    if (!prop) continue;
    const obj = fn.field("object");
    if (!obj) continue;

    if (cookiesNm && unwrapToCookiesFactory(obj, cookiesNm)) {
      if (prop === "get" && firstArg(outer.field("arguments"))) needs.getCookie = true;
      if (prop === "set") needs.setCookie = true;
      if (prop === "delete") needs.deleteCookie = true;
      if (prop === "has") needs.getCookie = true;
      if (prop === "getAll") needs.getCookies = true;
    }

    if (headersNm && unwrapToHeadersFactory(obj, headersNm) && prop === "get") {
      if (firstArg(outer.field("arguments"))) needs.getHeaders = true;
    }
  }

  if (cookiesNm) {
    for (const c of rootNode.findAll({
      rule: {
        kind: "call_expression",
        has: { field: "function", kind: "identifier", regex: `^${escapeRx(cookiesNm)}$` },
      },
    })) {
      if (!isZeroArgCall(c)) continue;
      if (isSupportedCookieFactoryRoot(c)) continue;
      if (isBareHeadersCookiesFactory(c)) needs.getCookies = true;
    }
  }

  if (headersNm) {
    for (const h of rootNode.findAll({
      rule: {
        kind: "call_expression",
        has: { field: "function", kind: "identifier", regex: `^${escapeRx(headersNm)}$` },
      },
    })) {
      if (!isZeroArgCall(h)) continue;
      if (isSupportedHeadersFactoryRoot(h)) continue;
      if (isBareHeadersCookiesFactory(h)) needs.getHeaders = true;
    }
  }

  return needs;
}

function unsupportedCookiesFactories(root: SgNode<TSX>, cookiesNm: string): boolean {
  for (const c of root.findAll({
    rule: {
      kind: "call_expression",
      has: { field: "function", kind: "identifier", regex: `^${escapeRx(cookiesNm)}$` },
    },
  })) {
    if (!isZeroArgCall(c)) return true;
    if (isSupportedCookieFactoryRoot(c)) continue;
    if (isBareHeadersCookiesFactory(c)) continue;
    return true;
  }
  return false;
}

function unsupportedHeadersFactories(root: SgNode<TSX>, headersNm: string): boolean {
  for (const h of root.findAll({
    rule: {
      kind: "call_expression",
      has: { field: "function", kind: "identifier", regex: `^${escapeRx(headersNm)}$` },
    },
  })) {
    if (!isZeroArgCall(h)) return true;
    if (isSupportedHeadersFactoryRoot(h)) continue;
    if (isBareHeadersCookiesFactory(h)) continue;
    return true;
  }
  return false;
}

function isSupportedCookieFactoryRoot(factoryCall: SgNode<TSX>): boolean {
  let cur: SgNode<TSX> = factoryCall;
  for (;;) {
    const p: SgNode<TSX> | null = cur.parent();
    if (!p) return false;
    if (p.kind() === "await_expression" || p.kind() === "parenthesized_expression") {
      cur = p;
      continue;
    }
    if (
      p.kind() === "member_expression" &&
      p.field("object")?.id() === cur.id() &&
      COOKIE_STORE_METHODS.has(p.field("property")?.text() ?? "")
    ) {
      const gp = p.parent();
      return Boolean(
        gp?.kind() === "call_expression" && gp.field("function")?.id() === p.id(),
      );
    }
    return false;
  }
}

function isSupportedHeadersFactoryRoot(factoryCall: SgNode<TSX>): boolean {
  let cur: SgNode<TSX> = factoryCall;
  for (;;) {
    const p: SgNode<TSX> | null = cur.parent();
    if (!p) return false;
    if (p.kind() === "await_expression" || p.kind() === "parenthesized_expression") {
      cur = p;
      continue;
    }
    if (
      p.kind() === "member_expression" &&
      p.field("object")?.id() === cur.id() &&
      HEADER_STORE_METHODS.has(p.field("property")?.text() ?? "")
    ) {
      const gp = p.parent();
      return Boolean(
        gp?.kind() === "call_expression" && gp.field("function")?.id() === p.id(),
      );
    }
    return false;
  }
}

/** Passed-through factory (e.g. `buildLegacyCtx(await headers(), …)`) vs chained `.get` / unknown methods. */
function isBareHeadersCookiesFactory(factoryCall: SgNode<TSX>): boolean {
  let cur: SgNode<TSX> = factoryCall;
  for (;;) {
    const p: SgNode<TSX> | null = cur.parent();
    if (!p) return true;
    if (p.kind() === "await_expression" || p.kind() === "parenthesized_expression") {
      cur = p;
      continue;
    }
    if (p.kind() === "member_expression" && p.field("object")?.id() === cur.id()) {
      return false;
    }
    return true;
  }
}

function bareReplacementTarget(factoryCall: SgNode<TSX>): SgNode<TSX> {
  const p = factoryCall.parent();
  if (p?.kind() === "await_expression") {
    const inner = singleNonPunctuationChild(p);
    if (inner && inner.id() === factoryCall.id()) return p;
  }
  return factoryCall;
}

function unwrapToCookiesFactory(node: SgNode<TSX>, cookiesNm: string | undefined): SgNode<TSX> | null {
  if (!cookiesNm) return null;
  let x: SgNode<TSX> | null = node;
  for (;;) {
    if (x.kind() === "parenthesized_expression") {
      x = singleNonPunctuationChild(x);
      if (!x) return null;
      continue;
    }
    if (x.kind() === "await_expression") {
      x = singleNonPunctuationChild(x);
      if (!x) return null;
      continue;
    }
    break;
  }
  if (
    x.kind() === "call_expression" &&
    x.field("function")?.kind() === "identifier" &&
    x.field("function")?.text() === cookiesNm &&
    isZeroArgCall(x)
  ) {
    return x;
  }
  return null;
}

function unwrapToHeadersFactory(node: SgNode<TSX>, headersNm: string | undefined): SgNode<TSX> | null {
  if (!headersNm) return null;
  let x: SgNode<TSX> | null = node;
  for (;;) {
    if (x.kind() === "parenthesized_expression") {
      x = singleNonPunctuationChild(x);
      if (!x) return null;
      continue;
    }
    if (x.kind() === "await_expression") {
      x = singleNonPunctuationChild(x);
      if (!x) return null;
      continue;
    }
    break;
  }
  if (
    x.kind() === "call_expression" &&
    x.field("function")?.kind() === "identifier" &&
    x.field("function")?.text() === headersNm &&
    isZeroArgCall(x)
  ) {
    return x;
  }
  return null;
}

function isZeroArgCall(c: SgNode<TSX>): boolean {
  const args = c.field("arguments");
  if (!args) return true;
  for (const ch of args.children()) {
    const k = ch.kind();
    if (k === "(" || k === ")" || k === ",") continue;
    return false;
  }
  return true;
}

function listArgs(args: SgNode<TSX> | null): SgNode<TSX>[] {
  const out: SgNode<TSX>[] = [];
  if (!args) return out;
  for (const ch of args.children()) {
    const k = ch.kind();
    if (k === "(" || k === ")" || k === ",") continue;
    out.push(ch as SgNode<TSX>);
  }
  return out;
}

function todoBannerTake(source: string): () => string {
  if (source.includes(R4F_SENTINEL)) {
    return (): string => "";
  }
  let used = false;
  const line = `${TODO_PREFIX}${R4F_SENTINEL}: \`getCookie\` / \`getHeaders\` / \`setCookie\` / \`deleteCookie\` / \`getCookies\` — TanStack Start server context only; \`draftMode\` / other \`next/headers\` usage — https://tanstack.com/start/latest/docs/framework/react/guide/server-functions\n`;
  return (): string => {
    if (used) return "";
    used = true;
    return `\n${line}`;
  };
}

function cookieGetBindingNames(root: SgNode<TSX>, cookiesNm: string): Set<string> {
  const names = new Set<string>();
  for (const decl of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const nameNode = decl.field("name");
    if (!nameNode || nameNode.kind() !== "identifier") continue;
    const init = decl.field("value");
    if (!init) continue;
    if (!isCookieGetCallExpr(init, cookiesNm)) continue;
    names.add(nameNode.text());
  }
  return names;
}

function isCookieGetCallExpr(n: SgNode<TSX>, cookiesNm: string): boolean {
  if (n.kind() !== "call_expression") return false;
  const fn = n.field("function");
  if (!fn || fn.kind() !== "member_expression") return false;
  if (fn.field("property")?.text() !== "get") return false;
  const obj = fn.field("object");
  if (!obj) return false;
  const factoryBase = unwrapAwaitParens(obj);
  if (!factoryBase || factoryBase.kind() !== "call_expression") return false;
  const callee = factoryBase.field("function");
  return Boolean(callee?.kind() === "identifier" && callee.text() === cookiesNm);
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ImportRewrite = { kind: "delete" } | { kind: "replace"; text: string };

function buildImportRewrite(
  stmtText: string,
  locals: Map<string, Builtin>,
  needs: Needs,
): ImportRewrite | null {
  const brace = extractNamedBrace(stmtText);
  if (brace === null) return null;

  const kept: string[] = [];
  for (const raw of splitSpecs(brace)) {
    const p = parsePiece(raw);
    if (!p) {
      kept.push(raw.trim());
      continue;
    }
    const b = locals.get(p.local);
    if (b === "cookies" || b === "headers") continue;
    kept.push(p.raw);
  }

  const names: string[] = [];
  if (needs.deleteCookie) names.push("deleteCookie");
  if (needs.getCookie) names.push("getCookie");
  if (needs.getCookies) names.push("getCookies");
  if (needs.getHeaders) names.push("getHeaders");
  if (needs.setCookie) names.push("setCookie");

  const lines: string[] = [];
  if (names.length > 0) {
    names.sort();
    lines.push(`import { ${names.join(", ")} } from "${START_SERVER}";`);
  }
  if (kept.length) lines.push(`import { ${kept.join(", ")} } from "${NEXT_HEADERS}";`);

  if (lines.length === 0) return { kind: "delete" };
  return { kind: "replace", text: lines.join("\n") };
}

function parseImportSource(t: string): string | null {
  const m = t.match(/from\s*["']([^"']+)["']/);
  return m?.[1] ?? null;
}

function extractNamedBrace(text: string): string | null {
  const m = text.match(/\{\s*([^}]*)\s*\}\s*from/);
  return m?.[1] ?? null;
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

function parsePiece(raw: string): { exported: string; local: string; raw: string } | null {
  const t = raw.trim();
  const am = /^([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)$/.exec(t);
  if (am) return { exported: am[1]!, local: am[2]!, raw: t };
  const id = /^([A-Za-z0-9_]+)$/.exec(t);
  if (!id) return null;
  return { exported: id[1]!, local: id[1]!, raw: t };
}

function extractBindings(stmts: SgNode<TSX>[]): Map<string, Builtin> {
  const out = new Map<string, Builtin>();
  for (const stmt of stmts) {
    const brace = extractNamedBrace(stmt.text());
    if (!brace) continue;
    for (const r of splitSpecs(brace)) {
      const p = parsePiece(r);
      if (!p) continue;
      if (p.exported === "cookies") out.set(p.local, "cookies");
      else if (p.exported === "headers") out.set(p.local, "headers");
      else if (p.exported === "draftMode") out.set(p.local, "draftMode");
    }
  }
  return out;
}

function unwrapAwaitParens(n: SgNode<TSX>): SgNode<TSX> | null {
  let x: SgNode<TSX> | null = n;
  if (x.kind() === "parenthesized_expression") {
    x = singleNonPunctuationChild(x);
  }
  if (!x) return null;
  if (x.kind() === "await_expression") {
    x = singleNonPunctuationChild(x);
  }
  return x;
}

function singleNonPunctuationChild(n: SgNode<TSX>): SgNode<TSX> | null {
  for (const c of n.children()) {
    const k = c.kind();
    if (k === "(" || k === ")" || k === "await") continue;
    return c as SgNode<TSX>;
  }
  return null;
}

function firstArg(args: SgNode<TSX> | null): SgNode<TSX> | null {
  if (!args) return null;
  for (const ch of args.children()) {
    const k = ch.kind();
    if (k === "(" || k === ")" || k === ",") continue;
    return ch as SgNode<TSX>;
  }
  return null;
}

function blankStmt(source: string, stmt: SgNode<TSX>): Edit {
  const start = stmt.range().start.index;
  let end = stmt.range().end.index;
  while (end < source.length && (source[end] === " " || source[end] === "\t")) end++;
  if (source[end] === "\r") end++;
  if (source[end] === "\n") end++;
  return { startPos: start, endPos: end, insertedText: "" };
}
