# Plan 381: Rate `ctx.images` in the platform capability matrix so non-Cloudflare targets get a diagnostic instead of a runtime failure

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/platform/src/capabilities.ts packages/codegen/src/platform-target.ts packages/codegen/src/capabilities.ts`
> On any drift, compare the "Current state" excerpts against live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug / security (fail-open surface)
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`ctx.images` is wired off a Cloudflare Images **binding** (`env.IMAGES`): every method in `packages/bindings/src/images/create-images.ts` calls `binding.info(...)`/`binding.input(...)`; there is no HTTP/credentials fallback. Yet `CAPABILITY_TO_FEATURE` in codegen deliberately leaves `images` unmapped, lumping it with credential-based add-ons (flags, r2sql, x402) under "app-level add-on with no platform-portability meaning — never gated, always emitted, on every target". That rationale fits the credential-based surfaces (they work anywhere fetch works) but **mis-classifies images**: on `target: node` codegen emits `ctx.images` types and wiring with no diagnostic, and the app fails at runtime with a missing-binding error — the exact fail-open the `platform_unsupported_feature` gate was built to prevent, and the same class as the two contracts CLAUDE.md records as having shipped wrong. The equally-binding-based `browser` and `vectors` ARE gated and rated.

## Platform parity (mandatory section)

| Feature | cloudflare | node |
|---------|-----------|------|
| `images` | `native` (Images binding) | `unsupported` (no binding; codegen omits the surface and emits `platform_unsupported_feature`) |

If other target matrices exist in `packages/platform/src/capabilities.ts` (grep `_CAPABILITIES` — e.g. a celld matrix), rate `images` there too: `unsupported` unless the host demonstrably provides an Images binding.

## Current state

- `packages/codegen/src/capabilities.ts:139-146` — `images` is a first-class `CapabilityKey` (`contextProperty: "images"`, `moduleSpecifier: "@lunora/bindings/images"`, ActionCtx-only field off `env.IMAGES`).
- `packages/platform/src/capabilities.ts` — `PlatformCapabilities["features"]` keys today: `ai, analytics, browser, containers, hyperdrive, keyValueStore(...), mail, pipelines, queues, scheduler, secrets, workflows, ...` (grep to see all) — **no `images`**.
- `packages/codegen/src/platform-target.ts:148-190` — `CAPABILITY_TO_FEATURE` maps `ai, analytics, browser, container, hyperdrive, kv, mail, pipelines, scheduler, storage, vectors, workflows`; the long doc comment above it names "Cloudflare Images" in the never-gated list. That comment must be corrected: split the list into "credential-based (genuinely target-agnostic): flags, access, r2sql, payments, x402" and remove images from it, with a per-key sentence for `r2sql` (credential-based, deliberately unmapped) as the audit suggested.
- `packages/bindings/src/images/create-images.ts:146-163` — binding-only implementation (excerpt verified: `binding.info(toStream(input))`, `binding.input(toStream(input)).transform(...)`).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build     | `pnpm run build:packages` | exit 0 |
| Platform tests | `pnpm --filter "@lunora/platform" run test` | all pass |
| Codegen tests | `pnpm --filter "@lunora/codegen" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/platform" run lint:types && pnpm --filter "@lunora/codegen" run lint:types` | exit 0 |
| API gate  | `pnpm run api:check` | exit 0 after `pnpm run api:update` for the intentional `PlatformCapabilities.features.images` addition (update ONLY after a fresh `pnpm run build:packages` — a stale build writes a wrong snapshot) |

## Scope

**In scope**:
- `packages/platform/src/capabilities.ts` (feature key + every target matrix in the file)
- `packages/codegen/src/platform-target.ts` (`CAPABILITY_TO_FEATURE` + its doc comment)
- `packages/platform/__tests__/`, `packages/codegen/__tests__/` (matrix/gating tests)
- Golden fixtures under `packages/codegen/__fixtures__/` (or wherever `git grep -l platform_unsupported_feature packages/codegen` points) — ONLY if assertions change

**Out of scope**:
- `packages/bindings/src/images/**` — the implementation is correct; only the matrix is wrong.
- `platform-node`'s runtime — rating `unsupported` requires no host code.
- Any other unmapped capability (`flags`, `access`, `r2sql`, `x402`, payments) — deliberate, now documented per-key.

## Git workflow

- Branch: `improve/wave22-bindings` (shared with plans 382/383; commit per plan)
- Commit: `fix(platform): rate images in the capability matrix`

## Steps

### Step 1: Add the feature key and ratings

In `packages/platform/src/capabilities.ts`: add `images?: Capability;` to `PlatformCapabilities["features"]` (alphabetical position, matching the JSDoc style of the `browser` entry — one line saying what it is and what backs it). Rate it in `CLOUDFLARE_CAPABILITIES` (`native`) and `NODE_CAPABILITIES` (`unsupported`, with the one-line reason comment style used by node's `browser`/`vectorStore` entries), plus any other matrix in the file.

**Verify**: `pnpm --filter "@lunora/platform" run test` → all pass (there is a matrix-completeness test; if it enumerates features, it will catch a missed matrix).

### Step 2: Map it in codegen

In `packages/codegen/src/platform-target.ts`: add `images: "images"` to `CAPABILITY_TO_FEATURE` and rewrite the doc comment's never-gated list as described in "Current state" (images removed; credential-based keys kept with the binding-vs-credentials criterion stated; one added sentence for `r2sql`).

**Verify**: `pnpm --filter "@lunora/codegen" run lint:types` → exit 0.

### Step 3: Tests + fixtures

Find the existing gating test for a binding-based capability (`grep -rn "platform_unsupported_feature" packages/codegen/__tests__/` and follow how `browser` or `vectors` is asserted for the node target). Add the mirror case: an app using `ctx.images` targeting node gets the diagnostic and the surface omitted; targeting cloudflare it is emitted unchanged (golden fixtures should stay byte-identical for cloudflare — the audit expects `native` to be a no-op there).

If any golden fixture changes, regenerate per the repo's codegen-fixture process (see how `packages/codegen`'s fixture tests describe regeneration in their header comments) and inspect the diff — only node-target fixtures may change.

**Verify**: `pnpm --filter "@lunora/codegen" run test` → all pass, new case included.

### Step 4: API snapshot

`pnpm run build:packages && pnpm run api:update`; commit the `api-snapshots/platform.api.md` (and codegen's, if its surface shifted) diff — it should show only the `images` feature key.

**Verify**: `pnpm run api:check` → exit 0.

## Test plan

- 2 new codegen cases (node → diagnostic+omitted; cloudflare → emitted) modeled on the existing browser/vectors gating tests.
- Platform matrix tests keep passing with the new key rated in every matrix.

## Done criteria

- [ ] `grep -n "images" packages/platform/src/capabilities.ts` shows the key + one rating per matrix in the file
- [ ] `grep -n 'images: "images"' packages/codegen/src/platform-target.ts` → 1 match
- [ ] The `CAPABILITY_TO_FEATURE` doc comment no longer lists Cloudflare Images as never-gated
- [ ] All commands in the table exit 0
- [ ] No files outside the in-scope list modified

## STOP conditions

- Cloudflare-target golden fixtures change (they must not — `native` is emit-as-before; a diff there means the mapping touched the wrong path).
- A matrix-completeness test requires rating targets this plan has no basis to rate (report which target and stop).
- `@lunora/bindings/images` turns out to have a non-binding fallback path this plan's premise missed.

## Maintenance notes

- The corrected doc comment now states the criterion (binding-based → mapped/gated; credential-based → unmapped). Every future `ctx.*` addition picks a side explicitly — reviewers should enforce that in PRs, per CLAUDE.md's platform-parity rule.
