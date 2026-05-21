/**
 * R14b — If `vite.config.ts` exists (scaffold) but no `__root.tsx`, write a minimal
 * root route so TanStack's route generator can emit `routeTree.gen` and the app
 * does not 404 at every path. Runs after pages cleanup so a failed `_app`
 * migration is still recoverable.
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Codemod } from 'codemod:ast-grep'
import type JSON_TYPES from 'codemod:ast-grep/langs/json'

import { resolveGlobalsCssUrlImport } from '../utils/globals-css-path.ts'
import { hasSrcAppOrPages } from '../utils/has-src-app-or-pages.ts'
import { getFilename } from '../utils/paths.ts'

function fileExists(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

const codemod: Codemod<JSON_TYPES> = async (root) => {
  const file = getFilename(root)
  if (!file.endsWith('/package.json') && !file.endsWith('package.json')) {
    return null
  }

  const repoRoot = dirname(file)
  if (!fileExists(join(repoRoot, 'vite.config.ts'))) {
    return null
  }

  const useSrc = hasSrcAppOrPages(repoRoot) || fileExists(join(repoRoot, 'src/router.tsx'))
  const rootPath = useSrc ? join(repoRoot, 'src/app/__root.tsx') : join(repoRoot, 'app/__root.tsx')

  if (fileExists(rootPath)) {
    return null
  }

  mkdirSync(dirname(rootPath), { recursive: true })
  const globalsUrl = resolveGlobalsCssUrlImport(rootPath)
  const contents = `import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";\nimport appCss from "${globalsUrl}";\n\n// TODO: Replace this placeholder root route with your real layout (fonts, providers, html/body shell).\nexport const Route = createRootRoute({\n  component: RootLayout,\n});\n\nfunction RootLayout() {\n  return (\n    <html lang="en">\n      <head>\n        <HeadContent />\n      </head>\n      <body>\n        <Outlet />\n        <Scripts />\n      </body>\n    </html>\n  );\n}\n`
  writeFileSync(rootPath, contents)
  return null
}

export default codemod
