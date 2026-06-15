# Plan 041: Smart Placement

> **Executor instructions**: Follow step by step. Run every verification command and confirm before moving on. On a "STOP conditions" item, stop and report. When done, tick checkboxes and update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 388a6423..HEAD -- packages/config/src/wrangler-validator.ts`. Confirm `WranglerConfig` (`:65-83`) still has no `placement` key. On mismatch, STOP.

## Status

- **Priority**: P3 — a one-line config flag with marginal benefit for the typical Cirrus app (see Verdict); pure ergonomics/typo-safety.
- **Effort**: S (smallest plan here — one validator item).
- **Risk**: LOW — validation only; no runtime change.
- **Depends on**: none
- **Category**: config-flag + doc note
- **Planned at**: commit `HEAD`, 2026-06-15

## Verdict

**Trivial to support; honestly close to a no-op for Cirrus's default topology — support it for typo-safety + a doc caveat, nothing more.** Smart Placement is just `"placement": { "mode": "smart" }` in `wrangler.jsonc`. It moves the _Worker_ invocation closer to a back-of-worker resource (a far-away origin DB, an upstream API) when the Worker makes lots of sequential calls to it. **But Cirrus's data lives in Durable Objects / D1**, which are themselves location-aware and already accessed via fast intra-Cloudflare RPC — so Smart Placement frequently does _nothing measurable_ for a DO-centric app and can even hurt latency for globally-distributed users (it pins invocation near one resource). It earns its keep only when an app's hot path is dominated by calls to an external, geographically-fixed origin (e.g. a self-hosted Postgres in one region). So: make the validator recognize the key (so a typo'd `"mode": "smrat"` is caught), add a short "when this helps / when it's a no-op" doc note, and stop.

## Current state

- `packages/config/src/wrangler-validator.ts` `WranglerConfig` interface (`:65-83`) does **not** include `placement`. As with `logpush`, the validator is allowlist-by-omission — an unknown `placement` key is silently ignored, so a malformed `mode` value (or a typo) gets no warning from Cirrus and is silently dropped by wrangler.
- No `placement` handling anywhere else: `grep -rn "placement" packages/config/src packages/vite/src packages/cli/src` → nothing.
- `reconcile-bindings.ts` only reconciles bindings (DOs, migrations, containers, workflows, D1) — placement is not a binding, so it has no place there and should not be added to it.

What's missing: `placement` is not a typed/validated key, and there's no guidance on when Smart Placement actually helps a Cirrus app.

## Item breakdown

- [x] **Item 1: Recognize and shape-check `placement` in the validator (the whole plan).**
    - In `packages/config/src/wrangler-validator.ts`, add to `WranglerConfig` (`:65-83`, alphabetical): `placement?: { mode?: string };`.
    - Add `validatePlacement(wrangler, errors)` (mirror `validateTailConsumers`'s shape): if `wrangler.placement !== undefined`, require it to be an object; if `placement.mode` is present, require it to be the string `"smart"` (the only documented value today) and otherwise push `'placement.mode must be "smart" (the only supported Smart Placement mode)'`. Call it alongside the other `validate*` calls (`:395-398`).
    - Tests in `packages/config/__tests__/` (mirror existing validator tests): `{ placement: { mode: "smart" } }` → valid; `{ placement: { mode: "fast" } }` → one error; `{ placement: "smart" }` (wrong shape) → one error; absent → no error. Plain-Node Vitest; no workerd.
    - Add a short doc note (1 paragraph) where wrangler/deploy config is documented: Smart Placement helps only when the hot path is dominated by calls to a fixed far-away _external_ origin; for DO/D1-centric Cirrus apps it is usually a no-op and can raise latency for geo-distributed users — leave it off unless a profile shows otherwise.

## Verification

- `pnpm --filter "@cirrus/config" run build`
- `pnpm --filter "@cirrus/config" run test`
- `pnpm --filter "@cirrus/config" run lint:types`
- `pnpm --filter "@cirrus/config" run lint:eslint`

## STOP conditions

- If you start auto-injecting `placement` into `wrangler.jsonc` (reconcile/scaffold), STOP — Cirrus cannot know whether an app benefits, and pinning placement by default would regress geo-distributed latency. It must stay an explicit opt-in.
- If the validator change grows past a small shape/value check, STOP — this is a one-flag plan.
