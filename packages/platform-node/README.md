# `@lunora/platform-node`

**Spike (plan 234).** A Node implementation of the [`@lunora/platform`](../platform) host contracts — `ShardHost`, `SocketHost`, `ShardDirectory`, `ShardKvStore`, `SchedulerHost` — over `better-sqlite3` and an in-process socket/directory/scheduler registry.

`@lunora/platform` defines _what_ a host must provide; `@lunora/platform-cloudflare` provides it for Cloudflare. This package provides it for a plain Node process, promoted from `@lunora/platform`'s `node:sqlite` reference host (`src/conformance/reference-host.ts`) and hardened toward real persistence semantics (a real `better-sqlite3` file, `node:v8` structured-clone-fidelity serialization for KV).

```ts
import { createNodePlatform } from "@lunora/platform-node";

const platform = createNodePlatform({ path: "./shard.sqlite3" });
```

## Why it exists

Portability was a claim, not a construction check — `PLATFORM_MATRICES` held exactly one entry (`cloudflare`), so nothing had exercised the contract against a second host. This package stands one up and runs the existing conformance TCK (`@lunora/platform/conformance`) against it; every place the engine or the TCK needed something the contract didn't promise is recorded in [`plans/234-node-host-findings.md`](../../plans/234-node-host-findings.md).

## Scope

This is a **spike**, not a production target: it is not wired into `lunora dev`, has no deploy driver, and several capabilities are honestly rated `emulated`/`unsupported` in its capability matrix entry (see `@lunora/platform`'s `NODE_CAPABILITIES`). Wiring it into the dev server is the payoff and a follow-up, not this change.
