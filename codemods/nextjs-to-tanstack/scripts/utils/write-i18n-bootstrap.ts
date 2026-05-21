/**
 * Writes `src/i18n.ts` or root `i18n.ts`: i18next for react-i18next after next-i18next is gone.
 * Loads `public/locales/<lng>/common.json` (SSR: `node:fs`, client: fetch; no extra deps).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { NextI18nCodemodConfig } from './read-next-i18n-config.ts'

export function generateI18nModuleSource(cfg: NextI18nCodemodConfig): string {
  const localesLiteral = cfg.locales.map((l) => JSON.stringify(l)).join(', ')
  const defaultLiteral = JSON.stringify(cfg.defaultLocale)

  return `/// <reference types="vite/client" />\n/**\n * nextjs-to-tanstack: i18next + react-i18next. Align \\\`lng\\\` with \\\`/{-$locale}\\\` routes (i18n.changeLanguage).\n */\nimport i18n from "i18next";\nimport { initReactI18next } from "react-i18next";\n\nconst DEFAULT_LNG = ${defaultLiteral};\nconst LOCALES = [${localesLiteral}] as const;\n\nasync function loadAllResources(): Promise<\n  Record<string, { common: Record<string, unknown> }>\n> {\n  if (import.meta.env.SSR) {\n    const { readFileSync, existsSync } = await import("node:fs");\n    const { join } = await import("node:path");\n    const out: Record<string, { common: Record<string, unknown> }> = {};\n    for (const lng of LOCALES) {\n      const p = join(process.cwd(), "public", "locales", lng, "common.json");\n      if (existsSync(p)) {\n        out[lng] = {\n          common: JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>,\n        };\n      }\n    }\n    return out;\n  }\n  const out: Record<string, { common: Record<string, unknown> }> = {};\n  await Promise.all(\n    LOCALES.map(async (lng) => {\n      const res = await fetch(\`/locales/\${lng}/common.json\`);\n      if (res.ok) {\n        out[lng] = { common: (await res.json()) as Record<string, unknown> };\n      }\n    }),\n  );\n  return out;\n}\n\nconst resources = await loadAllResources();\n\nawait i18n.use(initReactI18next).init({\n  resources,\n  lng: DEFAULT_LNG,\n  fallbackLng: DEFAULT_LNG,\n  supportedLngs: [...LOCALES],\n  ns: ["common"],\n  defaultNS: "common",\n  interpolation: { escapeValue: false },\n  react: { useSuspense: false },\n});\n\nexport default i18n;\n`
}

/** Exists and readable; JSSG fs API is thin. */
function fileExistsReadable(path: string): boolean {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

/** Writes bootstrap once; skips if target exists. */
export function writeI18nBootstrapIfAbsent(repoRoot: string, cfg: NextI18nCodemodConfig, useSrcLayout: boolean): void {
  const rel = useSrcLayout ? join('src', 'i18n.ts') : 'i18n.ts'
  const abs = join(repoRoot, rel)
  if (fileExistsReadable(abs)) {
    return
  }
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, generateI18nModuleSource(cfg))
}
