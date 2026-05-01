/**
 * Rewrites `next/navigation` client hooks to `@tanstack/react-router` where
 * there is a safe 1:1 mapping (ported from `/Users/amir/Desktop/codemod/next2tanstack`).
 *
 * - `usePathname` → `useLocation` + call sites `usePathname()` → `useLocation().pathname`
 * - `useSearchParams` → `useSearch` + `useSearchParams()` → `useSearch()`
 * - `useRouter` / `notFound` keep working; unknown named imports remain on `next/navigation`.
 */

import type { Codemod, Edit } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";

const NEXT_NAV = "next/navigation";
const TANSTACK = "@tanstack/react-router";

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root();
  const edits: Edit[] = [];

  const importStmts = rootNode.findAll({
    rule: {
      kind: "import_statement",
      regex: "next/navigation",
    },
  });

  let needsUseLocation = false;
  let needsUseSearch = false;

  for (const stmt of importStmts) {
    const text = stmt.text();
    if (!/from\s*["']next\/navigation["']/.test(text)) continue;

    const specText = extractNamedSpecifiersBrace(text);
    if (specText === null) continue;

    const specs = splitImportSpecifiers(specText);
    if (specs.length === 0) continue;

    const keepNext: string[] = [];
    const tanstackFromStmt: string[] = [];

    for (const raw of specs) {
      const s = raw.trim();
      if (!s) continue;

      if (/^useRouter\b/.test(s)) {
        tanstackFromStmt.push(s);
        continue;
      }
      if (/^usePathname\b/.test(s)) {
        tanstackFromStmt.push(s.replace(/^usePathname\b/, "useLocation"));
        needsUseLocation = true;
        continue;
      }
      if (/^useSearchParams\b/.test(s)) {
        tanstackFromStmt.push(s.replace(/^useSearchParams\b/, "useSearch"));
        needsUseSearch = true;
        continue;
      }

      keepNext.push(s);
    }

    const replacementLines: string[] = [];

    if (keepNext.length > 0) {
      replacementLines.push(`import { ${keepNext.join(", ")} } from "${NEXT_NAV}";`);
    }

    const mergedTanstack = mergeTanstackImports(tanstackFromStmt);
    if (mergedTanstack.length > 0) {
      replacementLines.push(`import { ${mergedTanstack.join(", ")} } from "${TANSTACK}";`);
    }

    const inserted =
      replacementLines.length > 0 ? `${replacementLines.join("\n")}\n` : "";
    edits.push({
      startPos: stmt.range().start.index,
      endPos: stmt.range().end.index,
      insertedText: inserted,
    });
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
  return rootNode.commitEdits(edits);
};

export default codemod;

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
