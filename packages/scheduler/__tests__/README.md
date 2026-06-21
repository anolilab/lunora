# `@lunora/scheduler` — Test Layout

This package has two parallel test suites coordinated by a single
`pnpm --filter @lunora/scheduler test`.

```
__tests__/
├── createScheduler.test.ts        # legacy "mocks" project (always runs)
├── SchedulerDO.test.ts            # legacy "mocks" project (always runs)
├── _fakeState.ts                  # shared mock helpers for the legacy suite
└── workerd/                       # workerd integration project (opt-in)
    ├── SchedulerDO.workerd.test.ts
    ├── test-worker.ts
    └── wrangler.jsonc
```

## `mocks` project (legacy fast-path)

Runs in plain Node. Uses `_fakeState.ts` — a hand-rolled in-memory
`DurableObjectState` stand-in that drives `alarm()` synchronously. Quick
and zero-setup but does not exercise the real workerd alarm scheduler.

## `workerd` project (real Durable Object alarms)

Boots a real `SchedulerDO` inside Miniflare via
`@cloudflare/vitest-pool-workers`. Tests drive the alarm path with
`runDurableObjectAlarm()` from `cloudflare:test`, which short-circuits
the wall clock so timers don't actually wait — but the runtime's own
alarm-registration and dispatch machinery is the genuine article.

**When to add a workerd-based test:** anything that depends on

- the runtime's real alarm scheduler (re-arming after fire, replace vs
  reschedule semantics);
- real `state.storage.list({ end })` upper-bound semantics that the
  legacy fake state may not faithfully reproduce;
- the actual `DurableObject.alarm()` override surface.

## Running the suites

```bash
# Mocks only (default):
pnpm --filter @lunora/scheduler test

# Both projects (opt-in — requires unrestricted localhost-loopback
# access between workerd and the test host; see top-level
# workerd-integration note in packages/do/__tests__/README.md):
LUNORA_WORKERD_TESTS=1 pnpm --filter @lunora/scheduler test
```
