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
 * `next` is **always** removed from the manifest once TanStack deps are added.
 * Packages such as `next-auth` may remain until you replace them with
 * framework-agnostic or TanStack-oriented alternatives; they no longer keep
 * `next` installed. `next-i18next` is removed because this workflow rewrites its
 * imports and emits an i18next/react-i18next bootstrap when locales are known.
 *
 * Mutations:
 *   - dependencies: remove `next`, `@tailwindcss/postcss`, and
 *     `eslint-config-next` / `@next/eslint-plugin-next` (from either bucket);
 *     ensure TanStack Start deps (`@tanstack/react-router`, `@tanstack/react-start`,
 *     `vite`, `@vitejs/plugin-react`, `nitro`, `@unpic/react`) exist at `"latest"` unless
 *     already present with a different version.
 *     Also ensure optional runtime packages used by emitted rewrites (`satori`,
 *     `@resvg/resvg-js`, `i18next`, `react-i18next`, `path-to-regexp`,
 *     `@edge-runtime/user-agent` when R4h rewrote `userAgent`) are present.
 *   - devDependencies: ensure `@tailwindcss/vite` and `tailwindcss` exist.
 *     For each **Google** sidecar font (`next/font/google`), add
 *     `@fontsource-variable/<packageKey>` at `"latest"`.
 *     `next/font/local` is skipped — those files are not on the registry.
 *   - scripts: replace any `dev`/`build`/`start` script that invokes `next` with
 *     the TanStack equivalent. Other scripts are untouched.
 *   - top level: ensure `"type": "module"`.
 */

import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs'

import type { Codemod } from 'codemod:ast-grep'
import type JSON_TYPES from 'codemod:ast-grep/langs/json'

import { emitWorkflowStepReport, WORKFLOW_NODE_IDS } from '../utils/migration-run-report.ts'
import { getFilename, normalizePath } from '../utils/paths.ts'
import { hasFontsourcePackage, readSidecar } from '../utils/sidecar.ts'

interface PackageJson {
  name?: string
  type?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

const RUNTIME_DEPS: [string, string][] = [
  /** Emitted by scaffold `query-client.ts` and `rewrite-next-cache` invalidation imports. */
  ['@tanstack/react-query', 'latest'],
  ['@tanstack/react-router', 'latest'],
  ['@tanstack/react-start', 'latest'],
  ['vite', 'latest'],
  ['@vitejs/plugin-react', 'latest'],
  ['nitro', 'latest'],
  ['@unpic/react', 'latest'],
]

const DEV_DEPS: [string, string][] = [
  ['@tailwindcss/vite', 'latest'],
  ['tailwindcss', 'latest'],
]

const codemod: Codemod<JSON_TYPES> = async (root) => {
  const file = getFilename(root)
  if (!file.endsWith('/package.json') && !file.endsWith('package.json')) {
    return null
  }

  const rootNode = root.root()
  const source = rootNode.text()

  let pkg: PackageJson
  try {
    pkg = JSON.parse(source) as PackageJson
  } catch {
    return null
  }

  const before = JSON.stringify(pkg)

  // Monorepo runs may visit every package.json; only migrate Next.js apps.
  const hasNext = Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next)
  if (!hasNext) {
    return null
  }

  const targetDir = inferTargetDir(file)
  const targetDirNorm = normalizePath(targetDir)
  const hadNextI18next = Boolean(pkg.dependencies?.['next-i18next'] ?? pkg.devDependencies?.['next-i18next'])

  const emitReport = (manifestChanged: boolean): void => {
    emitWorkflowStepReport({
      step: WORKFLOW_NODE_IDS.patchPackageJson,
      packageRoot: targetDirNorm,
      packageName: typeof pkg.name === 'string' ? pkg.name : undefined,
      manifestChanged,
      nextAdjacentDepsRemaining: collectNextAdjacentDeps(pkg),
    })
  }

  // Remove Next-specific deps (always — migrated apps do not keep `next`).
  deleteDep(pkg, 'dependencies', 'next')
  deleteDep(pkg, 'dependencies', '@tailwindcss/postcss')
  deleteDep(pkg, 'dependencies', 'next-i18next')
  deleteDep(pkg, 'devDependencies', 'next')
  deleteDep(pkg, 'devDependencies', '@tailwindcss/postcss')
  deleteDep(pkg, 'devDependencies', 'next-i18next')
  deleteDep(pkg, 'devDependencies', 'eslint-config-next')
  deleteDep(pkg, 'devDependencies', '@next/eslint-plugin-next')
  deleteDep(pkg, 'dependencies', 'eslint-config-next')
  deleteDep(pkg, 'dependencies', '@next/eslint-plugin-next')

  // Ensure TanStack runtime deps.
  for (const [name, version] of RUNTIME_DEPS) {
    ensureDep(pkg, 'dependencies', name, version)
  }

  const needsI18next =
    hadNextI18next ||
    fileExists(`${targetDir}/.codemod/i18n.json`) ||
    sourceTreeContains(targetDir, /\bfrom\s+["'](?:react-i18next|i18next)["']/)
  if (needsI18next) {
    ensureDep(pkg, 'dependencies', 'i18next', 'latest')
    ensureDep(pkg, 'dependencies', 'react-i18next', 'latest')
  }
  if (
    sourceTreeContains(targetDir, /\bfrom\s+["']satori["']/) ||
    sourceTreeContains(targetDir, /\bfrom\s+["']@resvg\/resvg-js["']/)
  ) {
    ensureDep(pkg, 'dependencies', 'satori', 'latest')
    ensureDep(pkg, 'dependencies', '@resvg/resvg-js', 'latest')
  }
  if (sourceTreeContains(targetDir, /\bfrom\s+["']path-to-regexp["']|\brequire\s*\(\s*["']path-to-regexp["']\s*\)/)) {
    ensureDep(pkg, 'dependencies', 'path-to-regexp', 'latest')
  }
  if (sourceTreeContains(targetDir, /\bfrom\s+["']@edge-runtime\/user-agent["']/)) {
    ensureDep(pkg, 'dependencies', '@edge-runtime/user-agent', 'latest')
  }

  // Ensure Tailwind devDeps.
  for (const [name, version] of DEV_DEPS) {
    ensureDep(pkg, 'devDependencies', name, version)
  }

  // Fonts from the sidecar.
  const sidecar = readSidecar(targetDir)
  for (const font of sidecar.fonts) {
    if (!hasFontsourcePackage(font)) {
      continue
    }
    ensureDep(pkg, 'devDependencies', `@fontsource-variable/${font.packageKey}`, 'latest')
  }

  // type: module.
  if (pkg.type !== 'module') {
    pkg.type = 'module'
  }

  // Scripts: `npm run dev` must run Vite + TanStack, not `next dev` (404).
  pkg.scripts ??= {}
  const { scripts } = pkg
  if (scripts.dev && /\bnext\b/.test(scripts.dev)) {
    scripts.dev = 'vite dev'
  }
  if (scripts.build && /\bnext\b/.test(scripts.build)) {
    scripts.build = 'vite build'
  }
  if (scripts.start && /\bnext\b/.test(scripts.start)) {
    scripts.start = 'node .output/server/index.mjs'
  }

  const after = JSON.stringify(pkg)
  if (after === before) {
    emitReport(false)
    return null
  }

  // Sort key ordering: keep the original first key sequence to avoid noisy
  // diffs. JSON.parse preserves insertion order, and our ensureDep() appends
  // to the existing object, so ordering should be stable.

  const serialised = `${stringifyOrdered(pkg)}\n`

  emitReport(true)

  const { start, end } = rootNode.range()
  return rootNode.commitEdits([
    {
      startPos: start.index,
      endPos: end.index,
      insertedText: serialised,
    },
  ])
}

export default codemod

function deleteDep(pkg: PackageJson, bucket: 'dependencies' | 'devDependencies', name: string): void {
  const existing = pkg[bucket]
  if (!existing) {
    return
  }
  if (!(name in existing)) {
    return
  }
  delete existing[name]
}

function ensureDep(pkg: PackageJson, bucket: 'dependencies' | 'devDependencies', name: string, version: string): void {
  pkg[bucket] ??= {}
  const existing = pkg[bucket]
  if (!(name in existing)) {
    existing[name] = version
  }
}

function stringifyOrdered(pkg: PackageJson): string {
  // Ensure predictable key ordering for reproducible diffs: top-level keys
  // follow a conventional order; unknown keys are preserved in the tail.
  const preferredOrder = [
    'name',
    'version',
    'description',
    'private',
    'type',
    'engines',
    'scripts',
    'dependencies',
    'devDependencies',
    'peerDependencies',
  ]
  const seen = new Set<string>()
  const out: Record<string, unknown> = {}
  for (const key of preferredOrder) {
    if (key in pkg) {
      out[key] = pkg[key]
      seen.add(key)
    }
  }
  for (const key of Object.keys(pkg)) {
    if (!seen.has(key)) {
      out[key] = pkg[key]
    }
  }
  return JSON.stringify(out, null, 2)
}

function inferTargetDir(packageJsonPath: string): string {
  const idx = packageJsonPath.lastIndexOf('/')
  if (idx === -1) {
    return '.'
  }
  return packageJsonPath.slice(0, idx)
}

function fileExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function sourceTreeContains(dir: string, needle: RegExp): boolean {
  const ignored = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.git', 'migrated-from-pages'])
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) {
      break
    }
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }
    for (const name of entries) {
      if (ignored.has(name)) {
        continue
      }
      const full = `${current}/${name}`
      let st: Stats
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!/\.(?:[cm]?[jt]sx?|json)$/.test(name)) {
        continue
      }
      let text: string
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      if (needle.test(text)) {
        return true
      }
    }
  }
  return false
}

function collectNextAdjacentDeps(pkg: PackageJson): string[] {
  const names = new Set<string>()
  for (const bucket of [pkg.dependencies, pkg.devDependencies]) {
    if (!bucket) {
      continue
    }
    for (const name of Object.keys(bucket)) {
      if (name.startsWith('next-') || name.startsWith('@next/') || name === '@sentry/nextjs') {
        names.add(name)
      }
    }
  }
  return [...names].sort()
}
