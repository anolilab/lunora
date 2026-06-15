# Plan 031: Browser Rendering (`@cirrus/browser`)

> **Executor instructions**: Follow step by step. Run every verification command and confirm before moving on. On a "STOP conditions" item, stop and report. When done, tick checkboxes and update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 058071c8..HEAD -- packages/storage/src packages/ai/src packages/config/src/infer-bindings.ts packages/config/src/reconcile-bindings.ts packages/config/src/wrangler-validator.ts packages/codegen/src/emit.ts packages/codegen/src/discover-feature-usage.ts`. If any of those files changed shape from what this plan cites (function names, the `PROBES` map, `emitAiFragments`, `capabilityForImportSource`), STOP and re-read before proceeding.

## Status

- **Priority**: P2 (a real Cloudflare product with no Cirrus surface today; screenshots/PDF/scrape are common app needs, but strictly action-only I/O — not on the core read/write path, so it ships after Images)
- **Effort**: M
- **Risk**: LOW (thin wrapper over `@cloudflare/playwright`; no new signing/crypto, no DO state)
- **Depends on**: none (config-layer binding wiring is shared with Plan 032; do whichever lands first and the other reuses the seam)
- **Category**: feature (new Cloudflare binding/product support — Browser Rendering)
- **Planned at**: commit `HEAD` (058071c8), 2026-06-15

## Verdict

Build a standalone **`@cirrus/browser`** package mirroring `packages/storage/`. Browser Rendering is a fenced Worker binding (`env.BROWSER`) driven through `@cloudflare/playwright` (`launch(env.BROWSER)` (from `@cloudflare/playwright`)); it has no business living inside `@cirrus/storage`. The whole surface is **non-deterministic network I/O**, so the generated `ctx.browser` helper lands on **ActionCtx only** — never `QueryCtx`/`MutationCtx` — exactly like `ctx.ai` (see `packages/codegen/src/emit.ts:765-767`, "like `ctx.fetch` — it lives on ActionCtx only") and consistent with the determinism rule in `packages/advisor/src/lints/static/nondeterministic-query-mutation.ts`. Keep `@cloudflare/playwright` a **peerDependency** (it pulls a large bundled chromium-protocol shim; don't force it on apps that never screenshot).

## Current state

- **No browser package exists.** `ls packages/` has no `browser/`. There is no `BROWSER` binding handling anywhere: `packages/config/src/infer-bindings.ts:164-186` (`capabilityForImportSource`) maps `@cirrus/auth|scheduler|storage|ai|payment` only; `packages/config/src/reconcile-bindings.ts` adds `ai`/`d1`/`r2`/DO bindings but knows nothing of `browser`; `packages/config/src/wrangler-validator.ts`'s `WranglerConfig` (lines 65-83) has no `browser` field.
- **The template to mirror is `packages/storage/`** — read it fully: `create-storage.ts` (the factory + key validation + ActionCtx-shaped helper object), `index.ts` (named-only exports), `types.ts` (a structural `R2BucketLike` "...Like" projection so unit tests pass a plain double), `package.json` (FSL-1.1-Apache-2.0, `"type": "module"`, `"sideEffects": false`, catalog deps, `exports` with `./package.json`), `project.json` (`["type:package", "category:add-on"]`).
- **The ctx-augmentation seam** is `emitAiFragments(hasAi)` in `packages/codegen/src/emit.ts:1248-1296`: when the project uses AI, codegen weaves `build`/`configField`/`contextField`/`stub` fragments into the generated ShardDO and adds `ai` to the `ActionCtx` interface (`emit.ts:864`, `ActionCtx extends Omit<ActionCtxBase, "db" | "storage" ...>`). Feature detection is `packages/codegen/src/discover-feature-usage.ts:50-58` (`PROBES` record: `{ contextProperty, moduleSpecifier }`).
- **Missing**: the package, the `browser` binding in the config layer (validator + infer + reconcile), and the `ctx.browser` codegen wiring on ActionCtx.

## Item breakdown

- [x] **Item 1: scaffold `@cirrus/browser` package skeleton** (own PR)
    - `vis generate cirrus-package --name=browser --description='Cloudflare Browser Rendering for Cirrus: ctx.browser screenshots, PDF, and scraping in actions'` to get the workspace shell, then conform it to the storage template.
    - Files to create/conform: `packages/browser/package.json` (copy `packages/storage/package.json`; keep FSL-1.1-Apache-2.0, `type:module`, `sideEffects:false`, catalog deps `catalog:tsc`/`catalog:test`/`catalog:build`/`catalog:cloudflare`/`catalog:types`; add `@cloudflare/playwright` as a **peerDependency** + a `catalog:` devDependency for tests; keep the `exports` `"."` + `"./package.json"` block); `packages/browser/project.json` (`{ "name": "browser", "tags": ["type:package", "category:add-on"] }`); `packages/browser/tsconfig.json` (extend `../../tsconfig.base.json` like storage); `packages/browser/vitest.config.ts`; `packages/browser/.releaserc.json` (extends `@anolilab/semantic-release-preset/pnpm`); `packages/browser/README.md`; `packages/browser/LICENSE.md`.
    - **Test**: none yet — `pnpm --filter "@cirrus/browser" run lint:types` must pass on the empty `src/index.ts`.

- [x] **Item 2: `createBrowser` factory + structural binding type** (own PR)
    - `packages/browser/src/types.ts`: `BrowserBindingLike` — a structural projection of `env.BROWSER` (the `Fetcher` the binding actually is; declare just what `@cloudflare/playwright`'s `launch` needs so tests pass a plain double, exactly like `R2BucketLike` in `packages/storage/src/types.ts:13-45`). `CirrusBrowserOptions` (`{ binding: BrowserBindingLike; launch?: BrowserLaunchLike; timeoutMs?: number }` — inject the `launch` driver for tests instead of importing `@cloudflare/playwright` at module top). `Browser` interface: `screenshot(url, opts?)`, `pdf(url, opts?)`, `scrape(url, fn)` / `content(url)`, plus a low-level `launch()` escape hatch returning the raw Playwright `Browser`.
    - `packages/browser/src/create-browser.ts`: `export const createBrowser = (options: CirrusBrowserOptions): Browser => { ... }`. Each method `launch`es (or reuses a session), opens a page, `goto(url)`, performs the op, and **always closes the page/browser in a `finally`** (a leaked browser session is billed + rate-limited — this is the one real footgun). Validate `url` is an absolute `http(s)` URL up front (reuse the spirit of `validateKey` in `create-storage.ts:143-169` — reject non-string/empty/non-http). Hard-cap `screenshot`/`pdf` viewport + a `timeoutMs` so a hostile/hung page can't pin the worker.
    - `packages/browser/src/index.ts`: **named-only** exports — `export { createBrowser } from "./create-browser";` + `export type { Browser, BrowserBindingLike, CirrusBrowserOptions, ... } from "./types";`. No `.js` extensions. No mixed default+named.
    - **Test**: `packages/browser/src/__tests__/create-browser.test.ts` — plain-Node Vitest. Pass a fake `launch` whose call returns a stub `Browser` (stub `newPage`/`goto`/`screenshot`/`close`); assert `screenshot()` calls `goto` with the validated URL, returns the bytes, and **closes the page even when `goto` throws** (the finally path). Assert URL validation rejects `ftp://`/empty/`javascript:`. **Mark any test that needs a real `env.BROWSER` / workerd pool as CI-only** (`describe.skipIf(!process.env.CI)`) — workerd can't run in this sandbox (see MEMORY: workerd-sandbox-limit).

- [x] **Item 3: recognize the `browser` binding in the config layer** (own PR)
    - `packages/config/src/wrangler-validator.ts`: add `browser?: { binding?: string }` to `WranglerConfig` (lines 65-83) and a tiny `validateBrowserBinding` (optional, but if present must have a non-empty `binding`) called from `validateWranglerConfig` alongside `validateContainers`/`validateWorkflows` (line ~397). Export nothing new from the public surface beyond the existing report.
    - `packages/config/src/infer-bindings.ts`: extend `Capabilities` (line 141) + `NO_CAPABILITIES` + `mergeCapabilities` with `usesBrowser`, add the `@cirrus/browser` arm to `capabilityForImportSource` (mirror the `@cirrus/ai` arm at lines 177-179), surface `usesBrowser` on `InferredBindings` (near line 126), and push a signal string when set.
    - `packages/config/src/reconcile-bindings.ts`: add a `reconcileBrowser` writer mirroring the AI writer (`reconcile-bindings.ts:274-283` — idempotent `applyModify(text, ["browser"], { binding: "BROWSER" })` keyed on `parsed.browser?.binding` already present). Add `browser?: { binding?: string }` to `WranglerShape` (line 57).
    - **Test**: extend the existing config `__tests__` — assert (a) a `@cirrus/browser` import flips `usesBrowser`, (b) reconcile adds `{ "browser": { "binding": "BROWSER" } }` once and is idempotent on a second run, (c) the validator accepts a well-formed `browser` block and flags a `{}` one.

- [x] **Item 4: wire `ctx.browser` onto ActionCtx via codegen** (own PR)
    - `packages/codegen/src/discover-feature-usage.ts`: add `browser` to the `FeatureUsage` interface (lines 24-39) and a `browser: { contextProperty: "browser", moduleSpecifier: "@cirrus/browser" }` entry to `PROBES` (lines 50-58).
    - `packages/codegen/src/emit.ts`: add an `emitBrowserFragments(hasBrowser)` mirroring `emitAiFragments` (lines 1248-1296) — `build` (`const browser = browserBinding ? createBrowser({ binding: browserBinding }) : browserStub`), `configField` (`browser?: (env) => BrowserBindingLike`), `contextField` (`browser,`), and a throwing `browserStub`. Add `browser` to the generated `ActionCtx` interface and its import block (alongside `ai`, near `emit.ts:765-767` and `emit.ts:864`). **Gate strictly on `hasBrowser`** so a non-browser app never imports `@cirrus/browser` into its generated worker — same gating rationale as the AI comment at `emit.ts:765`. Do **not** add `browser` to `QueryCtx`/`MutationCtx`.
    - **Test**: extend codegen golden/emit tests — assert a project that imports `@cirrus/browser` emits `ctx.browser` on `ActionCtx` (and the stub + build fragments), and a project that does not emits **neither** the import nor the field. If golden fixtures use `.js` import extensions in emitted output, keep them — that is the one codegen exception (per AGENTS.md).

- [x] **Item 5: docs + advisor/determinism cross-reference** (own PR, small)
    - `packages/browser/README.md`: document that `ctx.browser` is **action-only** and why (non-deterministic network I/O; cite the determinism contract), show `launch(env.BROWSER)` (from `@cloudflare/playwright`) equivalence, and note `@cloudflare/playwright` is a peer dep to install.
    - Add a one-line note in the README pointing at the `nondeterministic_query_mutation` advisor (`packages/advisor/src/lints/static/nondeterministic-query-mutation.ts`) — a `ctx.browser` call in a query/mutation is the same class of mistake as `fetch`, and is structurally impossible because the type isn't on those ctxs.
    - **Test**: none (docs).

## Verification

```bash
pnpm --filter "@cirrus/browser..." run build           # builds deps then the package
pnpm --filter "@cirrus/browser" run lint:types
pnpm --filter "@cirrus/browser" run test
pnpm --filter "@cirrus/config" run test                # Item 3 binding wiring
pnpm --filter "@cirrus/codegen" run test               # Item 4 ctx augmentation
pnpm --filter "@cirrus/browser" run lint:eslint
```

Do not run the vis `pnpm run test` aggregate in this sandbox (MEMORY: vis-run-test-corrupts-tree) — use per-package `--filter`.

## STOP conditions

- If the config-layer files (`infer-bindings.ts` `capabilityForImportSource`, `reconcile-bindings.ts` AI writer, `wrangler-validator.ts` `WranglerConfig`) have drifted from the cited line ranges, STOP and re-read before editing.
- If `emitAiFragments` / the `PROBES` map / the `ActionCtx extends Omit<...>` line no longer match `packages/codegen/src/emit.ts` and `discover-feature-usage.ts` as cited, STOP — the ctx seam moved.
- If a test you write requires a live `env.BROWSER` or a workerd pool to pass, STOP and convert it to a plain-Node double (or `skipIf(!process.env.CI)`) — workerd does not run in this sandbox.
- If `@cloudflare/playwright` cannot be added as a peer dep via the catalog without a version conflict, STOP and report rather than hard-pinning.
