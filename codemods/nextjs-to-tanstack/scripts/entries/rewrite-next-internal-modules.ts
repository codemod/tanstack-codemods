/**
 * R4dist — Remove remaining `next/dist/*` surface and codegen strings that pin
 * `next/dynamic`, so `next/*` imports are not required for these patterns.
 *
 * - `{ ApiError }` from `next/dist/server/api-utils` → small file-local `ApiError` class + TODO
 * - `require("next/dist/compiled/path-to-regexp")` → `require("path-to-regexp")` + file TODO (add dep)
 * - Exact string `import dynamic from "next/dynamic"` (e.g. CLI templates) → `import { lazy as dynamic } from "react"`
 * - `next/image` residuals:
 *   - `import { getImageProps } from "next/image"` → local passthrough helper + TODO
 *   - `import type { ImageProps } from "next/image"` → `type ImageProps = React.ImgHTMLAttributes<HTMLImageElement>`
 * - `import { after } from "next/server"` → local `after()` shim + TODO
 */

import type { Codemod } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { TODO_PREFIX } from "../utils/sentinels.ts";

const R4DIST_SENTINEL = "next/dist migration (R4dist)";
const PATH_TO_REGEXP_TODO_NEEDLE = "replaced Next's bundled copy";

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root();
  const source = rootNode.text();
  let s = source;

  const hadCompiledPathToRegexp = /next\/dist\/compiled\/path-to-regexp/.test(s);

  const apiTodo = `${TODO_PREFIX}${R4DIST_SENTINEL}: ApiError shim — align status codes / JSON body with your TanStack Start server routes — https://tanstack.com/start/latest/docs/framework/react/guide/server-routes\n`;
  s = s.replace(
    /^[ \t]*import\s*\{\s*ApiError\s*\}\s*from\s*["']next\/dist\/server\/api-utils["']\s*;?\s*\r?\n/m,
    `${apiTodo}class ApiError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
  }
}
`,
  );

  s = s.replace(
    /\brequire\s*\(\s*["']next\/dist\/compiled\/path-to-regexp["']\s*\)/g,
    `require("path-to-regexp")`,
  );

  if (hadCompiledPathToRegexp && !s.includes(PATH_TO_REGEXP_TODO_NEEDLE)) {
    const pathTodo = `${TODO_PREFIX}${R4DIST_SENTINEL}: ensure \`path-to-regexp\` is in package.json — replaced Next's bundled copy\n`;
    s = pathTodo + s;
  }

  const codegenTodo = `${TODO_PREFIX}${R4DIST_SENTINEL}: codegen — verify emitted bundle uses React.lazy (not next/dynamic)\n`;
  s = s.replace(
    /import dynamic from "next\/dynamic"/g,
    `${codegenTodo}import { lazy as dynamic } from "react"`,
  );
  s = s.replace(
    /import dynamic from 'next\/dynamic'/g,
    `${codegenTodo}import { lazy as dynamic } from 'react'`,
  );

  const headersTypeTodo = `${TODO_PREFIX}${R4DIST_SENTINEL}: \`import("next/headers")\` in types → \`getHeaders\` / \`getCookies\` from @tanstack/start/server — verify \`ReturnType\`\n`;
  const hadNextHeadersImportType = /\bimport\s*\(\s*["']next\/headers["']\s*\)/.test(s);
  const beforeHdrType = s;
  s = s.replace(
    /\bimport\s*\(\s*["']next\/headers["']\s*\)\s*\.\s*headers\b/g,
    `import("@tanstack/start/server").getHeaders`,
  );
  s = s.replace(
    /\bimport\s*\(\s*["']next\/headers["']\s*\)\s*\.\s*cookies\b/g,
    `import("@tanstack/start/server").getCookies`,
  );
  if (hadNextHeadersImportType && s !== beforeHdrType) {
    s = headersTypeTodo + s;
  }

  const readonlyNavTodo = `${TODO_PREFIX}${R4DIST_SENTINEL}: \`ReadonlyURLSearchParams\` from next/navigation → local alias; narrow to route search types when possible\n`;
  if (
    /\bReadonlyURLSearchParams\b/.test(s) &&
    /from\s*["']next\/navigation["']/.test(s)
  ) {
    s = s.replace(
      /^[ \t]*import\s+type\s*\{\s*ReadonlyURLSearchParams\s*\}\s*from\s*["']next\/navigation["']\s*;?\s*\r?\n/m,
      `${readonlyNavTodo}type ReadonlyURLSearchParams = URLSearchParams;\n`,
    );
  }

  const imageTodo = `${TODO_PREFIX}${R4DIST_SENTINEL}: next/image helper shim — verify responsive/srcSet behavior where \`getImageProps\` was used\n`;
  const hadImageImport = /from\s*["']next\/image["']/.test(s);
  s = s.replace(
    /^[ \t]*import\s*\{\s*getImageProps\s*\}\s*from\s*["']next\/image["']\s*;?\s*\r?\n/m,
    `${imageTodo}function getImageProps<T extends Record<string, unknown>>(input: T): { props: T } {\n  return { props: input };\n}\n`,
  );
  s = s.replace(
    /^[ \t]*import\s+type\s*\{\s*ImageProps\s*\}\s*from\s*["']next\/image["']\s*;?\s*\r?\n/m,
    `${imageTodo}type ImageProps = React.ImgHTMLAttributes<HTMLImageElement>;\n`,
  );
  if (hadImageImport) {
    s = s.replace(
      /^[ \t]*import\s+type\s*\{\s*ImageProps\s*\}\s*,\s*\{\s*getImageProps\s*\}\s*from\s*["']next\/image["']\s*;?\s*\r?\n/m,
      `${imageTodo}type ImageProps = React.ImgHTMLAttributes<HTMLImageElement>;\nfunction getImageProps<T extends Record<string, unknown>>(input: T): { props: T } {\n  return { props: input };\n}\n`,
    );
  }

  const afterTodo = `${TODO_PREFIX}${R4DIST_SENTINEL}: next/server \`after\` shim — ensure background work semantics match your runtime\n`;
  s = s.replace(
    /^[ \t]*import\s*\{\s*after\s*\}\s*from\s*["']next\/server["']\s*;?\s*\r?\n/m,
    `${afterTodo}const after = (cb: () => unknown) => {\n  void Promise.resolve().then(cb);\n};\n`,
  );

  const nextErrorTodo = `${TODO_PREFIX}${R4DIST_SENTINEL}: \`next/error\` was replaced with a local fallback component; customize your global error UI\n`;
  const hadNextError = /from\s*["']next\/error["']/.test(s);
  s = s.replace(
    /^[ \t]*import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s*["']next\/error["']\s*;?\s*\r?\n/m,
    `${nextErrorTodo}const $1 = ({ statusCode = 500 }: { statusCode?: number }) => (\n  <div role="alert">Unexpected error</div>\n);\n`,
  );
  if (hadNextError) {
    s = s.replace(/\b<([A-Za-z_$][A-Za-z0-9_$]*)\s+statusCode=\{0\}\s*\/>/g, "<div role=\"alert\">Unexpected error</div>");
  }

  if (s === source) return null;
  const r = rootNode.range();
  return rootNode.commitEdits([
    { startPos: r.start.index, endPos: r.end.index, insertedText: s },
  ]);
};

export default codemod;
