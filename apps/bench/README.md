# @lunora/bench

A realistic Lunora app for benchmarks and framework testing. It is private and
never published. Issue #1166 is the motivation: a real app with about 1,000
functions and 130 tables hit Cloudflare's 1 s startup CPU limit, and the
synthetic app in `scripts/check-worker-startup.js` does not look like it.

The app has two parts:

- **A hand-written core.** The SaaS kit, composed with `lunora registry add`, plus
  app code that reaches every server-side package that runs without credentials.
- **A deterministic generator.** It scales the app with "domain" modules shaped
  like the core, up to the profile of the app behind #1166.

## What is in the core

| Area                                                | Where                                                         | Package(s)                                             |
| --------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| Tenancy, projects, activity, admin projection       | `lunora/saas/`, `identity.ts` (registry `saas`)               | `@lunora/server`, `@lunora/d1` (`.global()`)           |
| Sign-in, organisations, admin, passkey, two-factor  | `lunora/auth/` (registry `auth`)                              | `@lunora/auth`, better-auth                            |
| Billing                                             | `lunora/payment/`, `plans.ts`, `http.ts` (registry `payment`) | `@lunora/payment` (Stripe)                             |
| Shared builders: auth, rate limits, tenant RLS, zod | `lunora/lib/crpc.ts`                                          | `@lunora/ratelimit`, zod                               |
| Tasks: sharded tables, RLS, full-text search        | `lunora/tasks/`                                               | `.shardBy("organizationId")`, `.searchIndex()`         |
| Presence                                            | `lunora/presence/` (registry `presence`)                      |                                                        |
| In-app feed and push                                | `lunora/notifications/`, `notify.ts`                          | `@lunora/notify`                                       |
| Support agent                                       | `lunora/agents.ts`, `assistant/`                              | `@lunora/agent`, `@lunora/ai`                          |
| Onboarding                                          | `lunora/workflows.ts`, `onboarding.ts`                        | `@lunora/workflow`                                     |
| Domain events and outbound mail                     | `lunora/queues.ts`                                            | `@lunora/queue`                                        |
| Nightly maintenance                                 | `lunora/crons.ts`, `crons/jobs.ts`                            | `@lunora/scheduler`                                    |
| Mail, AI, storage, flags                            | registry `mail`, `ai`, `storage`, `flags`                     | `@lunora/mail`, `@lunora/ai`, `@lunora/storage`, flags |
| KV cache and product analytics                      | `lunora/insights/`                                            | `@lunora/bindings`                                     |
| Warehouse reads                                     | `lunora/reporting/`                                           | `@lunora/hyperdrive` (PGlite in dev)                   |
| Link previews                                       | `lunora/web/`                                                 | `@lunora/browser`                                      |
| Paid public API for agents                          | `lunora/public-api/`                                          | `@lunora/x402`                                         |
| MCP over HTTP; OTLP or console telemetry            | `lunora/server.ts`                                            | `@lunora/mcp`, `lunorash/runtime` sinks                |

`lunora/lib/crpc.ts` matters most for the benchmark. It is the shared-builder
module real apps grow. It imports the rate limiter and zod at value level, and
every function module builds on it, so whatever it reaches stays on the startup
path however the registry is loaded. That is the pattern the app behind #1166
had. better-auth is on that path too, through `.auth()` in `lunora/server.ts`.
Actions cannot reach better-auth themselves: functions run without the Worker's
`env`, which is why onboarding takes the caller's address from the
`verifiedEmail` identity claim.

The following are left out on purpose:

- **`@lunora/container`** needs Docker and a Workers Paid plan.
- **`@lunora/privacy`**: its coverage lint requires every table with a `userId`
  column to be covered or excluded, and it needs a tombstones Durable Object plus
  about 350 lines of ports (see `examples/privacy`). It is a candidate for a later
  pass.
- **Vector search** (`.vectorize()`): there is no confirmed local Vectorize
  emulator.

## Run it

```bash
pnpm --filter "@lunora/bench..." run build:prod   # once: the packages it uses
cp apps/bench/.dev.vars.example apps/bench/.dev.vars   # then set the origins to this checkout's port
pnpm --filter @lunora/bench dev
```

The dev server serves on the playground's per-checkout port, which it prints as
`dev ports: playground :N`. `vite.config.ts` refuses to start when
`LUNORA_ORIGIN_URL` names a different port, because workflow, scheduler and agent
callbacks dispatch to that origin.

None of this needs credentials. Workers AI, Browser Rendering, Stripe, x402,
Web Push and OTLP are wired but stay inert until configured; see
`.dev.vars.example`. Each of those calls fails on its own while the rest of the
app runs.

## Scale it

```bash
node scripts/generate.mjs --domains 12                      # 12 generated domains
node scripts/generate.mjs --domains 12 --heavy-share 0.5    # half of them with a heavy SDK
node scripts/generate.mjs --preset customer                 # 40 domains, heavy share 0.5 ≈ the app behind #1166
node scripts/generate.mjs --domains 0                       # back to the committed core-only state
```

Domains are written to `lunora/domains/<name>/`, which is gitignored. The
generator rewrites `lunora/domains/schema.ts` (committed as an empty stub).

Each domain mirrors the core:

- sharded tables with indexes and a search index, plus a `.global()` catalog in
  every fourth domain;
- queries, mutations, internal jobs and actions built on `lib/crpc`, with tenant
  RLS and zod validators through `v.from`;
- in some domains, a scheduler, queue or AI hook.

`--heavy-share` gives that share of domains an `integrations.ts` action module on
a real third-party SDK, taken in turn from `@aws-sdk/client-s3` (with the
presigner), `e2b` (which brings `@connectrpc/connect` and `@bufbuild/protobuf`),
`@bufbuild/protobuf`, `tldts` and `@ai-sdk/openai`. Only that module imports the
SDK, so the function registry is its only importer. That is the profile that
let a lazy registry help the app behind #1166, where 979 dependency modules were
reachable only through the registry. Each action has a path that runs offline
(presign, template spec, protobuf encode, domain parse, provider construction).
The credentialed paths refuse until their keys are set; the keys are declared in
`lunora/env.ts`, the contract that populates `ctx.env`.

Presets: `core` (0 domains), `small` (8), `customer` (40, heavy share 0.5),
`large` (80, heavy share 0.5).

## Benchmark it

Three benches. Each one generates the size, builds it, measures, and then
restores the core-only state (pass `--keep` to skip the restore). Each writes
JSON with the load average and the git SHA to `.bench/results/` and prints a
table. Run them on a quiet machine, one at a time.

| Script                   | Measures                                                                                      | Typical run                                           |
| ------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `scripts/startup.mjs`    | Startup CPU (`wrangler check startup`) of the single-file bundle, eager vs `--lazy-functions` | `node scripts/startup.mjs --preset customer --runs 9` |
| `scripts/cold-start.mjs` | Latency of the first call of each function in a fresh isolate, and warm calls                 | `node scripts/cold-start.mjs --preset customer`       |
| `scripts/chunked.mjs`    | Startup CPU of chunked Vite (rolldown) builds next to the single-file esbuild bundle          | `node scripts/chunked.mjs --runs 7`                   |

### Startup

```bash
node scripts/startup.mjs                          # core, eager vs --lazy-functions, 7 runs each
node scripts/startup.mjs --preset customer --runs 11
node scripts/startup.mjs --domains 20 --heavy-share 0.5 --modes eager --keep
```

For each mode, the script:

1. Runs `lunora build --no-framework-build`, which produces the same wrangler
   single-file esbuild bundle that plan 490 §5.1 measured, plus its metafile.
2. Freezes that bundle with `wrangler deploy --dry-run --outfile`.
3. Runs `wrangler check startup --workerBundle` with the modes interleaved, so
   machine load hits both modes equally.

The figures, in the order to read them:

- **Active ms** (median/min/max) is local CPU, not Cloudflare's. The only
  calibration point is that a ~0.4 s local profile was rejected upstream.
- **eager modules / bytes** count what is reachable through static imports.
  This number is deterministic.
- **registry-only modules** is what a lazy registry can defer at most: modules
  reachable only through `_generated/functions.ts`, with the app's own `lunora/`
  modules in brackets. The JSON names the largest packages in that part.
- **packages**, in the JSON, shows which imports dominate startup. That list
  says which import to defer next.

### Cold start

```bash
node scripts/cold-start.mjs --preset customer                  # 20 isolates per mode, 2 warm rounds
node scripts/cold-start.mjs --preset customer --samples 30 --warm 1
```

A lazy registry moves module evaluation from startup to the first call of each
function. This bench measures where that cost lands. Per sample, it:

1. boots a fresh local runtime (`unstable_startWorker` on the frozen `lunora
build` bundle) and waits on its `ready` promise;
2. times `saas:me`, which gives the first response and the cold-to-first-response
   time;
3. wakes the tenant's shard;
4. calls each sampled function once (cold), in a shuffled order;
5. calls each again `--warm` times.

The sample has, per domain, `queries:list` and `admin:exportSummary` (which also
loads `jobs` and `validators`), plus the offline action of every heavy domain's
integration module: 4–5 of a domain's 6–8 modules, 94 functions at the customer
preset. `lines`, `notes`, `mutations` and `catalog` are not sampled. Each isolate signs in
as its own verified owner of its own organisation. The app's `read` rate limit
(200 per 10 s per caller) is persisted, so a shared caller would be refused
after the first isolate. The same limit caps `--warm`: each isolate makes
`domains × (1 + warm)` rate-limited reads (`queries:list`; the actions are not
limited), which must stay under 200.

### Chunked builds

```bash
node scripts/chunked.mjs                    # customer preset, 7 runs
node scripts/chunked.mjs --preset core --runs 5
```

This bench profiles six artifacts with interleaved runs: `lunora build`'s
single-file esbuild bundle, `vite build --minify` (rolldown chunks), and the
latter with rolldown's `output.strictExecutionOrder`, each eager and lazy. It
reports JS module count and bytes from the frozen upload. If an artifact fails to
start, the bench records its error and keeps going.

A `vite build` leaves `.wrangler/deploy/config.json` behind. That file silently
redirects every later wrangler command, `lunora build` included, to the Vite
output in `dist/`. `chunked.mjs` removes it, and `startup.mjs` refuses to run
while it exists (see FINDINGS.md).

### Checking a framework change

Build the changed package with `build:prod` and run the startup bench at
`--preset customer`. Compare the eager graph first, since it is deterministic,
and the Active time second. `scripts/worker-startup-measure.js` is the shared
measurement code, the same one the CI gate (`check-worker-startup.js`) uses;
`scripts/sized-app.mjs` holds the generate/build/restore steps the three benches
share.

Framework defects found while building this app are in [FINDINGS.md](./FINDINGS.md).
