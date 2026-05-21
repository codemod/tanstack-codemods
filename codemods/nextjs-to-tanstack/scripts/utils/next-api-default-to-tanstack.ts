/**
 * Convert Next.js Pages `default export` API handlers (`NextApiRequest` / `NextApiResponse`)
 * to TanStack Start server handlers using Web `Response` (best-effort GET / POST).
 */

import { indexOfMatchingBrace } from "./balanced-text-scan.ts";

/** `openParenIdx` points at `(`; returns index of the matching `)`. Parens inside strings are ignored naïvely — fine for typical `(req: NextApiRequest, res: NextApiResponse)`. */
function indexOfMatchingParen(source: string, openParenIdx: number): number {
  let depth = 0;
  for (let i = openParenIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Pulls the inner text of `export default [async] function handler(...) { ... }` using
 * brace-aware scanning (respects strings / template literals / comments) so huge HTML
 * templates in the body do not confuse the matcher.
 *
 * Used when the JSSG runtime cannot safely walk the AST for very large route modules.
 */
export function extractNextPagesApiDefaultHandlerBodyInner(source: string): string | null {
  const m =
    /export\s+default\s+async\s+function\s+handler\s*\(/.exec(source) ??
    /export\s+default\s+function\s+handler\s*\(/.exec(source);
  if (!m) return null;
  const openParen = m.index + m[0].length - 1;
  const closeParen = indexOfMatchingParen(source, openParen);
  if (closeParen === -1) return null;
  let i = closeParen + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === undefined || !/\s/.test(ch)) break;
    i++;
  }
  if (source[i] !== "{") return null;
  const closeBrace = indexOfMatchingBrace(source, i);
  if (closeBrace === -1) return null;
  return source.slice(i + 1, closeBrace).trim();
}

export interface TransformNextApiBodyOptions {
  /** Route path contains a `$param` segment (enables `req.query` → `params`). */
  hasPathParams: boolean;
}

/** Strip `const { method } = req` and `if (method !== 'GET') { ...405... }` guard. */
export function stripMethodGetGuard(source: string): string {
  const s = source.replace(/^[\s\n]*const\s*\{\s*method\s*\}\s*=\s*req\s*;\s*/m, "");
  const ifMatch = /^[\s\n]*if\s*\(\s*method\s*!==\s*["']GET["']\s*\)\s*\{/m.exec(s);
  if (!ifMatch) return s;
  const openBrace = ifMatch.index + ifMatch[0].length - 1;
  const close = indexOfMatchingBrace(s, openBrace);
  if (close === -1) return s;
  let end = close + 1;
  while (end < s.length) {
    const ch = s[end];
    if (ch === undefined || !/\s/.test(ch)) break;
    end++;
  }
  return s.slice(0, ifMatch.index) + s.slice(end);
}

/** Path segments like `/api/blog/$slug`: map `req.query` to `params` (plus dotted keys). */
export function rewriteReqQueryToParams(source: string, hasPathParams: boolean): string {
  if (!hasPathParams) {
    return rewriteReqQueryFromSearchParams(source);
  }
  let out = source;
  out = out.replace(
    /const\s*\{\s*([a-zA-Z0-9_$,\s]+)\s*\}\s*=\s*req\.query\s*;/,
    (_, keys: string) => {
      const parts = keys
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      const line = parts.map((k) => `const ${k} = params.${k}`).join("\n");
      return line + (line ? ";" : "");
    }
  );
  out = out.replace(/\breq\.query\.(\w+)/g, "params.$1");
  return out;
}

/** Routes without `$param`: `req.query` → `URL` `searchParams` as `query`. */
export function rewriteReqQueryFromSearchParams(source: string): string {
  if (!/\breq\.query\b/.test(source)) return source;
  let out = source.replace(/^\s+/, "");
  out = `const query = Object.fromEntries(new URL(request.url).searchParams);\n${out}`;
  out = out.replace(
    /const\s*\{\s*([^}]+)\s*\}\s*=\s*req\.query\s*;/,
    (_, keys: string) => `const { ${keys.trim()} } = query;`
  );
  out = out.replace(/\breq\.query\.(\w+)/g, "query.$1");
  out = out.replace(/\breq\.query\b/g, "query");
  return out;
}

/** Strip `if (req.method !== 'POST') { ... }`. */
export function stripMethodNonPostGuard(source: string): string {
  const ifMatch = /^[\s\n]*if\s*\(\s*req\.method\s*!==\s*["']POST["']\s*\)\s*\{/m.exec(source);
  if (!ifMatch) return source;
  const openBrace = ifMatch.index + ifMatch[0].length - 1;
  const close = indexOfMatchingBrace(source, openBrace);
  if (close === -1) return source;
  let end = close + 1;
  while (end < source.length) {
    const ch = source[end];
    if (ch === undefined || !/\s/.test(ch)) break;
    end++;
  }
  return source.slice(0, ifMatch.index) + source.slice(end);
}

export function rewriteReqBodyFromJson(source: string): string {
  if (!/\breq\.body\b/.test(source)) return source;
  let out = source.replace(/\breq\.body\b/g, "body");
  out = `const body = (await request.json()) as Record<string, unknown>;\n${out}`;
  return out;
}

function balancedParenEnd(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return openIdx;
}

/** Replace `res.status(n).json(...)` and `return res.status(n).json(...)` with `Response.json`. */
export function replaceResStatusJsonCalls(source: string): string {
  let result = source;
  for (let guard = 0; guard < 500; guard++) {
    const m = /(?:return\s+)?\bres\.status\(\s*(\d+)\s*\)\s*\.\s*json\s*\(\s*/m.exec(result);
    if (!m) {
      break;
    }
    const status = m[1] ?? "200";
    const jsonOpenIdx = m.index + m[0].length - 1;
    if (result[jsonOpenIdx] !== "(") {
      break;
    }
    const afterClose = balancedParenEnd(result, jsonOpenIdx);
    let cutEnd = afterClose;
    if (result[cutEnd] === ";") cutEnd++;
    const inner = result.slice(jsonOpenIdx + 1, afterClose - 1);
    const replacement = `return Response.json(${inner}, { status: ${status} });`;
    result = result.slice(0, m.index) + replacement + result.slice(cutEnd);
  }
  return result;
}

/** Replace `res.status(n).end(...)` (optional `return`). */
export function replaceResStatusEndCalls(
  source: string,
  options?: { allow405Method?: "GET" | "POST" }
): string {
  const allow405 = options?.allow405Method ?? "GET";
  let result = source;
  for (let guard = 0; guard < 100; guard++) {
    const m = /(?:return\s+)?\bres\.status\(\s*(\d+)\s*\)\s*\.\s*end\s*\(\s*/m.exec(result);
    if (!m) {
      break;
    }
    const status = m[1] ?? "200";
    const openIdx = m.index + m[0].length - 1;
    if (result[openIdx] !== "(") {
      break;
    }
    const afterClose = balancedParenEnd(result, openIdx);
    let cutEnd = afterClose;
    if (result[cutEnd] === ";") cutEnd++;
    const replacement =
      status === "405"
        ? `return new Response(null, { status: 405, headers: { Allow: "${allow405}" } });`
        : `return new Response(null, { status: ${status} });`;
    result = result.slice(0, m.index) + replacement + result.slice(cutEnd);
  }
  return result;
}

export function inferDefaultExportPagesApiKind(bodyInner: string): "GET" | "POST" {
  const t = bodyInner;
  if (/\breq\.body\b/.test(t)) return "POST";
  if (/req\.method\s*!==\s*["']POST["']/.test(t)) return "POST";
  if (/req\.method\s*===\s*["']POST["']/.test(t)) return "POST";
  return "GET";
}

export function transformNextApiDefaultHandlerBody(
  bodyInner: string,
  options: TransformNextApiBodyOptions,
  kind: "GET" | "POST"
): string {
  let s = bodyInner.trim();
  if (kind === "POST") {
    s = stripMethodNonPostGuard(s);
    s = rewriteReqBodyFromJson(s);
  } else {
    s = stripMethodGetGuard(s);
  }
  s = rewriteReqQueryToParams(s, options.hasPathParams);
  s = replaceResStatusJsonCalls(s);
  s = replaceResStatusEndCalls(s, {
    allow405Method: kind === "POST" ? "POST" : "GET",
  });
  return s;
}

export function isMultiMethodNextHandler(bodySource: string): boolean {
  if (/\bmethod\s*===\s*["']POST["']/.test(bodySource)) return true;
  if (/\bmethod\s*===\s*["']PUT["']/.test(bodySource)) return true;
  if (/\bmethod\s*===\s*["']DELETE["']/.test(bodySource)) return true;
  if (/\bmethod\s*===\s*["']PATCH["']/.test(bodySource)) return true;
  if (/switch\s*\(\s*method\s*\)/.test(bodySource)) return true;
  return false;
}
