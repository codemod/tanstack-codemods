/**
 * Scan plain source text with minimal string / template / comment awareness so
 * `{` / `}` inside literals don't corrupt brace depth (used by API/route repair).
 *
 * Also skips TSX `<Foo>…</Foo>` subtrees while matching braces so `{items.map(…)}`
 * and similar JSX children don't terminate the enclosing `createFileRoute(...) ({ … })`
 * object early.
 */

const JSX_LEADING_WORDS = new Set([
  "return",
  "throw",
  "case",
  "default",
  "typeof",
  "void",
  "yield",
  "await",
  "do",
  "else",
  "new",
  "extends",
]);

const DQ: "'" | '"' = "\u0022";

function precedingNonWs(source: string, ltIdx: number): number {
  let j = ltIdx - 1;
  while (j >= 0 && /[\t \r\n]/.test(source[j]!)) j--;
  return j;
}

/** Heuristic: `<div` (TSX) vs `a < b` / `a<b` (comparison). */
export function isLikelyTsxJsxOpen(source: string, ltIdx: number): boolean {
  if (source[ltIdx] !== "<") return false;
  const n1 = source[ltIdx + 1];
  if (n1 === undefined) return false;
  if (n1 === "/") return true;
  if (n1 === "!") return true;
  if (n1 === ">") return true;
  if (!/[A-Za-z_$]/.test(n1)) return false;

  let j = precedingNonWs(source, ltIdx);
  if (j < 0) return true;
  const c = source[j]!;

  if (c === "(") return true;
  if (/[,:=[{\[?!&|+\-*/%^~]/.test(c)) return true;
  if (c === ">") return true;
  if (c === "}") return true;
  if (c === ")") return true;

  let k = j;
  while (k >= 0 && /[\w$]/.test(source[k]!)) k--;
  const word = source.slice(k + 1, j + 1);
  if (JSX_LEADING_WORDS.has(word)) return true;

  if (/[a-zA-Z0-9_$]/.test(c)) return false;
  return true;
}

function skipStringLiteral(source: string, start: number, q: "'" | '"'): number {
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === q) return i + 1;
    i++;
  }
  return source.length;
}

function skipBracedTemplateExpression(source: string, innerStart: number): number {
  let i = innerStart;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === "'") {
      i = skipStringLiteral(source, i, "'");
      continue;
    }
    if (c === '"') {
      i = skipStringLiteral(source, i, DQ);
      continue;
    }
    if (c === "`") {
      i = skipTemplateLiteral(source, i);
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  return i;
}

function skipTemplateLiteral(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return i + 1;
    if (c === "$" && source[i + 1] === "{") {
      i = skipBracedTemplateExpression(source, i + 2);
      continue;
    }
    i++;
  }
  return source.length;
}

function skipUntilClosingTag(source: string, start: number, tagName: string): number {
  let i = start;
  const close = `</${tagName}`;
  while (i < source.length) {
    if (source.startsWith(close, i)) {
      const next = source[i + close.length];
      if (next === undefined || /\s|>/.test(next)) {
        const gt = source.indexOf(">", i);
        return gt === -1 ? source.length : gt + 1;
      }
    }
    if (source[i] === "<") {
      const next = skipTsxElement(source, i);
      i = next > i ? next : i + 1;
      continue;
    }
    if (source[i] === "{") {
      const c = indexOfMatchingBrace(source, i);
      if (c === -1) return source.length;
      i = c + 1;
      continue;
    }
    i++;
  }
  return source.length;
}

function skipFragmentChildren(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    if (source.startsWith("</>", i)) return i + 4;
    if (source[i] === "<") {
      const next = skipTsxElement(source, i);
      i = next > i ? next : i + 1;
      continue;
    }
    if (source[i] === "{") {
      const close = indexOfMatchingBrace(source, i);
      if (close === -1) return source.length;
      i = close + 1;
      continue;
    }
    i++;
  }
  return source.length;
}

/**
 * Skip one TSX element or fragment from `<`. If this does not look like JSX,
 * returns `start + 1` so callers never spin on `<`.
 */
function skipTsxElement(source: string, start: number): number {
  if (source[start] !== "<") return start;
  if (!isLikelyTsxJsxOpen(source, start)) return start + 1;

  let i = start;

  if (source.startsWith("<!--", i)) {
    const end = source.indexOf("-->", i + 4);
    return end === -1 ? source.length : end + 3;
  }

  if (source[i + 1] === "/") {
    const gt = source.indexOf(">", i);
    return gt === -1 ? source.length : gt + 1;
  }

  if (source[i + 1] === "!") {
    const gt = source.indexOf(">", i);
    return gt === -1 ? source.length : gt + 1;
  }

  i++;
  if (source[i] === ">") {
    return skipFragmentChildren(source, i + 1);
  }

  const nameStart = i;
  while (i < source.length && /[\w.$-]/.test(source[i]!)) i++;
  const tagName = source.slice(nameStart, i);

  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i]!)) i++;
    if (i >= source.length) return source.length;
    if (source[i] === ">") {
      i++;
      break;
    }
    if (source[i] === "/" && source[i + 1] === ">") {
      return i + 2;
    }

    if (source[i] === "{") {
      const close = indexOfMatchingBrace(source, i);
      if (close === -1) return source.length;
      i = close + 1;
      continue;
    }

    while (i < source.length && /[\w:$-]/.test(source[i]!)) i++;
    while (i < source.length && /\s/.test(source[i]!)) i++;
    if (i < source.length && source[i] === "=") {
      i++;
      while (i < source.length && /\s/.test(source[i]!)) i++;
      const q = source[i];
      if (q === '"' || q === "'") {
        i = skipStringLiteral(source, i, q);
      } else if (q === "{") {
        const close = indexOfMatchingBrace(source, i);
        if (close === -1) return source.length;
        i = close + 1;
      } else {
        while (i < source.length && !/\s/.test(source[i]!) && source[i] !== ">") i++;
      }
    }
  }

  return skipUntilClosingTag(source, i, tagName);
}

/** `openBraceIdx` points at `{`; returns index of the matching `}`. */
export function indexOfMatchingBrace(source: string, openBraceIdx: number): number {
  let i = openBraceIdx + 1;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === "'") {
      i = skipStringLiteral(source, i, "'");
      continue;
    }
    if (c === '"') {
      i = skipStringLiteral(source, i, DQ);
      continue;
    }
    if (c === "`") {
      i = skipTemplateLiteral(source, i);
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i + 2);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      let j = i + 2;
      while (j < source.length) {
        if (source[j] === "*" && source[j + 1] === "/") {
          j += 2;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }

    if (c === "<" && depth > 0) {
      const after = skipTsxElement(source, i);
      if (after > i) {
        i = after;
        continue;
      }
    }

    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  if (depth !== 0) return -1;
  return i - 1;
}
