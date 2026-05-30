# Benchmarks

Cirrus ships per-package benches under `packages/<name>/__bench__/`. They
exist to:

1. **Catch regressions** in the hot paths (count, rank, pagination, the
   reactive cache, cross-shard fan-out, RLS middleware, trigger runner,
   ratelimit shard aggregation, admin import throughput).
2. **Document expected performance shapes** — every bench's JSDoc explains
   what it measures, what to expect, and why.

## Running

Per package (use pnpm filters):

```bash
pnpm --filter @cirrus/do        bench
pnpm --filter @cirrus/server    bench
pnpm --filter @cirrus/runtime   bench
pnpm --filter @cirrus/codegen   bench
pnpm --filter @cirrus/values    bench
pnpm --filter @cirrus/ratelimit bench
```

To run a single bench file:

```bash
pnpm --filter @cirrus/do exec vitest bench --run rank-position
```

`vitest bench` is in experimental status — pin the vitest version if you
need stable cross-machine comparisons.

## What's covered

| Package             | File                                    | Measures                                                                           |
| ------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| `@cirrus/do`        | `count-indexed-vs-scan.bench.ts`        | `count()` via `aggregateIndex` counter vs SQL `SELECT COUNT(*)` scan               |
| `@cirrus/do`        | `aggregate-groupby.bench.ts`            | `aggregate()` and `groupBy()` indexed vs scan                                      |
| `@cirrus/do`        | `keyset-vs-offset.bench.ts`             | `findMany()` cursor seek vs offset-style at depth 5 000                            |
| `@cirrus/do`        | `reactive-cache.bench.ts`               | `ReactiveCache.run` hit vs miss vs no-wrapper baseline                             |
| `@cirrus/do`        | `rank-position.bench.ts`                | `rank()` via companion-table seek vs emulated `findMany + indexOf`                 |
| `@cirrus/do`        | `relations-with.bench.ts`               | `findMany({with})` no-relation / one / many / two relations                        |
| `@cirrus/do`        | `trigger-overhead.bench.ts`             | Per-write cost at 0 / 1 / 4 attached triggers                                      |
| `@cirrus/do`        | `write-throughput.bench.ts`             | `insert`/`patch`/`replace` against bare, aggregateIndex, rankIndex schemas         |
| `@cirrus/do`        | `broadcast-delta.bench.ts`              | WS broadcast fan-out                                                               |
| `@cirrus/d1`        | `count-indexed-vs-scan.bench.ts`        | D1 column-dialect mirror of the DO `count()` bench                                 |
| `@cirrus/d1`        | `keyset-vs-offset.bench.ts`             | D1 column-dialect mirror of the keyset bench                                       |
| `@cirrus/d1`        | `rank-position.bench.ts`                | D1 column-dialect mirror of the `rank()` bench                                     |
| `@cirrus/server`    | `dispatch.bench.ts`                     | `query()`/`mutation()` dispatch + validator                                        |
| `@cirrus/server`    | `http-dispatch.bench.ts`                | hono `httpRouter`: httpAction vs httpRoute plain / +searchParams / +body / +output |
| `@cirrus/server`    | `middleware-chain.bench.ts`             | `.use(mw)` chain dispatch cost at N = 0 / 1 / 4 / 8                                |
| `@cirrus/server`    | `rls-overhead.bench.ts`                 | `.use(rls(policies))` overhead — baseline / `true` / `WhereInput`                  |
| `@cirrus/runtime`   | `cross-shard-fanout.bench.ts`           | `QueryCoordinator.fanOut` `sum`/`topK`/`groupBy` merge at N = 4 and N = 64         |
| `@cirrus/runtime`   | `import-throughput.bench.ts`            | `orchestrateImport` over 1 / 4 / 16 shards (1 000 rows total)                      |
| `@cirrus/runtime`   | `orchestrate-migration-export.bench.ts` | `orchestrateMigration` + `orchestrateExport` at N = 4 / 16 shards                  |
| `@cirrus/runtime`   | `rpc-dispatch.bench.ts`                 | `worker.fetch /_cirrus/rpc` — bare / + resolveIdentity / + claims / shardKey       |
| `@cirrus/ratelimit` | `sharded-getvalue.bench.ts`             | `getValue()` unsharded vs `shards = 8` vs `shards = 32`                            |
| `@cirrus/ratelimit` | `limit-throughput.bench.ts`             | `limit()` consumer side — token bucket / window / sharded / deny-list hit          |
| `@cirrus/codegen`   | `run-codegen.bench.ts`                  | Full codegen run on a fixture project                                              |
| `@cirrus/values`    | `validators.bench.ts`                   | `v.*` validator parse                                                              |

## Interpreting output

Each bench prints `hz` (ops/sec), `min`/`max`/`mean` (ms), `p75`/`p99` (ms),
`rme` (relative margin of error), and sample count. The `Summary` block at
the end groups benches by `describe` and shows their relative speed.

A representative readout from `@cirrus/do bench` on a workstation:

```
count() — indexed vs scan
  · indexed: count by projectId         ~210 000 ops/sec
  · scan:    count by projectId          ~31 000 ops/sec  (6.7× slower)

ReactiveCache.run
  · hit                                    3.9M ops/sec   (~260 ns)
  · miss                                   1.0M ops/sec   (~990 ns)
  · baseline (no wrapper)                  4.2M ops/sec   (~240 ns)

findMany — keyset vs offset-style at depth 5000
  · keyset (page 101)                        ~700 ops/sec (~1.4 ms)
  · offset-style (limit 5050 + JS slice)     ~135 ops/sec (~7.4 ms)
  · control (page 1)                      ~12 500 ops/sec (~80 µs)
```

Use these as rough sanity checks; absolute numbers depend on the host
(CPU, Node version, SQLite build). The interesting question is **does the
ratio change between two runs** — that's the regression signal.

## Adding a bench

1. Put the file under `packages/<pkg>/__bench__/<name>.bench.ts`.
2. Add a `bench` script to the package's `package.json` if it's not there
   already (`"bench": "pnpm exec vitest bench --run"`).
3. Ensure `__bench__/**/*` is in the package's `tsconfig.json` `include`.
4. **Don't use `beforeAll`** — `vitest bench` doesn't await it the same way
   the test runner does. Set state up at module top via top-level await
   instead (the existing benches all do this).
5. Each `bench(...)` body should be tight — one operation under measure,
   no setup work inside the timed function. Use module-level fixtures.

## Performance gotchas (surfaced by the bench suite)

A few costs the benches reveal that are worth being aware of when
designing schemas + handlers:

- **D1 column-dialect scan is much more expensive than DO JSON-blob
  scan.** An indexed `count()` on D1 is ~65× faster than its scan;
  the same on `@cirrus/do` is only ~7× faster (SQLite has a fast path
  for unfiltered `COUNT(*)` over JSON blobs). The takeaway: **declare
  `aggregateIndex` aggressively on `.global()` tables**, where the
  scan baseline really hurts.
- **`httpRoute + body` (POST JSON) is roughly half the throughput of
  the plain `httpRoute` path.** The dominator is hono's
  `c.req.json()` — V8's `JSON.parse` on the body. For large bodies
  (>100KB) consider a streaming-validated path; for typical small
  bodies the cost is fine but worth knowing the budget split.
- **`+ rankIndex` insert is ~60% slower than bare.** Maintaining the
  sort-key SQLite index per write is inherent; for tables where you
  only need rank occasionally, prefer materialising the rank via an
  `aggregateIndex` of `count(rows-before)` if the partition is small.
  `syncRanks` now short-circuits on patches that don't touch
  partition / sort / static-where fields, so a patch on an unrelated
  field on a `rankIndex` table pays the floor cost.
- **`bare patch` floor is ~1.8× slower than `bare insert`.** Patch has
  to read+decode the prior row to feed triggers, aggregate diff, and
  rank-key diff. Routing through the shared `lookupById` helper
  collapses the table probe + row fetch into one SQL round-trip — the
  prior code did three.
- **Trigger fixed-cost is zero on the no-trigger path.** Writers
  precompute a `(table, timing, op)` matcher set at ctx-db construction
  and skip the `await fireTriggers(...)` microtask entirely when no
  handler is declared for that combination. Result: a write on a bare
  table pays no trigger cost (~13% faster than the prior code that
  always awaited the noop dispatcher). Attaching one or four triggers
  adds the expected per-handler cost on top.
- **Cross-shard `fanOut` is `stub.fetch` + `JSON.parse` bound.** At
  N = 64 each shard pays a fresh `Request` construction (body string +
  headers are now hoisted once per fan-out — the bench gain is small
  because that wasn't the dominant cost) + the in-stub round-trip + a
  `Response.json()` decode. For very wide fan-outs, prefer fewer +
  larger shards over many tiny ones; or batch multiple `query()` calls
  inside a single fan-out via a coordinator function that returns a
  composite result.

## Not yet wired

- **CI integration.** Benches don't run on PRs today; regressions will
  only show up if a developer runs them locally. Wiring a GitHub Actions
  job that runs `pnpm -r bench` and uploads the JSON output as an artifact
  is the natural next step.
- **Baseline storage / diffing.** `vitest bench` doesn't persist results
  between runs; comparing today's numbers to yesterday's requires a
  baseline file in the repo plus a small script to diff. Convex-style
  performance regression alerts ride on this kind of pipeline.
