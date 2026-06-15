# Plan 033: Cloudflare Stream (video) (`@cirrus/stream`)

> **Executor instructions**: Follow step by step. Run every verification command and confirm before moving on. On a "STOP conditions" item, stop and report. When done, tick checkboxes and update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 058071c8..HEAD -- packages/storage/src packages/config/src/infer-bindings.ts packages/config/src/reconcile-bindings.ts packages/config/src/wrangler-validator.ts packages/codegen/src/emit.ts packages/codegen/src/discover-feature-usage.ts`. If the storage template (esp. `signed-url.ts`/`presigned-url.ts`) or the config/codegen seams differ from what this plan cites, STOP and re-read.

## Status

- **Priority**: P3 (lowest of the three — video upload/playback is a narrower need than Images/Browser, and Stream has **no Worker binding**, so it's pure REST-over-`fetch` + signed playback; explicitly deprioritized vs Plan 032)
- **Effort**: M-L (tus resumable upload is the bulk of the work; signed playback mirrors storage but the JWT/key-pair signing is a new crypto path)
- **Risk**: MEDIUM (no binding means everything is authenticated REST against the Cloudflare API + a tus client; the signed-playback-token path is a new RSA/Ed25519 JWT flow, not the HMAC we already have)
- **Depends on**: none (no config-layer binding to reconcile — see Verdict). Independent of Plans 031/032.
- **Category**: feature (new Cloudflare product support — Stream)
- **Planned at**: commit `HEAD` (058071c8), 2026-06-15

## Verdict

Build a standalone **`@cirrus/stream`** package that **mirrors how `@cirrus/storage` does signed URLs** (`packages/storage/src/signed-url.ts` + `presigned-url.ts`) but talks to the Cloudflare **Stream REST API** — there is **no runtime binding** for Stream (unlike Images/Browser), so nothing touches the config layer's wrangler validator/infer/reconcile. The surface is three parts: (1) **upload** (direct-creator-upload URL minting + **tus resumable upload** for large files), (2) **signed playback URLs / tokens** (mirroring storage's signed-URL gating intent — but Stream uses its own signing-key JWT, not our HMAC helper), (3) **management** (list/get/delete videos). All of it is **non-deterministic network I/O → ActionCtx only** (same seam as `ctx.ai`, `emit.ts:765-767`), with the exception of the pure token/URL builders, which are deterministic free functions. Credentials are a Cloudflare account id + API token + a Stream signing key — these live in `.dev.vars`/secrets (the config layer's `reconcile-bindings.ts` payment precedent at the doc-comment around line 143: "provider secret pair … lives in `.dev.vars` (not `wrangler.jsonc`)"), **not** in `wrangler.jsonc`.

## Current state

- **No stream package exists** (`ls packages/` has no `stream/`). Because Stream has no binding, there is intentionally **nothing to add** to `packages/config/src/{wrangler-validator,infer-bindings,reconcile-bindings}.ts` — contrast Plans 031/032 which do wire a binding. The only config-layer touchpoint is a `.dev.vars` reminder (the payment precedent).
- **Template = `packages/storage/`** (read fully):
    - `signed-url.ts` (lines 109-246) for the signed-URL **shape and security posture** — TTL ceiling, host-bound canonical, `verify` returning `{ valid, reason? }` without leaking a signing oracle (lines 157-162). Stream's signed playback **token** is a different algorithm (a JWT signed with a Stream signing key) but the same "mint short-lived, app-gated, fail-closed" discipline applies.
    - `presigned-url.ts` (lines 119-157) for the **WebCrypto-only, no-SDK** signing style (SigV4 there; for Stream we hand-roll the JWT with `crypto.subtle` the same way — no bundled `jsonwebtoken`).
    - `create-storage.ts` for the factory/helper-object shape and `validateKey`-style input guarding; `types.ts` for structural `...Like` doubles + `R2S3Credentials`-style credential interfaces (lines 119-153).
    - `package.json`/`project.json` for package shape (`category:add-on`, FSL-1.1-Apache-2.0, catalog deps, `exports`).
- **ctx-augmentation seam**: `emitAiFragments` (`packages/codegen/src/emit.ts:1248-1296`), `ActionCtx extends Omit<...>` (`emit.ts:864`), feature detection `PROBES` (`packages/codegen/src/discover-feature-usage.ts:50-58`). `ctx.ai` is ActionCtx-only because non-deterministic (`emit.ts:765-767`).
- **Determinism contract**: `packages/advisor/src/lints/static/nondeterministic-query-mutation.ts` — Stream REST calls are `fetch`-class I/O, so they belong in actions.
- **Missing**: the entire package + the `ctx.stream` codegen wiring on ActionCtx. (No config-layer work.)

## Item breakdown

- [ ] **Item 1: scaffold `@cirrus/stream` package skeleton** (own PR)
    - `vis generate cirrus-package --name=stream --description='Cloudflare Stream for Cirrus: ctx.stream video uploads (tus), signed playback URLs, and management'`, then conform to the storage template.
    - Files: `packages/stream/package.json` (clone `packages/storage/package.json`; FSL-1.1-Apache-2.0, `type:module`, `sideEffects:false`, catalog deps, `exports` `"."` + `"./package.json"`; keywords `cirrus`/`cloudflare`/`stream`/`video`/`tus`/`signed-url`); `packages/stream/project.json` (`{ "name": "stream", "tags": ["type:package", "category:add-on"] }`); `tsconfig.json`, `vitest.config.ts`, `.releaserc.json`, `README.md`, `LICENSE.md`.
    - **Test**: `pnpm --filter "@cirrus/stream" run lint:types` passes on empty `src/index.ts`.

- [ ] **Item 2: REST client + credential types** (own PR)
    - `packages/stream/src/types.ts`: `StreamCredentials` interface (`{ accountId: string; apiToken: string }`) modelled on `R2S3Credentials` (`packages/storage/src/types.ts:119-153`); `CirrusStreamOptions` (`{ credentials: StreamCredentials; fetch?: typeof fetch }` — inject `fetch` for deterministic tests, no live network); video shapes (`StreamVideo`, `UploadResult`).
    - `packages/stream/src/create-stream.ts`: `export const createStream = (options: CirrusStreamOptions): Stream => { ... }`. Methods: `list()`, `get(uid)`, `delete(uid)` — thin authenticated `fetch` wrappers over `https://api.cloudflare.com/client/v4/accounts/<id>/stream...`. Surface a clear error on a non-2xx (don't swallow Cloudflare's `errors[]`). Use the injected `fetch`.
    - `packages/stream/src/index.ts`: named-only exports, no `.js` extensions.
    - **Test**: `packages/stream/src/__tests__/create-stream.test.ts` — plain-Node. Inject a fake `fetch` returning canned Cloudflare envelopes; assert `list`/`get`/`delete` hit the right URL with the `Authorization: Bearer` header, parse the `result`, and throw a directed error on `{ success: false, errors: [...] }`. No live network, runs in Node.

- [ ] **Item 3: direct-creator-upload URL + tus resumable upload** (own PR)
    - `packages/stream/src/upload.ts`: `createDirectUpload(opts)` — POST to the Stream `direct_upload` endpoint and return the one-time upload URL + `uid` (the client-side upload path; the most common pattern). `uploadResumable(stream, opts)` — a minimal **tus** client (tus 1.0.0 `POST`-create then chunked `PATCH` with `Upload-Offset`, honoring `Tus-Resumable`/`Location`) for large server-side uploads; keep it dependency-free over the injected `fetch` (don't pull a heavy `tus-js-client` peer dep unless tus-from-scratch proves unreasonable — if it does, STOP and report the trade-off).
    - **Test**: `packages/stream/src/__tests__/upload.test.ts` — plain-Node. Fake `fetch` that simulates the tus handshake (returns `Location` + advancing `Upload-Offset`); assert the client creates the upload, PATCHes chunks at the right offsets, and resolves with the `uid`. Assert `createDirectUpload` returns the upload URL from the canned envelope. **Mark any test needing the live Stream API as CI-only** (`skipIf(!process.env.CI)`); default tests use the `fetch` double.

- [ ] **Item 4: signed playback URLs / tokens** (own PR)
    - `packages/stream/src/signed-playback.ts`: `buildSignedPlaybackToken({ uid, signingKey, expiresInSeconds, ... })` and `buildSignedPlaybackUrl(...)` — a **JWT signed with a Stream signing key** via `crypto.subtle` (no `jsonwebtoken` dependency), hand-rolled exactly like `presigned-url.ts` hand-rolls SigV4 with WebCrypto (`packages/storage/src/presigned-url.ts:68-83`). Enforce a TTL ceiling and reject a non-finite/non-positive expiry, mirroring `buildSignedUrl`'s guards (`signed-url.ts:122-128`). These are **pure/deterministic** (a token mint, no I/O) → free functions, safe to use anywhere.
    - Export from `index.ts` (named-only).
    - **Test**: `packages/stream/src/__tests__/signed-playback.test.ts` — plain-Node WebCrypto. Mint a token, decode the JWT header/payload, assert `sub`/`exp`/`kid` are set and `exp` respects the ceiling; assert a non-finite expiry throws (mirrors storage's signed-url guard tests). If verifying the signature in-test, import the public half of a fixed test key pair via `crypto.subtle`.

- [ ] **Item 5: wire `ctx.stream` onto ActionCtx via codegen** (own PR)
    - `packages/codegen/src/discover-feature-usage.ts`: add `stream` to `FeatureUsage` (lines 24-39) + `stream: { contextProperty: "stream", moduleSpecifier: "@cirrus/stream" }` to `PROBES` (lines 50-58).
    - `packages/codegen/src/emit.ts`: add `emitStreamFragments(hasStream)` mirroring `emitAiFragments` (lines 1248-1296). **Difference from Plans 031/032**: there is no binding — `build` resolves credentials from env/secrets (`const stream = createStream({ credentials: { accountId: env.CF_ACCOUNT_ID, apiToken: env.STREAM_API_TOKEN } })`) guarded by a `streamStub` that throws a directed "set CF_ACCOUNT_ID/STREAM_API_TOKEN in .dev.vars" error when the secrets are absent (model the directed message on the AI stub at `emit.ts:1257`). Add `stream` to the `ActionCtx` interface + import block (`emit.ts:864`); **gate on `hasStream`**; do **not** add it to `QueryCtx`/`MutationCtx`.
    - **Test**: extend codegen emit/golden tests — a project importing `@cirrus/stream` emits `ctx.stream` on `ActionCtx` (+ stub/build reading the secret env vars); one that doesn't emits neither import nor field. Keep `.js` extensions in emitted golden output (codegen exception).

- [ ] **Item 6: docs + `.dev.vars` reminder** (own PR, small)
    - `packages/stream/README.md`: document that Stream has **no binding** (credentials go in `.dev.vars`/secrets: `CF_ACCOUNT_ID`, `STREAM_API_TOKEN`, and a Stream signing key for playback); show the upload (direct-creator + tus) and signed-playback flows; state that `ctx.stream` is **action-only** and why (REST `fetch` I/O is non-deterministic), citing `packages/advisor/src/lints/static/nondeterministic-query-mutation.ts`; note the signed-token builders are pure and usable anywhere.
    - Optionally surface the `.dev.vars` reminder through the existing config-layer secrets-scaffolder if it has a registration point (check `packages/config/src/` `.dev.vars` grammar/auto-scaffolder) — but only if it's a clean extension; otherwise leave it as README guidance (no binding reconcile is in scope).
    - **Test**: none (docs).

## Verification

```bash
pnpm --filter "@cirrus/stream..." run build
pnpm --filter "@cirrus/stream" run lint:types
pnpm --filter "@cirrus/stream" run test
pnpm --filter "@cirrus/codegen" run test               # Item 5
pnpm --filter "@cirrus/stream" run lint:eslint
```

No config-layer test is needed (no binding). Never run the vis `pnpm run test` aggregate in this sandbox (MEMORY: vis-run-test-corrupts-tree).

## STOP conditions

- If `emitAiFragments`/`PROBES`/the `ActionCtx extends Omit<...>` line have drifted from `emit.ts`/`discover-feature-usage.ts` as cited, STOP — the ctx seam moved.
- If hand-rolling a tus 1.0.0 client over `fetch` proves unreasonable, STOP and report the trade-off (a `tus-js-client` peer dep) rather than shipping a half-correct resumable-upload path.
- If the Stream signed-playback JWT requires an algorithm `crypto.subtle` can't do with the available key material (e.g. a key format mismatch), STOP and report before adding a JWT-library dependency.
- If any test requires the live Cloudflare Stream API to pass, STOP and convert it to a `fetch` double or `skipIf(!process.env.CI)` — no live network in this sandbox.
- If, contrary to this plan, current `@cloudflare/workers-types` shows a real Stream **binding** exists, STOP — the no-binding assumption (and the "no config-layer work" scope) would be wrong.
