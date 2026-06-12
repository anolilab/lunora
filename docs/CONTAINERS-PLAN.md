# Cloudflare Containers in Cirrus — DX Plan

Status: draft (research + design, no implementation yet)
Date: 2026-06-12

## TL;DR

Cloudflare Containers went GA in April 2026 and gives us everything we need to
deploy Docker containers as part of a Cirrus app: containers are attached to
Durable Objects (a `Container` class extends a DO), `wrangler deploy` builds the
Dockerfile locally and pushes it to a Cloudflare-managed registry, and
`wrangler dev` / the Cloudflare Vite plugin already run containers locally via
Docker. We do **not** need to build any deploy infrastructure ourselves — we
need a Cirrus-shaped API (`defineContainer`), codegen for the container DO
class, and binding inference/validation, all of which slot into existing seams
in `@cirrus/config`, `@cirrus/codegen`, and the CLI deploy pipeline.

[Railpack](https://railpack.com/) (Railway's Nixpacks successor) is useful but
optional: it gives us Dockerfile-less builds ("point at a directory, get an
image") at the cost of a BuildKit dependency. Recommended as Phase 2, not the
default path.

---

## 1. What Cloudflare provides (research summary)

### Platform model

- A container is always fronted by a **container-enabled Durable Object**: a
  class extending `Container` from the `@cloudflare/containers` npm package.
  Each DO instance controls exactly one container instance. This maps
  perfectly onto Cirrus's existing DO-centric topology — a container pool is
  "just another DO namespace" next to `ShardDO`/`SchedulerDO`/`SessionDO`.
- Routing is explicit: `getContainer(env.BINDING, name)` for stateful
  per-entity instances (one sandbox per user/session), `getRandom(env.BINDING, n)`
  for stateless load-balancing across a fixed pool. **There is no built-in
  autoscaling or latency-aware routing yet** (on Cloudflare's roadmap).

### wrangler.jsonc surface

```jsonc
{
  "containers": [
    {
      "class_name": "FfmpegContainer", // must match a DO class
      "image": "./containers/ffmpeg/Dockerfile", // or a registry ref
      "image_build_context": "./containers/ffmpeg",
      "image_vars": { "BUILD_FLAG": "1" }, // --build-arg equivalents
      "instance_type": "standard-1", // lite | basic | standard-1..4 | { vcpu, memory_mib, disk_mb }
      "max_instances": 5,
      "rollout_step_percentage": 25,
      "rollout_active_grace_period": 300
    }
  ],
  "durable_objects": {
    "bindings": [{ "name": "FFMPEG", "class_name": "FfmpegContainer" }]
  },
  "migrations": [{ "tag": "v2", "new_sqlite_classes": ["FfmpegContainer"] }]
}
```

- `image` accepts a local Dockerfile path **or** a registry reference from the
  Cloudflare Registry, Docker Hub, or Amazon ECR (private registries via
  `wrangler containers registries configure`).
- Container DOs must be SQLite-backed (`new_sqlite_classes`) — same migration
  convention Cirrus already reconciles for `ShardDO`.

### Deploy & image management

- `wrangler deploy` builds the image with local Docker, pushes it to
  `registry.cloudflare.com` (R2-backed, integrated auth, 50 GB/account), then
  deploys the Worker. Only changed layers are re-pushed.
- CI can split the steps: `wrangler containers build --push` / `wrangler
  containers push` work without a full deploy; `wrangler containers images
  list|delete` manage the registry.
- **Docker (or a compatible engine) is required on the deploying machine.**

### Local dev

- `wrangler dev` and `vite dev` (via `@cloudflare/vite-plugin`, which
  `@cirrus/vite` already wraps) build/pull and run containers locally.
  Requires Docker Desktop/Colima.
- Caveats: container code is **not** hot-reloaded (press `r` to rebuild);
  ports must be `EXPOSE`d in the Dockerfile for local dev; `vite dev` cannot
  pull from the Cloudflare Registry (use a local Dockerfile `FROM` it);
  `dev.enable_containers` / `dev.container_engine` tune behavior.

### Limits & pricing (for docs/limits.mdx)

- Instance types: `lite`, `basic`, `standard-1..4`; custom types up to
  4 vCPU / 12 GiB / 20 GB disk. Account caps: 1,500 concurrent vCPU,
  6 TiB memory, 30 TB disk (raisable via support).
- Requires Workers Paid ($5/mo). Since GA, vCPU is billed on **active CPU**
  (~$0.00002 per vCPU-second); memory/disk billed while instances run. Idle
  (slept) containers cost nothing in CPU.

### What Cloudflare does *not* provide (gaps we may want to fill)

1. **Autoscaling** — pools are fixed-size (`getRandom` over N instances).
2. **Dockerfile-less builds** — `image` must be a Dockerfile or a pre-built
   registry ref. This is the Railpack opportunity.
3. **Latency-aware routing** — `getRandom` ignores location.

---

## 2. Railpack assessment

[Railpack](https://github.com/railwayapp/railpack) is Railway's zero-config
source→OCI-image builder (successor to Nixpacks, now in maintenance mode).
Go + BuildKit LLB; detects Node, Python, Go, PHP, Java, Ruby, .NET, Deno,
Rust, Elixir…; images come out 38–77 % smaller than Nixpacks; versions
resolved via Mise and lockable for reproducible builds.

**Fit for Cirrus:** good, as an *optional* build strategy.

- Pro: `cirrus`-grade DX — "point `defineContainer` at `./services/transcoder`,
  no Dockerfile needed". Build locally → image lands in the Docker daemon →
  `wrangler containers push` → reference the pushed tag in `containers[].image`.
- Con: needs a running **BuildKit** instance (`BUILDKIT_HOST`, typically
  `docker run --privileged moby/buildkit`) *plus* the `railpack` binary. That
  is a heavier toolchain than the wrangler-native path, where Docker alone
  suffices and wrangler does build+push itself.
- Verdict: ship Dockerfile-first (zero extra deps, wrangler does the work),
  add Railpack as an opt-in `build: "auto"` strategy in Phase 2. Never make
  it the default.

---

## 3. Proposed DX

### 3.1 Authoring: `defineContainer` in a new `@cirrus/container` package

```ts
// cirrus/containers.ts
import { defineContainer } from "@cirrus/container";

export const transcoder = defineContainer({
    // exactly one source:
    image: "./containers/transcoder", // dir containing a Dockerfile (default path)
    // image: { registry: "docker.io/acme/transcoder:1.4" },  // pre-built
    // image: { build: "./services/transcoder" },              // Phase 2: railpack

    defaultPort: 8080,
    instanceType: "standard-1", // or { vcpu, memoryMib, diskMb }
    maxInstances: 5,
    sleepAfter: "5m",
    env: { LOG_LEVEL: "info" }, // static; secrets flow via .dev.vars / wrangler secrets
});
```

This mirrors `defineSchema`/`defineTable`: declarative config in `cirrus/`,
everything else generated. Convention: containers live in
`cirrus/containers.ts`, Dockerfiles under `containers/<name>/`.

### 3.2 Consumption: `ctx.containers` on **actions only**

```ts
export const transcode = action({
    args: { videoId: v.id("videos") },
    handler: async (ctx, { videoId }) => {
        // stateful: one instance per video
        const res = await ctx.containers.transcoder.get(videoId).fetch("/transcode", {
            method: "POST",
            body: JSON.stringify({ videoId }),
        });

        // stateless pool: random instance
        const pooled = await ctx.containers.transcoder.any().fetch("/probe");
    },
});
```

- Queries/mutations run inside `ShardDO` and must stay fast and deterministic
  — container calls are I/O-bound external work, so they belong on
  `ActionCtx`, exactly like `ctx.ai` (`@cirrus/ai` precedent; codegen-wired
  only when used).
- `.get(name)` wraps `getContainer`, `.any(n?)` wraps `getRandom`. The stub
  exposes `fetch`, plus lifecycle escape hatches (`start`, `stop`, `destroy`)
  for sandbox-style use cases.
- Scheduler interplay: a cron/`runAfter` action can drive batch containers —
  no new machinery needed.

### 3.3 Codegen

`@cirrus/codegen` discovers `cirrus/containers.ts` and emits into
`_generated/`:

1. A `Container`-extending DO class per definition
   (`class TranscoderContainer extends Container { defaultPort = 8080; sleepAfter = "5m"; … }`),
   re-exported from the worker entry so the binding actually resolves.
2. The typed `ctx.containers` surface on `ActionCtx` (only when containers
   exist, matching the `ctx.ai` pattern).
3. Binding names: `CONTAINER_TRANSCODER` ⇄ class `TranscoderContainer`
   (derived, stable, collision-checked against `SHARD`/`SESSION`/etc.).

### 3.4 Config: inference, reconciliation, validation (`@cirrus/config`)

Hook the existing seams (no new architecture):

| Seam                                      | Change                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/infer-bindings.ts`                   | New capability: `@cirrus/container` import + discovered `defineContainer` exports → inferred `containers[]` entries, DO bindings, migration classes.                                                                                                                                  |
| `src/reconcile-bindings.ts`               | Extend `WranglerShape` with `containers`; new `reconcileContainers()` writes `containers[]`, the DO bindings, and appends a `new_sqlite_classes` migration tag — idempotent like the existing DO reconciliation.                                                                       |
| `src/wrangler-validator.ts`               | Validate: every `containers[].class_name` has a matching DO binding **and** a sqlite migration; Dockerfile path exists (or ref looks like a registry image); `instance_type` is a known name or a custom object within Cloudflare's bounds; warn when `max_instances` is missing.      |

### 3.5 CLI (`@cirrus/cli`)

- `cirrus deploy` (existing 4-step pipeline in
  `packages/cli/src/commands/deploy/handler.ts`): add a **preflight Docker
  check** (`docker info`) when any container uses a Dockerfile source, with an
  actionable error ("install Docker or switch `image` to a registry ref").
  The actual build+push stays delegated to `wrangler deploy` — no custom
  pipeline.
- New `cirrus containers` subcommand group (thin wrappers, lazy-loaded like
  the rest): `build`, `push`, `images list`, `images delete` → forwarded to
  `wrangler containers …`. Main value: CI recipes ("build/push in one job,
  `cirrus deploy` in another") documented once.
- `vis generate cirrus-container --name=transcoder` internal template:
  scaffolds `containers/transcoder/Dockerfile` + AST-appends the
  `defineContainer` export to `cirrus/containers.ts`.

### 3.6 Vite / local dev (`@cirrus/vite`)

- `@cloudflare/vite-plugin` already runs containers in dev; we inherit that
  for free. Add to our doctor/validator layer:
  - Docker-not-running → friendly overlay error instead of a raw plugin crash.
  - Warn about the known caveats: no container hot-reload (press `r`),
    `EXPOSE` required locally, Cloudflare Registry refs not pullable in
    `vite dev`.
- Respect/forward `dev.enable_containers` and `dev.container_engine`.

### 3.7 Docs & templates

- New `apps/docs/content/docs/containers.mdx`: authoring, routing patterns
  (per-entity vs pool), pricing/limits, CI split, local-dev caveats.
- `deployment.mdx`: add the container build/push step to the deploy flow.
- A `templates/`-level example is **not** needed initially; an
  `examples/` app (e.g. ffmpeg thumbnailer or code-sandbox) demonstrates it
  better than baking containers into every starter.

---

## 4. Phasing

**Phase 1 — MVP (wrangler-native, Dockerfile + registry refs)**
`@cirrus/container` (`defineContainer` + ctx stubs) · codegen of Container DO
classes + `ctx.containers` · inference/reconcile/validation in
`@cirrus/config` · Docker preflight in `cirrus deploy` · docs + one example
app. *No new deploy infrastructure: wrangler does build, push, registry, dev.*

**Phase 2 — Build & ops ergonomics**
Railpack opt-in (`image: { build }`): run `railpack build` against a local
BuildKit (auto-bootstrapped `moby/buildkit` container when absent), tag, then
`wrangler containers push` and materialize the registry ref into a temp config
(same trick as the existing remote-bindings plugin) · `cirrus containers`
CLI group · CI guide · `vis generate cirrus-container`.

**Phase 3 — Beyond the platform**
Pool helpers with health/backoff on top of `getRandom` · poor-man's
autoscaling (scheduler-driven pool resize) until Cloudflare ships native
autoscaling · studio panel for container state (`getState()`) · advisor rules
(e.g. container fetch inside a query, missing `sleepAfter`, oversized
instance type).

## 5. Open questions

1. Package name: `@cirrus/container` (singular, matches `@cirrus/do`) vs
   `@cirrus/containers` (matches the platform name). Leaning singular.
2. Should `defineContainer` allow per-instance env at `start()` time in
   Phase 1, or is class-level `envVars` + secrets enough to start?
3. Where do container *secrets* land — reuse `.dev.vars` scaffolding from
   `@cirrus/config` (likely yes, zero new concepts)?
4. Do we expose WebSocket passthrough on the ctx stub in Phase 1 (the
   underlying `fetch` supports it) or defer until someone asks?
