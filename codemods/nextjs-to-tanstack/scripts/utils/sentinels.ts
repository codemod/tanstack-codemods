/**
 * Lightweight migration reminders inserted when the codemod can only go part
 * of the way automatically. Tier 1 prefixes lines where the AST transform was
 * applied but semantics may still need a human once-over; Tier 2 covers cases
 * where we bail on an unsafe rewrite. Both tiers share searchable prefixes so
 * you can skim the codebase after a run (`rg 'TanStack migration note:'`).
 */

import type { Edit, SgNode, TypesMap } from "codemod:ast-grep";

/** Public so entry scripts can build aligned single-line prefixes. */
export const REVIEW_PREFIX = "// TanStack migration note: ";

export const TODO_PREFIX = "// TanStack migration note: ";

type AnyNode = SgNode<TypesMap>;

/**
 * Build a leading-line comment insertion at the start of the given node.
 * The comment inherits the node's column indentation so multi-line blocks
 * stay visually aligned.
 */
export function insertReviewBefore<T extends TypesMap>(
  node: SgNode<T>,
  message: string,
): Edit {
  return buildLeadingCommentEdit(node as unknown as AnyNode, `${REVIEW_PREFIX}${message}`);
}

export function insertTodoBefore<T extends TypesMap>(
  node: SgNode<T>,
  message: string,
  docUrl?: string,
): Edit {
  const body = docUrl ? `${message} — ${docUrl}` : message;
  return buildLeadingCommentEdit(node as unknown as AnyNode, `${TODO_PREFIX}${body}`);
}

function buildLeadingCommentEdit(node: AnyNode, commentLine: string): Edit {
  const range = node.range();
  const column = range.start.column;
  const indent = " ".repeat(column);
  const insertedText = `${commentLine}\n${indent}`;
  return {
    startPos: range.start.index,
    endPos: range.start.index,
    insertedText,
  };
}

/**
 * True if the node (or the line preceding it) already carries a sentinel of
 * the given tier. Use from every entry script so second runs never duplicate
 * markers.
 */
export function hasReviewSentinel<T extends TypesMap>(
  source: string,
  node: SgNode<T>,
  needle?: string,
): boolean {
  return hasSentinel(source, node as unknown as AnyNode, REVIEW_PREFIX, needle);
}

export function hasTodoSentinel<T extends TypesMap>(
  source: string,
  node: SgNode<T>,
  needle?: string,
): boolean {
  return hasSentinel(source, node as unknown as AnyNode, TODO_PREFIX, needle);
}

function hasSentinel(source: string, node: AnyNode, prefix: string, needle?: string): boolean {
  const lineStart = findLineStart(source, node.range().start.index);
  const precedingLines = source.slice(0, lineStart).split("\n").slice(-6);
  for (const line of precedingLines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) continue;
    if (needle && !trimmed.includes(needle)) continue;
    return true;
  }
  return false;
}

function findLineStart(source: string, idx: number): number {
  const before = source.slice(0, idx);
  const nl = before.lastIndexOf("\n");
  return nl === -1 ? 0 : nl + 1;
}
