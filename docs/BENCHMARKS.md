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

| Package             | File                             | Measures                                                               |
| ------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `@cirrus/do`        | `count-indexed-vs-scan.bench.ts` | `count()` via `aggregateIndex` counter vs SQL `SELECT COUNT(*)` scan   |
| `@cirrus/do`        | `keyset-vs-offset.bench.ts`      | `findMany()` cursor seek vs offset-style at depth 5 000                |
| `@cirrus/do`        | `reactive-cache.bench.ts`        | `ReactiveCache.run` hit vs miss vs no-wrapper baseline                 |
| `@cirrus/do`        | `rank-position.bench.ts`         | `rank()` via companion-table seek vs emulated `findMany + indexOf`     |
| `@cirrus/do`        | `trigger-overhead.bench.ts`      | Per-write cost at 0 / 1 / 4 attached triggers                          |
| `@cirrus/do`        | `broadcast-delta.bench.ts`       | WS broadcast fan-out (existing)                                        |
| `@cirrus/server`    | `dispatch.bench.ts`              | `query()`/`mutation()` dispatch + validator (existing)                 |
| `@cirrus/server`    | `rls-overhead.bench.ts`          | `.use(rls(policies))` overhead — baseline / `true` / `WhereInput`      |
| `@cirrus/runtime`   | `cross-shard-fanout.bench.ts`    | `QueryCoordinator.fanOut` `sum`/`topK`/`groupBy` merge at N=4 and N=64 |
| `@cirrus/runtime`   | `import-throughput.bench.ts`     | `orchestrateImport` over 1 / 4 / 16 shards (1 000 rows total)          |
| `@cirrus/ratelimit` | `sharded-getvalue.bench.ts`      | `getValue()` unsharded vs `shards=8` vs `shards=32`                    |
| `@cirrus/codegen`   | `run-codegen.bench.ts`           | Full codegen run on a fixture project (existing)                       |
| `@cirrus/values`    | `validators.bench.ts`            | `v.*` validator parse (existing)                                       |

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

## Not yet wired

- **CI integration.** Benches don't run on PRs today; regressions will
  only show up if a developer runs them locally. Wiring a GitHub Actions
  job that runs `pnpm -r bench` and uploads the JSON output as an artifact
  is the natural next step.
- **Baseline storage / diffing.** `vitest bench` doesn't persist results
  between runs; comparing today's numbers to yesterday's requires a
  baseline file in the repo plus a small script to diff. Convex-style
  performance regression alerts ride on this kind of pipeline.
