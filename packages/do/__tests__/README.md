# `@lunora/do` — Test Layout

This package has two parallel test suites that run together under a single
`pnpm test`.

```
__tests__/
├── ShardDO.test.ts            # legacy "mocks" project — fast-path
└── workerd/                   # workerd integration project
    ├── ShardDO.workerd.test.ts
    ├── test-worker.ts
    └── wrangler.jsonc
```

## `mocks` project (legacy fast-path)

Runs in plain Node via `vitest run`. Uses hand-rolled doubles for
`DurableObjectState` (see `createFakeState` in `ShardDO.test.ts`). Boots in
milliseconds and is useful for tight feedback loops on pure logic — RPC
routing, error mapping, attachment shape validation.

**When to add a mock-based test:** quick logic checks where you do not need
real WebSocket lifecycle, real SQLite, or real hibernation behavior.

## `workerd` project (real Miniflare runtime)

Runs via `@cloudflare/vitest-pool-workers`, which boots a real `workerd`
process from a wrangler config (`workerd/wrangler.jsonc`) and a test entry
worker (`workerd/test-worker.ts`).

The test entry worker re-exports the production `ShardDO` / `SessionDO` as
concrete subclasses bound to `SHARD` / `SESSION` Durable Object namespaces.
Tests then use the `cloudflare:test` API to drive them:

- `env.SHARD.idFromName(...).get(id)` — get a real DO stub.
- `runInDurableObject(stub, (instance, state) => …)` — touch the DO from
  inside its own context (read/write `state.getWebSockets()`,
  `deserializeAttachment()`, etc.).
- `runDurableObjectAlarm(stub)` — synchronously run a pending alarm.
- WebSocket upgrades return a real `client` socket — `client.send(...)` /
  `client.addEventListener("message", ...)` exercise the real Hibernation API.

**When to add a workerd-based test:** WebSocket Hibernation, SQLite-in-DO,
alarms, or any behavior whose correctness depends on workerd lifecycle (e.g.
"the runtime already closed this socket, so don't call `.close()` again").

## Running the suites

```bash
# Both projects:
pnpm --filter @lunora/do test

# Just the legacy mocks:
pnpm --filter @lunora/do test -- --project mocks

# Just the workerd integration suite:
pnpm --filter @lunora/do test -- --project workerd
```

`vis run test` from the repo root invokes the same script and continues to work.

## Migration policy

We are **not** mass-converting the mock-based suite to workerd. The mocks
catch logic regressions cheaply; workerd catches integration regressions the
mocks structurally cannot model. New tests should default to **workerd**
unless they're verifying purely structural logic (envelope parsing, error
shape, etc.) where a mock is materially faster.

## Telemetry suites need `@lunora/observability` built

`function-metrics`, `settings`, `tracing`, `traced-fetch`, `shard-do.admin`,
`shard-do.sampling` and the workerd cf-bridge test import from
`@lunora/observability` rather than from `../src/*` — those modules live in that
package now. So a bare `pnpm --filter "@lunora/do" run test` fails on a stale or
absent `packages/observability/dist` with a missing-export error, which reads
like a broken test rather than a missing build.

Build first (`pnpm run build:packages`, or `pnpm --filter "@lunora/do..." run
build`), or use `pnpm run test:affected`, which builds dependencies for you.
