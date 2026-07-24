# @lunora/platform-conformance

Behavioral TCK (Test Compatibility Kit) for Lunora platform hosts.

This package exports a parameterized Vitest suite that asserts every host implementation satisfies the provider-neutral contract defined in `@lunora/platform`:

- `ShardHost` — single-writer serialization, durable transactions, local SQL, alarms, background continuation.
- `SocketHost` — hibernated WebSocket accept/send/close, attachment round-trip, tagged fan-out.
- `ShardDirectory` — deterministic placement + RPC dispatch.
- `SchedulerHost` — durable delayed jobs, cron, at-least-once delivery.

It also ships a reference in-memory host factory (`createReferenceHost`) built on `node:sqlite`. Any real host (Cloudflare Durable Objects, AWS, Rivet, Node) should be able to pass the same suite.

## Usage

```ts
import { describe, expect, it } from "vitest";

import { createReferenceHost, defineHostContractSuite } from "@lunora/platform-conformance";

defineHostContractSuite("reference", createReferenceHost, { describe, expect, it });
```

The Vitest API is injected rather than imported by the suite, so a host can run the same contract under a different test runner by passing a compatible `describe`/`expect`/`it`.

For a real host, implement the `@lunora/platform` contracts and pass your factory to `defineHostContractSuite`.

## Status

Phase 1 of plan 114. Engine-level behaviors (OCC-409 end-to-end, reactive subscription fan-out, RLS under live subscription) will be added to the TCK once the reactive engine is extracted into `@lunora/shard-engine` (Phase 2).
