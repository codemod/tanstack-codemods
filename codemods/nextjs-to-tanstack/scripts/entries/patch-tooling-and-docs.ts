/**
 * Post–package.json cleanup for Vite + TanStack: tsconfig, ESLint JSON,
 * README, and package-local GitHub workflow text (within the workflow target).
 *
 * Triggers when `@tanstack/react-start` is already in the manifest (same
 * gate as the migration guide). Mutates only files under the package root
 * directory that contains the visited `package.json`.
 */

import type { Codemod } from "codemod:ast-grep";
import type JSON_TYPES from "codemod:ast-grep/langs/json";
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getFilename } from "../utils/paths.ts";

/** Leftover `pages/` backups from R14 — not typecheck targets. */
const MIGRATION_TS_EXCLUDES = [
  "migrated-from-pages",
  "**/migrated-from-pages/**",
  "**/migrated-from-pages-*/**",
] as const;

interface TsConfig {
  compilerOptions?: Record<string, unknown>;
  exclude?: string[];
  [key: string]: unknown;
}

interface EsLintRc {
  extends?: string | string[];
  [key: string]: unknown;
}

const codemod: Codemod<JSON_TYPES> = async (root) => {
  const file = getFilename(root);
  if (!file.endsWith("/package.json") && !file.endsWith("package.json")) {
    return null;
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(root.root().text()) as Record<string, unknown>;
  } catch {
    return null;
  }

  const deps = {
    ...((pkg.dependencies ?? {}) as Record<string, string>),
    ...((pkg.devDependencies ?? {}) as Record<string, string>),
  };
  if (!deps["@tanstack/react-start"]) return null;

  const rootDir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";

  patchTsconfig(join(rootDir, "tsconfig.json"));
  patchTsconfig(join(rootDir, "tsconfig.app.json"));
  patchTsconfig(join(rootDir, "tsconfig.node.json"));

  patchEslintrcJson(join(rootDir, ".eslintrc.json"));

  patchTextFile(join(rootDir, "README.md"), patchNextReferencesInText);
  const workflowsDir = join(rootDir, ".github", "workflows");
  let workflowNames: string[] = [];
  try {
    workflowNames = readdirSync(workflowsDir);
  } catch {
    workflowNames = [];
  }
  for (const name of workflowNames) {
    if (!/\.(ya?ml)$/i.test(name)) continue;
    patchTextFile(join(workflowsDir, name), patchNextReferencesInText);
  }

  return null;
};

export default codemod;

function patchTsconfig(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  let cfg: TsConfig;
  try {
    cfg = JSON.parse(raw) as TsConfig;
  } catch {
    return;
  }
  const before = JSON.stringify(cfg);
  if (cfg.compilerOptions === undefined) {
    cfg.compilerOptions = {};
  }
  const coerce = cfg.compilerOptions;

  if (Array.isArray(coerce.plugins)) {
    coerce.plugins = coerce.plugins.filter((p) => {
      if (!p || typeof p !== "object") return true;
      const name = (p as { name?: string }).name;
      return name !== "next";
    });
    if ((coerce.plugins as unknown[]).length === 0) delete coerce.plugins;
  }

  const types = coerce.types;
  if (types === undefined) {
    coerce.types = ["vite/client"];
  } else if (typeof types === "string") {
    coerce.types = types === "vite/client" ? types : [types, "vite/client"];
  } else if (Array.isArray(types)) {
    const list = types.map(String);
    if (!list.includes("vite/client")) coerce.types = [...list, "vite/client"];
  }

  mergeMigrationTsExcludes(cfg);

  if (JSON.stringify(cfg) === before) return;
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
}

function mergeMigrationTsExcludes(cfg: TsConfig): void {
  const raw = cfg.exclude;
  const cur = Array.isArray(raw) ? raw.map(String) : [];
  for (const p of MIGRATION_TS_EXCLUDES) {
    if (!cur.includes(p)) cur.push(p);
  }
  cfg.exclude = cur;
}

function patchEslintrcJson(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  let cfg: EsLintRc;
  try {
    cfg = JSON.parse(raw) as EsLintRc;
  } catch {
    return;
  }
  const before = JSON.stringify(cfg);
  const drop = new Set([
    "next/core-web-vitals",
    "next",
    "eslint-config-next",
    "plugin:@next/next/recommended",
  ]);

  if (typeof cfg.extends === "string") {
    if (drop.has(cfg.extends)) {
      cfg.extends = ["eslint:recommended"];
    }
  } else if (Array.isArray(cfg.extends)) {
    const next = cfg.extends.filter((e) => !drop.has(String(e)));
    cfg.extends = next.length > 0 ? next : (["eslint:recommended"] as string[]);
  }

  if (JSON.stringify(cfg) === before) return;
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
}

function patchNextReferencesInText(text: string): string {
  let t = text;
  t = t.replace(/\bnext\s+build\b/g, "vite build");
  t = t.replace(/\bnext\s+dev\b/g, "vite dev");
  t = t.replace(/\bnext\s+start\b/g, "node .output/server/index.mjs");
  t = t.replace(/\bnext\s+lint\b/g, "eslint .");
  t = t.replace(/\bnext\.config\.(js|cjs|mjs|ts|mts|cts)\b/g, "vite.config.ts");
  return t;
}

function patchTextFile(path: string, patch: (s: string) => string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const next = patch(raw);
  if (next !== raw) writeFileSync(path, next);
}
