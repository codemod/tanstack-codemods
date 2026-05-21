/**
 * Convert a Next.js `metadata` export object into TanStack Start
 * `head()` entries.
 *
 * The input is always an AST node (an `object` expression) — we never parse
 * or stringify the source text. Every nested value that can't be mapped
 * deterministically surfaces as an `unmapped` key so the caller can emit a
 * short `// TODO:` comment next to the route definition.
 */

import type { SgNode, TypesMap } from 'codemod:ast-grep'

type AnyNode = SgNode<TypesMap>

export interface HeadBuildResult {
  /** Fully-formed `head: () => ({ meta: [...], links: [...], scripts: [...] })` source. */
  headOption: string
  /** One entry per unmapped key so the caller can insert review sentinels. */
  unmapped: string[]
  /** True when the metadata should be abandoned (e.g. async / function call). */
  bail: boolean
}

/** Parsed `meta` / `links` arrays before formatting into a `head()` option. */
export interface HeadParts {
  metaItems: string[]
  linkItems: string[]
  unmapped: string[]
}

export function composeHeadOption(metaItems: string[], linkItems: string[]): string {
  const linesOut: string[] = []
  linesOut.push('head: () => ({')
  if (metaItems.length > 0) {
    linesOut.push(`  meta: [${metaItems.join(', ')}],`)
  }
  if (linkItems.length > 0) {
    linesOut.push(`  links: [${linkItems.join(', ')}],`)
  }
  linesOut.push('})')
  return linesOut.join('\n')
}

/**
 * Collect TanStack `meta` / `links` entries from a Next.js `metadata` object.
 */
export function metadataObjectToHeadParts<T extends TypesMap>(objTyped: SgNode<T>): HeadParts {
  const objNode = objTyped as unknown as AnyNode
  const metaItems: string[] = []
  const linkItems: string[] = []
  const unmapped: string[] = []

  for (const pair of objNode.findAll({ rule: { kind: 'pair' } })) {
    // Only consider top-level pairs (direct children of the metadata object).
    const parent = pair.parent()
    if (!parent || parent.id() !== objNode.id()) {
      continue
    }

    const key = readKey(pair)
    const value = pair.field('value')
    if (!key || !value) {
      continue
    }

    switch (key) {
      case 'title': {
        const str = readStringLiteral(value)
        if (str !== null) {
          metaItems.push(`{ title: ${JSON.stringify(str)} }`)
        } else {
          metaItems.push(`{ title: ${value.text()} }`)
          unmapped.push('title (non-literal value)')
        }
        break
      }
      case 'description': {
        pushMeta(metaItems, 'name', 'description', value, unmapped, 'description')
        break
      }
      case 'keywords': {
        const items = readStringArray(value)
        if (items !== null) {
          metaItems.push(`{ name: "keywords", content: ${JSON.stringify(items.join(','))} }`)
        } else {
          unmapped.push('keywords (non-literal array)')
        }
        break
      }
      case 'authors':
      case 'creator':
      case 'publisher': {
        pushMeta(metaItems, 'name', key, value, unmapped, key)
        break
      }
      case 'openGraph': {
        if (!value.is('object')) {
          unmapped.push('openGraph (non-object)')
          break
        }
        collectNested(value, 'og:', metaItems, unmapped)
        break
      }
      case 'twitter': {
        if (!value.is('object')) {
          unmapped.push('twitter (non-object)')
          break
        }
        collectNested(value, 'twitter:', metaItems, unmapped)
        break
      }
      case 'icons': {
        collectIcons(value, linkItems, unmapped)
        break
      }
      default: {
        unmapped.push(key)
      }
    }
  }

  return { metaItems, linkItems, unmapped }
}

/**
 * Build a `head()` option string from a metadata object AST node. The caller
 * is expected to have already verified that the node is an `object`.
 */
export function metadataObjectToHead<T extends TypesMap>(objTyped: SgNode<T>): HeadBuildResult {
  const parts = metadataObjectToHeadParts(objTyped)
  return {
    headOption: composeHeadOption(parts.metaItems, parts.linkItems),
    unmapped: parts.unmapped,
    bail: false,
  }
}

/**
 * Quick check: is the value an async computation or a function call? We bail
 * on those rather than attempt a partial rewrite.
 */
export function isDynamicMetadata<T extends TypesMap>(node: SgNode<T>): boolean {
  const n = node as unknown as AnyNode
  if (n.is('function_declaration') || n.is('arrow_function')) {
    return true
  }
  if (n.is('call_expression')) {
    return true
  }
  return false
}

function readKey(pair: AnyNode): string | null {
  const keyNode = pair.field('key')
  if (!keyNode) {
    return null
  }

  if (keyNode.is('property_identifier') || keyNode.is('identifier')) {
    return keyNode.text()
  }
  if (keyNode.is('string')) {
    return readStringLiteral(keyNode)
  }
  return null
}

function readStringLiteral(node: AnyNode): string | null {
  if (!node.is('string')) {
    return null
  }
  const fragment = node.find({ rule: { kind: 'string_fragment' } })
  if (fragment) {
    return fragment.text()
  }
  // Empty strings have no fragment child.
  return ''
}

function readStringArray(node: AnyNode): string[] | null {
  if (!node.is('array')) {
    return null
  }
  const items: string[] = []
  for (const child of node.children()) {
    const k = child.kind()
    if (k === '[' || k === ']' || k === ',') {
      continue
    }
    const literal = readStringLiteral(child)
    if (literal === null) {
      return null
    }
    items.push(literal)
  }
  return items
}

function pushMeta(
  out: string[],
  attr: 'name' | 'property',
  metaName: string,
  value: AnyNode,
  unmapped: string[],
  unmappedLabel: string,
): void {
  const str = readStringLiteral(value)
  if (str !== null) {
    out.push(`{ ${attr}: ${JSON.stringify(metaName)}, content: ${JSON.stringify(str)} }`)
    return
  }
  unmapped.push(`${unmappedLabel} (non-literal value)`)
}

function collectNested(objNode: AnyNode, prefix: string, metaItems: string[], unmapped: string[]): void {
  const attr = prefix === 'og:' ? ('property' as const) : ('name' as const)
  for (const pair of objNode.findAll({ rule: { kind: 'pair' } })) {
    const p = pair.parent()
    if (!p || p.id() !== objNode.id()) {
      continue
    }
    const key = readKey(pair)
    const value = pair.field('value')
    if (!key || !value) {
      continue
    }
    if (key === 'images') {
      const arr = readStringArray(value)
      if (arr !== null) {
        for (const img of arr) {
          metaItems.push(`{ ${attr}: ${JSON.stringify(`${prefix}image`)}, content: ${JSON.stringify(img)} }`)
        }
      } else {
        const single = readStringLiteral(value)
        if (single !== null) {
          metaItems.push(`{ ${attr}: ${JSON.stringify(`${prefix}image`)}, content: ${JSON.stringify(single)} }`)
        } else {
          unmapped.push(`${prefix}images (non-literal)`)
        }
      }
      continue
    }
    pushMeta(metaItems, attr, `${prefix}${key}`, value, unmapped, `${prefix}${key}`)
  }
}

function collectIcons(node: AnyNode, links: string[], unmapped: string[]): void {
  if (node.is('string')) {
    const str = readStringLiteral(node)
    if (str !== null) {
      links.push(`{ rel: "icon", href: ${JSON.stringify(str)} }`)
      return
    }
  }
  if (node.is('object')) {
    for (const pair of node.findAll({ rule: { kind: 'pair' } })) {
      const p = pair.parent()
      if (!p || p.id() !== node.id()) {
        continue
      }
      const key = readKey(pair)
      const value = pair.field('value')
      if (!key || !value) {
        continue
      }
      const rel = iconKeyToRel(key)
      if (!rel) {
        unmapped.push(`icons.${key}`)
        continue
      }
      const str = readStringLiteral(value)
      if (str !== null) {
        links.push(`{ rel: ${JSON.stringify(rel)}, href: ${JSON.stringify(str)} }`)
        continue
      }
      const arr = readStringArray(value)
      if (arr !== null) {
        for (const href of arr) {
          links.push(`{ rel: ${JSON.stringify(rel)}, href: ${JSON.stringify(href)} }`)
        }
        continue
      }
      unmapped.push(`icons.${key} (non-literal)`)
    }
    return
  }
  unmapped.push('icons (unsupported shape)')
}

function iconKeyToRel(key: string): string | null {
  switch (key) {
    case 'icon': {
      return 'icon'
    }
    case 'shortcut': {
      return 'shortcut icon'
    }
    case 'apple': {
      return 'apple-touch-icon'
    }
    default: {
      return null
    }
  }
}
