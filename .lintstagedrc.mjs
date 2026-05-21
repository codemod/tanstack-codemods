/** @param {string[]} files */
function excludePnpmLockfile(files) {
  return files.filter((f) => !f.endsWith('pnpm-lock.yaml'))
}

export default {
  '*.{ts,tsx,js,jsx,mts,mjs}': ['oxfmt --write', 'oxlint --type-aware --type-check --fix'],
  /** @param {string[]} files */
  '*.{json,yaml,yml}': (files) => {
    const filtered = excludePnpmLockfile(files)
    return filtered.length ? [`oxfmt --write ${filtered.join(' ')}`] : []
  },
  'codemods/**/scripts/**/*.ts': ["bash -c 'pnpm run test'"],
}
