# `@cirrus/runtime` — Test Layout

This package has two parallel test suites coordinated by a single
`pnpm --filter @cirrus/runtime test`.

```
__tests__/
├── createWorker.test.ts           # legacy "mocks" project (always runs)
├── errors.test.ts                 # legacy "mocks" project (always runs)
├── index.test.ts                  # legacy "mocks" project (always runs)
└── workerd/                       # workerd integration project (opt-in)
    ├── createWorker.workerd.test.ts
    ├── test-worker.ts
    └── wrangler.jsonc
```

## `mocks` project (legacy fast-path)

Runs in plain Node against a hand-rolled `ShardNamespaceLike` double. No
real Durable Object is involved — these tests pin the routing, envelope
parsing, and error-mapping contracts at speed.

## `workerd` project (real Cloudflare runtime)

Boots the production `createWorker(...)` inside Miniflare via
`@cloudflare/vitest-pool-workers`, with a tiny echo-style `TestShardDO`
on the other side. Tests hit the worker through `SELF.fetch` and assert
the round-trip through the genuine Cloudflare runtime.

**When to add a workerd-based test:** anything where the integration
boundary matters — header propagation (`authorization`, `cookie`,
`x-d1-bookmark`), the `"METHOD path"` route-key shape, error-response
sanitization, and any future behaviour that depends on the real
`Request`/`Response` semantics rather than the WHATWG fetch shim.

## Running the suites

```bash
# Mocks only (default):
pnpm --filter @cirrus/runtime test

# Both projects (opt-in — requires unrestricted localhost-loopback
# access between workerd and the test host; see top-level
# workerd-integration note in packages/do/__tests__/README.md):
CIRRUS_WORKERD_TESTS=1 pnpm --filter @cirrus/runtime test
```
