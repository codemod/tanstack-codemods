import type { SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { indexOfMatchingBrace } from "./balanced-text-scan.ts";
import { utf8ByteOffsetToUtf16Index } from "./js-string-utf8-offsets.ts";

/** UTF-16 code unit index of the opening `{` of an `object` literal (handles TSX `range()` drift). */
export function objectLiteralOpenBraceIndex(source: string, obj: SgNode<TSX>): number {
  const open = utf8ByteOffsetToUtf16Index(source, obj.range().start.index);
  if (open < source.length && source[open] === "{") return open;

  let minPairStart = Number.POSITIVE_INFINITY;
  for (const child of obj.children()) {
    if (child.kind() !== "pair") continue;
    minPairStart = Math.min(
      minPairStart,
      utf8ByteOffsetToUtf16Index(source, child.range().start.index)
    );
  }
  if (minPairStart !== Number.POSITIVE_INFINITY) {
    const routeObjMarker = source.lastIndexOf(")({", minPairStart);
    if (routeObjMarker !== -1) {
      const braceIdx = routeObjMarker + 2;
      if (braceIdx < source.length && source[braceIdx] === "{") {
        return braceIdx;
      }
    }
    for (let i = minPairStart; i >= 0 && minPairStart - i < 800; i--) {
      if (source[i] === "{") return i;
    }
  }

  const braceChild = obj.children().find((c) => c.kind() === "{");
  if (braceChild) return utf8ByteOffsetToUtf16Index(source, braceChild.range().start.index);

  return open;
}

/**
 * UTF-16 code unit index of the closing `}` of an `object` literal.
 *
 * Uses `indexOfMatchingBrace` from the object’s opening `{` so TSX/JSX in sibling
 * code cannot make `range().end` (or a raw `end - 1`) point at the wrong `}` in
 * large route files.
 */
export function closingBraceIndexOfObjectLiteral(source: string, obj: SgNode<TSX>): number | null {
  const open = objectLiteralOpenBraceIndex(source, obj);
  if (open >= source.length || source[open] !== "{") {
    const endB = obj.range().end.index;
    if (endB < 1) return null;
    const after = utf8ByteOffsetToUtf16Index(source, endB);
    return after > 0 ? after - 1 : null;
  }
  const close = indexOfMatchingBrace(source, open);
  return close === -1 ? null : close;
}

/**
 * If the line containing `i` has a `//` line comment (not `http://`), return the index of
 * the last non-whitespace character before that comment; otherwise return `i`.
 */
function surfaceIndexBeforeLineComment(source: string, objOpen: number, i: number): number {
  const lineStart = Math.max(objOpen + 1, source.lastIndexOf("\n", i - 1) + 1);
  const seg = source.slice(lineStart, i + 1);
  for (let u = 0; u + 1 < seg.length; u++) {
    if (seg[u] !== "/" || seg[u + 1] !== "/") continue;
    const prev = u === 0 ? " " : (seg[u - 1] ?? " ");
    // Avoid `http://`, `https://`, `foo://` (comment usually has ws/punctuation before `//`).
    if (!/[\s,;(){}\[\]=<>]/.test(prev)) continue;
    const abs = lineStart + u;
    let t = abs - 1;
    while (t >= lineStart) {
      const ch = source[t];
      if (ch === undefined || !/\s/.test(ch)) break;
      t--;
    }
    return Math.max(objOpen, t);
  }
  return i;
}

/**
 * True when inserting `,\\n<newProp>: …` immediately before `closeBrace` (UTF-16 index) needs a leading comma.
 *
 * Walks backward from the closing `}` with `{}` / `()` / `[]` depth so nested literals
 * (e.g. `fetch(url, { next: { … } })`) do not confuse the scan. If the last surface
 * token before `}` is already `,` (optionally after `//` line tail), returns false so we
 * do not emit a duplicate comma line before `loader:`.
 */
export function objectLiteralNeedsCommaAfterLastProperty(
  source: string,
  configObj: SgNode<TSX>,
  closeBrace: number
): boolean {
  const objOpen = objectLiteralOpenBraceIndex(source, configObj);

  /** If only whitespace sits between `}` and a `,`, the object already has a trailing comma. */
  let j = closeBrace - 1;
  while (j > objOpen) {
    const ch = source[j];
    if (ch === undefined || !/\s/.test(ch)) break;
    j--;
  }
  if (j > objOpen && source[j] === ",") return false;

  let i = closeBrace - 1;
  let brace = 0;
  let paren = 0;
  let bracket = 0;

  while (i > objOpen) {
    if (brace === 0 && paren === 0 && bracket === 0) {
      i = surfaceIndexBeforeLineComment(source, objOpen, i);
    }

    const c = source[i];
    if (c === undefined) break;

    if (brace === 0 && paren === 0 && bracket === 0) {
      if (/\s/.test(c)) {
        i--;
        continue;
      }
      if (c === ",") return false;
    }

    if (c === "}") {
      brace++;
      i--;
      continue;
    }
    if (c === "{") {
      brace--;
      i--;
      continue;
    }
    if (c === ")") {
      paren++;
      i--;
      continue;
    }
    if (c === "(") {
      paren--;
      i--;
      continue;
    }
    if (c === "]") {
      bracket++;
      i--;
      continue;
    }
    if (c === "[") {
      bracket--;
      i--;
      continue;
    }

    if (brace === 0 && paren === 0 && bracket === 0) {
      return true;
    }

    i--;
  }

  return true;
}
