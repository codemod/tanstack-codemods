# nextjs-to-tanstack

Migrate a **Next.js** app (App Router and common Pages Router usage) to **TanStack Start** and **TanStack Router** file routes.

The workflow rewrites routes and handlers, updates tooling, and writes `TANSTACK_MIGRATION_NEXT_STEPS.md` next to `package.json` for remaining manual work.

---

## Quick start

```bash
# Registry
npx codemod@latest run nextjs-to-tanstack

# Monorepo: point at the Next.js package root
npx codemod@latest run nextjs-to-tanstack -t /path/to/next-app

# This repo: run the bundled workflow
npx codemod@latest workflow run --workflow workflow.yaml --target .
```

Back up or commit first (recommended). Many files change; unmigrated `pages/` files may end up under `migrated-from-pages/`.

The registry package name is `nextjs-to-tanstack` (same as in `codemod.yaml`).

---

## Workflow params

Pass these when running [`workflow.yaml`](workflow.yaml) with `-p`:

| Param                    | Type                  | Default   | Meaning                                                 |
| ------------------------ | --------------------- | --------- | ------------------------------------------------------- |
| `enableAiFollowupFixups` | `"true"` \| `"false"` | `"false"` | Optional AI pass after deterministic steps (see below). |

**`enableAiFollowupFixups`** — If `"true"`, an AI pass tries to clear low-risk `// TODO:` markers and tasks in `TANSTACK_MIGRATION_NEXT_STEPS.md`. Output is not fully deterministic; turn on only if you want that extra step.

```bash
npx codemod@latest workflow run --workflow workflow.yaml --target . \
  -p enableAiFollowupFixups=true
```

---

## What runs (overview)

### Layout and files

- Adds a Vite / TanStack Start scaffold (e.g. `vite.config.ts`, router entry). If Next i18n is detected, hints may go under `.codemod/`.
- Removes root Next-only configs (`next.config.*`, `postcss.config.*`).
- Maps layouts to `__root.tsx`, `page` / `route` modules to `createFileRoute`, and API-style routes to TanStack server handlers.
- Handles dynamic segments, `loading` / `error` / `not-found` / `template` files, and prunes empty App Router segment folders.

### Next.js APIs (mechanical rewrites)

- `metadata` / `viewport` → route `head()`; `params` / `searchParams` → router hooks.
- `next/link`, `next/image`, `next/navigation`, `next/dynamic`, `next/script` → TanStack-friendly patterns where safe.
- `next/cache` → TanStack Query–style invalidation; `next/headers` → Start server helpers; `next/server` → Fetch `Request` / `Response` (gaps documented in the generated guide).
- `next/og` → satori + resvg; `opengraph-image` / `twitter-image` → server `GET` routes.

### Data, types, and polish

- Safe top-level `await` may move into `Route.loader`; harder cases get `// TODO:` (R10).
- Pages data exports (`getStaticProps`, …) are stripped from migrated routes; Next-only types often become placeholders you should fix.
- Fonts and `globals.css` get patches; unused `next/*` imports are dropped; survivors are annotated (R10b).

### Package, tooling, and exit

- `package.json` picks up Start / Router / Vite deps and scripts.
- tsconfig, ESLint, and doc/CI strings that assume Next get light patches.
- Leftover `pages/` may move to `migrated-from-pages/`; `TANSTACK_MIGRATION_NEXT_STEPS.md` is written next to `package.json`.
- Optional AI step if enabled; transient codemod state (e.g. `.codemod/state.json`) is removed afterward.

### Monorepos

Globs match nested trees (e.g. `apps/foo/app/...`). In large repos, still pass `-t` at the Next package root so the run stays fast and focused.

---

## Supplementary notes

- **Pipeline** — Steps run in a fixed order. Later passes assume earlier renames (e.g. `[slug]/page.tsx` → `$slug.tsx`) already happened, so re-running individual scripts by hand out of order may not match a full workflow run.
- **Two outputs to trust** — Inline `// TODO: …` comments mark uncertain spots; `TANSTACK_MIGRATION_NEXT_STEPS.md` rolls those themes into a single checklist with doc links.
- **Surface area** — The codemod targets common App Router and Pages Router paths (`app/**`, `pages/**`, shared components). Custom indirection (barrels, codegen, or non-standard folders) may need manual follow-up even when imports are valid.

---

## Before and after (illustrative)

The snippets below mirror **fixture tests** in this repo. Your files may include extra imports, types, or TODOs until you finish the checklist.

### Dynamic page → TanStack file route

**Before** — `src/app/posts/[slug]/page.tsx`

```tsx
export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return <div>My Post: {slug}</div>
}
```

**After** — `src/app/posts/$slug.tsx` (dynamic segment becomes a `$param` file name; URL shape is `createFileRoute("/posts/$slug")`)

```tsx
import { createFileRoute } from '@tanstack/react-router'

function PostPage() {
  const { slug } = Route.useParams()
  return <div>My Post: {slug}</div>
}

export const Route = createFileRoute('/posts/$slug')({
  component: PostPage,
})
```

### App Router API route → server `GET` handler

**Before** — `src/app/api/hello/route.ts`

```tsx
export async function GET() {
  return Response.json('Hello, World!')
}
```

**After** — `src/app/api/hello.ts` (file moves up; HTTP methods live under `server.handlers`)

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/hello')({
  server: {
    handlers: {
      GET: async () => {
        return Response.json('Hello, World!')
      },
    },
  },
})
```

### Root layout → `__root.tsx`

**Before** — `src/app/layout.tsx`

```tsx
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Create Next App',
  description: 'Generated by create next app',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang='en'>
      <body>{children}</body>
    </html>
  )
}
```

**After** — `src/app/__root.tsx` (shell uses `Outlet`, `HeadContent`, and `Scripts`)

```tsx
import type { Metadata } from 'next'
import { Outlet, createRootRoute, HeadContent, Scripts } from '@tanstack/react-router'
import appCss from './globals.css?url'

export const metadata: Metadata = {
  title: 'Create Next App',
  description: 'Generated by create next app',
}

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  return (
    <html lang='en'>
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  )
}
```

Later passes move `metadata` toward route `head()` and clean up remaining `next`-only types — expect to edit this file again while you work through `TANSTACK_MIGRATION_NEXT_STEPS.md`.

### Link: `next/link` → TanStack Router

**Before**

```tsx
import Link from 'next/link'
;<Link href='/about' className='nav-link'>
  About
</Link>
```

**After**

```tsx
import { Link } from '@tanstack/react-router'
;<Link to='/about' className='nav-link'>
  About
</Link>
```

### Redirects (server / loader style)

**Before** — `next/navigation`

```tsx
import { redirect, RedirectType } from 'next/navigation'

export function guard() {
  redirect('/wish?error=invalid-thread-id', RedirectType.replace)
}
```

**After** — throw `redirect` from `@tanstack/react-router` (appropriate in loaders, `beforeLoad`, and server code paths; client components use `useNavigate()` instead)

```tsx
import { redirect } from '@tanstack/react-router'

export function guard() {
  throw redirect({ to: '/wish?error=invalid-thread-id', replace: true })
}
```

Some call sites may still get a **TODO** comment if the codemod cannot prove the context is safe to rewrite.

---

## After you run

1. **Install** — Install deps so `package.json` edits take effect. Refresh lockfiles as needed; skip strict frozen installs until things stabilize. Watch for packages that still peer on Next.

2. **Open the checklist** — Read `TANSTACK_MIGRATION_NEXT_STEPS.md`: i18n, env (`NEXT_PUBLIC_*` → `VITE_*` / `import.meta.env`), OG URLs, TODO buckets (R10, R4e–R4i, …). It links to the official [Migrate from Next.js](https://tanstack.com/start/latest/docs/framework/react/migrate-from-next-js) guide.

3. **Sweep leftovers** — e.g. `rg '// TODO:'`, remaining `from "next/…"` imports, `middleware`, and `migrated-from-pages/` after you merge or delete what you need.

4. **Run the dev server** — `npm run dev` or `vite dev` from the package root; fix navigation, loaders, and tests (Vitest: see R4h-bis in the guide).

This codemod is best-effort. Edge runtime, uncommon Next APIs, and app-specific design may still need manual work — the guide and TODOs are the source of truth.

---

## Development

```bash
npm test
codemod workflow validate --workflow workflow.yaml
codemod login && codemod publish
```

## Resources

- [Migrate from Next.js (TanStack Start)](https://tanstack.com/start/latest/docs/framework/react/migrate-from-next-js)
- [TanStack Router — routing concepts](https://tanstack.com/router/latest/docs/framework/react/routing/routing-concepts)
- [TanStack Start — server routes](https://tanstack.com/start/latest/docs/framework/react/guide/server-routes)

## License

MIT
