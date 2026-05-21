/**
 * Small helpers for JSX rewrites. Everything here goes through `kind` +
 * field lookups — never through raw JSX pattern strings, which ast-grep can't
 * parse without enclosing context.
 */

import type { Edit, SgNode } from 'codemod:ast-grep'

/**
 * Find every JSX opening element whose tag name exactly equals `tagName`.
 * Returns both self-closing (`<Foo />`) and paired (`<Foo>...</Foo>`) opens.
 */
export function findJsxOpeningElements(root: SgNode, tagName: string): SgNode[] {
  const rx = `^${escapeRegex(tagName)}$`
  return root.findAll({
    rule: {
      any: [
        {
          kind: 'jsx_opening_element',
          has: { field: 'name', kind: 'identifier', regex: rx },
        },
        {
          kind: 'jsx_self_closing_element',
          has: { field: 'name', kind: 'identifier', regex: rx },
        },
      ],
    },
  })
}

/**
 * Collect the list of `jsx_attribute` nodes belonging to the opening element.
 */
export function jsxAttributes(openEl: SgNode): SgNode[] {
  return openEl.findAll({ rule: { kind: 'jsx_attribute' } })
}

/**
 * The `property_identifier` child of a `jsx_attribute` holds the attribute's
 * name. Returns null for spread attributes.
 */
export function jsxAttributeName(attr: SgNode): SgNode | null {
  return attr.find({ rule: { kind: 'property_identifier' } })
}

/**
 * Rename an attribute by rewriting only the identifier node, preserving the
 * attribute value node exactly as-is.
 */
export function renameJsxAttribute(attr: SgNode, newName: string): Edit | null {
  const name = jsxAttributeName(attr)
  if (!name) {
    return null
  }
  if (name.text() === newName) {
    return null
  }
  return name.replace(newName)
}

/**
 * Attribute value accessor. Returns the raw value node (could be a string, a
 * jsx_expression, a template literal, ...).
 */
export function jsxAttributeValue(attr: SgNode): SgNode | null {
  const children = attr.children()
  // Structure: property_identifier, "=", value
  for (let i = children.length - 1; i >= 0; i--) {
    const c = children[i]
    if (!c) {
      continue
    }
    const k = c.kind()
    if (k === 'property_identifier' || k === '=') {
      continue
    }
    return c
  }
  return null
}

function escapeRegex(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
