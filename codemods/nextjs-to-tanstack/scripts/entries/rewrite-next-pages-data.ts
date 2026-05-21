/**
 * Strip Pages Router data APIs (`getStaticProps`, `getStaticPaths`, `getServerSideProps`),
 * `next-i18next/serverSideTranslations`, `next/head`, and type-only `next` imports that
 * only reference data-fetching types — after TanStack route shape exists.
 *
 * Runs on App Router modules (tsx, jsx under src/app or app). Idempotent when nothing matches.
 */

import type { Codemod } from 'codemod:ast-grep'
import type TSX from 'codemod:ast-grep/langs/tsx'

import { getFilename, normalizePath } from '../utils/paths.ts'
import { applyStripNextPagesDataPipeline, applyRepairRouteTailPipeline } from '../utils/strip-next-pages-data.ts'

const codemod: Codemod<TSX> = async (root) => {
  const file = normalizePath(getFilename(root))
  if (!isAppRouterSourceFile(file)) {
    return null
  }

  const rootNode = root.root()
  const source = rootNode.text()

  if (!looksLikeNeedsStrip(source)) {
    return null
  }

  const next = applyStripNextPagesDataPipeline(source)
  if (next === source) {
    return null
  }

  const { start, end } = rootNode.range()
  return rootNode.commitEdits([
    {
      startPos: start.index,
      endPos: end.index,
      insertedText: next,
    },
  ])
}

export default codemod

function isAppRouterSourceFile(file: string): boolean {
  return /(^|\/)src\/app\/.*\.(tsx|jsx)$/.test(file) || /(^|\/)app\/.*\.(tsx|jsx)$/.test(file)
}

function looksLikeNeedsStrip(source: string): boolean {
  if (applyRepairRouteTailPipeline(source) !== source) {
    return true
  }
  if (/\bgetStaticProps\b/.test(source) || /\bgetStaticPaths\b/.test(source) || /\bgetServerSideProps\b/.test(source)) {
    return true
  }
  if (source.includes('serverSideTranslations')) {
    return true
  }
  if (source.includes('next/head')) {
    return true
  }
  if (/from\s+["']next-i18next["']/.test(source)) {
    return true
  }
  if (/from\s+["']next-i18next\/serverSideTranslations["']/.test(source)) {
    return true
  }
  if (/\bimport\s+type\s+\{[^}]*\}\s+from\s+["']next["']/.test(source)) {
    return true
  }
  return false
}
