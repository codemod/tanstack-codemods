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
 */
export function collapseDuplicateTrailingExportClosures(source: string): string {
  return source.replace(/(\}\s*;)(\s*\}\s*;)+\s*$/, "$1\n");
}
