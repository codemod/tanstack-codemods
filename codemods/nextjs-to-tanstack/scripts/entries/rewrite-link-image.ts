/**
 * R4 + R5 — Swap `next/link` and `next/image` to their TanStack / Unpic
 * equivalents.
 *
 * R4 (`next/link` → `@tanstack/react-router` Link):
 *   - `import Link from "next/link"` → `import { Link } from "@tanstack/react-router"`.
 *   - Every `<Link href={...}>` using the imported alias → `<Link to={...}>`.
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

function rewriteLink(rootNode: SgNode<TSX>, alias: string): Edit[] {
  const edits: Edit[] = [];
  const source = rootNode.text();

  if (shouldSkipNextLinkMigration(source)) {
    return edits;
  }

  const removeEdit = removeImport(rootNode, { type: "default", from: NEXT_LINK });
  if (removeEdit) edits.push(removeEdit);

  const addEdit = addImport(rootNode, {
    type: "named",
    specifiers: [alias === "Link" ? { name: "Link" } : { name: "Link", alias }],
    from: TANSTACK_ROUTER,
  });
  if (addEdit) edits.push(addEdit);

  const opens = findJsxOpens(rootNode, alias);
  for (const opening of opens) {
    const target = outerJsxReplacementTarget(opening);
    const openEl = jsxOpeningFromSubject(target);
    if (!openEl) continue;

    const hrefAttr = findAttrOnOpening(openEl, "href");
    if (hrefAttr && externalStaticHref(hrefAttr)) {
      edits.push(target.replace(patchJsxAliasToAnchor(target.text(), alias)));
      continue;
    }

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

function externalStaticHref(hrefAttr: SgNode<TSX>): boolean {
  const val = attrValueNode(hrefAttr);
  if (!val) return false;
  if (val.kind() === "string") {
    const frag = val.find({ rule: { kind: "string_fragment" } });
    const literal = frag?.text() ?? "";
    return /^https?:\/\//.test(literal);
  }
  return false;
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

  const removeEdit = removeImport(rootNode, { type: "default", from: NEXT_IMAGE });
  if (removeEdit) edits.push(removeEdit);

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
