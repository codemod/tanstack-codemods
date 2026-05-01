/**
 * R12 — Patch `globals.css` with the Fontsource imports and Tailwind `@theme
 * inline` blocks recorded by R9.
 *
 * Targets: `src/app/globals.css`, `app/globals.css`, `src/styles/globals.css`,
 * and `styles/globals.css` (covers create-next-app layouts and Cal-style trees).
 *
 * CSS is line-oriented — we detect existing `@import "@fontsource-variable/…"`
 * statements and skip them, then append whatever is missing at the top of the
 * file (after any pre-existing `@import` line). A Tailwind `@theme inline`
 * block with `--font-<variable>: '<Family>', sans-serif;` is appended too when
 * the sidecar records variable font metadata.
 */

import type { Codemod, Edit } from "codemod:ast-grep";
import type CSS from "codemod:ast-grep/langs/css";
import { getFilename, inferCodemodTargetDir } from "../utils/paths.ts";
import { readSidecar, type FontEntry } from "../utils/sidecar.ts";

const codemod: Codemod<CSS> = async (root) => {
  const file = getFilename(root);
  if (!/\/globals\.css$/.test(file)) return null;

  const rootNode = root.root();
  const source = rootNode.text();

  const targetDir = inferCodemodTargetDir(file);
  const sidecar = readSidecar(targetDir);
  if (sidecar.fonts.length === 0) return null;

  const edits: Edit[] = [];

  const importBlock = buildImportBlock(source, sidecar.fonts);
  const themeBlock = buildThemeBlock(source, sidecar.fonts);

  // Anchor the injection point: right after the last existing `@import` line,
  // or at file start otherwise.
  const importAnchor = findAfterLastImport(source);

  const prepend = `${importBlock}${themeBlock}`;
  if (prepend.length === 0) return null;

  edits.push({
    startPos: importAnchor,
    endPos: importAnchor,
    insertedText: prepend,
  });

  return rootNode.commitEdits(edits);
};

export default codemod;

function buildImportBlock(source: string, fonts: FontEntry[]): string {
  const lines: string[] = [];
  for (const font of fonts) {
    const pkg = `@fontsource-variable/${font.packageKey}`;
    const rx = new RegExp(`@import\\s+["']${escapeRegex(pkg)}["']`);
    if (rx.test(source)) continue;
    lines.push(`@import "${pkg}";`);
  }
  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n`;
}

function buildThemeBlock(source: string, fonts: FontEntry[]): string {
  const themeLines: string[] = [];
  for (const font of fonts) {
    const varName = font.variable ?? inferVarName(font);
    const familyDisplay = familyDisplayName(font.family);
    const sig = `${varName}: '${familyDisplay} Variable'`;
    const rx = new RegExp(escapeRegex(sig));
    if (rx.test(source)) continue;
    themeLines.push(`  ${varName}: '${familyDisplay} Variable', sans-serif;`);
  }
  if (themeLines.length === 0) return "";
  return `@theme inline {\n${themeLines.join("\n")}\n}\n`;
}

function inferVarName(font: FontEntry): string {
  return `--font-${font.packageKey}`;
}

function familyDisplayName(raw: string): string {
  // Inter → Inter, DM_Sans → DM Sans, JetBrains_Mono → JetBrains Mono.
  return raw.replace(/_/g, " ");
}

function findAfterLastImport(source: string): number {
  // Match @import at a line start; take the position after the last such line.
  const rx = /^@import[^\n;]*;[ \t]*\n/gm;
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(source)) !== null) {
    lastEnd = match.index + match[0].length;
  }
  return lastEnd;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
