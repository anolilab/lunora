# Plan 115 — AWS deploy target (same DX, same behavior, second cloud)

> **Source:** Multi-cloud strategy session (2026-07-03). Companion to
> **plan 114** (platform abstraction layer), which is a hard prerequisite:
> this plan implements the `ShardHost`/`SocketHost`/`SchedulerHost`/
> `DeployDriver` contracts 114 defines, on AWS. Competitive trigger: AWS
> shipped **AWS Blocks** (June 2026 preview) — see §1 for the analysis and
> what we borrow vs. reject.
>
> **Positioning:** AWS Blocks validates the DX space (typed backend,
> infra-from-code, local-first dev) but its realtime is best-effort pub/sub
> with no reactive queries, no OCC, no cross-block transactions. "The same
> app, deployed to Cloudflare or AWS, with reactive consistency neither
> platform gives you natively" is a stronger pitch than either single-cloud
> story — **iff** we preserve the behavioral contract (114 §3), not just the
> API shape.

## 1. AWS Blocks analysis (what exists, what to borrow)

Repo: `aws-devtools-labs/aws-blocks` (Apache-2.0, TS, preview; docs at
`docs.aws.amazon.com/blocks`). Core model:

- A **Block** = one npm package bundling runtime code + a **local
  implementation** + the **CDK construct** that provisions it.
  `new KVStore(scope, 'todos')` is an in-memory store under `npm run dev`, a
  DynamoDB table at synth, DynamoDB SDK calls in Lambda.
- Switching mechanism: **Node conditional exports with custom conditions**
  (`cdk`, `aws-runtime`) — same import, different file per context.
- **IFC layer** (`aws-blocks/index.ts`): backend entry that is simultaneously
  local server, infra definition, and Lambda handler. `ApiNamespace` = typed
  frontend→backend RPC, no codegen. Optional `index.cdk.ts` escape hatch for
  raw CDK constructs.
- **Sandbox**: `npm run sandbox` = per-developer ephemeral AWS stack with
  Lambda hot-swap (seconds); `sandbox:destroy` tears down.
- Blocks: `KVStore`/`DistributedTable`/`Database` (DynamoDB et al.),
  `FileBucket` (S3), `AuthBasic/AuthCognito/AuthOIDC`, `AsyncJob`/`CronJob`,
  `Agent`/`KnowledgeBase`, `Realtime`, `EmailClient`, observability blocks,
  `Hosting`. Native client codegen (Kotlin/Swift/Dart) from `blocks.spec.json`.
- **Realtime block** = API Gateway WebSocket + DynamoDB;
  `publish`/`subscribe`/`getChannel` over Zod-typed namespaces; **delivery is
  best-effort, no buffering, no query reactivity**. Warning in their docs:
  renaming a Block ID deletes+recreates the resource (data loss) — resource
  identity is a real footgun we must handle better (§4).

**Borrow:** the sandbox concept (per-dev ephemeral stack, hot-swap), the
CDK-escape-hatch shape (user-extendable generated stack), infra-from-code
discipline (we already do this via binding inference — plan 114 §5.3).
**Reject:** conditional-exports switching (codegen + DI already covers it,
plan 114 D1) and their realtime model (far below Lunora's contract).

## 2. Strategy decision — how to host the shard tier on AWS

The entire difficulty concentrates in replacing the ShardDO (114 §3: single
writer per key, storage colocated with compute, hibernated sockets,
transactions, op-log pokes). Options evaluated:

### 2.1 REJECTED (unless spike surprises): self-host workerd on AWS

Run Cloudflare's OSS runtime (Apache-2.0, supports Workers + DOs) on an
ECS/EC2 fleet. Near-perfect parity, zero engine changes — but you inherit the
control plane Cloudflare does **not** open-source: DO placement/migration,
durable storage replication, and **WebSocket hibernation, which is a platform
feature, not part of OSS workerd**. You rebuild the hard parts underneath
workerd instead of beside it. Keep as a 1-day sizing spike; expect to
document as investigated-and-rejected.

### 2.2 REJECTED: serverless decomposition

Lambda + SQS FIFO (message-group = shard) for serialized mutations + DynamoDB
/Aurora state + API Gateway WS + DynamoDB connection registry. Every reactive
re-run becomes a Lambda invocation reading **remote** storage; read-set
tracking's economics die (114 §3 note); fan-out = N `PostToConnection` calls;
`TransactWriteItems` changes the OCC shape; hibernated-socket semantics
disappear. Ships something measurably different → violates "same behavior".

### 2.3 RECOMMENDED: stateful single-writer actor fleet (Node host)

An ECS/Fargate (or EC2 ASG) fleet running a **Node host of the extracted
engine** (114 §5.2):

- **Shard ownership:** lease table (DynamoDB conditional writes) + consistent-
  hash routing; at-most-one active owner per shard key. Lease fencing tokens
  guard against split-brain writes.
- **Storage:** embedded SQLite per shard on local NVMe/EBS, continuously
  replicated to S3 (Litestream-style WAL shipping) for durability; restore-on-
  ownership-move. Keeps reads in-process → read-set tracking, OCC CAS, and
  `transaction()` semantics carry over ~1:1.
- **Sockets:** WebSockets terminate on the same fleet behind an NLB; the
  engine's in-memory socket set and relay tier work as on CF. "Hibernation"
  becomes ordinary idle sockets on a long-lived process + attachment state
  persisted so an ownership move can migrate/resume subscriptions.
- **Stateless work:** `action`s (and optionally cold queries) can run on
  Lambda; only the shard tier is stateful.
- Fits the scale-invisibly principle: all of this is CDK-generated and
  autoscaled; the user sees `lunora deploy --target aws`.

### 2.4 SPIKE FIRST: build 2.3 on an existing OSS actor platform

Before hand-rolling 2.3, spike **Rivet Actors** (positions itself as
open-source Durable Objects; DO-like state/alarms/WebSockets; runs on own
infra) as the `ShardHost` implementation — if its DO-compat is real it
collapses the hardest workstream, and the 114 seam keeps it swappable.
Also evaluated: **Restate** (virtual objects give per-key serialization +
durable state, but KV-shaped state can't hold a SQLite DB per shard →
reactive engine rework; decline unless Rivet fails), **Temporal/DBOS**
(durable execution, wrong shape for realtime; rejected).

### 2.5 LATER (separate plan): Postgres-native backend

Aurora/RDS/Neon with `pg_advisory_xact_lock(hash(shardKey))` for per-shard
single-writer, logical-replication CDC → poke service, table-level
invalidation. Least infra to operate, most behavioral drift (remote reads →
coarser reactivity, different OCC shape). A legitimate **second** AWS backend
for "just RDS" shops, but starting with it means maintaining two consistency
models forever. Out of scope here; file separately if demanded.

## 3. Service mapping (capability matrix seed)

| Lunora surface                       | Cloudflare                  | AWS mapping                                                                                                                                                                       | Tier                                    |
| ------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Shard tier (`ctx.db`, subs, shapes)  | Durable Objects (SQLite)    | §2.3 actor fleet (ECS/Fargate + SQLite + S3 WAL) or Rivet (§2.4)                                                                                                                  | native (via our tier)                   |
| `.global()` tables                   | D1 + Sessions API           | Aurora Postgres / RDS (dialects **already exist**: `postgresDialect`/`mysqlDialect` in `packages/hyperdrive/src/global-dialect.ts`); read-your-writes via a session/bookmark shim | native                                  |
| WebSocket transport                  | CF edge + hibernation       | NLB → actor fleet (sockets colocated)                                                                                                                                             | emulated (no hibernation billing model) |
| `ctx.kv`                             | Workers KV                  | DynamoDB (or ElastiCache) behind `KVNamespaceLike`                                                                                                                                | native                                  |
| `ctx.storage` (R2)                   | R2                          | S3 (R2 is S3-compatible; mostly config) + presigned URLs                                                                                                                          | native                                  |
| `ctx.queues`                         | Queues                      | SQS (FIFO where ordering declared); consumer = Lambda or fleet worker                                                                                                             | native                                  |
| `@lunora/workflow`                   | CF Workflows                | Step Functions **or** fleet-native durable execution — own design pass; Step Functions' step semantics ≠ CF's memoized `step.do`                                                  | emulated                                |
| `@lunora/scheduler`                  | SchedulerDO + Cron Triggers | EventBridge Scheduler → invokes shard tier; cron via EventBridge rules                                                                                                            | native                                  |
| `ctx.ai`                             | Workers AI (AI SDK v6)      | Bedrock via `@ai-sdk/amazon-bedrock` — nearly free, `@lunora/ai` is provider-agnostic already                                                                                     | native                                  |
| `ctx.vectors`                        | Vectorize                   | S3 Vectors / OpenSearch Serverless                                                                                                                                                | emulated                                |
| `ctx.mail`                           | Resend transport            | SES `MailTransport` (~20 lines per audit)                                                                                                                                         | native                                  |
| `ctx.containers`                     | CF Containers               | ECS tasks (`defineContainer` → task defs)                                                                                                                                         | emulated                                |
| `ctx.sql` (Hyperdrive)               | Hyperdrive binding          | RDS Proxy; driver adapters (`fromNodePg`/`fromPostgresJs`/`fromMysql2`) unchanged                                                                                                 | native                                  |
| `ctx.analytics`                      | Analytics Engine            | Kinesis Firehose → Timestream/Athena                                                                                                                                              | emulated                                |
| `ctx.pipelines` / `ctx.r2sql`        | Pipelines / R2 SQL          | Firehose / Athena                                                                                                                                                                 | emulated                                |
| `ctx.images`                         | Cloudflare Images           | S3 + Serverless Image Handler / Lambda@Edge                                                                                                                                       | emulated                                |
| `ctx.browser`                        | Browser Rendering           | no clean managed equivalent                                                                                                                                                       | **unsupported** (v1)                    |
| `ctx.flags`                          | Flagship provider           | OpenFeature stays; AWS AppConfig provider slot-in                                                                                                                                 | native                                  |
| `ctx.secrets`                        | Secrets Store               | AWS Secrets Manager / SSM Parameter Store                                                                                                                                         | native                                  |
| Jurisdiction pinning                 | DO jurisdictions            | region pinning via placement hints (coarser)                                                                                                                                      | emulated                                |
| PITR                                 | DO storage PITR             | S3-versioned WAL snapshots (coarser granularity)                                                                                                                                  | emulated                                |
| Auth (`@lunora/auth`)                | D1-backed AuthStore         | `AuthStore`/`SqlExecutor` over Aurora/RDS (only `d1Executor` is CF-specific)                                                                                                      | native                                  |
| Payments / ratelimit / observability | adapters                    | already provider-neutral (`PaymentAdapter`, `RateLimitStore`, `ObservabilitySink` → CloudWatch sink)                                                                              | native                                  |

The 8 hardest replications, per the coupling audit: single-writer-per-key with
lock-free local state; storage colocated with compute; hibernated WS at scale;
in-process `getWebSockets()` enumeration; `storage.transaction()` semantics;
the DO-shaped scheduler; the wrangler/vite toolchain trio; relay tier +
jurisdiction pinning. §2.3 answers the first five with one component (the
actor fleet); the rest are the toolchain (§4) and scheduler (§3 row) work.

## 4. Toolchain — `@lunora/aws` deploy driver

Implements plan 114's `DeployDriver` (114 §5.3):

- **Emission:** inferred resource graph → a **generated CDK app** (synthesized
  into the project, user-extendable via an `index.cdk.ts`-style escape hatch —
  the one aws-blocks idea worth copying directly). Resource **identity must be
  stable** across renames where possible (learn from their Block-ID data-loss
  footgun: derive physical names from schema identity + explicit migration
  path, warn via advisor lint on rename).
- **CLI:** `lunora deploy --target aws` → `cdk deploy` through the existing
  spawn injection (`packages/cli/src/util/spawn.ts`); `lunora sandbox` /
  `sandbox destroy` = per-dev ephemeral stack with Lambda/fleet hot-swap;
  `secret put` → Secrets Manager; `tail` → CloudWatch Logs tail.
- **Local dev:** the Node actor host **is** the local dev server for
  `target: "aws"` — better prod parity than miniflare-for-AWS, and it double-
  serves as the conformance-suite host (114 §5.4) and a workerd-free test
  runner for the whole repo. `@lunora/vite` gains an AWS mode that skips
  `@cloudflare/vite-plugin` (the `cloudflare: false` opt-out already exists at
  `packages/vite/src/index.ts:151`) and mounts the Node host.
- **Config:** no `wrangler.jsonc`; the driver reconciles a
  `lunora.aws.jsonc` (or CDK context) equivalent; `.dev.vars` grammar is
  provider-neutral and carries over.

## 5. Phasing

Prereqs: plan 114 phases 0–2 (contracts + TCK + engine extraction) for phase
1 below; 114 phases 3–4 (deploy driver interface + codegen targets) for
phases 3–5.

One prereq is only half-done and phase 1 is where it bites: 114 §5.5 gates the
emitted `ctx.*` surface on the target but **not the emitted host entry**, and
`lunorash` depends on `@lunora/do` (hence `@lunora/platform-cloudflare`)
unconditionally. So an `aws` target today would still emit a `ShardDO` subclass
and still install the Cloudflare host. That is deliberate — with one host the
switch would be a seam nothing exercises — but phase 1 must land it alongside the
Node host, not assume it. See 114 §5.5 for why the fix is codegen (D1) rather
than making `@lunora/platform-cloudflare` an optional dependency (D2).

| Phase | Work                                                                                                                                                           | Gate                                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 0     | **Spikes (timeboxed):** (a) Rivet-as-ShardHost 2–3 days; (b) workerd-self-host sizing 1 day; (c) Litestream-style SQLite WAL→S3 restore drill 1–2 days         | Written verdict per spike; pick §2.3 hand-rolled vs. Rivet-backed                                         |
| 1     | **Node actor host** of the extracted engine (single process: leases, local SQLite, sockets); no AWS yet                                                        | Passes the 114 TCK 100%; repo test suites runnable on it without workerd                                  |
| 2     | **Distribution:** lease table + fencing, consistent-hash routing, S3 WAL replication + ownership-move restore, NLB socket path                                 | TCK green under forced ownership-moves + fault injection (kill -9 owner mid-mutation → no lost/dup write) |
| 3     | **`@lunora/aws` deploy driver:** CDK emission, `deploy`/`sandbox`/`secret`/`tail`, Vite AWS mode + local Node-host dev                                         | Playground app deploys + runs e2e on a real AWS account; sandbox create/destroy < 2 min                   |
| 4     | **Binding add-ons** per §3 mapping (KV/S3/SQS/SES/Bedrock/Secrets first; scheduler via EventBridge)                                                            | Per-binding conformance tests; capability matrix published; codegen enforces unsupported surfaces         |
| 5     | **Parity hardening:** `.global()` read-your-writes shim, relay tier on fleet, region pinning, PITR-equivalent snapshots; docs + template (`init --target aws`) | Full TCK + e2e matrix green on both clouds in CI (sandbox account)                                        |

Workflows (`@lunora/workflow` → Step Functions vs. fleet-native) is **explicitly
deferred** to its own plan — the step-memoization semantics don't map 1:1 and
deserve a dedicated design.

## 6. Risks & STOP conditions

- **STOP (phase 2)** if lease-fencing cannot rule out split-brain double-writes
  under partition in the fault-injection gate — the consistency story is the
  product; do not ship "usually single-writer".
- **STOP (phase 0/1)** if the engine (post-114-extraction) still needs CF-only
  semantics the Node host can't express — feed back into 114's interfaces
  rather than forking the engine.
- **Risk — operational surface:** an actor fleet is servers; we own upgrade,
  autoscale, and restore paths. Mitigation: CDK-managed, TCK + fault drills in
  CI, and the managed-control-plane option (Lunora Cloud deploying into the
  user's AWS account, SST-Console-style) as a product decision layered on the
  same driver — not a replacement for self-serve.
- **Risk — latency profile differs** (NLB hop, no edge PoPs). Publish honest
  numbers; don't claim CF-edge latency on AWS.
- **Risk — cost of parity drift over time.** Controls: capability matrix is
  code (codegen-enforced), TCK runs both hosts in CI, and the plan-template
  "platform parity" section (114 §5.6) gates every new feature.
- **Dependency risk (if Rivet path chosen):** external roadmap coupling —
  acceptable only behind the `ShardHost` seam with the hand-rolled fallback
  design kept current.

## 7. Open questions

1. Rivet vs. hand-rolled (phase 0 decides). Secondary: if Rivet, self-hosted
   only or also their cloud?
2. Fleet runtime: ECS/Fargate (simpler ops, slower ownership moves) vs. EC2
   ASG with local NVMe (faster SQLite, more ops). Lean Fargate first.
3. `.global()` on AWS: Aurora Serverless v2 vs. Aurora DSQL vs. RDS — pick per
   read-your-writes + connection-model needs (Sessions-API bookmark shim).
4. Does `lunora init` grow `--target aws` templates in v1, or is AWS
   migrate-an-existing-app only at first?
5. Sandbox account strategy for CI e2e (cost ceiling, teardown guarantees).
6. Native-client codegen (aws-blocks ships Kotlin/Swift/Dart) — out of scope
   here, but the `blocks.spec.json` idea overlaps with our OpenRPC surface;
   revisit after GA.
