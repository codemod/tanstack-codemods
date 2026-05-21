/**
 * Sidecar state file read/write helpers.
 *
 * Several workflow steps need to pass structured data between each other
 * (most notably: fonts detected by R9 that R11/R12 need to act on). Rather
 * than passing it through the workflow engine, we write a small JSON file
 * into the target repo at `.codemod/state.json` and remove it in the final
 * `finalize-cleanup` shell node.
 *
 * All fs usage stays inside the sandboxed target directory — no extra
 * capabilities are required.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DEFAULT_FILE = '.codemod/state.json'

export interface LocalFontFace {
  /** Path to the font file, POSIX relative to the package root (e.g. `src/fonts/x.woff2`). */
  repoRelativePath: string
  weight?: string | null
  style?: string | null
}

export interface FontEntry {
  /** Either "next/font/google" or "next/font/local". */
  importSource: 'next/font/google' | 'next/font/local'
  /** Display name, e.g. "Inter". For `next/font/local` this is the binding name unless `fontFaceFamily` is set. */
  family: string
  /** kebab-cased family used for `@fontsource-variable/<packageKey>` (Google only). */
  packageKey: string
  /** Variable option supplied to the Next helper, e.g. "--font-sans". */
  variable: string | null
  /** Google: `subsets` option from `next/font/google` (informational). */
  googleSubsets?: string[] | null
  /** Local: explicit `family` string from `localFont({ family: "…" })` when present. */
  fontFaceFamily?: string | null
  /** Local: one or more files for `@font-face` `src: url(…)`. */
  localFaces?: LocalFontFace[] | null
  /** Local: top-level `display` from `localFont({ … })`. */
  fontDisplay?: string | null
}

/** Only `next/font/google` families are published as `@fontsource-variable/*` on npm. */
export function hasFontsourcePackage(font: FontEntry): boolean {
  return font.importSource === 'next/font/google'
}

export interface SidecarState {
  fonts: FontEntry[]
}

const EMPTY: SidecarState = { fonts: [] }

function resolveFilePath(targetDir: string, file = DEFAULT_FILE): string {
  return join(targetDir, file)
}

export function readSidecar(targetDir: string, file = DEFAULT_FILE): SidecarState {
  const fullPath = resolveFilePath(targetDir, file)
  try {
    const raw = readFileSync(fullPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<SidecarState> | null
    return {
      fonts: Array.isArray(parsed?.fonts) ? parsed.fonts : [],
    }
  } catch {
    return { ...EMPTY }
  }
}

export function writeSidecar(targetDir: string, state: SidecarState, file = DEFAULT_FILE): void {
  const fullPath = resolveFilePath(targetDir, file)
  const dir = dirname(fullPath)
  mkdirSync(dir, { recursive: true })
  writeFileSync(fullPath, `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * Append new font entries, deduping on `packageKey`. Returns the merged state.
 */
export function addFontEntries(state: SidecarState, entries: FontEntry[]): SidecarState {
  const seen = new Set(state.fonts.map((f) => f.packageKey))
  const fonts = [...state.fonts]
  for (const entry of entries) {
    if (seen.has(entry.packageKey)) {
      continue
    }
    fonts.push(entry)
    seen.add(entry.packageKey)
  }
  return { ...state, fonts }
}

/**
 * Convert a Next font family string ("DM_Sans", "Inter", "Roboto Mono") to
 * the kebab-cased key Fontsource uses ("dm-sans", "inter", "roboto-mono").
 */
export function familyToPackageKey(family: string): string {
  return family
    .replaceAll(/[_\s]+/g, '-')
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
}
