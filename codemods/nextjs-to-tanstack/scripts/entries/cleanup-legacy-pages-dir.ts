/**
 * R14 — After route transforms, remove Next.js `pages/` (and `src/pages/`) so the
 * package no longer carries an abandoned router tree.
 *
 * - Empty directories: deleted.
 * - Non-empty (e.g. `_document.tsx`, `_error.tsx` never migrated): entire tree
 *   copied to `migrated-from-pages/{root-pages|src-pages}/` at the package root,
 *   then the original `pages` directory is removed. This keeps unmigrated files
 *   without registering them as TanStack routes under `app/`.
 *
 * Triggers on `package.json`; does not edit JSON.
 */

import type { Codemod } from "codemod:ast-grep";
import type JSON_TYPES from "codemod:ast-grep/langs/json";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, type Stats } from "fs";
import { safeRemoveDir } from "../utils/safe-remove.ts";
import { dirname, join } from "path";
import { emitWorkflowStepReport, WORKFLOW_NODE_IDS } from "../utils/migration-run-report.ts";
import { getFilename, normalizePath } from "../utils/paths.ts";

const BACKUP_SUBDIR = "migrated-from-pages";
const README_NAME = "README.txt";
const README_BODY =
  "This folder was created by the nextjs-to-tanstack codemod.\n" +
  "It holds files that still lived under Next.js pages/ after the automated migration.\n" +
  "Port them into TanStack Start (routes under app/, server routes, loaders) and delete\n" +
  "what you no longer need.\n";

type LegacyPagesDirOutcome = "absent" | "removed-empty" | "backed-up";

const codemod: Codemod<JSON_TYPES> = async (root) => {
  const file = getFilename(root);
  if (!file.endsWith("/package.json") && !file.endsWith("package.json")) {
    return null;
  }

  const pkgRoot = dirname(file);

  const rootPages = handleLegacyPages(
    join(pkgRoot, "pages"),
    join(pkgRoot, BACKUP_SUBDIR, "root-pages")
  );
  const srcPages = handleLegacyPages(
    join(pkgRoot, "src/pages"),
    join(pkgRoot, BACKUP_SUBDIR, "src-pages")
  );

  emitWorkflowStepReport({
    step: WORKFLOW_NODE_IDS.cleanupLegacyPages,
    packageRoot: normalizePath(pkgRoot),
    pagesAtRoot: rootPages,
    pagesUnderSrc: srcPages,
  });

  return null;
};

export default codemod;

/**
 * If `pagesPath` is a directory: remove when empty; otherwise copy to `backupDest`
 * and remove the source tree.
 */
function handleLegacyPages(pagesPath: string, backupDest: string): LegacyPagesDirOutcome {
  let st: Stats;
  try {
    st = statSync(pagesPath);
  } catch {
    return "absent";
  }
  if (!st.isDirectory()) return "absent";

  const entries = readdirSync(pagesPath);
  if (entries.length === 0) {
    try {
      safeRemoveDir(pagesPath);
    } catch {
      /* busy or permission — ignore */
    }
    return "removed-empty";
  }

  mkdirSync(dirname(backupDest), { recursive: true });
  if (pathExists(backupDest)) {
    safeRemoveDir(backupDest);
  }
  copyDirRecursive(pagesPath, backupDest);
  safeRemoveDir(pagesPath);

  const readmePath = join(dirname(backupDest), README_NAME);
  if (!pathExists(readmePath)) {
    try {
      writeFileSync(readmePath, README_BODY);
    } catch {
      /* best-effort */
    }
  }
  return "backed-up";
}

function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dest, name);
    const ent = statSync(from);
    if (ent.isDirectory()) {
      copyDirRecursive(from, to);
    } else {
      writeFileSync(to, readFileSync(from, "utf8"));
    }
  }
}

function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
