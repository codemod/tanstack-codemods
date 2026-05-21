/**
 * Resolve the Vite `?url` import for global CSS next to `__root.tsx`.
 * Uses the migrating layout/`_app` source when imports reference `globals.css`
 * (no `existsSync` — compatible with the JSSG `fs` shim).
 */

import { dirname, join, relative } from "path";
import { inferCodemodTargetDir, normalizePath } from "./paths.ts";

export function resolveGlobalsCssUrlImport(
  __rootTsxAbs: string,
  layoutFileSource?: string,
  layoutFileAbs?: string
): string {
  const appDir = dirname(normalizePath(__rootTsxAbs));
  if (layoutFileSource !== undefined && layoutFileAbs !== undefined) {
    const inferred = inferGlobalsFromImports(layoutFileSource, layoutFileAbs, appDir);
    if (inferred) return inferred;
  }
  return "./globals.css?url";
}

/**
 * Without reading the filesystem: parse `import … '…globals.css'` from the layout
 * file and compute a relative `?url` specifier from the future `__root` directory.
 */
function inferGlobalsFromImports(
  source: string,
  layoutFileAbs: string,
  appDirOfRoot: string
): string | null {
  const layoutDir = dirname(normalizePath(layoutFileAbs));
  const pkgRoot = inferCodemodTargetDir(layoutFileAbs);

  const importRe =
    /import\s+(?:\*\s+as\s+\w+|\{[^}]*\}|\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]([^'"]*globals\.css)['"]/g;
  const sideRe = /import\s*['"]([^'"]*globals\.css)['"]/g;

  const specs: string[] = [];
  for (const re of [importRe, sideRe]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(source);
    while (m !== null) {
      const spec = m[1];
      if (spec === undefined || !spec.includes("globals.css")) continue;
      if (!specs.includes(spec)) specs.push(spec);
      m = re.exec(source);
    }
  }
  // Side-effect-only import `import "…globals.css"`
  const bareRe = /import\s+['"]([^'"]*globals\.css)['"]\s*;/g;
  bareRe.lastIndex = 0;
  let bm: RegExpExecArray | null = bareRe.exec(source);
  while (bm !== null) {
    const spec = bm[1];
    if (spec === undefined || !spec.includes("globals.css")) continue;
    if (!specs.includes(spec)) specs.push(spec);
    bm = bareRe.exec(source);
  }

  for (const spec of specs) {
    const strip = spec.replace(/\?.*$/, "");
    const absPath = resolveCssImportSpecifier(strip, layoutDir, pkgRoot);
    if (!absPath) continue;
    const rel = normalizePath(relative(appDirOfRoot, absPath));
    const withDot = rel.startsWith(".") ? rel : `./${rel}`;
    return `${withDot}?url`;
  }
  return null;
}

function resolveCssImportSpecifier(
  spec: string,
  layoutDir: string,
  pkgRoot: string
): string | null {
  const s = spec;
  if (s.startsWith("@/")) {
    return normalizePath(join(pkgRoot, "src", s.slice(2)));
  }
  if (s.startsWith("~/")) {
    return normalizePath(join(pkgRoot, s.slice(2)));
  }
  if (s.startsWith("./") || s.startsWith("../")) {
    return normalizePath(join(layoutDir, s));
  }
  return null;
}
