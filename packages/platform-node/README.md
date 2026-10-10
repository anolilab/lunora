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

## On-demand profiling

`createNodeProfiler()` captures a CPU or heap profile of the running process
through the built-in inspector and returns it as a gzip-compressed pprof, which
`go tool pprof`, Pyroscope and Speedscope read. `createNodeProfileHandler({ token })`
exposes that over a bearer-guarded `POST` route the app mounts itself; the CLI
drives it with `lunora profile --target node --url <route>`.

```ts
import { createNodeProfileHandler } from "@lunora/platform-node";

const profile = createNodeProfileHandler({ token: process.env.LUNORA_ADMIN_TOKEN! });
// Serve it on whatever route you choose: `if (url.pathname === "/__profile") return profile(request);`
```

It runs one capture at a time per process, and refuses an empty token when the
handler is created. The pprof encoding uses `pprof-format`; the V8-to-pprof
conversion is in `src/node-profile-pprof.ts`. Profiling is not a `ctx.*`
surface or binding, so it has no entry in `PlatformCapabilities`.
