# @lunora/platform

Provider-neutral host contracts for Lunora.

This package defines the structural interfaces that separate the Lunora engine from any specific host (Cloudflare Workers, AWS, Rivet, Node, etc.). It contains **types and capability metadata only** — near-zero runtime code.

## Contracts

- **`ShardHost`** — single-writer execution, transactions, local SQL, alarms, and background continuation per shard key.
- **`SocketHost`** — hibernated WebSocket subscriptions with durable attachments and tagged fan-out.
- **`ShardDirectory`** — deterministic placement and RPC dispatch from shard keys to stubs.
- **`SchedulerHost`** — durable delayed jobs, cron, and at-least-once dispatch.
- **`PlatformCapabilities`** — capability matrix consumed by codegen to tailor emitted types per target.

Plus canonical binding projections (`KVNamespaceLike`, `R2BucketLike`, `QueueBindingLike`, `D1DatabaseLike`, `VectorizeIndexLike`, …) shared by all host adapters.

## Status

This package is part of plan 114 (multi-provider platform). It is the prerequisite for the AWS target in the same plan (§§6–9).
