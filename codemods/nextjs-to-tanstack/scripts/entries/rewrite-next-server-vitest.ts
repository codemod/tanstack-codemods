/**
 * Vitest / test files that use `next/server` middleware helpers (`NextResponse.next`,
 * `NextResponse.rewrite`) are skipped by `rewrite-next-server.ts`. This step replaces
 * those imports with small Fetch-API shims so `next/server` can be dropped in tests.
 *
 * Strips `vi.mock("next/server", …)` factories when present. Adds one TODO (R4h-test).
 */

import type { Codemod } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { getFilename, normalizePath } from "../utils/paths.ts";
import { TODO_PREFIX } from "../utils/sentinels.ts";

const R4H_TEST = "next/server Vitest shim (R4h-test)";

const SHIM = `
${TODO_PREFIX}${R4H_TEST}: Replace with \`Request\`/\`Response\` when tests no longer mimic Next middleware — https://tanstack.com/start/latest/docs/framework/react/guide/server-routes
type NextResponseInit = ResponseInit & { request?: { headers?: Headers } };

function __nextResponseJson(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

const NextResponse = Object.assign(
  function NextResponse(body?: BodyInit | null, init?: ResponseInit): Response {
    return new Response(body, init);
  },
  {
    json: __nextResponseJson,
    next: (init?: NextResponseInit) =>
      new Response(null, {
        status: 200,
        ...init,
        headers: {
          "x-middleware-next": "1",
          ...Object.fromEntries(new Headers(init?.headers)),
        },
      }),
    rewrite: (url: URL | string, init?: ResponseInit) => {
      const rewriteUrl = typeof url === "string" ? new URL(url, "http://localhost") : url;
      return new Response(null, {
        status: 200,
        ...init,
        headers: {
          "x-middleware-rewrite": rewriteUrl.toString(),
          ...Object.fromEntries(new Headers(init?.headers)),
        },
      });
    },
    redirect: (url: URL | string, statusOrInit?: number | ResponseInit) => {
      const redirectUrl = typeof url === "string" ? new URL(url, "http://localhost") : url;
      const status =
        typeof statusOrInit === "number"
          ? statusOrInit
          : (typeof statusOrInit === "object" && statusOrInit && "status" in statusOrInit
              ? (statusOrInit as ResponseInit).status
              : undefined) ?? 307;
      const baseInit =
        typeof statusOrInit === "object" && statusOrInit !== null && typeof statusOrInit !== "number"
          ? statusOrInit
          : {};
      const headers = new Headers((baseInit as ResponseInit).headers);
      headers.set("location", redirectUrl.toString());
      return new Response(null, { ...baseInit, status, headers });
    },
  },
);

class NextRequest extends Request {
  private readonly __cookieMap = new Map<string, string>();
  get nextUrl(): URL {
    return new URL(this.url);
  }
  cookies = {
    get: (name: string) => {
      const value = this.__cookieMap.get(name);
      return value !== undefined ? { name, value } : undefined;
    },
    set: (name: string, value: string) => {
      this.__cookieMap.set(name, value);
    },
  };
}

`;

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root();
  const file = normalizePath(getFilename(root));
  if (!/\.(test|spec)\.(m?[tj]sx?|m?[tj]s)$/.test(file)) {
    return null;
  }

  let s = rootNode.text();
  if (!/next\/server/.test(s)) return null;

  const needsShim =
    /\bvi\.mock\s*\(\s*["']next\/server["']/.test(s) ||
    /\bNextResponse\.next\b/.test(s) ||
    /\bNextResponse\.rewrite\b/.test(s);
  if (!needsShim) return null;

  s = s.replace(/^\/\/ TODO: remaining `next\/server`[^\n]*\r?\n/gm, "");

  s = stripViMockNextServer(s);
  s = s.replace(
    /^[ \t]*.*?vi\.importActual\s*\(\s*["']next\/server["']\)\s*;?\s*\r?\n/gm,
    "",
  );

  s = s.replace(
    /^[ \t]*import\s+(?:type\s+)?\{[^}]*\}\s*from\s*["']next\/server["']\s*;?\s*\r?\n/gm,
    "",
  );
  s = s.replace(
    /^[ \t]*import\s+type\s+\{\s*NextRequest\s*\}\s*from\s*["']next\/server["']\s*;?\s*\r?\n/gm,
    "",
  );
  s = s.replace(
    /^[ \t]*import\s+type\s+\{\s*NextResponse\s*\}\s*from\s*["']next\/server["']\s*;?\s*\r?\n/gm,
    "",
  );

  const insertAt = findLastImportEnd(s);
  s = s.slice(0, insertAt) + SHIM + s.slice(insertAt);

  if (s === rootNode.text()) return null;
  const r = rootNode.range();
  return rootNode.commitEdits([
    { startPos: r.start.index, endPos: r.end.index, insertedText: s },
  ]);
};

export default codemod;

function findLastImportEnd(s: string): number {
  const lines = s.split("\n");
  let lastEnd = 0;
  let offset = 0;
  for (const line of lines) {
    if (/^\s*import\s+/.test(line)) {
      lastEnd = offset + line.length;
    }
    offset += line.length + 1;
  }
  if (lastEnd === 0) return 0;
  const nl = s[lastEnd] === "\r" ? 2 : 1;
  return lastEnd < s.length && s[lastEnd] === "\n" ? lastEnd + 1 : lastEnd + nl;
}

function stripViMockNextServer(s: string): string {
  const re = /vi\.mock\s*\(\s*["']next\/server["']/g;
  let out = s;
  let match: RegExpExecArray | null;
  while ((match = re.exec(out)) !== null) {
    const start = match.index;
    const openParen = out.indexOf("(", start);
    if (openParen === -1) break;
    const end = findMatchingCloseParen(out, openParen);
    if (end === -1) break;
    let after = end + 1;
    while (after < out.length && /\s/.test(out[after]!)) after++;
    if (out[after] === ";") after++;
    out = out.slice(0, start) + out.slice(after);
    re.lastIndex = start;
  }
  return out;
}

function findMatchingCloseParen(src: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      i++;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}
