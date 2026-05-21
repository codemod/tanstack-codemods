/**
 * R12 — Patch `globals.css` with font loading the TanStack / Vite-friendly way:
 *
 * - **Google (`next/font/google`)** — `@import "@fontsource-variable/<pkg>"` plus
 *   Tailwind `@theme inline` entries (same pattern as Fontsource + Tailwind v4 docs).
 * - **Local (`next/font/local`)** — `@font-face` rules with `url(...)` relative to this
 *   CSS file, plus matching `@theme inline` lines for each `--font-*` variable.
 *
 * Targets: `src/app/globals.css`, `app/globals.css`, `src/styles/globals.css`,
 * and `styles/globals.css`.
 */

import type { Codemod, Edit } from "codemod:ast-grep";
import type CSS from "codemod:ast-grep/langs/css";
import { dirname, join, relative } from "path";
import { getFilename, inferCodemodTargetDir, normalizePath } from "../utils/paths.ts";
import { readSidecar, type FontEntry, hasFontsourcePackage } from "../utils/sidecar.ts";

const LOCAL_MARKER_PREFIX = "/* @codemod:next-font-local:";

const codemod: Codemod<CSS> = async (root) => {
  const file = getFilename(root);
  if (!/\/globals\.css$/.test(file)) return null;

  const rootNode = root.root();
  const source = rootNode.text();

  const targetDir = inferCodemodTargetDir(file);
  const sidecar = readSidecar(targetDir);
  const googleFonts = sidecar.fonts.filter(hasFontsourcePackage);
  const localFonts = sidecar.fonts.filter(
    (f) => f.importSource === "next/font/local" && f.localFaces && f.localFaces.length > 0
  );
  if (googleFonts.length === 0 && localFonts.length === 0) return null;

  const edits: Edit[] = [];

  const importBlock = buildGoogleFontsourceImports(source, googleFonts);
  const fontFaceBlock = buildLocalFontFaceBlock(source, file, localFonts);
  const themeLines = collectThemeLines(source, googleFonts, localFonts);

  const importAnchor = findAfterLastImport(source);
  let headInsert = `${importBlock}${fontFaceBlock}`;
  const themeMerge = tryMergeThemeLines(source, themeLines);
  if (themeMerge) {
    edits.push({
      startPos: themeMerge.pos,
      endPos: themeMerge.pos,
      insertedText: themeMerge.text,
    });
  } else if (themeLines.length > 0) {
    headInsert += `@theme inline {\n${themeLines.join("\n")}\n}\n`;
  }

  if (headInsert.length > 0) {
    edits.push({
      startPos: importAnchor,
      endPos: importAnchor,
      insertedText: headInsert,
    });
  }

  if (edits.length === 0) return null;
  edits.sort((a, b) => b.startPos - a.startPos);
  return rootNode.commitEdits(edits);
};

export default codemod;

function buildGoogleFontsourceImports(source: string, fonts: FontEntry[]): string {
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

function buildLocalFontFaceBlock(source: string, globalsAbs: string, fonts: FontEntry[]): string {
  const globalsDir = dirname(normalizePath(globalsAbs));
  const pkgRoot = normalizePath(inferCodemodTargetDir(globalsAbs));
  const chunks: string[] = [];

  for (const font of fonts) {
    const faces = font.localFaces ?? [];
    const displayFamily = cssFontFamilyName(font);
    for (const face of faces) {
      const markerComment = `${LOCAL_MARKER_PREFIX}${font.packageKey}:${face.repoRelativePath} */`;
      if (source.includes(markerComment)) continue;

      const absFont = join(pkgRoot, ...face.repoRelativePath.split(/[/\\]/).filter(Boolean));
      let rel = normalizePath(relative(globalsDir, absFont)).replace(/\\/g, "/");
      if (!rel.startsWith(".") && !rel.startsWith("/")) {
        rel = `./${rel}`;
      }
      const fmt = guessFontFormat(face.repoRelativePath);
      const lines: string[] = [
        markerComment,
        "@font-face {",
        `  font-family: '${escapeCssFamilyName(displayFamily)}';`,
        `  src: url('${escapeCssUrl(rel)}') format('${fmt}');`,
      ];
      if (face.weight) lines.push(`  font-weight: ${face.weight};`);
      if (face.style) lines.push(`  font-style: ${face.style};`);
      const disp = font.fontDisplay ?? "swap";
      lines.push(`  font-display: ${disp};`);
      lines.push("}");
      chunks.push(lines.join("\n"));
    }
  }
  if (chunks.length === 0) return "";
  return `${chunks.join("\n\n")}\n\n`;
}

function guessFontFormat(repoPath: string): string {
  const lower = repoPath.toLowerCase();
  if (lower.endsWith(".woff2")) return "woff2";
  if (lower.endsWith(".woff")) return "woff";
  if (lower.endsWith(".ttf")) return "truetype";
  if (lower.endsWith(".otf")) return "opentype";
  return "woff2";
}

function cssFontFamilyName(font: FontEntry): string {
  if (font.fontFaceFamily) return font.fontFaceFamily;
  return bindingToDisplayFamily(font.family);
}

/** `geistMono` → "Geist Mono", `sourceSerifLocal` → "Source Serif Local" */
function bindingToDisplayFamily(binding: string): string {
  const spaced = binding.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function escapeCssFamilyName(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function escapeCssUrl(s: string): string {
  return s.replace(/\\/g, "/").replace(/'/g, "\\'");
}

function collectThemeLines(
  source: string,
  googleFonts: FontEntry[],
  localFonts: FontEntry[]
): string[] {
  const themeLines: string[] = [];

  for (const font of googleFonts) {
    const varName = font.variable ?? inferVarName(font);
    if (themeVarDeclared(source, varName)) continue;
    const familyDisplay = familyDisplayName(font.family);
    themeLines.push(`  ${varName}: '${familyDisplay} Variable', sans-serif;`);
  }

  for (const font of localFonts) {
    const varName = font.variable ?? inferVarName(font);
    const displayFamily = cssFontFamilyName(font);
    if (themeVarDeclared(source, varName)) continue;
    themeLines.push(
      `  ${varName}: '${escapeCssFamilyName(displayFamily)}', ui-sans-serif, sans-serif;`
    );
  }

  return themeLines;
}

function themeVarDeclared(source: string, varName: string): boolean {
  return new RegExp(`^\\s*${escapeRegex(varName)}\\s*:`, "m").test(source);
}

function findThemeInlineBlockRange(
  source: string
): { bodyStart: number; closeBrace: number } | null {
  const m = source.match(/@theme\s+inline\s*\{/);
  if (!m || m.index === undefined) return null;
  const openBrace = m.index + m[0].length - 1;
  let i = openBrace + 1;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  if (depth !== 0) return null;
  return { bodyStart: openBrace + 1, closeBrace: i - 1 };
}

/** Insert new lines before the closing `}` of an existing `@theme inline` block. */
function tryMergeThemeLines(
  source: string,
  themeLines: string[]
): { pos: number; text: string } | null {
  if (themeLines.length === 0) return null;
  const r = findThemeInlineBlockRange(source);
  if (!r) return null;
  const inner = source.slice(r.bodyStart, r.closeBrace);
  const toAdd = themeLines.filter((line) => {
    const vm = line.match(/^\s*(--font-[\w-]+)\s*:/);
    if (!vm) return true;
    return !new RegExp(`^\\s*${escapeRegex(vm[1] ?? "")}\\s*:`, "m").test(inner);
  });
  if (toAdd.length === 0) return null;
  return { pos: r.closeBrace, text: `\n${toAdd.join("\n")}` };
}

function inferVarName(font: FontEntry): string {
  return `--font-${font.packageKey}`;
}

function familyDisplayName(raw: string): string {
  return raw.replace(/_/g, " ");
}

function findAfterLastImport(source: string): number {
  const rx = /^@import[^\n;]*;[ \t]*\n/gm;
  let lastEnd = 0;
  let match: RegExpExecArray | null = rx.exec(source);
  while (match !== null) {
    lastEnd = match.index + match[0].length;
    match = rx.exec(source);
  }
  return lastEnd;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
