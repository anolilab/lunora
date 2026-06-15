# Implementation Plans

Cloudflare platform-coverage gap analysis, generated 2026-06-15 (baseline commit
`058071c8`). Each plan answers one question: **does lunora support a given
Cloudflare product/binding, and if not, what would first-class support look
like?** Every plan is independent — pick any one and execute it as its own
PR(s); none blocks another except where a "Depends on" row says so.

The 14 completed plans (027–032, 034, 035, 038–043) have shipped and been
removed from this directory. Only the deferred plans remain below.

Status values: TODO | IN PROGRESS | DONE | BLOCKED (one-line reason) | REJECTED.

## Plan index

| Plan | Cloudflare product        | Shape                                  | Pkg                  | Pri | Eff | Status              |
| ---- | ------------------------- | -------------------------------------- | -------------------- | --- | --- | ------------------- |
| 033  | Stream (video)            | `@lunora/stream` (REST + signed URLs)  | new `@lunora/stream` | P3  | M-L | TODO (P3, deferred) |
| 036  | Pipelines                 | hint-binding + `ctx` send helper       | config/storage       | P3  | S   | TODO (P3, deferred) |
| 037  | Realtime / Calls (WebRTC) | optional TURN/SFU helper (out-of-core) | —                    | P3  | S   | TODO (P3, deferred) |

## How these were derived

Audit of lunora's binding/feature coverage (the `@lunora/*` packages plus the
binding inference in `packages/config/src/{wrangler-validator,infer-bindings,reconcile-bindings,remote-bindings}.ts`)
against the full Cloudflare developer-platform surface. Already first-class and
**not** in this list: Durable Objects, D1, R2 (`@lunora/storage`), Vectorize
(`@lunora/vectors`), Workers AI (`@lunora/ai`), Queues + Cron (`@lunora/scheduler`),
Containers (`@lunora/container`), Workflows (`@lunora/workflow`).

## Remaining plans

All three are **P3, deferred** with documented revisit triggers:

- **033 Stream** — a clear product package (`@lunora/stream`, REST + signed URLs),
  deferred on priority rather than design risk.
- **036 Pipelines** — config/storage hint-binding plus a `ctx` send helper.
- **037 Realtime / Calls (WebRTC)** — an optional, out-of-core TURN/SFU helper;
  a non-goal for the core until a concrete use case lands.

## Notes for executors

- `dist/` is gitignored and built on demand. Before a package's `test`/`lint:types`,
  build deps once: `pnpm run build:packages` (or `pnpm --filter "@lunora/<pkg>..." run build`,
  trailing `...` includes deps), or use `pnpm run test:affected` / `pnpm run lint:affected:types`.
- ESM with `moduleResolution: "bundler"` — **no `.js` extensions** in relative
  imports (sole exception: `@lunora/codegen`'s emitted `_generated/*` output).
- Never mix a default export with named exports; named-only when a file has >1 export.
- Shared dep versions come from pnpm catalogs (`catalog:*`) — never hardcode a version.
- New packages mirror `packages/storage/` shape (conditional exports, `project.json`
  tags, packem/vitest/.releaserc, FSL-1.1-Apache-2.0 license).
- **workerd can't run in this sandbox** — prefer plain-Node unit tests; gate
  `@cloudflare/vitest-pool-workers` / puppeteer / live-API tests as CI-only.
- Non-deterministic I/O (browser, images, external SQL, analytics writes) belongs
  on **ActionCtx**, never query/mutation — see the `nondeterministic_query_mutation`
  advisor rule.
- When an item lands, tick its checkbox in the plan and update the Status cell above.
