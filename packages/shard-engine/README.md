# @lunora/shard-engine

Host-neutral reactive engine for Lunora.

This package holds the per-shard state machine that powers Lunora's real-time features:

- Optimistic concurrency control (OCC)
- Change-data-capture (`__cdc_log`) and reactive subscription fan-out
- Dependency tracking and the reactive cache
- Relations, aggregates, ranks, and search
- The `pokeStart`/`pokePart`/`pokeEnd` subscription protocol

It consumes the provider-neutral host contracts from `@lunora/platform` (`ShardHost`, `SocketHost`, `ShardDirectory`, `SchedulerHost`) and can be mounted on any platform host.

## Status

Phase 2 of plan 114. The engine is being extracted from `@lunora/do`; `@lunora/do` will shrink to the Cloudflare host binding that wires `ShardHost`/`SocketHost` to Durable Objects.
