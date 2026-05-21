/**
 * Thin wrappers on top of `@jssg/utils` so every entry script uses exactly
 * the same import-manipulation surface.
 *
 * `@jssg/utils` is typed against the generic `TypesMap`. Our entry scripts
 * are typed against language-specific maps (e.g. `TSX`). Rather than force
 * every caller to cast, these wrappers perform the structural cast
 * internally. The runtime shape is identical — both resolve to the same
 * tree-sitter AST — so the `unknown as` cast is safe.
 */

import type { Edit, SgNode, TypesMap } from "codemod:ast-grep";
import {
  addImport as rawAddImport,
  getImport as rawGetImport,
  removeImport as rawRemoveImport,
} from "@jssg/utils/javascript/imports";

type AddOpts = Parameters<typeof rawAddImport>[1];
type GetOpts = Parameters<typeof rawGetImport>[1];
type RemoveOpts = Parameters<typeof rawRemoveImport>[1];

// The raw @jssg/utils helpers are declared against the internal JS|TS|TSX
// union, which does not unify with `TypesMap`. At runtime the shapes are
// identical; we cast via `unknown` on the call boundary only.
type RawFn = (program: unknown, options: unknown) => unknown;

export function getImport<T extends TypesMap>(
  program: SgNode<T>,
  options: GetOpts
): ReturnType<typeof rawGetImport> {
  return (rawGetImport as unknown as RawFn)(program, options) as ReturnType<typeof rawGetImport>;
}

export function addImport<T extends TypesMap>(program: SgNode<T>, options: AddOpts): Edit | null {
  return (rawAddImport as unknown as RawFn)(program, options) as Edit | null;
}

export function removeImport<T extends TypesMap>(
  program: SgNode<T>,
  options: RemoveOpts
): Edit | null {
  return (rawRemoveImport as unknown as RawFn)(program, options) as Edit | null;
}

export function removeNamedImports<T extends TypesMap>(
  program: SgNode<T>,
  from: string,
  specifiers: string[]
): Edit[] {
  const edits: Edit[] = [];
  for (const name of specifiers) {
    const edit = removeImport(program, { type: "named", specifiers: [name], from });
    if (edit) edits.push(edit);
  }
  return edits;
}

export function addNamedImport<T extends TypesMap>(
  program: SgNode<T>,
  from: string,
  name: string,
  alias?: string
): Edit | null {
  return addImport(program, {
    type: "named",
    specifiers: [alias ? { name, alias } : { name }],
    from,
  });
}

export function addDefaultImport<T extends TypesMap>(
  program: SgNode<T>,
  from: string,
  name: string
): Edit | null {
  return addImport(program, { type: "default", name, from });
}

/**
 * `@jssg/utils` `addImport` can merge named specifiers as `{ createFileRoute , Link }` (space before `,`).
 * Replace affected `import { … } from "@tanstack/react-router"` statements with normal `, ` spacing.
 */
export function tanstackRouterNamedImportCommaFixEdits<T extends TypesMap>(
  program: SgNode<T>
): Edit[] {
  const edits: Edit[] = [];
  const untyped = program as unknown as SgNode<TypesMap>;
  for (const stmt of untyped.findAll({ rule: { kind: "import_statement" } })) {
    const t = stmt.text();
    if (!/from\s*["']@tanstack\/react-router["']/.test(t)) continue;
    const fixed = t.replace(/([\w$])\s+,/g, "$1,");
    if (fixed !== t) {
      edits.push({
        startPos: stmt.range().start.index,
        endPos: stmt.range().end.index,
        insertedText: fixed,
      });
    }
  }
  return edits;
}

/**
 * True if `program` contains any JSX element whose opening tag's name is
 * `alias`. Use this to detect whether an import's local binding is actually
 * referenced before bothering to rewrite JSX.
 */
export function programHasJsxUsage<T extends TypesMap>(program: SgNode<T>, alias: string): boolean {
  const untyped = program as unknown as SgNode<TypesMap>;
  const match = untyped.find({
    rule: {
      kind: "jsx_opening_element",
      has: {
        field: "name",
        any: [
          { kind: "identifier", regex: `^${escapeRegex(alias)}$` },
          {
            kind: "member_expression",
            has: { kind: "identifier", regex: `^${escapeRegex(alias)}$` },
          },
        ],
      },
    },
  });
  return match != null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
