# Plan 108: Add a `lunora add payment` registry item (and the pattern for heavy add-ons)

> **Executor instructions**: This is a scaffolding/feature plan with a concrete
> deliverable (a registry item). Follow step by step; run each verify. STOP
> conditions halt you. Update `plans/README.md` when done unless a reviewer owns it.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- registry examples/payment-demo`

## Status

- **Priority**: P2
- **Effort**: M (S–M for payment specifically; the demo is the source material)
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction (feature / DX)
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

`lunora add <item>` scaffolds a feature into a project from `registry/`. Today the
registry ships only thin/leaf items (auth + 3 OAuth variants, backup, crons,
mail, presence, ratelimit, storage). The **heaviest, highest-boilerplate**
packages — `payment`, `ai`, `workflow`, `queue`, `scheduler`, `container`,
`flags` — have **no** registry item, so users wire them by hand. Meanwhile
`examples/payment-demo/lunora/billing.ts` (79 lines) hand-rolls exactly the
payment surface a registry item exists to absorb: a Stripe checkout action,
metered `track`, entitlement `check`, subscription rows, and webhook wiring in
`createShardDO({ payment })`. Payment is the clearest friction-worth-productizing
case; shipping `lunora add payment` turns the demo into a one-command install and
sets the template for `ai`/`workflow` to follow.

## Current state

Registry layout — each item is a directory with `registry.json` + source files;
the index lists them. Existing items: `registry/{auth, auth-auth0, auth-clerk,
auth-magic-link, auth-otp, backup, crons, mail, presence, ratelimit, storage}`,
plus `registry/index.json`, `registry/schema/` (the item schema), and
`.d.ts`/tsconfig helpers.

The `storage` item manifest is the closest structural exemplar
(`registry/storage/registry.json`) — copy its shape:

```json
{
    "$schema": "../schema/registry-item.schema.json",
    "name": "storage",
    "title": "Storage",
    "description": "…",
    "docs": "… step-by-step wiring the user must do after add …",
    "requires": [],
    "deps": { "@lunora/storage": "workspace:*", "@lunora/server": "workspace:*", "@lunora/ratelimit": "workspace:*" },
    "bindings": [{ "path": ["r2_buckets"], "value": [{ "binding": "UPLOADS", "bucket_name": "replace-me-uploads" }] }],
    "envVars": [
        { "name": "STORAGE_SIGNING_SECRET", "description": "…", "secret": true },
        { "name": "STORAGE_PUBLIC_BASE_URL", "description": "…", "value": "http://localhost:8787/storage", "secret": false }
    ],
    "files": [{ "from": "storage.ts", "to": "lunora/storage/index.ts", "merge": "create-or-skip" }]
}
```

The source material — `examples/payment-demo/lunora/billing.ts` (read it in full;
79 lines) — contains the checkout action, metered `track`, entitlement `check`,
and the subscription schema usage. `examples/payment-demo` also wires payment in
its worker (`createShardDO({ payment })`) and its `wrangler.jsonc`/`.dev.vars`
(Stripe/Polar secrets) — read those to know the bindings + env the item must
scaffold.

`@lunora/payment` package role (from `CLAUDE.md`): provider-agnostic payments,
Stripe-first adapter, webhook sync, subscription/payment state machine,
entitlements, idempotency, money helpers; Polar adapter included.

Read the `add` command handler (grep `packages/cli/src` for `registry` /
`resolve.ts` — `packages/cli/src/commands/registry/resolve.ts` changed recently)
to learn exactly how `registry.json` fields (`deps`, `bindings`, `envVars`,
`files`, `requires`, `merge`) are consumed, so the new item is well-formed.

## Commands you will need

| Purpose              | Command                                             | Expected       |
| -------------------- | --------------------------------------------------- | -------------- |
| Validate item schema | inspect `registry/schema/registry-item.schema.json` | field contract |
| CLI test             | `pnpm --filter "@lunora/cli" run test`              | all pass       |
| CLI typecheck        | `pnpm --filter "@lunora/cli" run lint:types`        | exit 0         |

## Scope

**In scope**:

- New `registry/payment/` directory: `registry.json` + the scaffolded source
  file(s) (`payment.ts` → `lunora/payment/index.ts`, promoted/adapted from
  `examples/payment-demo/lunora/billing.ts`), plus a `README.md` if peers have one.
- `registry/index.json` — add the `payment` entry (match the existing entries'
  shape).
- If `lunora add` has a fixture/test list of known items, add `payment` there.

**Out of scope**:

- `ai` / `workflow` / `queue` / `scheduler` / `container` / `flags` items — this
  plan ships **payment** and establishes the pattern; the others are follow-ups
  noted in the index.
- Changing the `add` command's engine/behavior — the item must fit the existing
  contract. If it can't, STOP (see conditions).
- The `@lunora/payment` package source.

## Git workflow

- Branch: `advisor/108-registry-payment-item`
- Commit: `feat(registry): add payment item for lunora add`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Learn the item contract

Read `registry/schema/registry-item.schema.json` and
`packages/cli/src/commands/registry/resolve.ts` (+ the `add` handler). Note: how
`files[].merge` works (`create-or-skip` etc.), how `bindings[]` reconcile into
`wrangler.jsonc`, how `envVars[]` scaffold `.dev.vars` (secret vs value), and how
`deps` are added. Confirm the payment package's binding needs (does it need a KV/
DO binding? a webhook route?) by reading `examples/payment-demo`'s worker +
`wrangler.jsonc`.

**Verify**: you can list, from the schema, every field the new `registry.json`
must set. Note any binding/env the demo uses that the item must scaffold.

### Step 2: Author `registry/payment/payment.ts`

Promote `examples/payment-demo/lunora/billing.ts` into a general item source:
the checkout action, metered `track`, entitlement `check`, and the subscription
table wiring — generalized (no demo-specific hardcodes; use `replace-me` /
env-driven values like the storage item's `bucket_name: "replace-me-uploads"`).
Keep it provider-agnostic where the package allows (Stripe default; note Polar in
docs). Follow repo conventions: no `.js` extensions in imports, named exports,
`@lunora/*` imports (or `lunorash/*` if the item targets umbrella projects — check
what other items emit).

**Verify**: the file type-checks in isolation against the payment package's public
API (read `packages/payment/src/index.ts` exports to confirm the symbols used
exist).

### Step 3: Author `registry/payment/registry.json`

Mirror `storage`'s manifest:

- `deps`: `@lunora/payment`, `@lunora/server` (+ any the demo imports).
- `envVars`: the Stripe (and/or Polar) secrets the demo needs — mark `secret:
true`, with `openssl`-style generation hints where relevant; **never** put a
  real key value (the audit rule: reference credential type only).
- `bindings`: whatever `createShardDO({ payment })` + the webhook route require
  (read the demo's `wrangler.jsonc`).
- `files`: `[{ "from": "payment.ts", "to": "lunora/payment/index.ts", "merge":
"create-or-skip" }]`.
- `docs`: the post-add wiring steps (register the webhook route, set secrets, run
  codegen) — concrete, like storage's `docs`.

Add the `payment` entry to `registry/index.json`.

**Verify**: the manifest validates against `registry/schema/registry-item.schema.json`
(if there's a validation test/script, run it; else eyeball against the schema).
`pnpm --filter "@lunora/cli" run test` → all pass (the add command's item-list
tests, if any, include `payment`).

### Step 4: Dry-run `lunora add payment` if possible

If the environment allows, scaffold into a throwaway target and confirm the files
land, deps/bindings/envVars are proposed, and no error. If not runnable in the
sandbox, verify via the CLI's unit tests for `add`/`resolve` (add a case that
`payment` resolves to the expected files/deps).

**Verify**: `pnpm --filter "@lunora/cli" run test` → all pass.

## Test plan

- If `packages/cli/__tests__` has a registry/add test that enumerates items or
  resolves an item's files, add a `payment` case: it resolves to
  `lunora/payment/index.ts` with the expected deps + envVars.
- Validate the manifest against the item JSON schema (existing script or a small
  assertion).
- Verification: `pnpm --filter "@lunora/cli" run test` + `run lint:types` exit 0.

## Done criteria

- [ ] `registry/payment/{registry.json, payment.ts, README.md?}` exist and the manifest validates against the item schema.
- [ ] `registry/index.json` lists `payment`.
- [ ] `payment.ts` type-checks against `@lunora/payment`'s public API and follows repo conventions (no `.js` extensions, named exports).
- [ ] `pnpm --filter "@lunora/cli" run test` + `run lint:types` exit 0.
- [ ] No real secret values anywhere in the item (credential types/names only).
- [ ] `git status` shows only registry files (+ optional CLI test).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The `add` command contract can't express something payment needs (e.g. a
  webhook HTTP route that the item must register) without an engine change — STOP
  and report; scaffolding a partial item that leaves the user with a broken
  webhook is worse than none.
- `examples/payment-demo/lunora/billing.ts` uses a payment API that isn't in
  `@lunora/payment`'s public exports (i.e. it reaches into internals) — STOP;
  the item must use the public surface.
- Any real credential value would need to appear in the item to make it work —
  STOP; that's a security violation. Use `replace-me`/env references only.

## Maintenance notes

- This item is the template for `ai`, `workflow`, `queue`, `scheduler`,
  `container`, `flags` registry items (follow-ups). Keep the manifest shape
  consistent so the pattern is copyable.
- A reviewer should confirm the scaffolded `payment.ts` stays in sync with the
  `@lunora/payment` public API as it evolves — a registry item that drifts from
  the package is a silent breakage.
- If `examples/payment-demo` is updated, re-check that the item didn't fall behind.
