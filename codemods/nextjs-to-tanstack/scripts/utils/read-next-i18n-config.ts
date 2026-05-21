/**
 * Best-effort discovery of Next.js `i18n` settings from `next-i18next.config.*`
 * or `next.config.*` (same sources Next reads at build time).
 * Used to emit optional `/{-$locale}/…` TanStack routes per:
 * https://tanstack.com/router/latest/docs/guide/internationalization-i18n
 */

import { readFileSync } from "fs";
import { join } from "path";

export type NextI18nCodemodConfig = {
  defaultLocale: string;
  locales: string[];
};

const NEXT_I18NEXT_CANDIDATES = [
  "next-i18next.config.js",
  "next-i18next.config.mjs",
  "next-i18next.config.cjs",
] as const;

const NEXT_CONFIG_CANDIDATES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
  "next.config.mts",
  "next.config.cts",
] as const;

function readTextIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function readResolvedI18nConfig(packageRoot: string): NextI18nCodemodConfig | null {
  const fromCodemod = readCodemodI18nJson(packageRoot);
  if (fromCodemod) return fromCodemod;
  return readNextI18nConfig(packageRoot);
}

export function readCodemodI18nJson(packageRoot: string): NextI18nCodemodConfig | null {
  const p = join(packageRoot, ".codemod/i18n.json");
  const text = readTextIfExists(p);
  if (!text) return null;
  try {
    const j = JSON.parse(text) as {
      defaultLocale?: string;
      locales?: string[];
    };
    if (!j.defaultLocale || !j.locales?.length) return null;
    return { defaultLocale: j.defaultLocale, locales: j.locales };
  } catch {
    return null;
  }
}

export function readNextI18nConfig(packageRoot: string): NextI18nCodemodConfig | null {
  for (const name of NEXT_I18NEXT_CANDIDATES) {
    const p = join(packageRoot, name);
    const text = readTextIfExists(p);
    if (!text) continue;
    const parsed = parseI18nBlock(text);
    if (parsed) return parsed;
  }
  for (const name of NEXT_CONFIG_CANDIDATES) {
    const p = join(packageRoot, name);
    const text = readTextIfExists(p);
    if (!text) continue;
    const parsed = parseI18nFromNextConfig(text);
    if (parsed) return parsed;
  }
  return null;
}

function parseI18nFromNextConfig(source: string): NextI18nCodemodConfig | null {
  /** `i18n` may be inlined or `const { i18n } = require("./next-i18next.config")` — read file is enough when inlined. */
  return parseI18nBlock(source);
}

/**
 * Looks for `i18n:` or top-level `defaultLocale` / `locales` as in next-i18next.config.js.
 */
function parseI18nBlock(source: string): NextI18nCodemodConfig | null {
  if (!/\bi18n\s*:/.test(source) && !/\bdefaultLocale\s*:/.test(source)) {
    return null;
  }
  const defaultLocale = extractDefaultLocale(source);
  const locales = extractLocalesArray(source);
  if (locales.length === 0 && !defaultLocale) return null;
  const def = defaultLocale ?? locales[0] ?? "en";
  const merged = locales.length > 0 ? (locales.includes(def) ? locales : [def, ...locales]) : [def];
  return { defaultLocale: def, locales: [...new Set(merged)] };
}

function extractDefaultLocale(source: string): string | null {
  const m = source.match(/defaultLocale\s*:\s*["']([^"']+)["']/);
  return m?.[1] ?? null;
}

function extractLocalesArray(source: string): string[] {
  const m = source.match(/locales\s*:\s*\[([\s\S]*?)\]/);
  if (!m?.[1]) return [];
  const inner = m[1];
  const parts = inner.split(",");
  const out: string[] = [];
  for (const p of parts) {
    const q = p.match(/["']([^"']+)["']/);
    if (q?.[1]) out.push(q[1]);
  }
  return out;
}
