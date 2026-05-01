/**
 * Convert a Next.js App Router file path into its TanStack Start equivalent.
 *
 * Rules (per the official migration guide):
 *   src/app/page.tsx                        → src/app/index.tsx             "/"
 *   src/app/posts/page.tsx                  → src/app/posts.tsx             "/posts"
 *   src/app/posts/[slug]/page.tsx           → src/app/posts/$slug.tsx       "/posts/$slug"
 *   src/app/posts/[...slug]/page.tsx        → src/app/posts/$.tsx           "/posts/$"
 *   src/app/prefix/[[...slug]]/page.tsx     → src/app/prefix/$.tsx + sibling index.tsx that redirects empty splat "/prefix/$"
 *   src/app/(marketing)/about/page.tsx      → src/app/about.tsx             "/about"
 *   src/app/api/hello/route.ts              → src/app/api/hello.ts          "/api/hello"
 *   src/app/layout.tsx                      → src/app/__root.tsx            (root)
 *
 * Everything operates on POSIX-style paths. No filesystem access.
 */

export type NextFileKind = "layout" | "page" | "route" | "other";

export interface RoutePathResult {
  /** Target file path (POSIX) relative to repo root, with dynamic segments converted. */
  newPath: string;
  /** Route path TanStack expects inside `createFileRoute(...)`, or null for layouts. */
  routePath: string | null;
  /** Which Next convention was detected. */
  kind: NextFileKind;
  /** True if the source file was a Next catch-all `[...slug]` segment. */
  wasCatchAll: boolean;
  /** Original dynamic segment name, or null. Useful for R3 to restore user names. */
  dynamicSegmentName: string | null;
  /**
   * Optional catch-all `[[...name]]` has no single-file equivalent: we emit the
   * splat route (`…/$.tsx`) plus a sibling `index.tsx` that redirects with an
   * empty `_splat` so the parent URL still resolves.
   * Omitted when the splat sits directly under `app/` (nothing to anchor an index sibling).
   */
  optionalCatchAllRedirect?: {
    indexNewPath: string;
    indexRoutePath: string;
    splatRoutePath: string;
  };
}

const SEG_DYNAMIC = /^\[(?!\.\.\.)([^\]]+)\]$/;
const SEG_CATCHALL = /^\[\.\.\.([^\]]+)\]$/;
const SEG_GROUP = /^\(([^)]+)\)$/;

const normalize = (path: string): string => path.replace(/\\/g, "/");

const stripAppPrefix = (path: string): { head: string; rest: string[] } | null => {
  const parts = normalize(path).split("/");
  const appIdx = parts.lastIndexOf("app");
  if (appIdx === -1) return null;

  const head = parts.slice(0, appIdx + 1).join("/");
  const rest = parts.slice(appIdx + 1);
  return { head, rest };
};

const detectKind = (fileName: string | undefined): NextFileKind => {
  if (!fileName) return "other";
  if (/^layout\.(t|j)sx?$/.test(fileName)) return "layout";
  if (/^page\.(t|j)sx?$/.test(fileName)) return "page";
  if (/^route\.(t|j)sx?$/.test(fileName)) return "route";
  return "other";
};

/** Next App Router auxiliary files ported from next2tanstack-style transforms. */
export type SpecialRouteFileVariant = "loading" | "error" | "not-found";

export interface SpecialRouteFileResult {
  /** Repo-relative posix path (`src/app/...`). */
  newPath: string;
  routePath: string;
  /** Key used in `createFileRoute(...)({ ... })`. */
  routeOptionProperty: "pendingComponent" | "errorComponent" | "notFoundComponent";
  variant: SpecialRouteFileVariant;
}

export function classifySpecialRouteFileBasename(fileName: string | undefined): SpecialRouteFileVariant | null {
  if (!fileName) return null;
  if (/^loading\.(t|j)sx?$/.test(fileName)) return "loading";
  if (/^error\.(t|j)sx?$/.test(fileName)) return "error";
  if (/^not-found\.(t|j)sx?$/.test(fileName)) return "not-found";
  return null;
}

type SegmentTranslation = {
  text: string | null;
  dynamic: string | null;
  catchAll: boolean;
  optionalCatchAll: boolean;
  group: boolean;
};

const translateSegment = (seg: string): SegmentTranslation => {
  const group = SEG_GROUP.exec(seg);
  if (group) {
    return { text: null, dynamic: null, catchAll: false, optionalCatchAll: false, group: true };
  }

  const optionalCatchAll = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(seg);
  if (optionalCatchAll) {
    const name = optionalCatchAll[1] ?? "";
    return { text: "$", dynamic: name, catchAll: true, optionalCatchAll: true, group: false };
  }

  const catchAll = SEG_CATCHALL.exec(seg);
  if (catchAll) {
    return { text: "$", dynamic: catchAll[1] ?? null, catchAll: true, optionalCatchAll: false, group: false };
  }

  const dynamic = SEG_DYNAMIC.exec(seg);
  if (dynamic) {
    const name = dynamic[1] ?? "";
    return { text: `$${name}`, dynamic: name, catchAll: false, optionalCatchAll: false, group: false };
  }

  return { text: seg, dynamic: null, catchAll: false, optionalCatchAll: false, group: false };
};

/**
 * Map `loading.tsx` / `error.tsx` / `not-found.tsx` to TanStack Start route
 * module files (`-pending.tsx`, `-error.tsx`, `-not-found.tsx`) while keeping the
 * same logical `createFileRoute` path as sibling `page.tsx` would have used.
 *
 * Mirrors conventions from `/Users/amir/Desktop/codemod/next2tanstack`.
 */
export function computeSpecialRouteFileTransform(relativePath: string): SpecialRouteFileResult | null {
  const split = stripAppPrefix(relativePath);
  if (!split) return null;
  const { head, rest } = split;

  const fileName = rest.at(-1);
  const variant = classifySpecialRouteFileBasename(fileName);
  if (!variant) return null;

  const dirSegs = rest.slice(0, -1);
  const ext = fileName!.slice(fileName!.indexOf("."));

  for (const seg of dirSegs) {
    if (seg.startsWith("@")) return null;
    if (/^\(\.{1,3}\)/.test(seg)) return null;
  }

  if (dirSegs.length > 0 && dirSegs[0] === "api") return null;

  const translated: string[] = [];
  for (const seg of dirSegs) {
    const t = translateSegment(seg);
    if (t.group) continue;
    if (t.text === null) return null;
    translated.push(t.text);
  }

  const routePath = translated.length === 0 ? "/" : `/${translated.join("/")}`;

  const leaf =
    variant === "loading"
      ? `-pending${ext}`
      : variant === "error"
        ? `-error${ext}`
        : `-not-found${ext}`;
  const dirPart = translated.length ? `${translated.join("/")}/` : "";

  const routeOptionProperty =
    variant === "loading"
      ? "pendingComponent"
      : variant === "error"
        ? "errorComponent"
        : "notFoundComponent";

  return {
    newPath: `${head}/${dirPart}${leaf}`,
    routePath,
    routeOptionProperty,
    variant,
  };
}

/**
 * Given the relative path of a Next App Router source file, return the
 * TanStack Start target path + route string.
 *
 * Returns null when the file doesn't live inside an `app/` directory or the
 * conversion is not supported (e.g. parallel/intercepting routes like
 * `@modal/` or `(.)foo`).
 */
export function computeRoutePath(relativePath: string): RoutePathResult | null {
  const split = stripAppPrefix(relativePath);
  if (!split) return null;
  const { head, rest } = split;

  const fileName = rest.at(-1);
  const dirSegs = rest.slice(0, -1);
  const kind = detectKind(fileName);

  if (kind === "other") return null;

  const ext = fileName!.slice(fileName!.indexOf("."));

  if (kind === "layout") {
    if (dirSegs.length !== 0) return null; // nested layouts are not handled here
    return {
      newPath: `${head}/__root${ext}`,
      routePath: null,
      kind,
      wasCatchAll: false,
      dynamicSegmentName: null,
    };
  }

  // Parallel (`@foo`) / intercepting (`(.)foo` / `(...)foo`) routes — bail.
  for (const seg of dirSegs) {
    if (seg.startsWith("@")) return null;
    if (/^\(\.{1,3}\)/.test(seg)) return null;
  }

  const translated: string[] = [];
  let wasCatchAll = false;
  let dynamicName: string | null = null;
  let hasOptionalCatchAll = false;
  for (const seg of dirSegs) {
    const t = translateSegment(seg);
    if (t.group) continue;
    if (t.text === null) return null;
    translated.push(t.text);
    if (t.catchAll) wasCatchAll = true;
    if (t.optionalCatchAll) hasOptionalCatchAll = true;
    if (t.dynamic) dynamicName = t.dynamic;
  }

  const parentDir = translated.slice(0, -1);
  const leaf = translated.at(-1);

  if (kind === "page") {
    // `src/app/page.tsx` → `src/app/index.tsx`, route `/`.
    if (translated.length === 0) {
      return {
        newPath: `${head}/index${ext}`,
        routePath: "/",
        kind,
        wasCatchAll: false,
        dynamicSegmentName: null,
      };
    }
    const newDir = parentDir.length === 0 ? head : `${head}/${parentDir.join("/")}`;
    const routeDir = parentDir.length === 0 ? "" : `/${parentDir.join("/")}`;
    const splatRoutePath = `${routeDir}/${leaf}`;
    const pageResult: RoutePathResult = {
      newPath: `${newDir}/${leaf}${ext}`,
      routePath: splatRoutePath,
      kind,
      wasCatchAll,
      dynamicSegmentName: dynamicName,
    };
    if (hasOptionalCatchAll && parentDir.length > 0) {
      pageResult.optionalCatchAllRedirect = {
        indexNewPath: `${newDir}/index${ext}`,
        indexRoutePath: routeDir,
        splatRoutePath,
      };
    }
    return pageResult;
  }

  // route.ts → <parent>.ts
  if (translated.length === 0) return null; // route.ts at src/app root is meaningless in Next
  const newDir = parentDir.length === 0 ? head : `${head}/${parentDir.join("/")}`;
  const routeDir = parentDir.length === 0 ? "" : `/${parentDir.join("/")}`;
  return {
    newPath: `${newDir}/${leaf}${ext}`,
    routePath: `${routeDir}/${leaf}`,
    kind,
    wasCatchAll,
    dynamicSegmentName: dynamicName,
  };
}

/**
 * Quick classifier used by entry scripts to short-circuit files that fall
 * outside their intended scope. The workflow's `include:` already filters
 * most cases; this is belt-and-braces.
 */
export function detectNextFileKind(relativePath: string): NextFileKind {
  const fileName = normalize(relativePath).split("/").at(-1);
  return detectKind(fileName);
}
