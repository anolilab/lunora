# @cirrus/do

Durable Object base classes for the Cirrus framework. Provides `ShardDO` (SQLite-backed shard with the WebSocket Hibernation API and a subscription registry) and `SessionDO` (auth session pinning). Subclass these from a Worker that uses `@cirrus/runtime`.

## TODO: integration

Phase 1.5 will add real Durable Object tests using `@cloudflare/vitest-pool-workers` + Miniflare. For now this package ships unit tests that exercise the base classes with stubbed `DurableObjectState` doubles.
