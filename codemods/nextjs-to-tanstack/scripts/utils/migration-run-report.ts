/**
 * Collects per-package migration metadata for TANSTACK_MIGRATION_NEXT_STEPS.md:
 * - `codemod:workflow` persisted state (parallel-safe via `acquireLock`) for R10 / R10b
 * - same state API for per-step JSON summaries (`mtg:step-report:<pkg>:<stepId>` keys)
 * - pairs with `useMetricAtom` in R10 / R10b entry scripts (CLI + `getEntries()` in the guide)
 */

import type { MetricAtom } from 'codemod:metrics'
import { acquireLock, getState, setState } from 'codemod:workflow'

import { inferCodemodTargetDir, normalizePath } from './paths.ts'

export const WORKFLOW_NODE_IDS = {
  scaffoldTanstackFiles: 'scaffold-tanstack-files',
  patchPackageJson: 'patch-package-json',
  cleanupLegacyPages: 'cleanup-legacy-pages',
  patchRootI18nProvider: 'patch-root-i18n-provider',
} as const

export interface R10Accum {
  files: string[]
  todoMarkersAdded: number
}

export interface R10bAccum {
  byModule: Record<string, number>
  middlewareTodoFiles: string[]
}

/** Normalized package root + step id — matches keys used by `emitWorkflowStepReport`. */
export function workflowStepReportStateKey(packageRootNorm: string, stepId: string): string {
  return `mtg:step-report:${normalizePath(packageRootNorm)}:${stepId}`
}

function pkgKeyFromAbsFile(fileAbs: string): string {
  return normalizePath(inferCodemodTargetDir(fileAbs))
}

export function relPathUnderPkg(fileAbs: string): string {
  const pkg = pkgKeyFromAbsFile(fileAbs)
  const n = normalizePath(fileAbs)
  return n.startsWith(`${pkg}/`) ? n.slice(pkg.length + 1) : n
}

export function emitWorkflowStepReport(payload: unknown): void {
  if (!payload || typeof payload !== 'object') {
    return
  }
  const { step, packageRoot } = payload as { step?: unknown; packageRoot?: unknown }
  if (typeof step !== 'string' || typeof packageRoot !== 'string') {
    return
  }
  const key = workflowStepReportStateKey(packageRoot, step)
  const release = acquireLock(`${key}:lock`)
  try {
    setState(key, payload, false)
  } finally {
    release()
  }
}

export function bumpR10(fileAbs: string, todoMarkersAdded: number): void {
  if (todoMarkersAdded <= 0) {
    return
  }
  const pkg = pkgKeyFromAbsFile(fileAbs)
  const key = `mtg:r10:${pkg}`
  const release = acquireLock(`${key}:lock`)
  try {
    const cur = getState<R10Accum>(key) ?? { files: [], todoMarkersAdded: 0 }
    cur.files.push(relPathUnderPkg(fileAbs))
    cur.todoMarkersAdded += todoMarkersAdded
    setState(key, cur, false)
  } finally {
    release()
  }
}

export function bumpR10bFromModules(fileAbs: string, modules: string[]): void {
  if (modules.length === 0) {
    return
  }
  const pkg = pkgKeyFromAbsFile(fileAbs)
  const key = `mtg:r10b:${pkg}`
  const release = acquireLock(`${key}:lock`)
  try {
    const cur = getState<R10bAccum>(key) ?? { byModule: {}, middlewareTodoFiles: [] }
    for (const m of modules) {
      cur.byModule[m] = (cur.byModule[m] ?? 0) + 1
    }
    setState(key, cur, false)
  } finally {
    release()
  }
}

export function bumpR10bMiddlewareFile(fileAbs: string): void {
  const pkg = pkgKeyFromAbsFile(fileAbs)
  const key = `mtg:r10b:${pkg}`
  const release = acquireLock(`${key}:lock`)
  try {
    const cur = getState<R10bAccum>(key) ?? { byModule: {}, middlewareTodoFiles: [] }
    const rel = relPathUnderPkg(fileAbs)
    if (!cur.middlewareTodoFiles.includes(rel)) {
      cur.middlewareTodoFiles.push(rel)
    }
    setState(key, cur, false)
  } finally {
    release()
  }
}

function formatMetricEntries(atom: MetricAtom): string {
  const entries = atom.getEntries()
  if (entries.length === 0) {
    return '*No entries in this run.*'
  }
  return entries
    .map((e) => {
      const dims =
        Object.keys(e.cardinality).length === 0
          ? '(total)'
          : Object.entries(e.cardinality)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')
      return `- \`${dims}\`: **${e.count}**`
    })
    .join('\n')
}

function readWorkflowStepReport(
  pkg: string,
  stepId: string,
  label: string,
): { stepId: string; label: string; raw: string | null } {
  const key = workflowStepReportStateKey(pkg, stepId)
  const release = acquireLock(`${key}:lock`)
  try {
    const val = getState<unknown>(key)
    if (val === null || val === undefined) {
      return { stepId, label, raw: null }
    }
    if (typeof val === 'string') {
      return { stepId, label, raw: val }
    }
    try {
      return { stepId, label, raw: JSON.stringify(val, null, 2) }
    } catch {
      return { stepId, label, raw: '[unserializable]' }
    }
  } finally {
    release()
  }
}

function collectStepReportSnapshots(stateKeyRoot: string): { stepId: string; label: string; raw: string | null }[] {
  const pkg = normalizePath(stateKeyRoot)
  const items: { stepId: string; label: string }[] = [
    {
      stepId: WORKFLOW_NODE_IDS.scaffoldTanstackFiles,
      label: 'Scaffold (Vite / router / i18n bootstrap)',
    },
    {
      stepId: WORKFLOW_NODE_IDS.patchPackageJson,
      label: 'package.json (R11)',
    },
    {
      stepId: WORKFLOW_NODE_IDS.cleanupLegacyPages,
      label: 'Legacy `pages/` cleanup (R14)',
    },
    {
      stepId: WORKFLOW_NODE_IDS.patchRootI18nProvider,
      label: 'Root I18next provider (R14c)',
    },
  ]
  return items.map(({ stepId, label }) => readWorkflowStepReport(pkg, stepId, label))
}

export function buildMigrationRunSummarySection(params: {
  /** Display path for the markdown (often relative to the workflow target). */
  packageRoot: string
  /** Normalized package directory; must match `packageRoot` passed into `emitWorkflowStepReport` for state keys. */
  stateKeyRoot: string
  r10: R10Accum | undefined
  r10b: R10bAccum | undefined
  r10Metric: MetricAtom
  r10bMetric: MetricAtom
}): string {
  const { packageRoot, stateKeyRoot, r10, r10b, r10Metric, r10bMetric } = params
  const steps = collectStepReportSnapshots(stateKeyRoot)
  const lines: string[] = []

  lines.push('## 4. Migration run summary')
  lines.push('')
  lines.push(
    'From `codemod:workflow` **state**: R10 / R10b totals, per-step JSON (`acquireLock` / `setState` / `getState`), and CLI **metrics** (`useMetricAtom` in R10 / R10b).',
  )
  lines.push('')
  lines.push(`- **Package root (this manifest):** \`${packageRoot}\``)
  lines.push('')

  lines.push('### Step reports (workflow state)')
  lines.push('')
  let anyStep = false
  for (const s of steps) {
    if (!s.raw) {
      continue
    }
    anyStep = true
    lines.push(`#### ${s.label}`)
    lines.push('')
    lines.push('```json')
    try {
      const parsed: unknown = JSON.parse(s.raw)
      lines.push(JSON.stringify(parsed, null, 2))
    } catch {
      lines.push(s.raw)
    }
    lines.push('```')
    lines.push('')
  }
  if (!anyStep) {
    lines.push(
      '*No step reports in workflow state for this package (normal when only this script runs, or earlier steps did not persist a report).*',
    )
    lines.push('')
  }

  lines.push('### R10 — async route components (loader migration + `// TODO: … Route.loader …` when needed)')
  lines.push('')
  if (r10 && r10.todoMarkersAdded > 0) {
    lines.push(`- **TODO markers inserted:** ${r10.todoMarkersAdded}`)
    lines.push(`- **Files touched:** ${r10.files.length}`)
    if (r10.files.length > 0) {
      lines.push('')
      for (const f of r10.files) {
        lines.push(`  - \`${f}\``)
      }
      lines.push('')
    }
  } else {
    lines.push('*No R10 state for this package in this run.*')
    lines.push('')
  }
  lines.push('Metric **`nextjs-to-tanstack-r10-async-await`** (CLI + below):')
  lines.push('')
  lines.push(formatMetricEntries(r10Metric))
  lines.push('')

  lines.push('### R10b — remaining `next/*` imports (per-line TODOs + middleware)')
  lines.push('')
  if (r10b && (Object.keys(r10b.byModule).length > 0 || r10b.middlewareTodoFiles.length > 0)) {
    if (Object.keys(r10b.byModule).length > 0) {
      lines.push('- **Counts by module:**')
      for (const [mod, c] of Object.entries(r10b.byModule).sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`  - \`${mod}\`: ${c}`)
      }
    }
    if (r10b.middlewareTodoFiles.length > 0) {
      lines.push('- **Middleware files with a file-level TODO:**')
      for (const f of r10b.middlewareTodoFiles) {
        lines.push(`  - \`${f}\``)
      }
    }
    lines.push('')
  } else {
    lines.push('*No R10b state for this package in this run.*')
    lines.push('')
  }
  lines.push('Metric **`nextjs-to-tanstack-r10b-next-import`** (CLI + below):')
  lines.push('')
  lines.push(formatMetricEntries(r10bMetric))
  lines.push('')

  return lines.join('\n')
}
