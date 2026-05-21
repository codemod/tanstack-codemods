/**
 * When `.codemod/i18n.json` exists, ensures `react-i18next` is wired at the root:
 * - Writes `src/i18n.ts` if missing (same bootstrap as scaffold).
 * - Patches `__root.tsx` to wrap `<Outlet />` with `<I18nextProvider i18n={i18n}>`
 *   when not already present.
 */

import type { Codemod } from "codemod:ast-grep";
import type JSON_TYPES from "codemod:ast-grep/langs/json";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { hasSrcAppOrPages } from "../utils/has-src-app-or-pages.ts";
import { emitWorkflowStepReport, WORKFLOW_NODE_IDS } from "../utils/migration-run-report.ts";
import { getFilename, normalizePath } from "../utils/paths.ts";
import { readCodemodI18nJson } from "../utils/read-next-i18n-config.ts";
import { writeI18nBootstrapIfAbsent } from "../utils/write-i18n-bootstrap.ts";

function readableFile(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

const codemod: Codemod<JSON_TYPES> = async (root) => {
  const file = getFilename(root);
  if (!file.endsWith("/package.json") && !file.endsWith("package.json")) {
    return null;
  }

  const repoRoot = dirname(file);
  const cfg = readCodemodI18nJson(repoRoot);
  if (!cfg) return null;

  const report = {
    step: WORKFLOW_NODE_IDS.patchRootI18nProvider,
    packageRoot: normalizePath(repoRoot),
    wroteI18nBootstrapFile: false,
    patchedI18nextProviderInRoot: false,
    preloadedI18nImportInRouter: false,
    notes: [] as string[],
  };

  const useSrc = hasSrcAppOrPages(repoRoot) || readableFile(join(repoRoot, "src/router.tsx"));

  const i18nRel = useSrc ? join(repoRoot, "src/i18n.ts") : join(repoRoot, "i18n.ts");
  const hadI18nModule = readableFile(i18nRel);

  writeI18nBootstrapIfAbsent(repoRoot, cfg, useSrc);
  report.wroteI18nBootstrapFile = !hadI18nModule && readableFile(i18nRel);

  const i18nModulePath = "../i18n";
  const rootPath = useSrc ? join(repoRoot, "src/app/__root.tsx") : join(repoRoot, "app/__root.tsx");

  if (!readableFile(rootPath)) {
    report.notes.push("__root.tsx missing — skipped provider patch");
    emitWorkflowStepReport(report);
    return null;
  }

  let src = readFileSync(rootPath, "utf8");
  if (/\bI18nextProvider\b/.test(src)) {
    report.notes.push("__root already wraps I18nextProvider");
    emitWorkflowStepReport(report);
    return null;
  }

  const outletRe = /<Outlet\b[^>]*\/>/;
  if (!outletRe.test(src)) {
    report.notes.push("No <Outlet /> match — skipped provider patch");
    emitWorkflowStepReport(report);
    return null;
  }

  if (!/from\s+["']react-i18next["']/.test(src)) {
    src = `import { I18nextProvider } from "react-i18next";\nimport i18n from "${i18nModulePath}";\n${src}`;
  } else if (!/\bimport\s+i18n\s+from\s+["']/.test(src)) {
    src = `import i18n from "${i18nModulePath}";\n${src}`;
  }

  const patched = src.replace(
    outletRe,
    (m) => `<I18nextProvider i18n={i18n}>${m}</I18nextProvider>`
  );
  if (patched === src) {
    report.notes.push("Outlet replace produced no change");
    emitWorkflowStepReport(report);
    return null;
  }

  writeFileSync(rootPath, patched);
  report.patchedI18nextProviderInRoot = true;

  const routerFile = useSrc ? join(repoRoot, "src/router.tsx") : join(repoRoot, "router.tsx");
  if (readableFile(routerFile)) {
    let r = readFileSync(routerFile, "utf8");
    if (!/\bimport\s+["']\.?\/?i18n["']/.test(r) && !r.includes('from "./i18n"')) {
      r = `import "./i18n";\n${r}`;
      writeFileSync(routerFile, r);
      report.preloadedI18nImportInRouter = true;
    } else {
      report.notes.push("router already imports i18n");
    }
  } else {
    report.notes.push("router.tsx missing — skipped i18n preload");
  }

  emitWorkflowStepReport(report);
  return null;
};

export default codemod;
