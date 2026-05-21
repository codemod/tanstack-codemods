/**
 * JSSG / tree-sitter `range().{start,end}.index` values are UTF-8 **byte** offsets into the
 * source file, while JavaScript `string` indexing / `RegExp` results use UTF-16 code units.
 * These helpers convert between the two so `source.slice` / `source[i]` and `commitEdits`
 * stay consistent on non-ASCII TSX.
 */

export function utf8ByteOffsetToUtf16Index(source: string, byteOffset: number): number {
  if (byteOffset <= 0) {
    return 0
  }
  const utf8 = new TextEncoder().encode(source)
  const b = Math.min(byteOffset, utf8.length)
  return new TextDecoder('utf-8').decode(utf8.subarray(0, b)).length
}

export function utf16IndexToUtf8ByteOffset(source: string, utf16Index: number): number {
  return new TextEncoder().encode(source.slice(0, utf16Index)).length
}
