/**
 * R11 — Patch `package.json`.
 *
 * Runs on exactly one file (`package.json`) with `language: json`. JSON has
 * no comments to preserve, so we take the simple-and-safe route of
 * parse → mutate → stringify via the standard library. The `.codemod/state.json`
 * sidecar is consulted for font dependencies written by R9.
 *
 * Skips package.json files that do not depend on `next` (so monorepo runs
 * using `** /package.json` globs skip unrelated workspaces).
 *
 * Skips patches when other dependencies still imply a Next runtime
 * (`next-auth`, `@next/fonts`, …) so removing `next` cannot leave broken installs.
 *
 * Mutations:
 *   - dependencies: remove `next`, `@tailwindcss/postcss`; ensure TanStack
 *     Start deps (`@tanstack/react-router`, `@tanstack/react-start`,
 *     `vite`, `@vitejs/plugin-react`, `nitro`, `@unpic/react`) exist at `"latest"` unless
 *     already present with a different version.
 *   - devDependencies: ensure `@tailwindcss/vite` and `tailwindcss` exist.
 *     For each sidecar font, add `@fontsource-variable/<packageKey>` at `"latest"`.
 *   - scripts: replace any `dev`/`build`/`start` script that currently invokes
 *     `next` with the TanStack equivalent. Other scripts are untouched.
 *   - top level: ensure `"type": "module"`.
 */

import type { Codemod } from "codemod:ast-grep";
import type JSON_TYPES from "codemod:ast-grep/langs/json";
import { getFilename } from "../utils/paths.ts";
import { readSidecar } from "../utils/sidecar.ts";

interface PackageJson {
  name?: string;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

const RUNTIME_DEPS: Array<[string, string]> = [
  ["@tanstack/react-router", "latest"],
  ["@tanstack/react-start", "latest"],
  ["vite", "latest"],
  ["@vitejs/plugin-react", "latest"],
  ["nitro", "latest"],
  ["@unpic/react", "latest"],
];

const DEV_DEPS: Array<[string, string]> = [
  ["@tailwindcss/vite", "latest"],
  ["tailwindcss", "latest"],
];

const codemod: Codemod<JSON_TYPES> = async (root) => {
  const file = getFilename(root);
  if (!file.endsWith("/package.json") && !file.endsWith("package.json")) {
    return null;
  }

  const rootNode = root.root();
  const source = rootNode.text();

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(source) as PackageJson;
  } catch {
    return null;
  }

  const before = JSON.stringify(pkg);

  // Monorepo runs may visit every package.json; only migrate Next.js apps.
  const hasNext = Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next);
  if (!hasNext) {
    return null;
  }

  if (hasAdjacentNextDependency(pkg)) {
    return null;
  }

  // Remove Next-specific deps.
  deleteDep(pkg, "dependencies", "next");
  deleteDep(pkg, "dependencies", "@tailwindcss/postcss");
  deleteDep(pkg, "devDependencies", "next");
  deleteDep(pkg, "devDependencies", "@tailwindcss/postcss");

  // Ensure TanStack runtime deps.
  for (const [name, version] of RUNTIME_DEPS) {
    ensureDep(pkg, "dependencies", name, version);
  }

  // Ensure Tailwind devDeps.
  for (const [name, version] of DEV_DEPS) {
    ensureDep(pkg, "devDependencies", name, version);
  }

  // Fonts from the sidecar.
  const targetDir = inferTargetDir(file);
  const sidecar = readSidecar(targetDir);
  for (const font of sidecar.fonts) {
    ensureDep(pkg, "devDependencies", `@fontsource-variable/${font.packageKey}`, "latest");
  }

  // type: module.
  if (pkg.type !== "module") {
    pkg.type = "module";
  }

  // Scripts: only touch those that currently invoke `next`.
  if (pkg.scripts) {
    const scripts = pkg.scripts;
    if (scripts.dev && /\bnext\b/.test(scripts.dev)) scripts.dev = "vite dev";
    if (scripts.build && /\bnext\b/.test(scripts.build)) scripts.build = "vite build";
    if (scripts.start && /\bnext\b/.test(scripts.start))
      scripts.start = "node .output/server/index.mjs";
  }

  const after = JSON.stringify(pkg);
  if (after === before) return null;

  // Sort key ordering: keep the original first key sequence to avoid noisy
  // diffs. JSON.parse preserves insertion order, and our ensureDep() appends
  // to the existing object, so ordering should be stable.

  const serialised = `${stringifyOrdered(pkg)}\n`;

  return rootNode.commitEdits([
    {
      startPos: 0,
      endPos: source.length,
      insertedText: serialised,
    },
  ]);
};

export default codemod;

/** True while ecosystem packages imply a bundled Next dependency (do not strip `next` alone). */
function hasAdjacentNextDependency(pkg: PackageJson): boolean {
  const merged: Record<string, string> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
  delete merged.next;
  delete merged["@tailwindcss/postcss"];

  for (const name of Object.keys(merged)) {
    if (name.startsWith("next-")) return true;
    if (name.startsWith("@next/")) return true;
    // e.g. @sentry/nextjs, @calcom/feature-xyz-next (anything scoped .../next…)
    if (name.includes("/next")) return true;
  }
  return false;
}

function deleteDep(
  pkg: PackageJson,
  bucket: "dependencies" | "devDependencies",
  name: string,
): void {
  const existing = pkg[bucket] as Record<string, string> | undefined;
  if (!existing) return;
  if (!(name in existing)) return;
  delete existing[name];
}

function ensureDep(
  pkg: PackageJson,
  bucket: "dependencies" | "devDependencies",
  name: string,
  version: string,
): void {
  if (!pkg[bucket]) pkg[bucket] = {};
  const existing = pkg[bucket] as Record<string, string>;
  if (!(name in existing)) {
    existing[name] = version;
  }
}

function stringifyOrdered(pkg: PackageJson): string {
  // Ensure predictable key ordering for reproducible diffs: top-level keys
  // follow a conventional order; unknown keys are preserved in the tail.
  const preferredOrder = [
    "name",
    "version",
    "description",
    "private",
    "type",
    "engines",
    "scripts",
    "dependencies",
    "devDependencies",
    "peerDependencies",
  ];
  const seen = new Set<string>();
  const out: Record<string, unknown> = {};
  for (const key of preferredOrder) {
    if (key in pkg) {
      out[key] = pkg[key];
      seen.add(key);
    }
  }
  for (const key of Object.keys(pkg)) {
    if (!seen.has(key)) {
      out[key] = pkg[key];
    }
  }
  return JSON.stringify(out, null, 2);
}

function inferTargetDir(packageJsonPath: string): string {
  const idx = packageJsonPath.lastIndexOf("/");
  if (idx === -1) return ".";
  return packageJsonPath.slice(0, idx);
}
