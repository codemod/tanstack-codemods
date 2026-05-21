/**
 * Collapses erroneous repeated `};` tails at **end of file only** (e.g. `};};`),
 * which can appear after partial Pages/SSG stripping or bad merges while the rest
 * of the module is a normal component (no `export const Route`).
 *
 * Does not touch lines ending in `});` (typical `createFileRoute(...)()` close).
 *
 * IMPORTANT: Never use `/m` on `$` here — with multiline `$`, `\s*` can span
 * newlines inside nested object/type literals and falsely match legitimate `};`
 * pairs mid-file (e.g. Prisma `TeamGetPayload<{ ... }>`).
 *
 * Duplicate closings must use **horizontal** whitespace only between stacked `};`
 * tokens (e.g. `};};`). If a **newline** separates two trailing `};`, that is
 * almost always valid code (`return { … };` then the outer block `};`), not a
 * merge artifact — deleting it corrupts hooks and helpers (see app `_hooks/*.ts`).
 */
export function collapseDuplicateTrailingExportClosures(source: string): string {
  return source.replace(/(\}\s*;)((?:[ \t]*\}\s*;)+)\s*$/, '$1\n')
}
