# Plan 107: Code-split the Studio so panels + heavy deps load on demand

> **Executor instructions**: This is the largest plan in the set and spans the
> studio bundler + three host-serving paths. Read the ENTIRE plan (especially the
> "Serving reality" section and STOP conditions) before writing any code. Follow
> step by step; run each verify. Update `plans/README.md` when done unless a
> reviewer owns it.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- packages/studio packages/config/src/studio-host packages/vite/src/studio-plugin.ts packages/cli/src/util/studio-server.ts`

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

The studio (the biggest package, ~39k lines, served locally by the CLI/Vite dev
server) statically imports all ~35 feature panels and eagerly instantiates every
one, with routes wired as `component: () => panels[tab]`. Heavyweight deps —
`@xyflow/react` (schema diagram) and `recharts` (home + reports charts) — sit in
that same eager graph. A user landing on Home downloads and parses the entire
studio (graph engine, chart library, SQL editor, every panel) before first
interaction, even though Home needs none of them. Route-level lazy loading moves
each panel and its heavy deps into their own on-demand chunk.

## Serving reality — READ THIS FIRST (why this is L, not M)

The studio is **not** served as a Vite app with automatic chunk splitting. It is
bundled by a hand-rolled esbuild script into a **single** file and served as one
static asset:

- `packages/studio/scripts/build-standalone.mjs` runs `esbuild` with
  `outfile: "dist/standalone/studio.js"`, `bundle: true`, `minify: true`,
  `keepNames: true`, `format: "esm"`, **no `splitting`, no `outdir`**. It emits
  one file.
- Three hosts serve exactly `/studio.js` + `/styles.css`:
  - `packages/cli/src/util/studio-server.ts:197` — `if (pathname !== "/studio.js"
    && pathname !== "/styles.css") return false;` (only those two paths served).
  - `packages/vite/src/studio-plugin.ts:29-31` — `STUDIO_SCRIPT_PATH =
    "/__lunora/studio.js"`, `STUDIO_STYLE_PATH = "/__lunora/styles.css"`.
  - `packages/config/src/studio-host/assets.ts:17-31` — `loadStudioAssets` reads
    exactly `@lunora/studio/standalone/studio.js` + `styles.css` into buffers.

**Consequence**: adding `React.lazy` boundaries in `studio.tsx` alone does
**nothing** for load time unless esbuild also emits separate chunks AND the hosts
serve them. So this plan has two halves: (1) lazy boundaries in the SPA, and
(2) make the build emit chunks and the hosts serve them.

Because the standalone bundle is inlined and served as loose files (not through
Vite's dev server), enabling esbuild `splitting: true` + `outdir` produces N chunk
files that the three static servers must now serve by directory, not by two exact
paths. That is the bulk of the work and the risk.

## Current state

Eager imports + panels map (`packages/studio/src/app/studio.tsx:41-92`,
`1012-1085`):
```ts
import { AnalyticsPanel } from "../features/analytics/analytics-panel";
// … ~35 static panel imports …
    const panels: Record<StudioTab, ReactElement> = {
        analytics: <AnalyticsPanel />,
        // … all ~35 instantiated eagerly …
        home: <HomePanel initialShardKey={initialShardKey} />,
        schema: <SchemaRoutePanel … />,   // pulls @xyflow/react via schema-viewer
        // …
    };
    const indexRoute = createRoute({ component: () => panels.home, getParentRoute: () => rootRoute, path: "/" });
    const tabRoutes = TABS.map((tab) => createRoute({ component: () => panels[tab], getParentRoute: () => rootRoute, path: `/${tab}` }));
```
No `React.lazy`/dynamic `import()` anywhere in `app/*.tsx` (confirmed). Heavy
deps: `@xyflow/react`, `recharts` (`packages/studio/package.json:87,92`). Router
is `@tanstack/react-router`.

## Two implementation options — pick based on a spike

**Option A (recommended if it works): esbuild code splitting + directory serving.**
Enable `splitting: true` + `outdir: "dist/standalone"` in `build-standalone.mjs`,
convert the panels map to `React.lazy(() => import("../features/…"))` per route
with a `Suspense` fallback, keep Home eager. Then update the three hosts to serve
any file under the standalone dir (not just `/studio.js`), with correct MIME +
path safety (no traversal). This delivers real on-demand chunks.

**Option B (smaller, partial win): manual heavy-dep isolation without full
splitting.** Keep a single bundle but lazy-load only the two heaviest subtrees
(`@xyflow/react` schema diagram, `recharts` charts) via dynamic `import()` so
esbuild — even with a single `outfile` — will still emit them as separate async
chunks **only if** `splitting`/`outdir` is on. Without `splitting`, esbuild
inlines dynamic imports into the one file, so Option B still requires `outdir`.
Net: there is no real win without `splitting`+`outdir`+directory serving. So
**Option A is the real plan; Option B is not a shortcut.**

Given that, this plan commits to Option A, gated by a spike (Step 1) that proves
the hosts can serve a chunk directory. If the spike fails, STOP.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Build studio | `pnpm --filter "@lunora/studio" run build` | exit 0; emits standalone output |
| Typecheck studio | `pnpm --filter "@lunora/studio" run lint:types` | exit 0 |
| Typecheck cli | `pnpm --filter "@lunora/cli" run lint:types` | exit 0 |
| Typecheck vite | `pnpm --filter "@lunora/vite" run lint:types` | exit 0 |
| Typecheck config | `pnpm --filter "@lunora/config" run lint:types` | exit 0 |
| Lint studio | `pnpm --filter "@lunora/studio" run lint:eslint` | exit 0 |

**Do NOT run the studio Vitest suite** (jsdom hang in this sandbox). Verify via
build + `lint:types` + `lint:eslint`, and by inspecting the emitted
`dist/standalone/` directory contents.

## Scope

**In scope**:
- `packages/studio/src/app/studio.tsx` — convert the eager `panels` element map
  to route-level lazy components with a `Suspense` fallback; keep `home` eager.
- `packages/studio/scripts/build-standalone.mjs` — `splitting: true` + `outdir`
  (replace `outfile`); adjust the synthetic entry / chunk naming as needed; keep
  the `keepNames`, `NODE_ENV` probe, and single-file-name expectations of
  downstream resolvers in mind.
- `packages/cli/src/util/studio-server.ts` — serve the chunk directory (not just
  two exact paths) with MIME + traversal safety.
- `packages/vite/src/studio-plugin.ts` — same, under `/__lunora/*`.
- `packages/config/src/studio-host/assets.ts` — if hosts read bytes via this
  helper, generalize it to resolve+read arbitrary files under the standalone dir
  (or expose a directory root the hosts serve from).

**Out of scope**:
- Splitting the Home panel or the shell — Home stays eager (synchronous first
  paint, per the existing `indexRoute` comment).
- Rewriting the studio to be served through Vite's own bundler (too large).
- Changing panel behavior/props.
- The `dist/index.mjs`/`dist/mount.mjs` **library** outputs (react-externalized)
  — those are for host-bundler embedding and are a different consumer; do not
  break them, but the splitting change targets the **standalone** bundle only.

## Git workflow

- Branch: `advisor/107-studio-route-code-splitting`
- Commit(s): `perf(studio): lazy-load feature panels` + `build(studio): emit split chunks for the standalone bundle` + `feat(cli,vite,config): serve studio chunk directory`.
- Do NOT push/PR unless instructed.

## Steps

### Step 1: SPIKE — prove chunk-directory serving is viable

Before touching `studio.tsx`, do a minimal proof:
1. In `build-standalone.mjs`, switch to `splitting: true` + `outdir:
   "dist/standalone"` (keep the synthetic entry). Build. Inspect
   `packages/studio/dist/standalone/` — confirm esbuild emits a primary entry +
   `chunk-*.js` files, all ESM.
2. Confirm the entry file references the chunks by **relative** path (esbuild does
   this) and that those paths resolve under the served base (`/studio.js`'s
   directory for CLI, `/__lunora/` for Vite).
3. Decide the entry filename: downstream resolvers hardcode `studio.js`
   (`assets.ts`, `studio-server.ts:170` `scriptSrc: "/studio.js"`,
   `studio-plugin.ts`). Ensure esbuild's entry output is named `studio.js` (set
   the entry point's output name, or rename post-build) so the HTML's
   `scriptSrc` stays valid, and the chunks live beside it.

If esbuild cannot emit a stable `studio.js` entry + relative chunks that the
static servers can serve by directory, **STOP** — the standalone architecture
doesn't support splitting without a larger redesign; report the finding and the
options (e.g. move the standalone bundle behind a tiny static file server, or
accept Option B's no-op).

**Verify**: `packages/studio/dist/standalone/` contains `studio.js` + one or more
`chunk-*.js`; the entry imports chunks by relative path.

### Step 2: Lazy boundaries in `studio.tsx`

Convert the panels map to `React.lazy`. Keep `home` (and the shell/layout) eager.
Wrap the routed outlet in `<Suspense fallback={<PanelSkeleton/>}>` (reuse an
existing studio loading/skeleton component if present — grep
`packages/studio/src` for a skeleton/spinner). Because panels currently receive
props (`initialShardKey`, `functions`, etc.), each lazy component must be wrapped
so the props still flow — e.g. `const AnalyticsPanel = lazy(() => import(
"../features/analytics/analytics-panel").then(m => ({ default: m.AnalyticsPanel
})))` for named exports (note several panels are named exports, some default —
check each import line). Then `component: () => <Suspense><AnalyticsPanel
/></Suspense>` in the route.

Preserve the `data` route's `validateSearch: validateDataViewSearch`.

**Verify**: `pnpm --filter "@lunora/studio" run lint:types` → exit 0;
`pnpm --filter "@lunora/studio" run build` → exit 0 and emits split chunks; the
schema-diagram (`@xyflow/react`) and reports (`recharts`) end up in chunks NOT
loaded by the Home route (inspect chunk contents or the entry's static imports).

### Step 3: Serve the chunk directory from the three hosts

For each host, replace the two-exact-path check with directory serving under the
standalone root:
- Resolve requested pathname to a file under the standalone dir; **reject path
  traversal** (`..`, absolute escapes) — normalize and confirm the resolved path
  stays within the dir. Return 404 for anything outside.
- Serve `.js` as `text/javascript; charset=utf-8`, `.css` as `text/css`, and
  any `.map` if emitted. Keep the existing `styles.css` handling.
- Preserve the per-request freshness stamp logic (`studioAssetsStamp`) so a
  mid-session rebuild is picked up — generalize it to the directory mtime or the
  entry's mtime.
- CLI: `studio-server.ts` `serveStaticAsset` — generalize.
- Vite: `studio-plugin.ts` — serve chunks under `/__lunora/*`.
- Config: `assets.ts` `loadStudioAssets` — provide a `resolveStandaloneFile(name)`
  the hosts call, or expose the standalone directory path for the hosts to read
  from. Keep the graceful "studio not built" fallback.

**Verify**: `pnpm --filter "@lunora/cli" run lint:types`,
`pnpm --filter "@lunora/vite" run lint:types`,
`pnpm --filter "@lunora/config" run lint:types` → all exit 0.

### Step 4: Manual end-to-end confirmation (best-effort in sandbox)

If a dev server can be started in this environment, load the studio, open the
Network tab, confirm Home does not fetch the schema-diagram/recharts chunks and
that navigating to Schema/Reports lazy-loads them. If the sandbox can't run it,
document that the change is verified by (a) the emitted chunk graph and (b)
static-import analysis showing Home's chunk excludes the heavy deps, and flag a
manual smoke-test as a reviewer action.

**Verify**: build output + chunk inspection show heavy deps are in on-demand
chunks; hosts' `lint:types` pass.

## Test plan

- No jsdom component tests (sandbox hang). The gates are:
  - `pnpm --filter "@lunora/studio" run build` succeeds and emits `studio.js` +
    `chunk-*.js`.
  - Static analysis / chunk inspection: `@xyflow/react` and `recharts` are NOT in
    the Home-path chunk.
  - Host `lint:types` pass; a traversal-safety unit test for the new
    directory-serving path handler if one is extractable as a pure function
    (recommended — test that `../etc/passwd`-style requests are rejected).
- If the CLI studio-server has existing tests
  (`packages/cli/__tests__/util/`), add a case: a request for a `chunk-*.js`
  under the standalone dir is served; a traversal request is rejected (404/403).
- Verification: the builds + host `lint:types` + any added serve-path test pass.

## Done criteria

- [ ] `pnpm --filter "@lunora/studio" run build` emits a `studio.js` entry plus on-demand `chunk-*.js` files under `dist/standalone/`.
- [ ] The Home route's loaded code excludes `@xyflow/react` and `recharts` (they load only when Schema/Reports are visited).
- [ ] All three hosts serve chunk files from the standalone directory with correct MIME and path-traversal protection; `/studio.js` + `/styles.css` still work.
- [ ] `lint:types` passes for studio, cli, vite, config; `lint:eslint` passes for studio.
- [ ] The `dist/index.mjs`/`dist/mount.mjs` library outputs still build (not broken by the standalone splitting change).
- [ ] `git status` shows only in-scope files.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- **Step 1 spike fails**: esbuild can't emit a stable `studio.js` entry + relative
  chunks the static servers can serve → STOP, report; do not ship lazy boundaries
  that don't actually split (they'd add Suspense complexity for zero load-time
  benefit).
- Serving a directory would require a materially larger rewrite of a host's
  request pipeline (e.g. the Vite plugin's middleware can't cleanly serve
  arbitrary sub-paths) → STOP and report the blocked host rather than shipping a
  half-working split (chunks 404 → white screen).
- Path-traversal protection can't be made airtight for any host → STOP; a studio
  static server that serves arbitrary files is a security regression.
- The library (`mount.mjs`) build breaks → STOP; the standalone change must not
  affect the embedding path.

## Maintenance notes

- New panels should be added as lazy routes, not eager entries — document this in
  the studio's panel-authoring notes so the eager graph doesn't creep back.
- A reviewer must manually smoke-test the dev studio (Network tab) — the sandbox
  can't, and "chunks 404 in one host" is the most likely regression.
- If the studio is ever migrated to be served through Vite's own bundler, this
  hand-rolled splitting + directory serving can be removed in favor of Vite's
  automatic chunking.
- Keep Home (and the shell) eager — synchronous first paint is a deliberate
  property (see the `indexRoute` comment in `studio.tsx`).
