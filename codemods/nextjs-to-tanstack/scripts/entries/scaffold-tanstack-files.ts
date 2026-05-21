/**
 * Replacement for the scaffold-tanstack-files shell node.
 *
 * Triggers off `package.json`; only packages that declare a `next` dependency
 * are scaffolded (safe for monorepos where the workflow includes `** /package.json`).
 * From inside the transform, writes `vite.config.ts`, `router.tsx`, a
 * `routeTree.gen.ts` TypeScript stub (until Vite regenerates it), and a starter
 * `query-client.ts` for TanStack Query, using the
 * sandboxed `fs` module — but only when each file doesn't already exist, so the
 * step is idempotent.
 *
 * Layout:
 *   • `src/app/**` or `src/pages/**` (classic create-next-app): `srcDirectory: 'src'`,
 *     router at `src/router.tsx`.
 *   • `app/` or `pages/` at package root without `src/`: `srcDirectory: '.'`,
 *     router at `router.tsx`.
 *
 * The package.json content itself is not modified here (R11 handles that);
 * the transform returns `null`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Codemod } from 'codemod:ast-grep'
import type JSON_TYPES from 'codemod:ast-grep/langs/json'

import { hasSrcAppOrPages } from '../utils/has-src-app-or-pages.ts'
import { emitWorkflowStepReport, WORKFLOW_NODE_IDS } from '../utils/migration-run-report.ts'
import { getFilename, normalizePath } from '../utils/paths.ts'
import { readNextI18nConfig } from '../utils/read-next-i18n-config.ts'
import { writeI18nBootstrapIfAbsent } from '../utils/write-i18n-bootstrap.ts'

/** Local type only — do not name `PackageJson` (merges with patch-package-json.ts in the toolchain). */
interface NextPackageManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const ROUTER_FILE = `import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
  })

  return router
}
`

/** Satisfies tsserver before the first Vite run; TanStack overwrites this during dev/build. */
const QUERY_CLIENT_SRC = `import { QueryClient } from '@tanstack/react-query'

/**
 * Shared singleton for client + server invalidation after migrating \`next/cache\`.
 * Wire the same instance through your router root / TanStack Query provider.
 * Prefer query keys prefixed \`['next-cache', 'tag', …]\` / \`['next-cache', 'path', …]\`
 * to line up with \`invalidateQueries\` emitted by the R4e codemod.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
    },
  },
})
`

const ROUTE_TREE_GEN_STUB = `/**
 * Placeholder for TypeScript until \`vite dev\` or \`vite build\` runs.
 * @tanstack/react-start regenerates this file during the Vite build.
 */
import type { AnyRoute } from '@tanstack/react-router'

export const routeTree = null as unknown as AnyRoute
`

/** R1 defaults to \`./globals.css?url\` when the root layout had no CSS import — ensure the file exists. */
const DEFAULT_GLOBALS_CSS = `@import "tailwindcss";\n`

const VITE_CONFIG_SRC_APP = `import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  server: {
    port: 3000,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: 'src',
      router: {
        routesDirectory: 'app',
      },
    }),
    viteReact(),
    nitro(),
  ],
})
`

const VITE_CONFIG_ROOT_APP = `import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  server: {
    port: 3000,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: '.',
      router: {
        routesDirectory: 'app',
      },
    }),
    viteReact(),
    nitro(),
  ],
})
`

const codemod: Codemod<JSON_TYPES> = async (root) => {
  const file = getFilename(root)
  if (!file.endsWith('/package.json') && !file.endsWith('package.json')) {
    return null
  }

  const repoRoot = dirname(file)
  let pkg: NextPackageManifest
  try {
    pkg = JSON.parse(root.root().text()) as NextPackageManifest
  } catch {
    return null
  }
  const hasNext = Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next)
  if (!hasNext) {
    return null
  }

  const useSrcApp = hasSrcAppOrPages(repoRoot)

  writeIfAbsent(join(repoRoot, 'vite.config.ts'), useSrcApp ? VITE_CONFIG_SRC_APP : VITE_CONFIG_ROOT_APP)
  const routerPath = useSrcApp ? join(repoRoot, 'src', 'router.tsx') : join(repoRoot, 'router.tsx')
  writeIfAbsent(routerPath, ROUTER_FILE)
  const routeGenPath = useSrcApp ? join(repoRoot, 'src', 'routeTree.gen.ts') : join(repoRoot, 'routeTree.gen.ts')
  writeIfAbsent(routeGenPath, ROUTE_TREE_GEN_STUB)

  const queryClientPath = useSrcApp ? join(repoRoot, 'src', 'query-client.ts') : join(repoRoot, 'query-client.ts')
  writeIfAbsent(queryClientPath, QUERY_CLIENT_SRC)

  const globalsCssPath = useSrcApp ? join(repoRoot, 'src', 'app', 'globals.css') : join(repoRoot, 'app', 'globals.css')
  writeIfAbsent(globalsCssPath, DEFAULT_GLOBALS_CSS)

  const i18n = readNextI18nConfig(repoRoot)
  if (i18n) {
    const codemodDir = join(repoRoot, '.codemod')
    mkdirSync(codemodDir, { recursive: true })
    writeFileSync(
      join(codemodDir, 'i18n.json'),
      `${JSON.stringify(
        {
          source: 'next-i18n',
          defaultLocale: i18n.defaultLocale,
          locales: i18n.locales,
          tanstackOptionalLocaleSegment: '{-$locale}',
        },
        null,
        2,
      )}\n`,
    )
    writeI18nBootstrapIfAbsent(repoRoot, i18n, useSrcApp)
  }

  emitWorkflowStepReport({
    step: WORKFLOW_NODE_IDS.scaffoldTanstackFiles,
    packageRoot: normalizePath(repoRoot),
    usedSrcLayout: useSrcApp,
    i18nFromNextConfig: i18n ? { defaultLocale: i18n.defaultLocale, locales: i18n.locales } : null,
  })

  return null
}

export default codemod

function writeIfAbsent(path: string, content: string): void {
  try {
    readFileSync(path)
    return // Already exists.
  } catch {
    // Continue to write.
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
