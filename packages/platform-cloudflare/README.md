# `@lunora/platform-cloudflare`

The Cloudflare implementation of the [`@lunora/platform`](../platform) host contracts.

`@lunora/platform` defines _what_ a host must provide — `ShardHost`, `SocketHost`, `ShardDirectory`, `ShardKvStore`. This package provides it for Cloudflare, over `DurableObjectState`, hibernatable WebSockets, and a `DurableObjectNamespace`.

```ts
import { createShardPlatform } from "@lunora/platform-cloudflare";

// Inside a Durable Object:
const platform = createShardPlatform(state);
```

## Why it exists

So a second target is an addition rather than a refactor. `@lunora/do` depends on this package, not on Cloudflare directly — every provider API it needs arrives through a contract. Plan 114's Node/AWS host (§§6–9) ships the same surface from `@lunora/platform-aws`, and `@lunora/do` changes only which package it composes.

The adapters are verified by the conformance suites in `@lunora/platform/conformance` and `@lunora/shard-engine/conformance`, run against a real Durable Object in `@lunora/do`'s workerd project.
