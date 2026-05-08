/**
 * After the safe `next/*` rewrites, tag every remaining Next import (and Edge
 * middleware entrypoints) with a single-line `// TODO:` comment when needed.
 * so humans can grep the repo instead of relying only on the markdown checklist.
 */

import type { Codemod, Edit } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { useMetricAtom } from "codemod:metrics";
import {
  bumpR10bFromModules,
  bumpR10bMiddlewareFile,
} from "../utils/migration-run-report.ts";
import { collapseDuplicateTrailingExportClosures } from "../utils/eof-closure-cleanup.ts";
import { getFilename, normalizePath } from "../utils/paths.ts";
import { hasTodoSentinel, insertTodoBefore, TODO_PREFIX } from "../utils/sentinels.ts";

const MIDDLEWARE_NEEDLE = "Next.js middleware";

const r10bMetric = useMetricAtom("nextjs-to-tanstack-r10b-next-import");

function finalizeWithEofCleanup(original: string, mutated: string | null): string | null {
  const base = mutated ?? original;
  const out = collapseDuplicateTrailingExportClosures(base);
  if (out === original && mutated === null) return null;
  return out;
}

const codemod: Codemod<TSX> = async (root) => {
  const rootNode = root.root();
  const source = rootNode.text();
  const file = normalizePath(getFilename(root));
  const edits: Edit[] = [];

  const importStmts = rootNode.findAll({ rule: { kind: "import_statement" } });
  const nextImports = importStmts.filter((s) => {
    const from = parseImportSource(s.text());
    return from != null && (from === "next" || from.startsWith("next/"));
  });

  const absFile = getFilename(root);

  if (isNextMiddlewarePath(file) && nextImports.length > 0) {
    if (!source.includes(`${TODO_PREFIX}${MIDDLEWARE_NEEDLE}`)) {
      edits.push({
        startPos: 0,
        endPos: 0,
        insertedText: `${TODO_PREFIX}${MIDDLEWARE_NEEDLE} has no drop-in in TanStack Start — port request/auth logic to server routes or server functions — https://tanstack.com/start/latest/docs/framework/react/guide/server-routes\n`,
      });
    }
    if (edits.length > 0) {
      const froms = nextImports
        .map((s) => parseImportSource(s.text()))
        .filter((x): x is string => Boolean(x));
      bumpR10bMiddlewareFile(absFile);
      bumpR10bFromModules(absFile, froms);
      r10bMetric.increment({ context: "middleware" }, 1);
      for (const fr of froms) {
        r10bMetric.increment({ module: fr });
      }
      return finalizeWithEofCleanup(source, rootNode.commitEdits(edits));
    }
    return finalizeWithEofCleanup(source, null);
  }

  const taggedModules: string[] = [];
  for (const stmt of nextImports) {
    const from = parseImportSource(stmt.text());
    if (!from) continue;
    if (hasTodoSentinel(source, stmt, from)) continue;
    const { message, docUrl } = todoForNextSpecifier(from);
    edits.push(insertTodoBefore(stmt, message, docUrl));
    taggedModules.push(from);
  }

  if (edits.length === 0) {
    return finalizeWithEofCleanup(source, null);
  }

  bumpR10bFromModules(absFile, taggedModules);
  for (const m of taggedModules) {
    r10bMetric.increment({ module: m });
  }

  return finalizeWithEofCleanup(source, rootNode.commitEdits(edits));
};

export default codemod;

function isNextMiddlewarePath(file: string): boolean {
  return /(^|\/)middleware\.tsx?$/i.test(file) && !file.includes("/node_modules/");
}

function parseImportSource(statementText: string): string | null {
  const m = statementText.match(/from\s*["']([^"']+)["']/);
  return m?.[1] ?? null;
}

function todoForNextSpecifier(from: string): { message: string; docUrl?: string } {
  const serverRoutes =
    "https://tanstack.com/start/latest/docs/framework/react/guide/server-routes";

  if (from === "next/headers") {
    return {
      message:
        "remaining `next/headers` usage was not auto-ported (e.g. `draftMode`, `cookies().set`, `headers()` without `.get`) — wire Web `Request` from TanStack Router / Start context or server handlers",
      docUrl: "https://tanstack.com/router/latest/docs/framework/react/guide/router-context",
    };
  }
  if (from === "next/cookies" || from === "next/response") {
    return {
      message: `replace \`${from}\` with Web Request/Response patterns or TanStack Start server routes`,
      docUrl: serverRoutes,
    };
  }
  if (from === "next/server") {
    return {
      message:
        "remaining `next/server` imports (`userAgent`, `after`, middleware-only `NextResponse` helpers, etc.) — complete the port to Web APIs and TanStack Start server routes",
      docUrl: serverRoutes,
    };
  }
  if (from === "next/og") {
    return {
      message:
        "remaining `next/og` usage beyond the import rewrite — `@vercel/og` is added in package.json; align with Vercel OG runtime on Nitro/Vite",
      docUrl: "https://vercel.com/docs/functions/og-image-generation",
    };
  }
  if (from === "next/cache") {
    return {
      message:
        "remaining `next/cache` usage was not fully auto-ported — finish with TanStack Query (useQuery/useMutation + query keys) per https://tanstack.com/query/latest/docs/framework/react/overview",
      docUrl: "https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation",
    };
  }
  if (from === "next/dynamic") {
    return {
      message:
        "this `next/dynamic` usage was not auto-ported — use React.lazy + Suspense, route-level code splitting, or manual loading UIs",
      docUrl: "https://react.dev/reference/react/lazy",
    };
  }
  if (from === "next/script" || from === "next/head") {
    return {
      message: `replace \`${from}\` with plain <script>/<head> or TanStack router head APIs as needed`,
      docUrl: "https://tanstack.com/start/latest/docs/framework/react/migrate-from-next-js",
    };
  }
  if (from === "next/font/local" || from.startsWith("next/font")) {
    return {
      message:
        "wire fonts via @font-face / @fontsource (or your design system); local `next/font` npm deps are not added automatically",
      docUrl: "https://tanstack.com/start/latest/docs/framework/react/migrate-from-next-js",
    };
  }
  if (from === "next/navigation") {
    return {
      message:
        "remaining `next/navigation` usage was not auto-ported (e.g. `notFound`, `useSelectedLayoutSegments`, `router.prefetch`, multi-arg `redirect`, or redirects in components) — move auth to route loaders when possible",
      docUrl: "https://tanstack.com/router/latest/docs/framework/react/guide/navigation",
    };
  }
  if (from === "next") {
    return {
      message:
        "remaining `next` root import — value imports (e.g. `createServer`, `Instrumentation`) have no TanStack twin; port boots/server wiring manually; type-only imports should have been erased by R4j",
      docUrl: "https://tanstack.com/start/latest/docs/framework/react/migrate-from-next-js",
    };
  }
  if (from.startsWith("next/dist")) {
    return {
      message: `internal \`${from}\` was not fully auto-ported — avoid Next internals; use Web APIs, small local shims, or peer deps`,
      docUrl: "https://tanstack.com/start/latest/docs/framework/react/migrate-from-next-js",
    };
  }
  if (
    from === "next/link" ||
    from === "next/image" ||
    from === "next/router" ||
    from === "next/compat/router"
  ) {
    return {
      message: `this \`${from}\` import survived the codemod — port to @tanstack/react-router or unpic manually`,
      docUrl: "https://tanstack.com/router/latest/docs/framework/react/routing/routing-concepts",
    };
  }

  return {
    message: `port or remove this \`${from}\` import for TanStack Start`,
    docUrl: "https://tanstack.com/start/latest/docs/framework/react/migrate-from-next-js",
  };
}
