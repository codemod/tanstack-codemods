/**
 * Safer Tier‑S rewrites for `next/dynamic` and `next/script`.
 *
 * `next/dynamic` → React `lazy`:
 *   - Only when every `dynamic(...)` call is `dynamic(() => import(...))` optionally
 *     followed by `, { ssr: false }` or `, {}`. Any `loading` / other options → skip file.
 *
 * `next/script`:
 *   - Only `<Script src=... />` (or self-closing equivalent) with strategies we map to
 *     native `defer` / `async`. Skips `beforeInteractive`, `worker`, inline bodies,
 *     `onReady`, or non-empty element children.
 */

import type { Codemod, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { addImport, getImport, removeImport } from "../utils/imports.ts";
import { TODO_PREFIX } from "../utils/sentinels.ts";

const NEXT_DYNAMIC = "next/dynamic";
const NEXT_SCRIPT = "next/script";
const NEXT_HEAD = "next/head";

const HEAD_TODO_SENTINEL = "next/head migration (R4c-head)";

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root();
  let dynamicAlias: string | null = null;
  let scriptAlias: string | null = null;

  const dynImport = getImport(rootNode, { type: "default", from: NEXT_DYNAMIC });
  if (dynImport && !dynImport.isNamespace) {
    dynamicAlias = dynImport.alias;
  }

  const scriptImp = getImport(rootNode, { type: "default", from: NEXT_SCRIPT });
  if (scriptImp && !scriptImp.isNamespace) {
    scriptAlias = scriptImp.alias;
  }

  const edits: Edit[] = [];

  const headImp = getImport(rootNode, { type: "default", from: NEXT_HEAD });
  if (headImp && !headImp.isNamespace) {
    const headEdits = rewriteHead(rootNode, headImp.alias);
    edits.push(...headEdits);
  }

  if (dynamicAlias) {
    const dynamicEdits = rewriteDynamic(rootNode, dynamicAlias);
    if (dynamicEdits !== "skip") edits.push(...dynamicEdits);
  }

  if (scriptAlias) {
    const scriptEdits = rewriteScript(rootNode, scriptAlias);
    if (scriptEdits !== "skip") edits.push(...scriptEdits);
  }

  if (edits.length === 0) return null;
  return rootNode.commitEdits(edits);
};

export default codemod;

function rewriteHead(rootNode: SgNode<TSX>, alias: string): Edit[] {
  const source = rootNode.text();
  const edits: Edit[] = [];
  const opens = findJsxScriptOpens(rootNode, alias);

  for (const opening of opens) {
    const openEl = jsxOpeningFromSubject(outerJsxReplacementTarget(opening));
    if (openEl && countJsxAttributes(openEl) > 0) {
      return [];
    }
  }

  if (!source.includes(HEAD_TODO_SENTINEL)) {
    edits.push({
      startPos: 0,
      endPos: 0,
      insertedText: `${TODO_PREFIX}${HEAD_TODO_SENTINEL}: move meta tags to TanStack Start head APIs / document title — https://tanstack.com/start/latest/docs/framework/react/migrate-from-next-js\n`,
    });
  }

  const rm = removeImport(rootNode, { type: "default", from: NEXT_HEAD });
  if (rm) edits.push(rm);

  for (const opening of findJsxScriptOpens(rootNode, alias)) {
    const target = outerJsxReplacementTarget(opening);
    const openEl = jsxOpeningFromSubject(target);
    if (!openEl) continue;
    if (target.kind() === "jsx_self_closing_element") {
      let ot = openEl.text();
      ot = ot.replace(
        new RegExp(`^<\\s*${escapeRegex(alias)}\\s*\\/\\s*>`),
        "<></>",
      );
      edits.push(openEl.replace(ot));
      continue;
    }
    if (target.kind() === "jsx_element") {
      let ot = openEl.text();
      ot = ot.replace(
        new RegExp(`^<\\s*${escapeRegex(alias)}\\s*>`),
        "<>",
      );
      edits.push(openEl.replace(ot));
      const close = target.children().find((c) => c.kind() === "jsx_closing_element");
      if (close) {
        let ct = close.text();
        ct = ct.replace(new RegExp(`</\\s*${escapeRegex(alias)}\\s*>`, "i"), "</>");
        if (ct !== close.text()) edits.push(close.replace(ct));
      }
    }
  }

  return edits;
}

function countJsxAttributes(openEl: SgNode<TSX>): number {
  return openEl.findAll({ rule: { kind: "jsx_attribute" } }).length;
}

const LOADING_STRIP_SENTINEL = "next/dynamic loading UI stripped (R4c)";

function rewriteDynamic(rootNode: SgNode<TSX>, alias: string): Edit[] | "skip" {
  const source = rootNode.text();
  const calls = rootNode.findAll({
    rule: {
      kind: "call_expression",
      has: {
        field: "function",
        kind: "identifier",
        regex: `^${escapeRegex(alias)}$`,
      },
    },
  });

  if (calls.length === 0) return [];

  const callEdits: Edit[] = [];
  let strippedLoadingUi = false;

  for (const call of calls) {
    const args = extractCallArgs(call);
    if (args.length === 0 || args.length > 2) return "skip";
    const loader = args[0];
    if (!loader) return "skip";
    if (!isSimpleImportArrow(loader)) return "skip";
    if (args.length === 2) {
      const opt = args[1];
      if (!opt || !canConvertDynamicOptionsToLazy(opt)) return "skip";
      if (objectOptionHasLoadingKey(opt)) strippedLoadingUi = true;
    }
    callEdits.push(call.replace(`lazy(${loader.text()})`));
  }

  if (callEdits.length === 0) return [];

  const importEdits: Edit[] = [];
  if (strippedLoadingUi && !source.includes(LOADING_STRIP_SENTINEL)) {
    importEdits.push({
      startPos: 0,
      endPos: 0,
      insertedText: `${TODO_PREFIX}${LOADING_STRIP_SENTINEL}: restore loading UX with \`<Suspense fallback={…}>\` — https://react.dev/reference/react/Suspense\n`,
    });
  }
  const rm = removeImport(rootNode, { type: "default", from: NEXT_DYNAMIC });
  if (rm) importEdits.push(rm);
  importEdits.push(...ensureLazyReactImport(rootNode));

  return [...importEdits, ...callEdits];
}

function objectOptionHasLoadingKey(node: SgNode<TSX>): boolean {
  if (!node.is("object")) return false;
  for (const pair of node.findAll({ rule: { kind: "pair" } })) {
    const parent = pair.parent();
    if (!parent || parent.id() !== node.id()) continue;
    const keyNode = pair.field("key");
    const key =
      keyNode?.kind() === "property_identifier"
        ? keyNode.text()
        : (keyNode?.text().replace(/['"]/g, "").trim() ?? "");
    if (key === "loading") return true;
  }
  return false;
}

function canConvertDynamicOptionsToLazy(node: SgNode<TSX>): boolean {
  if (isSafeDynamicOptionsNode(node)) return true;
  if (!node.is("object")) return false;
  for (const pair of node.findAll({ rule: { kind: "pair" } })) {
    const parent = pair.parent();
    if (!parent || parent.id() !== node.id()) continue;
    const keyNode = pair.field("key");
    const key =
      keyNode?.kind() === "property_identifier"
        ? keyNode.text()
        : (keyNode?.text().replace(/['"]/g, "").trim() ?? "");
    if (key !== "ssr" && key !== "loading") return false;
  }
  return true;
}

function extractCallArgs(call: SgNode<TSX>): SgNode<TSX>[] {
  const list = call.field("arguments");
  if (!list) return [];
  const out: SgNode<TSX>[] = [];
  for (const ch of list.children()) {
    if (ch.kind() === "(" || ch.kind() === ")" || ch.kind() === ",") continue;
    out.push(ch as SgNode<TSX>);
  }
  return out;
}

function isSimpleImportArrow(arg: SgNode<TSX>): boolean {
  if (arg.kind() !== "arrow_function") return false;
  const raw = arg.text();
  const m = raw.match(/=>\s*([\s\S]*)$/);
  if (!m?.[1]) return false;
  const body = m[1].trim();
  if (body.startsWith("import(")) return true;
  if (body.startsWith("(") && /import\s*\(/.test(body)) return true;
  return false;
}

function isSafeDynamicOptionsNode(node: SgNode<TSX>): boolean {
  if (!node.is("object")) {
    const t = node.text().trim();
    return t === "{}" || /^\{\s*ssr\s*:\s*false\s*\}$/.test(t);
  }
  for (const pair of node.findAll({ rule: { kind: "pair" } })) {
    const parent = pair.parent();
    if (!parent || parent.id() !== node.id()) continue;
    const keyNode = pair.field("key");
    const key =
      keyNode?.kind() === "property_identifier"
        ? keyNode.text()
        : (keyNode?.text().replace(/['"]/g, "").trim() ?? "");
    if (key !== "ssr") return false;
    const val = pair.field("value")?.text().trim() ?? "";
    if (val !== "false") return false;
  }
  return true;
}

function ensureLazyReactImport(rootNode: SgNode<TSX>): Edit[] {
  const edits: Edit[] = [];
  const source = rootNode.text();
  const reactStmts = rootNode.findAll({
    rule: {
      kind: "import_statement",
      regex: "from\\s*[\"']react[\"']",
    },
  });

  for (const stmt of reactStmts) {
    const text = stmt.text();
    if (!/from\s*["']react["']/.test(text)) continue;
    if (!/\{/.test(text)) continue;
    const brace = /\{([^}]*)\}/.exec(text);
    if (!brace) continue;
    const inner = brace[1] ?? "";
    if (/\blazy\b/.test(inner)) return edits;
    const insert = inner.trim() ? `${inner.trim().replace(/,\s*$/, "")}, lazy` : "lazy";
    const nextImport = text.replace(/\{[^}]*\}/, `{ ${insert} }`);
    edits.push({
      startPos: stmt.range().start.index,
      endPos: stmt.range().end.index,
      insertedText: nextImport,
    });
    return edits;
  }

  const add = addImport(rootNode, {
    type: "named",
    specifiers: [{ name: "lazy" }],
    from: "react",
  });
  if (add) edits.push(add);
  return edits;
}

function rewriteScript(rootNode: SgNode<TSX>, alias: string): Edit[] | "skip" {
  if (!scriptUsagesAreAllSafe(rootNode, alias)) return "skip";

  const edits: Edit[] = [];
  const rm = removeImport(rootNode, { type: "default", from: NEXT_SCRIPT });
  if (rm) edits.push(rm);

  for (const opening of findJsxScriptOpens(rootNode, alias)) {
    const target = outerJsxReplacementTarget(opening);
    const openEl = jsxOpeningFromSubject(target);
    if (!openEl) continue;

    const srcAttr = findAttrOnOpening(openEl, "src");

    if (onReadyAttr(openEl)) return "skip";

    const strat = findAttrOnOpening(openEl, "strategy");
    let useDefer = !!srcAttr; // only add defer for external scripts
    let useAsync = false;
    if (strat) {
      const raw = attrValueNode(strat)?.text() ?? strat.text();
      const v = raw.replace(/^=\s*/, "").replace(/["']/g, "").trim();
      if (/beforeInteractive|^worker$/i.test(v)) return "skip";
      if (v === "lazyOnload") {
        useAsync = !!srcAttr;
        useDefer = false;
      }
    }

    const patchedOpen = patchScriptOpeningText(openEl.text(), alias, useDefer, useAsync);
    if (patchedOpen === null) return "skip";
    edits.push(openEl.replace(patchedOpen));

    if (target.kind() === "jsx_element") {
      const close = target.children().find((c) => c.kind() === "jsx_closing_element");
      if (close) {
        const ct = close.text();
        const nextClose = ct.replace(
          new RegExp(`</\\s*${escapeRegex(alias)}\\s*>`, "i"),
          "</script>",
        );
        if (nextClose !== ct) edits.push(close.replace(nextClose));
      }
    }
  }

  return edits;
}

function patchScriptOpeningText(
  openText: string,
  alias: string,
  useDefer: boolean,
  useAsync: boolean,
): string | null {
  let t = openText.replace(new RegExp(`^<\\s*${escapeRegex(alias)}\\b`), "<script");
  if (!/^<\s*script\b/.test(t)) return null;
  t = t.replace(/\s+strategy=\{[^}]*\}\s*/g, " ");
  t = t.replace(/\s+strategy="[^"]*"\s*/gi, " ");
  t = t.replace(/\s+strategy='[^']*'\s*/gi, " ");
  t = t.replace(/\s{2,}/g, " ");
  if (useAsync && !/\basync\b/.test(t)) t = t.replace(/<script\b/, "<script async");
  else if (useDefer && !/\bdefer\b/.test(t)) t = t.replace(/<script\b/, "<script defer");
  return t;
}

function onReadyAttr(openEl: SgNode<TSX>): boolean {
  return findAttrOnOpening(openEl, "onReady") != null;
}

function scriptUsagesAreAllSafe(rootNode: SgNode<TSX>, alias: string): boolean {
  for (const opening of findJsxScriptOpens(rootNode, alias)) {
    const openEl = jsxOpeningFromSubject(outerJsxReplacementTarget(opening));
    if (!openEl) return false;
    if (onReadyAttr(openEl)) return false;
    const hasSrc = !!findAttrOnOpening(openEl, "src");
    const strat = findAttrOnOpening(openEl, "strategy");
    if (strat) {
      const raw = attrValueNode(strat)?.text() ?? strat.text();
      const v = raw.replace(/^=\s*/, "").replace(/["']/g, "").trim();
      if (/beforeInteractive|^worker$/i.test(v)) return false;
    }
    const outer = outerJsxReplacementTarget(opening);
    // External script must have src; inline script (<Script>{...}</Script>) is safe
    // as long as children are only JSX expressions, not raw text content.
    if (!hasSrc) {
      if (outer.kind() === "jsx_self_closing_element") return false; // self-closing without src → skip
    }
    if (outer.kind() === "jsx_element") {
      for (const ch of outer.children()) {
        if (ch.kind() === "jsx_text" && /\S/.test(ch.text())) return false;
      }
    }
  }
  return true;
}

function findJsxScriptOpens(rootNode: SgNode<TSX>, alias: string): SgNode<TSX>[] {
  const rx = `^${escapeRegex(alias)}$`;
  return rootNode.findAll({
    rule: {
      any: [
        {
          kind: "jsx_opening_element",
          has: { field: "name", kind: "identifier", regex: rx },
        },
        {
          kind: "jsx_self_closing_element",
          has: { field: "name", kind: "identifier", regex: rx },
        },
      ],
    },
  });
}

function outerJsxReplacementTarget(opening: SgNode<TSX>): SgNode<TSX> {
  if (opening.kind() === "jsx_self_closing_element") return opening;
  let cursor: SgNode<TSX> | null = opening;
  while (cursor) {
    if (cursor.kind() === "jsx_element") return cursor;
    cursor = cursor.parent() as SgNode<TSX> | null;
  }
  return opening;
}

function jsxOpeningFromSubject(subject: SgNode<TSX>): SgNode<TSX> | null {
  if (
    subject.kind() === "jsx_self_closing_element" ||
    subject.kind() === "jsx_opening_element"
  ) {
    return subject;
  }
  if (subject.kind() === "jsx_element") {
    for (const child of subject.children()) {
      if (child.kind() === "jsx_opening_element") return child as SgNode<TSX>;
    }
  }
  return null;
}

function findAttrOnOpening(openEl: SgNode<TSX>, prop: string): SgNode<TSX> | null {
  for (const attr of openEl.findAll({ rule: { kind: "jsx_attribute" } })) {
    const name = firstChildOfKind(attr, "property_identifier")?.text();
    if (name === prop) return attr;
  }
  return null;
}

function firstChildOfKind(parent: SgNode<TSX>, kind: string): SgNode<TSX> | null {
  for (const child of parent.children()) {
    if (child.kind() === kind) return child;
  }
  return null;
}

function attrValueNode(attr: SgNode<TSX>): SgNode<TSX> | null {
  const children = attr.children();
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (!child) continue;
    const k = child.kind();
    if (k === "property_identifier" || k === "=") continue;
    return child;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
