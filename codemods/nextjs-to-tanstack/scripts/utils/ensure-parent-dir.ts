/**
 * Ensure the parent directory exists before a codemod rename moves a file into
 * a flattened route path (TanStack colocates `page.tsx` into `segment.tsx`,
 * which must not fail with ENOENT).
 *
 * `pruneEmptyAncestorsAfterRename` removes now-empty folders (e.g. abandoned
 * `pages/...` / `app/.../segment` directories) up to the package root.
 *
 * Sandboxed workflow runners (e.g. QuickJS without Node `fs`) cannot call
 * `mkdirSync` / `readdirSync`; failures are swallowed so the host can
 * materialize paths when applying edits and renames.
 */

import { mkdirSync, readdirSync } from "fs";
import type { Dirent } from "fs";
import { basename, dirname, join } from "path";
import { inferCodemodTargetDir, normalizePath } from "./paths.ts";
import { safeRemoveFile, safeRmdirIfEmpty } from "./safe-remove.ts";

/** Filenames that should not block deleting an otherwise abandoned Next.js segment dir. */
const IGNORABLE_APP_DIR_FILES = new Set([".DS_Store", "Thumbs.db", ".gitkeep", ".keep"]);

export function removeIgnorableFilesystemEntriesInDir(dirAbs: string): void {
  let names: string[];
  try {
    names = readdirSync(dirAbs);
  } catch {
    return;
  }
  for (const name of names) {
    if (!IGNORABLE_APP_DIR_FILES.has(name)) continue;
    safeRemoveFile(join(dirAbs, name));
  }
}

export function ensureParentDir(absFilePath: string): void {
  const dir = dirname(absFilePath);
  if (dir === "." || dir === "/") return;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* Host applies the rename and may create parents without Node fs in sandbox */
  }
}

/**
 * Walk upward from the **parent** of the file that was just moved/renamed and
 * remove each directory that ends up empty. Stops at the inferred package root
 * or when a non-empty directory is hit. Safe for monorepos (`-t package/`).
 */
export function pruneEmptyAncestorsAfterRename(previousFileAbsolute: string): void {
  try {
    const pkgRoot = normalizePath(inferCodemodTargetDir(previousFileAbsolute));
    let d = normalizePath(dirname(previousFileAbsolute));

    for (;;) {
      if (d === pkgRoot || !d.startsWith(`${pkgRoot}/`)) return;

      try {
        removeIgnorableFilesystemEntriesInDir(d);
        if (readdirSync(d).length > 0) return;
        if (!safeRmdirIfEmpty(d)) return;
      } catch {
        return;
      }

      const parent = normalizePath(dirname(d));
      if (parent === d) return;
      d = parent;
    }
  } catch {
    /* No Node fs in some runtimes */
  }
}

/**
 * Next.js App Router uses directories like `[slug]` or `[...slug]`; after files
 * move to TanStack flat routes (`$slug.tsx`, `$.tsx`), those folders can be
 * left empty. Remove any such segment directory under `app/` that is empty
 * (after stripping ignorable files like `.DS_Store`). Deepest paths first.
 */
export function pruneEmptyNextBracketSegmentDirsUnderApp(appAbs: string): void {
  try {
    const root = normalizePath(appAbs);

    for (let pass = 0; pass < 32; pass++) {
      const dirs = collectAllSubdirectories(root);
      dirs.sort((a, b) => b.length - a.length);
      let removedAny = false;
      for (const d of dirs) {
        if (!isNextDynamicRouteSegmentFolder(basename(d))) continue;
        removeIgnorableFilesystemEntriesInDir(d);
        try {
          if (readdirSync(d).length === 0 && safeRmdirIfEmpty(d)) removedAny = true;
        } catch {
          /* */
        }
      }
      if (!removedAny) break;
    }

    // e.g. `app/posts/` left empty after `page.tsx` → `posts.tsx` and `[slug]` removed
    for (let pass = 0; pass < 32; pass++) {
      const dirs = collectAllSubdirectories(root);
      dirs.sort((a, b) => b.length - a.length);
      let removedAny = false;
      for (const d of dirs) {
        if (normalizePath(d) === root) continue;
        removeIgnorableFilesystemEntriesInDir(d);
        try {
          if (readdirSync(d).length === 0 && safeRmdirIfEmpty(d)) removedAny = true;
        } catch {
          /* */
        }
      }
      if (!removedAny) break;
    }
  } catch {
    /* sandbox / no fs */
  }
}

function collectAllSubdirectories(root: string): string[] {
  const dirs: string[] = [];
  const collect = (dir: string) => {
    let dirents: Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of dirents) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules") continue;
      const full = join(dir, e.name);
      dirs.push(full);
      collect(full);
    }
  };
  collect(normalizePath(root));
  return dirs;
}

function isNextDynamicRouteSegmentFolder(name: string): boolean {
  return name.startsWith("[") && name.endsWith("]") && name.length >= 3;
}
