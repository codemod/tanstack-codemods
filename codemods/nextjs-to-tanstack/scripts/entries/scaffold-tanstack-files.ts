/**
 * Replacement for the scaffold-tanstack-files shell node.
 *
 * Triggers off `package.json`; only packages that declare a `next` dependency
 * are scaffolded (safe for monorepos where the workflow includes `** /package.json`).
 * From inside the transform, writes `vite.config.ts` and `router.tsx` using the
 * sandboxed `fs` module — but only when the files don't already exist, so the
 * step is idempotent.
 *
 * Layout:
 *   • `src/app/**` (classic create-next-app `--src-dir`): `srcDirectory: 'src'`,
 *     router at `src/router.tsx`.
 *   • `app/` at package root without `src/app` (many monorepos): `srcDirectory: '.'`,
 *     router at `router.tsx`.
 *
 * The package.json content itself is not modified here (R11 handles that);
 * the transform returns `null`.
 */

import type { Codemod } from "codemod:ast-grep";
import type JSON_TYPES from "codemod:ast-grep/langs/json";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getFilename } from "../utils/paths.ts";

/** Local type only — do not name `PackageJson` (merges with patch-package-json.ts in the toolchain). */
type NextPackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const ROUTER_FILE = `import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
  })

  return router
}
`;

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
`;

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
`;

function hasSrcApp(repoRoot: string): boolean {
  try {
    return statSync(join(repoRoot, "src", "app")).isDirectory();
  } catch {
    return false;
  }
}

const codemod: Codemod<JSON_TYPES> = async (root) => {
  const file = getFilename(root);
  if (!file.endsWith("/package.json") && !file.endsWith("package.json")) {
    return null;
  }

  const repoRoot = dirname(file);
  let pkg: NextPackageManifest;
  try {
    pkg = JSON.parse(root.root().text()) as NextPackageManifest;
  } catch {
    return null;
  }
  const hasNext = Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next);
  if (!hasNext) {
    return null;
  }

  const useSrcApp = hasSrcApp(repoRoot);

  writeIfAbsent(
    join(repoRoot, "vite.config.ts"),
    useSrcApp ? VITE_CONFIG_SRC_APP : VITE_CONFIG_ROOT_APP,
  );
  writeIfAbsent(
    useSrcApp ? join(repoRoot, "src", "router.tsx") : join(repoRoot, "router.tsx"),
    ROUTER_FILE,
  );
  return null;
};

export default codemod;

function writeIfAbsent(path: string, content: string): void {
  try {
    readFileSync(path);
    return; // Already exists.
  } catch {
    // Continue to write.
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
