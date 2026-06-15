# Plan 032: Cloudflare Images transformations (`@lunora/images`)

> **Executor instructions**: Follow step by step. Run every verification command and confirm before moving on. On a "STOP conditions" item, stop and report. When done, tick checkboxes and update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 058071c8..HEAD -- packages/storage/src packages/ai/src packages/config/src/infer-bindings.ts packages/config/src/reconcile-bindings.ts packages/config/src/wrangler-validator.ts packages/codegen/src/emit.ts packages/codegen/src/discover-feature-usage.ts`. If the storage template, the config binding seam, or `emitAiFragments`/`PROBES` differ from what this plan cites, STOP and re-read.

## Status

- **Priority**: P1 (highest of the three media plans — Images pairs directly with the already-shipped `@lunora/storage`/R2 source path, so resize/format/optimize on upload-and-serve is the most common real need; binding-backed so it's also the cleanest to wire)
- **Effort**: M
- **Risk**: LOW-MEDIUM (the `images` binding transform pipeline is new surface; the URL-based variant + delivery is just signed-URL building we already do in storage)
- **Depends on**: shares the config-layer binding seam with Plan 031 (do either first; the second reuses the validator/infer/reconcile pattern). The R2-source ergonomics lean on `@lunora/storage` but do not require code changes there.
- **Category**: feature (new Cloudflare binding/product support — Images)
- **Planned at**: commit `HEAD` (058071c8), 2026-06-15

## Verdict

Build a standalone **`@lunora/images`** package, not a `@lunora/storage/images` subpath. **Weighed both**: a subpath would co-locate it with the R2 source (Images' most natural input) and avoid a new package, BUT (1) the `images` binding (`env.IMAGES.input(stream).transform({...}).output({...})`) is a **distinct Cloudflare product with its own binding** — folding it into storage muddies storage's single responsibility and forces every `@lunora/storage` consumer to carry the Images surface; (2) the package convention here is one `@lunora/*` per binding (`ai`, `vectors`, `storage`); (3) the URL-transform + signed-delivery variant has nothing to do with R2. So: **standalone package**, with first-class R2 ergonomics (accept an `R2ObjectBodyLike` / `ReadableStream` straight from `ctx.storage.download(...)` as transform input). The binding-backed `transform`/`output` path is **non-deterministic I/O → ActionCtx only** (same seam as `ctx.ai`, `emit.ts:765-767`); the pure **URL-building / signed-delivery** helpers are deterministic and may be exported as plain functions usable anywhere (they mint a string, they don't do I/O — mirror `buildSignedUrl` in `packages/storage/src/signed-url.ts`).

## Current state

- **No images package exists** (`ls packages/` has no `images/`). No `IMAGES` binding handling: `packages/config/src/infer-bindings.ts:164-186` knows only `auth|scheduler|storage|ai|payment`; `reconcile-bindings.ts` has no `images` writer; `wrangler-validator.ts`'s `WranglerConfig` (lines 65-83) has no `images` field.
- **Template = `packages/storage/`** (read fully): `create-storage.ts` for the factory + helper-object shape, `signed-url.ts` for the **HMAC-SHA256 signed-URL approach** (this is the direct model for signed Images-delivery URLs — `importHmacKey` memoization at lines 55-69, `canonicalize`, the `MAX_EXPIRES_IN_SECONDS` ceiling, `toBase64Url`, and `verifySignedUrl` returning `{ valid, reason? }` without leaking a signing oracle, lines 151-246), `types.ts` for structural `...Like` bindings + test doubles, `package.json`/`project.json` for the package shape (`category:add-on`, FSL-1.1-Apache-2.0).
- **ctx-augmentation seam**: `emitAiFragments` in `packages/codegen/src/emit.ts:1248-1296`, the `ActionCtx extends Omit<...>` interface at `emit.ts:864`, and feature detection in `packages/codegen/src/discover-feature-usage.ts:50-58` (`PROBES`). `ctx.ai` is the precedent: ActionCtx-only because it's non-deterministic (`emit.ts:765-767` comment: "like `ctx.fetch` — it lives on ActionCtx only").
- **Determinism contract**: `packages/advisor/src/lints/static/nondeterministic-query-mutation.ts` — a binding-backed image transform is network/compute I/O, so it belongs in an action; the URL-building helpers are pure and exempt.
- **Missing**: the package, the `images` binding in the config layer, and `ctx.images` codegen wiring on ActionCtx.

## Item breakdown

- [x] **Item 1: scaffold `@lunora/images` package skeleton** (own PR)
    - `vis generate lunora-package --name=images --description='Cloudflare Images for Lunora: ctx.images transforms (resize/format/optimize) and signed delivery URLs'`, then conform to the storage template.
    - Files: `packages/images/package.json` (clone `packages/storage/package.json`; FSL-1.1-Apache-2.0, `type:module`, `sideEffects:false`, catalog deps, `exports` `"."` + `"./package.json"`; keywords `lunora`/`cloudflare`/`images`/`transform`/`signed-url`); `packages/images/project.json` (`{ "name": "images", "tags": ["type:package", "category:add-on"] }`); `tsconfig.json` (extends base), `vitest.config.ts`, `.releaserc.json`, `README.md`, `LICENSE.md`.
    - **Test**: `pnpm --filter "@lunora/images" run lint:types` passes on an empty `src/index.ts`.

- [x] **Item 2: `createImages` factory + binding transform pipeline** (own PR)
    - `packages/images/src/types.ts`: `ImagesBindingLike` — structural projection of `env.IMAGES` exposing `input(stream) -> { transform(opts) -> { output(opts) -> Promise<ImageTransformationResult> } }` (declare only the chain we call, so a unit test passes a plain double — mirror `R2BucketLike`, `packages/storage/src/types.ts:13-45`). `TransformOptions` (`{ width?, height?, fit?, rotate?, blur?, ... }`), `OutputOptions` (`{ format?: "image/webp"|"image/avif"|"image/jpeg"|"image/png"|"json", quality? }`), `LunoraImagesOptions` (`{ binding: ImagesBindingLike; deliveryBaseUrl?: string; signingSecret?: string }` — the last two power the URL helpers), and the `Images` interface.
    - `packages/images/src/create-images.ts`: `export const createImages = (options: LunoraImagesOptions): Images => { ... }`. Methods: `transform(input, transformOpts, outputOpts)` where `input` accepts a `ReadableStream | ArrayBuffer | Blob | R2ObjectBodyLike` (when given an R2 body, pull `.body` — first-class `ctx.storage.download(...)` ergonomics) and runs `binding.input(stream).transform(t).output(o)`; `info(input)` for dimension/format probing. Validate output format against an allowlist; clamp width/height to sane ceilings so a hostile request can't request a multi-gigapixel canvas.
    - `packages/images/src/index.ts`: **named-only** exports, no `.js` extensions.
    - **Test**: `packages/images/src/__tests__/create-images.test.ts` — plain-Node. Fake `ImagesBindingLike` whose `input().transform().output()` records the options it received; assert `transform()` threads width/height/format through, accepts an `R2ObjectBodyLike` (reads `.body`), and rejects a disallowed output format. **CI-only** (`skipIf(!process.env.CI)`) for anything needing the real `env.IMAGES` worker pool — workerd doesn't run here.

- [x] **Item 3: URL-based transform + signed delivery helpers** (own PR)
    - `packages/images/src/delivery-url.ts`: `buildImageDeliveryUrl({ baseUrl, key|imageId, transform, variant? })` — the **URL-based transform variant** (`/cdn-cgi/image/<options>/<source>` form, or the Images-delivery `…/<variant>` form) as a **pure string builder**. Mirror `packages/storage/src/signed-url.ts:109-149` structure.
    - `packages/images/src/signed-delivery-url.ts`: `buildSignedImageUrl` + `verifySignedImageUrl` — HMAC-SHA256 signed delivery URLs that resolve back through the Worker (app-gated delivery), copied in spirit from `signed-url.ts`: reuse the memoized `importHmacKey` pattern (lines 55-69), the `MAX_EXPIRES_IN_SECONDS` 7-day ceiling, `toBase64Url`/`fromBase64Url`, host-bound canonical, and a `verify` that returns `{ valid, reason? }` **without leaking a precise reason to clients** (the signing-oracle note at `signed-url.ts:157-162`). These are deterministic → safe to export as free functions and use anywhere.
    - Export all from `index.ts` (named-only).
    - **Test**: `packages/images/src/__tests__/signed-delivery-url.test.ts` — round-trip `buildSignedImageUrl` → `verifySignedImageUrl` (valid), tamper the key/transform → `bad_signature`, expire → `expired`, malformed → `malformed`. Pure WebCrypto, runs in plain Node (storage's signed-url tests are the precedent). Assert the URL-builder produces the documented `/cdn-cgi/image/...` path.

- [x] **Item 4: recognize the `images` binding in the config layer** (own PR)
    - `packages/config/src/wrangler-validator.ts`: add `images?: { binding?: string }` to `WranglerConfig` (lines 65-83) + a `validateImagesBinding` (if present, non-empty `binding`) wired into `validateWranglerConfig` near line 397.
    - `packages/config/src/infer-bindings.ts`: extend `Capabilities`/`NO_CAPABILITIES`/`mergeCapabilities` with `usesImages`, add the `@lunora/images` arm to `capabilityForImportSource` (mirror `@lunora/ai`, lines 177-179), surface `usesImages` on `InferredBindings`, push a signal.
    - `packages/config/src/reconcile-bindings.ts`: add `reconcileImages` mirroring the AI writer (lines 274-283) — idempotent `applyModify(text, ["images"], { binding: "IMAGES" })` keyed on `parsed.images?.binding`. Add `images?: { binding?: string }` to `WranglerShape` (line 57).
    - **Test**: extend config `__tests__` — `@lunora/images` import flips `usesImages`; reconcile adds `{ "images": { "binding": "IMAGES" } }` once and is idempotent; validator accepts a good block, flags an empty one.

- [x] **Item 5: wire `ctx.images` onto ActionCtx via codegen** (own PR)
    - `packages/codegen/src/discover-feature-usage.ts`: add `images` to `FeatureUsage` (lines 24-39) + `images: { contextProperty: "images", moduleSpecifier: "@lunora/images" }` to `PROBES` (lines 50-58).
    - `packages/codegen/src/emit.ts`: add `emitImagesFragments(hasImages)` mirroring `emitAiFragments` (lines 1248-1296) — `build` (`const images = imagesBinding ? createImages({ binding: imagesBinding }) : imagesStub`), `configField`, `contextField` (`images,`), throwing `imagesStub`. Add `images` to the generated `ActionCtx` interface + import block (alongside `ai`, `emit.ts:864`). **Gate on `hasImages`** so non-Images apps never import `@lunora/images`. Do **not** add `images` to `QueryCtx`/`MutationCtx` — the binding transform is non-deterministic I/O. (The pure URL helpers from Item 3 are imported directly by handlers as needed, not wired onto ctx.)
    - **Test**: extend codegen emit/golden tests — a project importing `@lunora/images` emits `ctx.images` on `ActionCtx` (+ stub/build), one that doesn't emits neither import nor field. Keep `.js` extensions in emitted golden output (codegen exception).

- [x] **Item 6: docs — R2 pairing + determinism note** (own PR, small)
    - `packages/images/README.md`: show the upload→transform→serve flow piping `ctx.storage.download(key)` into `ctx.images.transform(...)`; document the URL-based variant and signed delivery; state explicitly that `ctx.images` (binding transform) is **action-only** and why (non-deterministic compute/network), citing `packages/advisor/src/lints/static/nondeterministic-query-mutation.ts`, while the URL/signed-URL helpers are pure and usable anywhere.
    - **Test**: none (docs).

## Verification

```bash
pnpm --filter "@lunora/images..." run build
pnpm --filter "@lunora/images" run lint:types
pnpm --filter "@lunora/images" run test
pnpm --filter "@lunora/config" run test                # Item 4
pnpm --filter "@lunora/codegen" run test               # Item 5
pnpm --filter "@lunora/images" run lint:eslint
```

Never run the vis `pnpm run test` aggregate in this sandbox (MEMORY: vis-run-test-corrupts-tree).

## STOP conditions

- If `validateWranglerConfig`/`capabilityForImportSource`/the AI reconcile writer have drifted from the cited line ranges, STOP and re-read before editing the config layer.
- If `emitAiFragments`/`PROBES`/the `ActionCtx extends Omit<...>` line no longer match `emit.ts`/`discover-feature-usage.ts`, STOP — the ctx seam moved.
- If the real Cloudflare `env.IMAGES.input().transform().output()` chain signature differs from what `ImagesBindingLike` projects (verify against current `@cloudflare/workers-types`), STOP and reconcile the structural type before writing `create-images.ts`.
- If any test requires a live `env.IMAGES` / workerd pool to pass, STOP and convert to a plain-Node double or `skipIf(!process.env.CI)` — workerd doesn't run in this sandbox.
