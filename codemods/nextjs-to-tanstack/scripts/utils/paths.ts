/**
 * Path helpers. We deliberately avoid `SgRoot.relativeFilename()` because
 * it is not available in every JSSG runtime version; instead we derive the
 * app-relative path from the absolute filename by locating the last
 * `/src/app/` segment. Every other path helper normalizes slashes so the
 * same code paths work on Windows hosts.
 */

import { dirname } from "path";
import type { SgRoot, TypesMap } from "codemod:ast-grep";

const SRC_APP = "/src/app/";

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** True for POSIX absolute paths or Windows `C:/...` after normalization. */
export function isAbsoluteNormalizedPath(path: string): boolean {
  const n = normalizePath(path);
  return n.startsWith("/") || /^[A-Za-z]:\//.test(n);
}

/**
 * Directory where `.codemod/state.json` should live: the package root (parent
 * of `src/` or of `app/` when there is no `src/` prefix before the App Router).
 */
export function inferCodemodTargetDir(fileAbs: string): string {
  const n = normalizePath(fileAbs);
  const srcIdx = n.lastIndexOf("/src/");
  if (srcIdx > 0) {
    return n.slice(0, srcIdx);
  }
  const appIdx = n.lastIndexOf("/app/");
  if (appIdx > 0) {
    return n.slice(0, appIdx);
  }
  return dirname(fileAbs);
}

export function getFilename<T extends TypesMap>(root: SgRoot<T>): string {
  return normalizePath(root.filename());
}

/**
 * Returns the path slice starting at `src/app/...` if the file is under an
 * app directory, otherwise the full (slash-normalised) absolute path.
 *
 * This is what the entry scripts use to classify layout/page/route files;
 * the workflow's `include:` globs guarantee the file shape but we still
 * match defensively in case the step is run standalone.
 */
export function getAppRelativePath<T extends TypesMap>(root: SgRoot<T>): string {
  const file = getFilename(root);
  const idx = file.lastIndexOf(SRC_APP);
  if (idx === -1) {
    // Fall back to the file's tail so single-file tests (no /src/app/
    // prefix) still classify correctly.
    return file;
  }
  return file.slice(idx + 1);
}

/**
 * The repo-root-relative new path for a renamed file. Falls back to the
 * current file's directory when the input isn't under `src/app/` so tests
 * that live outside the conventional tree still function.
 */
export function resolveRenameTarget<T extends TypesMap>(
  root: SgRoot<T>,
  computedNewPath: string,
): string {
  const normalized = normalizePath(computedNewPath);
  if (isAbsoluteNormalizedPath(normalized)) {
    return normalized;
  }
  const file = getFilename(root);
  const idx = file.lastIndexOf(SRC_APP);
  if (idx === -1) {
    const dir = file.slice(0, file.lastIndexOf("/"));
    const leaf = computedNewPath.split("/").pop() ?? computedNewPath;
    return `${dir}/${leaf}`;
  }
  const baseAbs = file.slice(0, idx + 1);
  return `${baseAbs}${computedNewPath}`;
}
