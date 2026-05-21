/**
 * Replaces `next-i18next` package specifiers with `react-i18next` (same public
 * hooks/components as re-exported by next-i18next). Removes the obsolete
 * `next-i18next/serverSideTranslations` import line (TanStack uses client-side
 * i18n bootstrap instead).
 */

/** Pages/App SSG helper — not available on `react-i18next`; strip import line only. */
export function stripNextI18nextServerSideTranslationsImport(source: string): string {
  return source.replace(
    /^\s*import\s+\{[^}]*serverSideTranslations[^}]*\}\s+from\s+["']next-i18next\/serverSideTranslations["']\s*;?\s*\n/gm,
    ""
  );
}

/**
 * `from "next-i18next"` / `from 'next-i18next'` and `import("next-i18next")` → react-i18next.
 * Preserves quote style via capture group.
 */
export function rewriteNextI18nextMainAndDynamicImports(source: string): string {
  let s = source;
  s = s.replace(/from\s+(["'])next-i18next\1/g, "from $1react-i18next$1");
  s = s.replace(/import\s*\(\s*(["'])next-i18next\1\s*\)/g, "import($1react-i18next$1)");
  return s;
}

/** Used by R10a app-route pipeline and the cross-cutting i18n import step. */
export function applyNextI18nextToReactI18nextModuleRewrites(source: string): string {
  let s = stripNextI18nextServerSideTranslationsImport(source);
  s = rewriteNextI18nextMainAndDynamicImports(s);
  return s;
}
