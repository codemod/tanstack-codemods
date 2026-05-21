/**
 * Runtime-safe wrappers for `rmSync` / `rmdirSync` / `unlinkSync`.
 *
 * LLRT (QuickJS) exposes only a subset of Node `fs` exports.
 * Static named imports (`import { rmSync } from "fs"`) fail at module‐load
 * time when the export doesn't exist. This module works around the limitation
 * by importing the `fs` namespace and probing for functions at runtime.
 */

import * as _fs from 'node:fs'
import { join } from 'node:path'

interface RmOpts {
  recursive?: boolean
  force?: boolean
}

type FsWithOptionalRm = typeof _fs & {
  rmSync?: (p: string, o?: RmOpts) => void
  rmdirSync?: (p: string) => void
  unlinkSync?: (p: string) => void
}
const fsProbe = _fs as FsWithOptionalRm
const _rmSync = fsProbe.rmSync
const _rmdirSync = fsProbe.rmdirSync
const _unlinkSync = fsProbe.unlinkSync

export function safeRemoveFile(path: string): void {
  if (_rmSync) {
    _rmSync(path, { force: true })
    return
  }
  if (_unlinkSync) {
    try {
      _unlinkSync(path)
    } catch {
      /* already absent */
    }
    return
  }
}

/**
 * Recursively remove a directory tree. Falls back from `rmSync` to a manual
 * walk using `readdirSync` + `unlinkSync` + `rmdirSync` when the full
 * `rmSync` API isn't available in the runtime.
 */
export function safeRemoveDir(path: string): void {
  if (_rmSync) {
    _rmSync(path, { recursive: true, force: true })
    return
  }
  recursiveRemove(path)
}

function recursiveRemove(dirPath: string): void {
  let entries: string[]
  try {
    entries = _fs.readdirSync(dirPath)
  } catch {
    return
  }
  for (const name of entries) {
    const full = join(dirPath, name)
    try {
      const st = _fs.statSync(full)
      if (st.isDirectory()) {
        recursiveRemove(full)
      } else {
        safeRemoveFile(full)
      }
    } catch {
      /* stat or remove failed — skip */
    }
  }
  if (_rmdirSync) {
    try {
      _rmdirSync(dirPath)
    } catch {
      /* non-empty or busy */
    }
  }
}

export function safeRmdirIfEmpty(path: string): boolean {
  try {
    const entries = _fs.readdirSync(path)
    if (entries.length > 0) {
      return false
    }
    if (_rmdirSync) {
      _rmdirSync(path)
    } else if (_rmSync) {
      _rmSync(path, { recursive: true, force: true })
    }
    return true
  } catch {
    return false
  }
}
