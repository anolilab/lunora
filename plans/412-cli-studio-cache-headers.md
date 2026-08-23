# Plan 412: Share the studio asset cache-header logic between the Vite and CLI hosts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/cli/src/util/studio-server.ts packages/vite/src/studio-plugin.ts packages/config/src/studio-host/`
> On any change, compare the "Current state" excerpts against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug | security
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

The Vite studio host sends `Cache-Control: no-cache` plus a `W/"<file>-<stamp>"` ETag on studio assets, with a comment explaining the incident it prevents: the entry + stylesheet sit at stable unhashed URLs, so heuristic browser caching "once masked a fixed render loop behind a stale bundle". The CLI studio host (`lunora dev` without Vite — the host that ships to users) sets **only** `Content-Type` (`grep -c "Cache-Control\|ETag" packages/cli/src/util/studio-server.ts` → 0), so a rebuilt `@lunora/studio` is served stale until a hard reload — the exact documented failure. Worse, the SPA document embeds the admin token and is heuristically cacheable, so the token lands in the browser's disk cache. The repo already has the precedent for fixing host drift by consolidation: `transport-guard.ts` was moved into `@lunora/config/studio-host` after the two hosts diverged on the loopback guard and leaked the token-bearing document.

## Current state

- `packages/vite/src/studio-plugin.ts:186-228` — `serveStaticAsset`: stamp-keyed asset reload, `Cache-Control: no-cache`, `ETag: W/"<fileName>-<stamp>"`, If-None-Match → 304.
- `packages/cli/src/util/studio-server.ts:153-158`:
    ```ts
    const sendAsset = (response: ServerResponse, body: Buffer, contentType: string): void => {
        response.statusCode = 200;
        response.setHeader("Content-Type", contentType);
        response.end(body);
    };
    ```
    `:307` serves the token-bearing SPA document through the same helper. The CLI host re-reads asset bytes on rebuild (a freshness mechanism the browser never asks for).
- The consolidation precedent + target home: `packages/config/src/studio-host/` (see `transport-guard.ts:9-16` for the drift-incident rationale; `assets.ts` already exports `studioAssetsStamp`, `loadStudioAssets`, `assetContentType` from the same directory, re-exported via `index.ts:16`).

## Commands you will need

| Purpose      | Command                                                                                                                                      | Expected on success                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Install      | `pnpm install`                                                                                                                               | exit 0                                                                                        |
| Build deps   | `pnpm --filter "@lunora/cli..." run build && pnpm --filter "@lunora/vite..." run build`                                                      | exit 0                                                                                        |
| Tests        | `pnpm --filter "@lunora/config" run test && pnpm --filter "@lunora/cli" run test && pnpm --filter "@lunora/vite" run test`                   | all pass                                                                                      |
| Typecheck    | `pnpm --filter "@lunora/config" run lint:types && pnpm --filter "@lunora/cli" run lint:types && pnpm --filter "@lunora/vite" run lint:types` | exit 0                                                                                        |
| API snapshot | `pnpm run build:packages && pnpm run api:check`                                                                                              | exit 0 (run `api:update` after a fresh build if the @lunora/config surface legitimately grew) |

## Scope

**In scope**:

- `packages/config/src/studio-host/` — new small helper (e.g. `asset-cache.ts`): given `(fileName, stamp, ifNoneMatch)` return `{ etag?: string; notModified: boolean }`, plus the `no-cache`/`no-store` policy constants; export from `index.ts`.
- `packages/vite/src/studio-plugin.ts` — replace the inline ETag/304 block with the shared helper (behaviour identical).
- `packages/cli/src/util/studio-server.ts` — `sendAsset` gains `Cache-Control: no-cache` + ETag/304 via the helper; the SPA document path sends `Cache-Control: no-store` (token-bearing).
- `packages/config/__tests__/` + whichever existing test files cover `studio-server`/`studio-plugin` (extend).
- `api-snapshots/config.api.md` via `pnpm run api:update` (new export).

**Out of scope**:

- Any change to which assets are served, transport guards, or the SPA fallback routing.
- `@lunora/studio` itself.

## Git workflow

- Branch: `improve/wave22-cli`
- Commit: `fix(cli): send cache headers from the studio dev server`

## Steps

### Step 1: Extract the helper into `@lunora/config/studio-host`

Pure function(s), no I/O: ETag construction `W/"${fileName}-${stamp}"`, case-handling for If-None-Match comparison exactly as the Vite host does today (`headerValue(...)?.toLowerCase()` comparison — port it faithfully), and exported constants for the two cache policies (`no-cache` assets, `no-store` token-bearing documents). Export via `studio-host/index.ts`.

**Verify**: `pnpm --filter "@lunora/config" run test` + `lint:types` → pass.

### Step 2: Switch the Vite host to the helper

`studio-plugin.ts`'s `serveStaticAsset` keeps its stamp/reload logic; only the ETag/304/header lines route through the helper. Response behaviour byte-identical.

**Verify**: `pnpm --filter "@lunora/vite" run test` → pass.

### Step 3: Teach the CLI host

`sendAsset` accepts the stamp (or the helper result) and sets `Cache-Control: no-cache` + ETag, answering 304 on match; the document-serving call sites (`:307` and the initial `/` route) use `no-store` and no ETag.

**Verify**: `pnpm --filter "@lunora/cli" run test` → pass.

### Step 4: API snapshot

`pnpm run build:packages && pnpm run api:update` (fresh build first — the snapshot reads `dist/`), commit the updated `api-snapshots/config.api.md`.

**Verify**: `pnpm run api:check` → exit 0.

## Test plan

- Helper unit tests in `packages/config/__tests__`: ETag shape, match → notModified, mismatch → new ETag, undefined stamp → no ETag.
- CLI host: extend the existing studio-server test file (find: `grep -rln "studio-server" packages/cli/__tests__`) — asset response carries `Cache-Control: no-cache` + ETag; repeat request with If-None-Match → 304; document response carries `no-store`.
- Vite host: existing tests stay green unmodified (behaviour unchanged).

## Done criteria

- [ ] `grep -c "Cache-Control" packages/cli/src/util/studio-server.ts` ≥ 2
- [ ] All three packages' tests + lint:types exit 0
- [ ] `pnpm run api:check` exits 0
- [ ] Vite host tests pass without modification
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The "Current state" excerpts don't match the live code.
- The CLI host has no existing test file to extend AND standing one up requires new server-boot scaffolding beyond what other CLI tests already do — report instead of building a harness.
- The Vite host's behaviour cannot be kept identical through the helper without widening its signature past `(fileName, stamp, ifNoneMatch)` + policies — report the shape mismatch.

## Maintenance notes

- Any future studio host (e.g. a cloud host) must use this helper — that's the point.
- Reviewer: confirm the 304 path still ends the response without a body and that the document route can never emit an ETag (a cached 304 for a token-bearing document would be its own bug).
