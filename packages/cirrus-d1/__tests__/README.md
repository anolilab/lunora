# `@cirrus/d1` — Test Layout

This package has two parallel test suites coordinated by a single
`pnpm --filter @cirrus/d1 test`.

```
__tests__/
├── D1Client.test.ts            # legacy "mocks" project (always runs)
├── MigrationRunner.test.ts     # legacy "mocks" project (always runs)
└── workerd/                    # workerd integration project (opt-in)
    ├── D1Client.workerd.test.ts
    ├── test-worker.ts
    └── wrangler.jsonc
```

## `mocks` project (legacy fast-path)

Runs in plain Node. Uses hand-rolled stand-ins for `D1Database`,
`D1DatabaseSession`, and prepared statements. Quick and zero-setup —
useful when you need a tight feedback loop on pure routing or argument
plumbing.

## `workerd` project (real D1)

Boots a real Miniflare D1 database via `@cloudflare/vitest-pool-workers`.
The bound database is in-process SQLite; tests can read/write through
either `env.DB` directly or through the worker exposed by
`__tests__/workerd/test-worker.ts`.

**When to add a workerd-based test:** anything that depends on real
session bookmarks, real `INSERT … RETURNING`, real foreign-key enforcement,
or anything else where SQLite semantics matter.

## Running the suites

```bash
# Mocks only (default):
pnpm --filter @cirrus/d1 test

# Both projects (opt-in — requires unrestricted localhost-loopback
# access between workerd and the test host; see top-level
# workerd-integration note in packages/cirrus-do/__tests__/README.md):
CIRRUS_WORKERD_TESTS=1 pnpm --filter @cirrus/d1 test
```
