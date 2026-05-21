/**
 * Map Next.js `export const viewport = { … }` onto TanStack Router `head().meta`
 * entries (`viewport`, `theme-color`, `color-scheme`).
 */

import type { SgNode, TypesMap } from "codemod:ast-grep";

type AnyNode = SgNode<TypesMap>;

export interface ViewportMetaParts {
  metaItems: string[];
  unmapped: string[];
}

const LAYOUT_KEYS = new Set([
  "width",
  "height",
  "initialScale",
  "minimumScale",
  "maximumScale",
  "userScalable",
  "viewportFit",
  "interactiveWidget",
]);

export function viewportObjectToMetaParts<T extends TypesMap>(
  objTyped: SgNode<T>
): ViewportMetaParts {
  const objNode = objTyped as unknown as AnyNode;
  const metaItems: string[] = [];
  const unmapped: string[] = [];

  let themeColorValue: AnyNode | null = null;
  let colorSchemeValue: AnyNode | null = null;
  const layoutPairs = new Map<string, AnyNode>();

  for (const pair of objNode.findAll({ rule: { kind: "pair" } })) {
    const parent = pair.parent();
    if (!parent || parent.id() !== objNode.id()) continue;

    const key = readKey(pair);
    const value = pair.field("value");
    if (!key || !value) continue;

    if (key === "themeColor") {
      themeColorValue = value;
      continue;
    }
    if (key === "colorScheme") {
      colorSchemeValue = value;
      continue;
    }
    if (LAYOUT_KEYS.has(key)) {
      layoutPairs.set(key, value);
      continue;
    }
    unmapped.push(key);
  }

  const viewportContent = buildViewportContent(layoutPairs, unmapped);
  metaItems.push(`{ name: "viewport", content: ${JSON.stringify(viewportContent)} }`);

  if (themeColorValue) {
    collectThemeColor(themeColorValue, metaItems, unmapped);
  }
  if (colorSchemeValue) {
    const cs = readStringLiteral(colorSchemeValue);
    if (cs !== null) {
      metaItems.push(`{ name: "color-scheme", content: ${JSON.stringify(cs)} }`);
    } else {
      unmapped.push("colorScheme (non-literal value)");
    }
  }

  return { metaItems, unmapped };
}

function buildViewportContent(layoutPairs: Map<string, AnyNode>, unmapped: string[]): string {
  let width: string | null = null;
  let height: string | null = null;
  let initialScale: number | null = null;
  let minimumScale: number | null = null;
  let maximumScale: number | null = null;
  let userScalable: boolean | null = null;
  let viewportFit: string | null = null;
  let interactiveWidget: string | null = null;

  for (const [key, value] of layoutPairs) {
    switch (key) {
      case "width": {
        const s = readStringLiteral(value);
        if (s !== null) {
          width = s;
          break;
        }
        const n = readNumberLiteral(value);
        if (n !== null) {
          width = String(n);
          break;
        }
        unmapped.push("viewport.width (non-literal)");
        break;
      }
      case "height": {
        const s = readStringLiteral(value);
        if (s !== null) {
          height = s;
          break;
        }
        const n = readNumberLiteral(value);
        if (n !== null) {
          height = String(n);
          break;
        }
        unmapped.push("viewport.height (non-literal)");
        break;
      }
      case "initialScale": {
        const n = readNumberLiteral(value);
        if (n !== null) initialScale = n;
        else unmapped.push("viewport.initialScale (non-literal)");
        break;
      }
      case "minimumScale": {
        const n = readNumberLiteral(value);
        if (n !== null) minimumScale = n;
        else unmapped.push("viewport.minimumScale (non-literal)");
        break;
      }
      case "maximumScale": {
        const n = readNumberLiteral(value);
        if (n !== null) maximumScale = n;
        else unmapped.push("viewport.maximumScale (non-literal)");
        break;
      }
      case "userScalable": {
        const b = readBooleanLiteral(value);
        if (b !== null) userScalable = b;
        else unmapped.push("viewport.userScalable (non-literal)");
        break;
      }
      case "viewportFit": {
        const s = readStringLiteral(value);
        if (s !== null) viewportFit = s;
        else unmapped.push("viewport.viewportFit (non-literal)");
        break;
      }
      case "interactiveWidget": {
        const s = readStringLiteral(value);
        if (s !== null) interactiveWidget = s;
        else unmapped.push("viewport.interactiveWidget (non-literal)");
        break;
      }
      default:
        break;
    }
  }

  const segments: string[] = [];
  segments.push(`width=${width ?? "device-width"}`);
  if (height != null) segments.push(`height=${height}`);
  segments.push(`initial-scale=${initialScale ?? 1}`);
  if (minimumScale != null) segments.push(`minimum-scale=${minimumScale}`);
  if (maximumScale != null) segments.push(`maximum-scale=${maximumScale}`);
  if (userScalable === false) segments.push("user-scalable=no");
  if (userScalable === true) segments.push("user-scalable=yes");
  if (viewportFit != null) segments.push(`viewport-fit=${viewportFit}`);
  if (interactiveWidget != null) {
    segments.push(`interactive-widget=${interactiveWidget}`);
  }

  return segments.join(", ");
}

function collectThemeColor(value: AnyNode, metaItems: string[], unmapped: string[]): void {
  const single = readStringLiteral(value);
  if (single !== null) {
    metaItems.push(`{ name: "theme-color", content: ${JSON.stringify(single)} }`);
    return;
  }
  if (value.is("array")) {
    for (const el of arrayElements(value)) {
      const desc = readThemeColorDescriptor(el);
      if (!desc) {
        unmapped.push("themeColor (non-literal descriptor in array)");
        continue;
      }
      pushThemeColor(metaItems, desc);
    }
    return;
  }
  if (value.is("object")) {
    const desc = readThemeColorDescriptor(value);
    if (desc) {
      pushThemeColor(metaItems, desc);
      return;
    }
    unmapped.push("themeColor (unsupported object shape)");
    return;
  }
  unmapped.push("themeColor (unsupported value)");
}

function pushThemeColor(metaItems: string[], desc: { color: string; media?: string }): void {
  if (desc.media != null) {
    metaItems.push(
      `{ name: "theme-color", content: ${JSON.stringify(desc.color)}, media: ${JSON.stringify(desc.media)} }`
    );
  } else {
    metaItems.push(`{ name: "theme-color", content: ${JSON.stringify(desc.color)} }`);
  }
}

function readThemeColorDescriptor(node: AnyNode): {
  color: string;
  media?: string;
} | null {
  if (!node.is("object")) return null;
  let color: string | undefined;
  let media: string | undefined;
  for (const pair of node.findAll({ rule: { kind: "pair" } })) {
    const p = pair.parent();
    if (!p || p.id() !== node.id()) continue;
    const key = readKey(pair);
    const val = pair.field("value");
    if (!key || !val) continue;
    if (key === "color") {
      const s = readStringLiteral(val);
      if (s === null) return null;
      color = s;
      continue;
    }
    if (key === "media") {
      const s = readStringLiteral(val);
      if (s === null) return null;
      media = s;
    }
  }
  if (color === undefined) return null;
  return { color, media };
}

function arrayElements(node: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (const child of node.children()) {
    const k = child.kind();
    if (k === "[" || k === "]" || k === "," || k === "spread_element") continue;
    out.push(child);
  }
  return out;
}

function readKey(pair: AnyNode): string | null {
  const keyNode = pair.field("key");
  if (!keyNode) return null;

  if (keyNode.is("property_identifier") || keyNode.is("identifier")) {
    return keyNode.text();
  }
  if (keyNode.is("string")) {
    return readStringLiteral(keyNode);
  }
  return null;
}

function readStringLiteral(node: AnyNode): string | null {
  if (!node.is("string")) return null;
  const fragment = node.find({ rule: { kind: "string_fragment" } });
  if (fragment) return fragment.text();
  return "";
}

function readNumberLiteral(node: AnyNode): number | null {
  if (!node.is("number")) return null;
  const t = node.text().replace(/_/g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function readBooleanLiteral(node: AnyNode): boolean | null {
  const k = node.kind();
  if (k === "true") return true;
  if (k === "false") return false;
  return null;
}
