# Cloudflare Containers in Cirrus — DX Plan

Status: Phases 1–3 implemented (one item deliberately deferred — see §4)
Date: 2026-06-12 (implementation 2026-06-13)

## Implementation status

- **Phase 1 — shipped.** `@cirrus/container` (`defineContainer`, `ctx.containers`),
  codegen of the Container DO classes + typed `ctx.containers`,
  inference/reconcile/validation in `@cirrus/config`, Docker preflight in
  `cirrus deploy`, the `cirrus containers` CLI group, the
  `vis generate cirrus-container` generator, and docs.
- **Phase 2 — shipped.** Railpack `image: { build }` source end-to-end:
  validated/normalized/discovered, the config reconciler writes the
  deterministic build tag, and `cirrus deploy` builds + pushes each build
  container (BuildKit preflight) before wrangler runs. Orchestration is
  injected-spawner unit-tested.
- **Phase 3 — shipped, except the Studio panel.** Resilient
  `ctx.containers.<name>.pool()` (retry + backoff), the container→Cirrus
  bridge (`@cirrus/container/bridge`), two advisor lints
  (`container_oversized_instance`, `container_public_internet`) that surface in
  Studio's existing **Advisors** table, and dev log correlation
  (`type: "container"` lifecycle events tagged by instance id).
    - **Deferred: a dedicated Studio container panel.** Cloudflare exposes no
      live container-instance state to a Worker, and `ShardDO` cannot enumerate
      container Durable Objects — so a panel could only restate the declared
      config already visible in `cirrus/containers.ts`. Container concerns
      instead surface through the Advisors table (the two lints above). A panel
      becomes worthwhile if/when Cloudflare ships an instance-state API or
      containers report health back via a callback.

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
            "rollout_active_grace_period": 300,
        },
    ],
    "durable_objects": {
        "bindings": [{ "name": "FFMPEG", "class_name": "FfmpegContainer" }],
    },
    "migrations": [{ "tag": "v2", "new_sqlite_classes": ["FfmpegContainer"] }],
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

### Runtime & operational facts (these shape our DX)

- **Images must be `linux/amd64`.** Biggest dev-machine footgun (Apple
  Silicon): builds need `--platform linux/amd64`. Our doctor/preflight should
  catch arm64 images before wrangler's error does.
- **Disk is ephemeral.** Fresh disk on every (re)start; persistence means R2
  (FUSE) or the upcoming snapshots. Natural tie-in for `@cirrus/storage`.
- **Cold starts: 1–3 s** (image-size dependent); the DO and its container are
  **not guaranteed co-located** — calls from actions must tolerate a network
  hop both ways.
- **Rolling deploys:** on update, instances get `SIGTERM`, then `SIGKILL`
  after 15 minutes. Container processes should handle SIGTERM (exec-form
  `ENTRYPOINT` in our scaffolded Dockerfiles, documented shutdown hooks).
- **OOM = restart**, no swap. Pick instance types accordingly.
- **Logs require `observability.enabled` in wrangler.jsonc** (7-day retention
  on Paid). `CLOUDFLARE_DURABLE_OBJECT_ID` and friends
  (`CLOUDFLARE_APPLICATION_ID`, `CLOUDFLARE_LOCATION`, `CLOUDFLARE_REGION`,
  `CLOUDFLARE_COUNTRY_A2`) are auto-injected for correlation.
- **Secrets:** Worker Secrets / Secrets Store, surfaced to the container via
  `envVars` (class-level) or per-instance env at `start()`. No separate
  container-secret system to integrate.
- **Containers can reach Worker bindings** (D1, R2, KV, DOs) via _outbound
  handlers_: plain HTTP from the container to virtual hostnames, intercepted
  and resolved inside the Workers runtime. The container can also address its
  own DO. (Big Phase 3 opportunity — see below.)
- **Egress control:** `enableInternet` on the Container class gates outbound
  internet access.

### Limits & pricing (for docs/limits.mdx)

- Instance types: `lite`, `basic`, `standard-1..4`; custom types up to
  4 vCPU / 12 GiB / 20 GB disk. Account caps: 1,500 concurrent vCPU,
  6 TiB memory, 30 TB disk (raisable via support).
- Requires Workers Paid ($5/mo). Billing starts at first request and stops at
  sleep (scale-to-zero). vCPU is **active-CPU** billed ($0.000020/vCPU-s,
  375 vCPU-min/mo included); memory ($0.0000025/GiB-s, 25 GiB-h included) and
  disk ($0.00000007/GB-s, 200 GB-h included) are billed on _provisioned_
  instance-type size while running.
- **Network egress is billed separately**: $0.025/GB NA+EU (1 TB/mo
  included), $0.05/GB Oceania/Korea/Taiwan, $0.04/GB elsewhere (500 GB/mo
  included) — worth a loud note in docs since Workers users aren't used to
  egress fees.

### What Cloudflare does _not_ provide (gaps we may want to fill)

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

**Fit for Cirrus:** good, as an _optional_ build strategy.

- Pro: `cirrus`-grade DX — "point `defineContainer` at `./services/transcoder`,
  no Dockerfile needed". Build locally → image lands in the Docker daemon →
  `wrangler containers push` → reference the pushed tag in `containers[].image`.
- Con: needs a running **BuildKit** instance (`BUILDKIT_HOST`, typically
  `docker run --privileged moby/buildkit`) _plus_ the `railpack` binary. That
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
    image: "./containers/transcoder", // dir → normalized to <dir>/Dockerfile + image_build_context=<dir>; a path ending in "Dockerfile" is used as-is
    // image: { registry: "docker.io/acme/transcoder:1.4" },  // pre-built
    // image: { build: "./services/transcoder" },              // Phase 2: railpack

    defaultPort: 8080,
    instanceType: "standard-1", // or { vcpu, memoryMib, diskMb }
    maxInstances: 5,
    sleepAfter: "5m",
    env: { LOG_LEVEL: "info" }, // static, baked into the generated class
    secrets: ["TRANSCODER_API_KEY"], // names of Worker secrets forwarded as env at DO construction
    // enableInternet defaults to true — the platform default. Turning egress
    // off by default would silently break containers that call external APIs;
    // an advisor rule (Phase 3) nudges instead when egress looks unused.
});
```

This mirrors `defineSchema`/`defineTable`: declarative config in `cirrus/`,
everything else generated. Convention: containers live in
`cirrus/containers.ts`, Dockerfiles under `containers/<name>/`.

Note on `--env`: `containers[]` is written at the top level like the other
reconciled bindings; per-environment container overrides are out of scope for
Phase 1 (same stance the reconciler already takes for DO/D1/AI bindings).

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

`@cirrus/codegen` discovers `cirrus/containers.ts` (new
`discoverContainers`, ts-morph based like `discoverAiUsage`) and emits
`_generated/containers.ts`:

1. One **thin** DO class per definition delegating to a runtime base so the
   emitted string template stays trivial and the behavior stays unit-testable
   in `@cirrus/container`:

    ```ts
    import { CirrusContainer } from "@cirrus/container";
    import { transcoder } from "../containers";

    export class TranscoderContainer extends CirrusContainer {
        constructor(ctx: DurableObjectState, env: Env) {
            super(ctx, env, transcoder); // applies defaultPort/sleepAfter/env and merges declared secrets from `env` into envVars
        }
    }
    ```

    The user's worker entry must re-export these (wrangler requires the DO
    class exported from the entry): templates/init add
    `export * from "./cirrus/_generated/containers"`, the class-A virtual
    worker injects it automatically, and binding inference — which already
    keys DO provisioning on entry exports — simply gains the generated class
    names, so a missing re-export surfaces as the existing actionable hint
    instead of a late wrangler error.

2. The typed `ctx.containers` surface on `ActionCtx` (only when containers
   exist, matching the `ctx.ai` pattern), built from the `CONTAINER_*` env
   bindings via a `containerClient(namespace)` helper in `@cirrus/container`.
3. Binding names: `CONTAINER_TRANSCODER` ⇄ class `TranscoderContainer`
   (derived from the export name, stable, collision-checked against
   `SHARD`/`SESSION`/`SCHEDULER`).

### 3.4 Config: inference, reconciliation, validation (`@cirrus/config`)

Hook the existing seams (no new architecture):

| Seam                        | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/infer-bindings.ts`     | New capability: `@cirrus/container` import + discovered `defineContainer` exports → inferred `containers[]` entries, DO bindings, migration classes.                                                                                                                                                                                                                                                                                                                                       |
| `src/reconcile-bindings.ts` | Extend `WranglerShape` with `containers`; new `reconcileContainers()` writes `containers[]`, the DO bindings, **appends a new migration tag** with `new_sqlite_classes` (never mutates an existing tag — DO migration tags are append-only), and sets `observability.enabled` **only when the key is absent** (an explicit `false` is a user billing decision and is respected, with a warning). Idempotent like the existing DO reconciliation.                                           |
| `src/wrangler-validator.ts` | Validate: every `containers[].class_name` has a matching DO binding **and** a sqlite migration; Dockerfile path exists (or ref looks like a registry image); `instance_type` is a known name or a custom object within Cloudflare's bounds; warn when `max_instances` is missing and when `observability` is off (container logs are invisible without it). `.any(n)` pool-size checks only apply when `n` is a literal — anything else is a Phase 3 advisor concern, not a validator one. |

### 3.5 CLI (`@cirrus/cli`)

- `cirrus deploy` (existing 4-step pipeline in
  `packages/cli/src/commands/deploy/handler.ts`): add a **preflight Docker
  check** (`docker info`) when any container uses a Dockerfile source, with an
  actionable error ("install Docker or switch `image` to a registry ref"),
  plus an **amd64 check** — registry refs and local builds must target
  `linux/amd64` (Apple Silicon is the common failure mode; our scaffolded
  Dockerfiles and any railpack invocation pass `--platform linux/amd64`
  explicitly). The actual build+push stays delegated to `wrangler deploy` —
  no custom pipeline.
- New `cirrus containers` subcommand group (thin wrappers, lazy-loaded like
  the rest): `build`, `push`, `images list`, `images delete` → forwarded to
  `wrangler containers …`. Main value: CI recipes ("build/push in one job,
  `cirrus deploy` in another") documented once.
- `vis generate cirrus-container --name=transcoder` internal template:
  scaffolds `containers/transcoder/Dockerfile` + AST-appends the
  `defineContainer` export to `cirrus/containers.ts`. The Dockerfile template
  bakes in the operational best practices: exec-form `ENTRYPOINT` (so
  `SIGTERM` reaches the process during rollouts), `EXPOSE` for the default
  port (required by local dev), and an amd64-safe base image.

### 3.6 Vite / local dev (`@cirrus/vite`)

- `@cloudflare/vite-plugin` already runs containers in dev; we inherit that
  for free. Add to our doctor/validator layer:
    - Docker-not-running → friendly overlay error instead of a raw plugin crash.
    - Warn about the known caveats: no container hot-reload (press `r`),
      `EXPOSE` required locally, Cloudflare Registry refs not pullable in
      `vite dev`.
- Respect/forward `dev.enable_containers` and `dev.container_engine`.

### 3.7 Testing story

Container workloads shouldn't be assumed runnable inside
`vitest-pool-workers` (and even where they are, requiring Docker in unit
tests is wrong), so the unit-test path cannot depend on Docker:

- `@cirrus/container` ships a **test double**: `ctx.containers.<name>` backed
  by a user-provided `fetch` handler (mirrors how `ctx.ai` is mocked). Action
  tests stay Docker-free and deterministic.
- Integration tests that need the real thing run against `wrangler dev` /
  `vite dev` with Docker present — gated in CI behind a label/conditional job
  so the default test matrix stays container-free.
- Our own package CI: the example app's container build runs in one dedicated
  workflow job (Docker is available on GitHub runners), not in every
  package's test run.

### 3.8 Docs & templates

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
app. _No new deploy infrastructure: wrangler does build, push, registry, dev._

**Phase 2 — Build & ops ergonomics**
Railpack opt-in (`image: { build }`): run `railpack build` against a local
BuildKit (auto-bootstrapped `moby/buildkit` container when absent), tag, then
`wrangler containers push` and materialize the registry ref into a temp config
(same trick as the existing remote-bindings plugin) · `cirrus containers`
CLI group · CI guide · `vis generate cirrus-container`.

**Phase 3 — Beyond the platform**
Pool helpers with health/backoff on top of `getRandom` · poor-man's
autoscaling (scheduler-driven pool resize) until Cloudflare ships native
autoscaling · **container→Cirrus bridge**: expose selected queries/mutations
to the container via the outbound-handler mechanism (the container calls a
virtual hostname, the handler resolves it inside the Workers runtime — a
typed client for container code, generated by codegen) · studio panel for
container state (`getState()`) + per-instance log correlation via
`CLOUDFLARE_DURABLE_OBJECT_ID` · dev-overlay log streaming for containers
(extend the existing log-stream plugin) · advisor rules (container fetch
inside a query, missing `sleepAfter`, oversized instance type,
`enableInternet` left on without egress use).

**Related, explicitly out of scope:** Cloudflare **Sandboxes** (GA alongside
Containers) is a higher-level SDK on top of Containers for AI code execution.
If/when `@cirrus/ai` wants code interpreters, it should consume Sandboxes
directly rather than us rebuilding it on `defineContainer`.

## 5. Decisions (formerly open questions)

1. **Package name: `@cirrus/container`** (singular). Matches the singular
   convention of `@cirrus/storage`/`@cirrus/scheduler`/`@cirrus/mail`, and
   avoids import-site confusion with `@cloudflare/containers`, which the
   generated code imports in the same files.
2. **Per-instance env: Phase 2.** Phase 1 ships class-level `env` +
   `secrets`; the platform's per-instance env at `start()` is exposed later
   as a non-breaking optional argument (`.get(id, { env })`) together with
   the sandbox-style use cases that actually need it. Retrofitting is cheap;
   shrinking an over-built API is not.
3. **Secrets reuse the existing pipeline.** `defineContainer({ secrets })`
   names Worker secrets; codegen forwards `this.env.<NAME>` into the
   container's `envVars`. Locally they come from `.dev.vars` (already
   scaffolded by `@cirrus/config`), in production from `wrangler secret` /
   Secrets Store. Zero new concepts, and the validator can check that
   declared secrets are scaffolded.
4. **WebSocket passthrough: Phase 1.** `Container.fetch()` already proxies
   WebSocket upgrades, so it's free to expose — and Cirrus is a real-time
   framework; shipping containers without WS would be off-brand. `ctx`-side
   API: just `fetch` with an `Upgrade` request, no separate method.
