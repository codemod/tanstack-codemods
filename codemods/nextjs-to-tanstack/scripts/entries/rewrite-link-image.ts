/**
 * R4 + R5 — Swap `next/link` and `next/image` to their TanStack / Unpic
 * equivalents.
 *
 * R4 (`next/link` → `@tanstack/react-router` Link or `<a>`):
 *   - `import Link from "next/link"` → `import { Link } from "@tanstack/react-router"` when needed.
 *   - In-app `<Link href="/path">` → `<Link to="/path">`.
 *   - Hash links (`#…`), absolute URLs, `mailto:`, `tel:`, `javascript:`, and protocol-relative
 *     URLs become native `<a href>` so TanStack `Link` is not used for unsupported targets.
 *
 * R5 (`next/image` → `@unpic/react` Image):
 *   - `import Image from "next/image"` → `import { Image } from "@unpic/react"`.
 *   - Numeric-string `width` / `height` attributes become numeric JSX literal
 *     expressions (`width="600"` → `width={600}`).
 *   - Non-numeric width/height attributes are dropped so Unpic can defer sizing
 *     to CSS or parent layout.
 *
 * Both rules use `getImport` to locate the actual local alias, which means
 * aliased imports (`import MyLink from "next/link"`) are handled correctly
 * and a shadowing local `function Link()` is left alone.
 */

import type { Codemod, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { addImport, getImport, removeImport } from "../utils/imports.ts";

const NEXT_LINK = "next/link";
const NEXT_IMAGE = "next/image";
const TANSTACK_ROUTER = "@tanstack/react-router";
const UNPIC = "@unpic/react";

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root();
  const edits: Edit[] = [];

  edits.push(...rewriteNextLinkTypeOnlyImports(rootNode));

  const linkImport = getImport(rootNode, { type: "default", from: NEXT_LINK });
  if (linkImport && !linkImport.isNamespace) {
    const linkEdits = rewriteLink(rootNode, linkImport.alias);
    if (linkEdits.length > 0) edits.push(...linkEdits);
  }

  const imageImport = getImport(rootNode, { type: "default", from: NEXT_IMAGE });
  if (imageImport && !imageImport.isNamespace) {
    edits.push(...rewriteImage(rootNode, imageImport.alias));
  }

  if (edits.length === 0) return null;
  return rootNode.commitEdits(edits);
};

export default codemod;

/**
 * `import type { LinkProps } from "next/link"` and inline `type` specifiers —
 * Next types are replaced with `@tanstack/react-router` (see Link props docs).
 */
function rewriteNextLinkTypeOnlyImports(rootNode: SgNode<TSX>): Edit[] {
  const edits: Edit[] = [];
  for (const stmt of rootNode.findAll({ rule: { kind: "import_statement" } })) {
    const t = stmt.text();
    if (!/from\s*["']next\/link["']/.test(t)) continue;
    if (!isNextLinkTypeOnlyImportStatement(t)) continue;
    const next = t.replace(
      /from\s*["']next\/link["']/,
      `from "${TANSTACK_ROUTER}"`,
    );
    if (next === t) continue;
    edits.push({
      startPos: stmt.range().start.index,
      endPos: stmt.range().end.index,
      insertedText: next,
    });
  }
  return edits;
}

function isNextLinkTypeOnlyImportStatement(text: string): boolean {
  if (/^\s*import\s+type\b/m.test(text)) return true;
  return /\{\s*type\s+[^}]+[^}]*\}/.test(text);
}

function rewriteLink(rootNode: SgNode<TSX>, alias: string): Edit[] {
  const edits: Edit[] = [];
  const source = rootNode.text();

  if (shouldSkipNextLinkMigration(source)) {
    return edits;
  }

  const opens = findJsxOpens(rootNode, alias);
  let keepsTanstackLink = false;

  for (const opening of opens) {
    const target = outerJsxReplacementTarget(opening);
    const openEl = jsxOpeningFromSubject(target);
    if (!openEl) continue;

    const hrefAttr = findAttrOnOpening(openEl, "href");
    if (hrefAttr && hrefAttrRequiresNativeAnchor(hrefAttr)) {
      edits.push(
        target.replace(patchNextLinkFragmentToAnchor(target.text(), alias)),
      );
      continue;
    }

    keepsTanstackLink = true;

    for (const attr of openEl.findAll({ rule: { kind: "jsx_attribute" } })) {
      const prop = firstChildOfKind(attr, "property_identifier")?.text();
      if (!prop) continue;

      if (prop === "prefetch") {
        const jsxVal = attrValueNode(attr);
        let raw =
          jsxVal?.text()?.trim().replace(/^=\s*/, "") ?? "true";
        raw = raw.replace(/^\{/g, "").replace(/\}$/g, "").trim();

        if (raw === "true") edits.push(attr.replace(`preload="intent"`));
        else if (raw === "false") edits.push(attr.replace(`preload={false}`));
        else edits.push(attr.replace(`preload={${raw} ? "intent" : false}`));
        continue;
      }

      if (prop === "scroll") {
        const jsxVal = attrValueNode(attr);
        const rawOuter = jsxVal?.text()?.trim() ?? "{}";
        const inner =
          rawOuter.startsWith("{") && rawOuter.endsWith("}")
            ? rawOuter.slice(1, -1).trim()
            : rawOuter.replace(/^[={}\s]+/g, "");
        edits.push(attr.replace(`resetScroll={${inner}}`));
        continue;
      }

      if (["as", "shallow", "locale", "legacyBehavior", "passHref"].includes(prop)) {
        edits.push(dropJsxAttr(attr, source));
      }
    }

    const hrefRename = findAttrOnOpening(openEl, "href");
    const nameNode = hrefRename ? firstChildOfKind(hrefRename, "property_identifier") : null;
    if (nameNode && nameNode.text() === "href") {
      edits.push(nameNode.replace("to"));
    }
  }

  const removeLinkEdit = removeImport(rootNode, { type: "default", from: NEXT_LINK });
  if (removeLinkEdit) {
    const endPos = keepsTanstackLink
      ? removeLinkEdit.endPos
      : extendRemovalPastOptionalBlankLine(source, removeLinkEdit.endPos);
    edits.push({ ...removeLinkEdit, endPos });
  }

  if (keepsTanstackLink) {
    const addEdit = addImport(rootNode, {
      type: "named",
      specifiers: [alias === "Link" ? { name: "Link" } : { name: "Link", alias }],
      from: TANSTACK_ROUTER,
    });
    if (addEdit) edits.push(addEdit);
  }

  return edits;
}

function shouldSkipNextLinkMigration(source: string): boolean {
  const importsUseLinkStatus =
    /import\s[^;]*\buseLinkStatus\b[^;]*from\s*["']next\/link["']/m.test(source) ||
    /\buseLinkStatus\s*\(/.test(source);
  const mdxHeavy =
    /\buseMDXComponents\s*\(/.test(source) || /from\s*["']mdx\/types["']/.test(source);

  return importsUseLinkStatus || mdxHeavy;
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

/**
 * Same-origin relative paths stay on TanStack `Link`; everything else becomes `<a href>`.
 */
function literalRequiresNativeAnchor(literal: string): boolean {
  if (literal.length === 0) return false;
  if (/^https?:\/\//i.test(literal)) return true;
  if (literal.startsWith("//")) return true;
  if (literal.startsWith("#")) return true;
  if (/^mailto:/i.test(literal)) return true;
  if (/^tel:/i.test(literal)) return true;
  if (/^javascript:/i.test(literal)) return true;
  return false;
}

function hrefAttrRequiresNativeAnchor(hrefAttr: SgNode<TSX>): boolean {
  const val = attrValueNode(hrefAttr);
  if (!val) return false;
  if (val.kind() === "string") {
    const frag = val.find({ rule: { kind: "string_fragment" } });
    const literal = frag?.text() ?? "";
    return literalRequiresNativeAnchor(literal);
  }
  if (val.kind() === "jsx_expression") {
    const inner = jsxExpressionStringLiteral(val);
    return inner != null && literalRequiresNativeAnchor(inner);
  }
  return false;
}

/** `href={"#x"}` / `href={'#x'}` */
function jsxExpressionStringLiteral(expr: SgNode<TSX>): string | null {
  const children = expr.children();
  const meaningful = children.filter(
    (c) => c.kind() !== "{" && c.kind() !== "}",
  );
  if (meaningful.length !== 1) return null;
  const only = meaningful[0]!;
  if (only.kind() !== "string") return null;
  const frag = only.find({ rule: { kind: "string_fragment" } });
  return frag?.text() ?? null;
}

function stripNextLinkOnlyAttrsFromConvertedAnchor(fragment: string): string {
  let s = fragment;
  const attrNames =
    "prefetch|scroll|as|shallow|locale|legacyBehavior|passHref";
  for (let i = 0; i < 12; i++) {
    const t = s.replace(
      new RegExp(`\\s(?:${attrNames})(?:=\\{[^}]*\\}|="[^"]*"|='[^']*')`, "g"),
      "",
    );
    if (t === s) break;
    s = t;
  }
  return s;
}

function patchNextLinkFragmentToAnchor(fragment: string, alias: string): string {
  let s = patchJsxAliasToAnchor(fragment, alias);
  s = stripNextLinkOnlyAttrsFromConvertedAnchor(s);
  return s;
}

function patchJsxAliasToAnchor(fragment: string, alias: string): string {
  const openRe = new RegExp(`<\\s*${escapeRegex(alias)}\\b`, "g");
  const closeRe = new RegExp(`</\\s*${escapeRegex(alias)}\\s*>`, "gi");
  return fragment.replace(openRe, "<a").replace(closeRe, "</a>");
}

function dropJsxAttr(attr: SgNode<TSX>, source: string): Edit {
  let start = attr.range().start.index;
  const end = attr.range().end.index;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) {
    start--;
  }
  return { startPos: start, endPos: end, insertedText: "" };
}

function rewriteImage(rootNode: SgNode<TSX>, alias: string): Edit[] {
  const edits: Edit[] = [];
  const source = rootNode.text();

  const removeImageEdit = removeImport(rootNode, { type: "default", from: NEXT_IMAGE });
  if (removeImageEdit) edits.push(removeImageEdit);

  const addEdit = addImport(rootNode, {
    type: "named",
    specifiers: [alias === "Image" ? { name: "Image" } : { name: "Image", alias }],
    from: UNPIC,
  });
  if (addEdit) edits.push(addEdit);

  for (const opening of findJsxOpens(rootNode, alias)) {
    const openEl = jsxOpeningFromSubject(outerJsxReplacementTarget(opening)) ?? opening;

    for (const attr of openEl.findAll({ rule: { kind: "jsx_attribute" } })) {
      const nameNode = firstChildOfKind(attr, "property_identifier");
      if (!nameNode) continue;
      const attrName = nameNode.text();
      const valueNode = attrValueNode(attr);
      const propVal = valueNode?.text() ?? "";

      if (attrName === "fill") {
        edits.push(dropJsxAttr(attr, source));
        continue;
      }

      if (attrName === "layout") {
        if (propVal.includes('"fill"') || propVal.includes("'fill'")) {
          edits.push(dropJsxAttr(attr, source));
        }
        continue;
      }

      if (attrName === "placeholder" || attrName === "blurDataURL") {
        edits.push(dropJsxAttr(attr, source));
        continue;
      }

      if (attrName === "loading") {
        edits.push(dropJsxAttr(attr, source));
        continue;
      }

      if (attrName === "onLoadingComplete") {
        const val = propVal.startsWith("=") ? propVal.slice(1).trim() : propVal;
        edits.push(attr.replace(`onLoad={${val}}`));
        continue;
      }

      if (
        ["quality", "unoptimized", "loader", "loaderFile", "objectFit", "preload"].includes(attrName)
      ) {
        edits.push(dropJsxAttr(attr, source));
      }
    }

    for (const attr of openEl.findAll({ rule: { kind: "jsx_attribute" } })) {
      const nameNode = firstChildOfKind(attr, "property_identifier");
      if (!nameNode) continue;
      const attrName = nameNode.text();
      if (attrName !== "width" && attrName !== "height") continue;

      const valNode = attrValueNode(attr);
      if (!valNode || valNode.kind() !== "string") continue;

      const frag = valNode.find({ rule: { kind: "string_fragment" } });
      if (!frag) continue;
      const literal = frag.text();
      if (/^\d+$/.test(literal)) {
        edits.push(valNode.replace(`{${literal}}`));
      } else {
        edits.push(dropJsxAttr(attr, source));
      }
    }
  }

  return edits;
}

function findJsxOpens(rootNode: SgNode<TSX>, alias: string): SgNode<TSX>[] {
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

function firstChildOfKind(parent: SgNode<TSX>, kind: string): SgNode<TSX> | null {
  for (const child of parent.children()) {
    if (child.kind() === kind) return child;
  }
  return null;
}

function attrValueNode(attr: SgNode<TSX>): SgNode<TSX> | null {
  // jsx_attribute children: property_identifier, "=", value.
  // The value can be a string, jsx_expression, or (rare) identifier.
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

/** After {@link removeImport}, eat one more line ending if the next line is blank. */
function extendRemovalPastOptionalBlankLine(source: string, endPos: number): number {
  let e = endPos;
  if (source.slice(e, e + 2) === "\r\n") {
    e += 2;
  } else if (source[e] === "\n") {
    e++;
  } else if (source[e] === "\r") {
    e++;
  }
  return e;
}
