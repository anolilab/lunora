# Implementation Plans

Cloudflare platform-coverage gap analysis, generated 2026-06-15 (baseline commit
`058071c8`). Each plan answers one question: **does Lunora support a given
Cloudflare product/binding, and if not, what would first-class support look
like?** Every plan is independent — pick any one and execute it as its own
PR(s); none blocks another except where a "Depends on" row says so.

Status values: TODO | IN PROGRESS | DONE | BLOCKED (one-line reason) | REJECTED.

## Plan index

| Plan | Cloudflare product            | Shape                                   | Pkg                      | Pri | Eff | Status                     |
| ---- | ----------------------------- | --------------------------------------- | ------------------------ | --- | --- | -------------------------- |
| 027  | Workers KV                    | thin `@lunora/kv` + `ctx.kv`            | new `@lunora/kv`         | P2  | M   | DONE                       |
| 028  | Hyperdrive (Postgres/MySQL)   | `@lunora/hyperdrive` + `ctx.sql`        | new `@lunora/hyperdrive` | P2  | L   | DONE                       |
| 029  | Email Routing (inbound)       | `@lunora/mail/inbound` subpath          | mail                     | P2  | M   | DONE                       |
| 030  | Service Bindings              | config validate + typed env seam        | config (+codegen)        | P2  | M   | DONE                       |
| 031  | Browser Rendering             | `@lunora/browser` + `ctx.browser`       | new `@lunora/browser`    | P2  | M   | DONE (Playwright)          |
| 032  | Cloudflare Images             | `@lunora/images` + `ctx.images`         | new `@lunora/images`     | P1  | M   | DONE                       |
| 033  | Stream (video)                | `@lunora/stream` (REST + signed URLs)   | new `@lunora/stream`     | P3  | M-L | TODO (P3, deferred)        |
| 034  | Turnstile (CAPTCHA)           | `@lunora/auth` middleware + helper      | auth                     | P1  | S   | DONE                       |
| 035  | Analytics Engine              | `ctx.analytics` + Studio SQL read       | config/studio            | P1  | M   | DONE                       |
| 036  | Pipelines                     | hint-binding + `ctx` send helper        | config/storage           | P3  | S   | TODO (P3, deferred)        |
| 037  | Realtime / Calls (WebRTC)     | optional TURN/SFU helper (out-of-core)  | —                        | P3  | S   | TODO (P3, deferred)        |
| 038  | Pub/Sub (MQTT)                | defer until GA (non-goal w/ trigger)    | —                        | P3  | S   | DONE (non-goal documented) |
| 039  | Workers for Platforms         | validator passthrough only              | config                   | P3  | S   | DONE                       |
| 040  | Logpush                       | validator key + docs (Studio card live) | config                   | P2  | S   | DONE                       |
| 041  | Smart Placement               | validator typo-safety + doc note        | config                   | P3  | S   | DONE                       |
| 042  | mTLS client certificates      | validator passthrough only              | config                   | P3  | S   | DONE                       |
| 043  | Pages → Workers Static Assets | reject Pages; scope `assets` validator  | config                   | P3  | S   | DONE (Pages rejected)      |

## How these were derived

Audit of Lunora's binding/feature coverage (the `@lunora/*` packages plus the
binding inference in `packages/config/src/{wrangler-validator,infer-bindings,reconcile-bindings,remote-bindings}.ts`)
against the full Cloudflare developer-platform surface. Already first-class and
**not** in this list: Durable Objects, D1, R2 (`@lunora/storage`), Vectorize
(`@lunora/vectors`), Workers AI (`@lunora/ai`), Queues + Cron (`@lunora/scheduler`),
Containers (`@lunora/container`), Workflows (`@lunora/workflow`).

## Reading order by impact

- **Highest ROI / sharpest parity gaps** (a Cloudflare-native dev expects these to
  "just be there"): **027 KV**, **034 Turnstile**, **032 Images**, **035 Analytics
  Engine**, **029 Email Routing inbound**.
- **Strategic but heavier** (competes with / complicates the D1+DO core — read the
  Verdict's determinism/realtime risk note first): **028 Hyperdrive**.
- **Clear product packages**: **031 Browser Rendering**, **033 Stream**.
- **Config-layer hardening** (cheap, mostly validator coverage): **030 Service
  Bindings**, **040 Logpush**, **041 Smart Placement**, **042 mTLS**, **039
  Workers for Platforms**, **043 Static Assets**.
- **Deferred / non-goals** (documented with a revisit trigger): **037 Realtime/
  Calls**, **038 Pub/Sub**.

## Cross-cutting prerequisite

Plans 030/039/042 surface a shared finding: codegen emits **no typed
`Env`/`CloudflareBindings` interface** today (`env` flows as
`Record<string, unknown>` through `packages/codegen/src/emit.ts`). Any typed
`env.<BINDING>` access (service bindings, dispatch, mTLS) depends on first
introducing that env-augmentation seam — **Plan 030 owns it**; the niche plans
defer their optional typing to it rather than emitting competing `Env` types.

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
