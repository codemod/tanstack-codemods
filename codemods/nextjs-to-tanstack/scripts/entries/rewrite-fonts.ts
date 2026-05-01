/**
 * R9 — Strip `next/font/google` and `next/font/local` usage, record
 * detected fonts into `.codemod/state.json` for the downstream
 * patch-globals-css and patch-package-json steps to consume.
 *
 * Per-file actions:
 *   1. Remove the `import { ... } from "next/font/*"` statement.
 *   2. Remove every `const <binding> = <font>({...})` declaration that uses
 *      those imports.
 *   3. Remove any JSX attribute value `<binding>.className` /
 *      `<binding>.variable` / `<binding>.style` expressions. If the attribute
 *      holds ONLY that expression, drop the attribute entirely; if it's part
 *      of a larger template literal / string expression, leave a review
 *      sentinel above the JSX element and let the user tidy it.
 *
 * Sidecar writes happen via `utils/sidecar.ts`. On the final workflow node
 * (`finalize-cleanup`), the sidecar directory is removed so nothing from the
 * codemod survives.
 */

import type { Codemod, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { getImport } from "../utils/imports.ts";
import { getFilename, inferCodemodTargetDir } from "../utils/paths.ts";
import {
  addFontEntries,
  familyToPackageKey,
  readSidecar,
  writeSidecar,
  type FontEntry,
} from "../utils/sidecar.ts";
import { hasReviewSentinel, insertReviewBefore } from "../utils/sentinels.ts";

const GOOGLE = "next/font/google";
const LOCAL = "next/font/local";

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root();

  const googleImport = getImport(rootNode, { type: "default", from: GOOGLE });
  const localImport = getImport(rootNode, { type: "default", from: LOCAL });
  const anyGoogle = rootNode.find({
    rule: {
      kind: "import_statement",
      has: {
        field: "source",
        has: { kind: "string_fragment", regex: `^${escapeRegex(GOOGLE)}$` },
      },
    },
  });
  const anyLocal = rootNode.find({
    rule: {
      kind: "import_statement",
      has: {
        field: "source",
        has: { kind: "string_fragment", regex: `^${escapeRegex(LOCAL)}$` },
      },
    },
  });

  // Gather every named specifier from either module. Local font helpers are
  // default exports, but Google provides named helpers (Inter, DM_Sans, ...).
  const fontSpecifiers: Array<{ source: "google" | "local"; specifier: string }> = [];
  if (anyGoogle) {
    for (const spec of anyGoogle.findAll({ rule: { kind: "import_specifier" } })) {
      const name = spec.field("name")?.text();
      if (name) fontSpecifiers.push({ source: "google", specifier: name });
    }
  }
  if (anyLocal) {
    const defaultImportIdent = anyLocal
      .find({
        rule: {
          kind: "import_clause",
          has: { kind: "identifier" },
        },
      })
      ?.find({ rule: { kind: "identifier" } });
    const defaultName = defaultImportIdent?.text();
    if (defaultName) fontSpecifiers.push({ source: "local", specifier: defaultName });
  }
  if (!anyGoogle && !anyLocal) return null;
  void googleImport;
  void localImport;

  const edits: Edit[] = [];
  const fontEntries: FontEntry[] = [];

  // Find every `const <name> = <Helper>({ ... })` whose Helper identifier
  // matches one of the imported specifiers.
  const specifierSet = new Set(fontSpecifiers.map((s) => s.specifier));
  const fontBindings: Array<{ binding: string; entry: FontEntry }> = [];

  for (const child of rootNode.children()) {
    if (child.kind() !== "lexical_declaration" && child.kind() !== "variable_declaration") {
      continue;
    }
    const declarator = firstChildOfKind(child, "variable_declarator");
    if (!declarator) continue;
    const bindingName = declarator.field("name")?.text();
    const value = declarator.field("value");
    if (!bindingName || !value) continue;
    if (!value.is("call_expression")) continue;
    const callee = value.field("function")?.text();
    if (!callee) continue;

    const sourceHint = fontSpecifiers.find((s) => s.specifier === callee);
    if (!sourceHint) continue;

    const source = specifierSet.has(callee) ? sourceHint.source : null;
    if (!source) continue;

    const variable = readVariableArg(value);
    const family = source === "google" ? callee : bindingName;
    const entry: FontEntry = {
      importSource: source === "google" ? GOOGLE : LOCAL,
      family,
      packageKey: familyToPackageKey(family),
      variable,
    };
    fontEntries.push(entry);
    fontBindings.push({ binding: bindingName, entry });

    // Remove the whole declaration (including trailing newline).
    const src = rootNode.text();
    edits.push({
      startPos: child.range().start.index,
      endPos: extendToTrailingNewline(src, child.range().end.index),
      insertedText: "",
    });
  }

  // Remove JSX attribute values that reference <binding>.className /
  // <binding>.variable / <binding>.style — drop the attribute when it's the
  // whole value; strip next/font refs from template `className={\`...\`}`; else
  // leave a review sentinel.
  const bindingNames = fontBindings.map((f) => f.binding);
  const srcText = rootNode.text();

  for (const attr of rootNode.findAll({ rule: { kind: "jsx_attribute" } })) {
    const prop = firstChildOfKind(attr, "property_identifier");
    if (prop?.text() !== "className") continue;

    const value = findJsxAttrExpressionValue(attr);
    if (!value) continue;

    const onlyFontRef = bindingNames.some((b) => isFontMemberRef(value, b));
    if (onlyFontRef) {
      edits.push(dropJsxAttribute(attr, srcText));
      continue;
    }

    if (!bindingNames.some((b) => attrContainsFontMember(attr, b))) continue;

    const mixed = tryRewriteMixedClassName(value, bindingNames);
    if (mixed.kind === "replace") {
      edits.push({
        startPos: value.range().start.index,
        endPos: value.range().end.index,
        insertedText: mixed.literal,
      });
    } else if (mixed.kind === "review") {
      if (!hasReviewSentinel(srcText, attr, "next/font bindings")) {
        edits.push(
          insertReviewBefore(
            attr,
            "className still references removed next/font bindings — replace with Tailwind font utilities or literals"
          )
        );
      }
    }
  }

  // Remove the import statements themselves.
  if (anyGoogle) {
    const src = rootNode.text();
    edits.push({
      startPos: anyGoogle.range().start.index,
      endPos: extendToTrailingNewline(src, anyGoogle.range().end.index),
      insertedText: "",
    });
  }
  if (anyLocal) {
    const src = rootNode.text();
    edits.push({
      startPos: anyLocal.range().start.index,
      endPos: extendToTrailingNewline(src, anyLocal.range().end.index),
      insertedText: "",
    });
  }

  if (fontEntries.length > 0) {
    const targetDir = inferCodemodTargetDir(getFilename(root));
    const state = readSidecar(targetDir);
    const merged = addFontEntries(state, fontEntries);
    writeSidecar(targetDir, merged);
  }

  if (edits.length === 0) return null;
  return rootNode.commitEdits(edits);
};

export default codemod;

function readVariableArg(call: SgNode<TSX>): string | null {
  const args = call.field("arguments");
  if (!args) return null;
  for (const arg of args.children()) {
    if (!arg.is("object")) continue;
    for (const pair of arg.findAll({ rule: { kind: "pair" } })) {
      const parent = pair.parent();
      if (!parent || parent.id() !== arg.id()) continue;
      const key = pair.field("key");
      if (key?.text() !== "variable") continue;
      const value = pair.field("value");
      if (!value?.is("string")) return null;
      const frag = value.find({ rule: { kind: "string_fragment" } });
      return frag ? frag.text() : "";
    }
  }
  return null;
}

function findJsxAttrExpressionValue(attr: SgNode<TSX>): SgNode<TSX> | null {
  // A jsx_attribute's second-to-last child is the value; we want the
  // expression inside `{...}`.
  const expr = firstChildOfKind(attr, "jsx_expression");
  if (!expr) return null;
  for (const child of expr.children()) {
    if (child.kind() === "{" || child.kind() === "}") continue;
    return child;
  }
  return null;
}

function isFontMemberRef(node: SgNode<TSX>, binding: string): boolean {
  if (!node.is("member_expression")) return false;
  const object = node.field("object");
  const property = node.field("property");
  if (!object || !property) return false;
  if (object.text() !== binding) return false;
  return ["className", "variable", "style"].includes(property.text());
}

function attrContainsFontMember(attr: SgNode<TSX>, binding: string): boolean {
  return (
    attr.find({
      rule: {
        kind: "member_expression",
        has: {
          field: "object",
          kind: "identifier",
          regex: `^${escapeRegex(binding)}$`,
        },
      },
    }) !== null
  );
}

/**
 * Rewrite `className={\`...${font.variable}...\`}` after font bindings were removed.
 * Only template literals without remaining `${...}` holes are rewritten; anything
 * else gets a manual review marker.
 */
function tryRewriteMixedClassName(
  expr: SgNode<TSX>,
  bindings: string[],
): { kind: "replace"; literal: string } | { kind: "review" } {
  if (!expr.is("template_string")) {
    return { kind: "review" };
  }

  let s = expr.text();
  for (const b of bindings) {
    const re = new RegExp(
      `\\$\\{\\s*${escapeRegex(b)}\\s*\\.\\s*(?:variable|className|style)\\s*\\}`,
      "g",
    );
    s = s.replace(re, "");
  }

  if (s.startsWith("`") && s.endsWith("`")) {
    s = s.slice(1, -1);
  }
  s = s.replace(/\s+/g, " ").trim();

  if (s.includes("${")) {
    return { kind: "review" };
  }

  for (const b of bindings) {
    if (new RegExp(`\\b${escapeRegex(b)}\\s*\\.`).test(s)) {
      return { kind: "review" };
    }
  }

  if (s.length === 0) {
    return { kind: "replace", literal: JSON.stringify("font-sans antialiased") };
  }

  return { kind: "replace", literal: JSON.stringify(s) };
}

function dropJsxAttribute(attr: SgNode<TSX>, source: string): Edit {
  // Extend backwards to absorb leading whitespace / newline so the opening tag
  // stays clean after removal.
  let start = attr.range().start.index;
  const end = attr.range().end.index;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) {
    start--;
  }
  return { startPos: start, endPos: end, insertedText: "" };
}

function firstChildOfKind(parent: SgNode<TSX>, kind: string): SgNode<TSX> | null {
  for (const child of parent.children()) {
    if (child.kind() === kind) return child;
  }
  return null;
}

function extendToTrailingNewline(source: string, end: number): number {
  if (source.slice(end, end + 2) === "\r\n") return end + 2;
  if (source[end] === "\n") return end + 1;
  if (source[end] === "\r") return end + 1;
  return end;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
