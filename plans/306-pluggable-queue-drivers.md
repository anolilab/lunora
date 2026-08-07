# Plan 306 — A pluggable queue-driver package, so a deployment picks its own backend

**Baseline:** `75a1b7a7b` (2026-08-07)
**Status:** TODO
**Priority:** P2 · **Effort:** L · **Risk:** MED · **Category:** platform/queues

> **Executor instructions**: §4 records the decisions and the alternatives they
> beat — read it before changing the contract in §3.2, or the same options get
> re-litigated. The STOP conditions in §8 are the ones that mean the design is
> wrong rather than incomplete.

## 0. Headline finding

**No general-purpose Node job library delivers a batch whose members settle
independently.** Twelve were checked (§1.3). Every one is one-job-per-handler:
the handler's return value or throw settles a single job.

`@lunora/queue` is message-shaped instead — a consumer receives a batch and
decides each message's fate separately. That one difference is why no library
can be dropped in, and why the adapters worth writing are **message-broker**
adapters (SQS, Pub/Sub, Service Bus, AMQP, JetStream), not job-library wrappers.
Batch-with-partial-settle is a broker feature, which is unsurprising: Cloudflare
Queues is modelled on that tier.

The corollary sizes the work. Batch assembly, the implicit-ack rule, `attempts`
accounting and the dead-letter threshold have to live **above** any adapter
regardless of backend. That engine already exists — inside
`createNodeQueueHost` (`packages/platform-node/src/node-queue-host.ts:299-390`).
Extracting it is most of the first release; the SQLite adapter then falls out as
the thinnest possible implementation and doubles as the TCK's reference.

## 1. Current state (audit)

### 1.1 The contract, as it stands today

| Element                                                                                                  | Location                                        |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `QueueBindingLike` (producer: `send` / `sendBatch`)                                                      | `packages/platform/src/bindings.ts:419`         |
| `MessageLike` (`ack`, `retry`, `attempts`, `body`, `id`, `timestamp`)                                    | `packages/platform/src/bindings.ts:425`         |
| `MessageBatchLike` (`messages`, `queue`, `ackAll`, `retryAll`)                                           | `packages/platform/src/bindings.ts:437`         |
| `MessageSendRequestLike` (batch entry: `body`, `contentType`, `delaySeconds`)                            | `packages/platform/src/bindings.ts:408`         |
| `QueueContentType` = `bytes \| json \| text \| v8`                                                       | `packages/platform/src/bindings.ts:391`         |
| `QueueSendOptions` / `QueueRetryOptions`                                                                 | `packages/platform/src/bindings.ts:394`, `:448` |
| `QueueConsumerTuning` (`maxBatchSize`, `maxBatchTimeout`, `maxRetries`, `retryDelay`, `deadLetterQueue`) | `packages/queue/src/types.ts:72`                |
| `QueueConsumerMode` = `push \| pull`                                                                     | `packages/queue/src/types.ts:66`                |
| `dispatchQueueBatch` — routes a batch to the declared handler                                            | `packages/queue/src/dispatch.ts:289`            |

### 1.2 The two backings that exist

- **Cloudflare** — Cloudflare Queues, rated `native`
  (`packages/platform/src/capabilities.ts:95`).
- **Node** — a `better-sqlite3` table, rated `emulated`
  (`packages/platform/src/capabilities.ts:180`), implemented at
  `packages/platform-node/src/node-queue-host.ts`. Schema at `:183`, batch
  assembly at `:299`, settlement at `:232`.

Neither is a choice a user makes. A Node deployment already running Postgres,
Redis or SQS still gets the SQLite table. That is correct for one process and
wrong for several: SQLite has a single writer, so consumers contend once they
outnumber cores, and it cannot span machines at all.

### 1.3 Provider survey

Checked 2026-08-07. Download figures are npm monthly, quoted as a maintenance
signal only, not a recommendation.

#### Maps cleanly — receive-batch plus per-message settle is native

| Backend               | Client                                                                                                            | Batch receive                                                                                                               | Per-message settle                                                                                                                                                                                                                                              | Delay                                                                                   | DLQ                                                                                                                      | Visibility    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------- |
| **AWS SQS**           | [`@aws-sdk/client-sqs`](https://www.npmjs.com/package/@aws-sdk/client-sqs) (40M)                                  | [`ReceiveMessage`](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html) ≤10       | [`DeleteMessageBatch`](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_DeleteMessageBatch.html) / [`ChangeMessageVisibility`](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ChangeMessageVisibility.html) | `DelaySeconds` ≤15min                                                                   | [redrive policy](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html) | native        |
| **Google Pub/Sub**    | [`@google-cloud/pubsub`](https://www.npmjs.com/package/@google-cloud/pubsub) (23M)                                | [pull with `maxMessages`](https://cloud.google.com/pubsub/docs/pull)                                                        | per-message `ack()` / `nack()`                                                                                                                                                                                                                                  | publish schedule                                                                        | [dead-letter topic](https://cloud.google.com/pubsub/docs/handling-failures)                                              | ack deadline  |
| **Azure Service Bus** | [`@azure/service-bus`](https://www.npmjs.com/package/@azure/service-bus) (2.8M)                                   | [`receiveMessages(maxCount)`](https://learn.microsoft.com/azure/service-bus-messaging/service-bus-nodejs-how-to-use-queues) | `complete` / `abandon` / `deadLetter`                                                                                                                                                                                                                           | `scheduledEnqueueTime`                                                                  | [native sub-queue](https://learn.microsoft.com/azure/service-bus-messaging/service-bus-dead-letter-queues)               | lock duration |
| **RabbitMQ / AMQP**   | [`amqplib`](https://www.npmjs.com/package/amqplib) (12M), [`rascal`](https://www.npmjs.com/package/rascal) (196k) | [`prefetch(n)`](https://www.rabbitmq.com/docs/consumer-prefetch)                                                            | per-delivery `ack` / `nack`                                                                                                                                                                                                                                     | [delayed-message plugin](https://github.com/rabbitmq/rabbitmq-delayed-message-exchange) | [dead-letter exchange](https://www.rabbitmq.com/docs/dlx)                                                                | consumer ack  |
| **NATS JetStream**    | [`@nats-io/jetstream`](https://www.npmjs.com/package/@nats-io/jetstream) (1.3M)                                   | [`fetch({ batch })`](https://docs.nats.io/nats-concepts/jetstream/consumers)                                                | `ack()` / `nak(delay)`                                                                                                                                                                                                                                          | `nak` with delay                                                                        | `max_deliver` + advisory                                                                                                 | ack wait      |
| **SQLite**            | [`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3)                                                  | shipped                                                                                                                     | shipped                                                                                                                                                                                                                                                         | shipped                                                                                 | shipped                                                                                                                  | shipped       |

SQS is the closest of all — near enough 1:1 that it is the right second adapter
for flushing out contract mistakes. Note its delay cap is **15 minutes** against
Cloudflare's 12 hours (§8, risk 2).

#### Maps with work

| Backend      | Client                                                                                                                                                                                               | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Postgres** | [`pg-boss`](https://pgboss.io/) (4.7M, MIT, `node >=22.12`)                                                                                                                                          | advertises batch work and "dead letter queues with redrive"; the exact option names were **not** confirmable from its published README (4,288 chars, no hits for `batchSize`/`deadLetter`/`startAfter`) — verify against [pgboss.io](https://pgboss.io/) before adapting. Alternative: raw [`SELECT … FOR UPDATE SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE), which gives full control at the cost of owning the schema |
| **MySQL**    | —                                                                                                                                                                                                    | `SELECT … FOR UPDATE SKIP LOCKED` since 8.0; same shape as raw Postgres                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Kafka**    | [`@confluentinc/kafka-javascript`](https://www.npmjs.com/package/@confluentinc/kafka-javascript) (3.6M, active), [`kafkajs`](https://www.npmjs.com/package/kafkajs) (14M but last published 2023-02) | [`eachBatch`](https://kafka.js.org/docs/consuming#a-name-each-batch-a-eachbatch) gives the batch, but offsets have no per-message ack: a partial settle means committing the lowest un-acked offset and reprocessing the rest. See §9 Q2                                                                                                                                                                                                                                |

#### Job-shaped — the batch layer would have to be rebuilt

| Library                                                                | Downloads | Why it does not fit                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`bullmq`](https://docs.bullmq.io/)                                    | 31M       | one job per worker; no batch, lock rather than visibility window, DLQ is the failed set                                                                                                                             |
| [`@openqueue/sdk`](https://github.com/quickbits-io/openqueue)          | small     | **the right idea** — a "world" abstraction with `world-bullmq` / `world-postgres` drivers; read it for the seam shape (§4.3). No batch delivery, no documented DLQ or visibility timeout, pre-1.0, CLI requires Bun |
| [`@platformatic/job-queue`](https://github.com/platformatic/job-queue) | small     | no delay, no batch, no DLQ; requires a caller-supplied id, which defeats its own dedup when used as a message queue                                                                                                 |
| [`@boringnode/queue`](https://github.com/boringnode/queue)             | 28k       | has delay (`.in('30s')`) and backoff strategies, but no batch, no DLQ, and `engines.node >= 24.0.0` against this repo's `^22.15.0 \|\| >=24.11.0`                                                                   |
| [`glide-mq`](https://github.com/avifenesh/glide-mq)                    | small     | closest on features (batch, DLQ, delay, per-message ack) but requires a Valkey/Redis 7+ server plus a Rust NAPI binding; v0.15.4                                                                                    |
| [`sidequest`](https://github.com/sidequestjs/sidequest)                | 8k        | no batch, and **LGPL-3.0-or-later** against this repo's FSL-1.1-Apache-2.0 — a licensing question, not a preference                                                                                                 |
| [`liteque`](https://github.com/karakeep-app/liteque)                   | 9k        | SQLite-backed and peers on `better-sqlite3`, but no delay, no batch, no retry-with-delay; pulls `drizzle-orm` + `zod`                                                                                               |
| [`plainjob`](https://www.npmjs.com/package/plainjob)                   | 1k        | `better-sqlite3` + `cron-parser` only, has `{ delay }` and cron — but **no retry at all**, no batch, no DLQ; v0.0.14, last published 2024-10                                                                        |
| `bee-queue`, `@queuert/sqlite`, `better-queue-sqlite`, `bunqueue`      | —         | Redis-only, framework-coupled, unmaintained since 2022, or Bun-targeted                                                                                                                                             |

## 2. Existing seams (do not reinvent)

- **`dispatchQueueBatch`** (`packages/queue/src/dispatch.ts:289`) already owns
  routing a batch to its declared handler, the disposition-recording proxies,
  and the capture sink. An adapter package must feed it, never replace it.
- **`@lunora/platform/conformance`** is the established pattern for gating
  multiple implementations of one contract. The adapter TCK copies its shape
  rather than inventing a second testing idiom.
- **`createNodeQueueHost`** is the reference semantics. Its batch assembly
  (`:299`) and settlement (`:232`) are the code to extract, not to rewrite.
- **`PlatformCapabilities`** (`packages/platform/src/capabilities.ts`) is where a
  backend's support level is declared. §6.

### 2.1 The repo already has this pattern three times — match one

Three vocabularies exist, and they are not interchangeable:

| Term       | Means                                                                       | Examples                                                                                                                             |
| ---------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `*Driver`  | a **deploy target**                                                         | `DeployDriver` (`packages/config/src/deploy-driver.ts:208`), `cloudflare-driver.ts`, `node-driver.ts`                                |
| `*Adapter` | a **stateless translator** between a provider's API and Lunora's vocabulary | `PaymentAdapter` (`packages/payment/src/adapter.ts:47`), `@lunora/replica`'s SQLite adapters, `@lunora/hyperdrive`'s driver adapters |
| `*Store`   | **pluggable persistence** behind one contract                               | `RateLimitStore` (`packages/ratelimit/src/types.ts:100`), `@visulima/workflow`'s `WorkflowStore`                                     |

`@lunora/payment` is the closest analogue and the one to copy, because it solves
the same problem — one contract, five providers with genuinely different
capabilities:

- **`readonly identifier: ProviderId`** — a stable string per adapter
  (`adapter.ts:79`), so logs and errors name the backend.
- **`readonly capabilities: ProviderCapabilities`** (`types.ts:37`) — a _named
  interface_, not an inline object literal, "encoded in types so tax/UX
  assumptions aren't tribal knowledge".
- **Optional methods carry "this provider cannot do X"**, each documented with
  what the facade does instead — `checkEntitlement?`, `getBalances?`,
  `reportUsage?` (`adapter.ts:58-89`). This is the house idiom, and it is better
  than a boolean: an absent method cannot be called by mistake, where
  `supportsPartialSettle: false` can.
- **"Adapters never own state"** (`adapter.ts:42`) — durable state lives in the
  store the facade owns, not in the adapter.
- `@experimental` on every exported member while the surface is settling.

Subpath exports differ between the two precedents: `@lunora/payment` uses flat
provider names (`./stripe`, `./polar`), `@lunora/replica` nests
(`./adapters/better-sqlite3`). Payment's is the larger and newer; §10 follows it.

Disposal: the repo uses **synchronous `Symbol.dispose` delegating to a
`close()`** (`packages/platform-node/src/node-platform.ts:31`), not
`asyncDispose`. §10 diverges deliberately and says why.

### 2.2 External prior art, read at source

[`@openqueue/sdk`](https://github.com/quickbits-io/openqueue) is the only one of
the surveyed projects that solves the _pluggable-backend_ problem rather than the
queue problem, so its contract was read rather than skimmed
([`packages/core/src/world.ts`](https://github.com/quickbits-io/openqueue/blob/main/packages/core/src/world.ts),
[`packages/core/src/transport/types.ts`](https://github.com/quickbits-io/openqueue/blob/main/packages/core/src/transport/types.ts)).
Four things are worth taking, and one confirms a decision here:

- **A spec version with a runtime guard.** `WORLD_SPEC_VERSION` plus
  `validateWorld()`, which rejects a mismatched world with "upgrade the packages
  in lockstep" rather than failing at the first missing method. A third-party
  adapter compiled against an older contract is exactly the failure this
  prevents, and §10 had no answer for it. **Adopt.**
- **Capabilities enforced before dispatch, not documented.**
  `assertCapability(transport, 'delay')` throws a typed
  `UnsupportedCapabilityError` naming the transport, and core calls it _before_
  reaching for the matching method — "so an unsupported call fails with a typed
  error instead of silently degrading". Stronger than a docstring, and stronger
  than optional methods alone. **Adopt alongside** the `PaymentAdapter`
  optional-method idiom: optional methods for shape, `assertCapability` for the
  flags that are not method-shaped (delay ceilings, partial settle).
- **Migrations belong to the adapter that owns schema.** `WorldMigrations` —
  committed `steps` with checksums plus a `status()` probe — "present only on
  worlds that own durable SQL state". §10 had nothing here, and both the SQLite
  and Postgres adapters own a schema. **Adopt as an optional member.**
- **Import-cleanliness is a stated constraint.** Their world module "pulls in no
  ioredis/bullmq — so `@openqueue/core/world` can be consumed by third-party
  transports without dragging the Redis stack into their bundle". The same must
  hold here: the contract entry point must not import any backend client, or
  every consumer pays for all of them. **Adopt as a gate**, not a convention.

**What confirms §4.2:** their delivery interface is
`consume(queue, options): TransportConsumer` where `options.process(job)` takes
**one job**. Having chosen subscribe/handle, the design cannot express a batch
whose members settle separately — the same wall every job library hits (§0). It
is the clearest available evidence that receive/settle is the right shape for
this contract, from the project that went furthest in the other direction.

## 3. The behavioural contract to preserve

### 3.1 Delivery semantics — assertable as written

1. A consumer receives up to `maxBatchSize` messages, or fewer once
   `maxBatchTimeout` has elapsed since the oldest pending message.
2. Each message settles independently: explicit `ack()` or
   `retry({ delaySeconds })` wins; an undecided message is an **implicit ack when
   the handler returns** and a **retry when it throws**.
3. `attempts` counts deliveries, is visible to the handler, and reaching
   `maxRetries` routes the message to `deadLetterQueue` if declared. With none
   declared the message is **parked, never dropped** — a vanished message is what
   makes a queue impossible to debug.
4. `delaySeconds` is honoured on `send`, `sendBatch` and `retry`, and is
   `0–43200` (12 hours) at the contract level.
5. An in-flight message becomes visible again if its consumer dies.
6. All four content types round-trip; `v8` is the only one that survives a `Map`.
7. `mode: "pull"` queues accept sends and are never consumed by a push adapter.

### 3.2 What must not change

- The public shapes in `packages/platform/src/bindings.ts:391-450`. An adapter
  package is additive; it does not get to widen `MessageLike`.
- `dispatchQueueBatch`'s signature and the implicit-ack rule it encodes.
- `createNodeQueueHost`'s observable behaviour — its 9 tests
  (`packages/platform-node/__tests__/node-queue-host.test.ts`) must pass
  unchanged after the extraction in W1. That is the gate proving the refactor
  was behaviour-preserving.

## 4. Design decisions

### 4.1 The engine lives above the adapter

**Chosen:** batch assembly, implicit-ack, `attempts`, `maxRetries` → DLQ are
shared code; an adapter implements transport only.

**Over:** each adapter implementing the full contract. Rejected because it
guarantees five subtly different implementations of the implicit-ack rule, and
because backends that _do_ have native batching (SQS, Service Bus) have
different caps than the contract — reconciling that per adapter is where the
divergence would start.

### 4.2 Adapter contract is receive/settle, not subscribe/handle

**Chosen:** `receive(queue, max, visibilityMs)` returning claimed messages, and
`settleBatch(messages, outcome)` with an optional finer-grained `settle`.

**Over:** a push/subscribe callback model. Rejected because the engine needs to
control batch boundaries and timing — an adapter that pushes decides the batch,
which is exactly the authority the engine must hold to keep `maxBatchTimeout`
meaningful across backends.

`@openqueue/sdk` is the worked example of the alternative: its
`consume(queue, { process(job) })` hands the transport one job at a time, and as
a direct result the framework has no batch delivery at all (§2.2). The shape is
the constraint, not an implementation detail.

### 4.3 A standalone package, not `@lunora/queue-adapters`

**Chosen (proposed):** a `@visulima/*` package. Nothing in the contract is
Lunora-specific once it is stated as receive/settle; the Cloudflare host could
consume it for local `wrangler dev` parity, and a third host gets queues free.

**Over:** `@lunora/queue-adapters`, which keeps versioning in lockstep with the
contract it serves at the cost of being un-reusable. **This is Q1 in §9 and it
sets the dependency direction — settle it before the first adapter is written.**

### 4.4 SQLite stays the reference

**Over:** promoting SQS to reference. Rejected because the reference must run in
CI with no credentials and no container.

## 5. Workstreams

| WS     | Size | Work                                                                                                                                 |
| ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **W1** | M    | Extract the engine from `createNodeQueueHost`; leave it a thin `QueueAdapter` over SQLite. Gate: its existing 9 tests pass unchanged |
| **W2** | M    | The TCK — one suite every adapter must pass (§7 phase 1)                                                                             |
| **W3** | M    | SQS adapter. Exercises the "native everything" end                                                                                   |
| **W4** | L    | Postgres adapter. Exercises the "build it yourself" end, and is the first to need `migrations` (§10.1)                               |
| **W5** | S    | Adapter selection in `@lunora/config`; capability rating per target                                                                  |
| **W6** | M    | Pub/Sub, Service Bus, AMQP, JetStream — on demand, one PR each                                                                       |

## 6. Platform parity

| Feature      | `cloudflare` | `node`   | Notes                                                                                                                                                                                                                                   |
| ------------ | ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.queues` | native       | emulated | Today: Cloudflare Queues vs the SQLite table. After this plan, `node` stays `emulated` but the note names the selected adapter; an adapter does not make it `native`, because the platform is not providing the feature — an adapter is |

The rating does not change. What changes is that the note must say which adapter
is active, since "emulated" over SQS and over SQLite have very different
operational envelopes. W5 owns that.

## 7. Phasing & ordering

| Phase | Work                     | Gate                                                                                                                                                                    |
| ----- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Answer Q1 (package home) | A decision recorded in §9 — nothing else starts first                                                                                                                   |
| 1     | W1 + W2                  | `node-queue-host.test.ts` green **unchanged**; the SQLite adapter passes the TCK; and a test asserts the contract entry point's import graph pulls in no backend client |
| 2     | W3                       | SQS adapter passes the TCK against [ElasticMQ](https://github.com/softwaremill/elasticmq) or LocalStack in CI                                                           |
| 3     | W4                       | Postgres adapter passes the TCK against a container                                                                                                                     |
| 4     | W5                       | An app selecting an adapter in config round-trips a message end to end                                                                                                  |

## 8. Risks & STOP conditions

- **STOP** if the TCK cannot be written so that all adapters pass it identically —
  that means the contract is under-specified, and shipping adapters against an
  ambiguous contract is how they diverge silently. Re-scope to nailing §3.1 down.
- **STOP** if extracting the engine (W1) changes any of the 9 existing tests. A
  changed assertion means the extraction changed behaviour, and the SQLite host
  is the thing every other adapter will be compared against.
- **Risk: delay caps differ.** SQS caps `DelaySeconds` at 15 minutes; the
  contract says 12 hours. _Mitigate:_ the engine holds long delays itself and
  hands the adapter only what it can express, or the adapter declares its cap and
  the TCK asserts the documented degradation. Decide in W3, not in W1.
- **Risk: at-least-once means duplicates.** Every backend here is at-least-once.
  The contract already implies it (`attempts` is visible), but it should be said
  out loud in the package docs, since a user moving from Cloudflare Queues will
  assume identical semantics.
- **Perf watch:** no `__bench__` suite covers queues today. If one is added,
  measure batch assembly cost at `maxBatchSize: 100` — the current SQLite
  implementation issues one `UPDATE` per claimed message
  (`node-queue-host.ts:322-326`), which is the first thing that will show up.

## 9. Open questions (answer during execution)

1. **Package home** — `@visulima/*` or `@lunora/queue-adapters`? Sets the
   dependency direction; blocks phase 1.
2. **Does Kafka belong at all?** Its offset model cannot express partial settle
   without reprocessing. Excluding it may be better than shipping an adapter that
   silently duplicates.
3. **Pull-mode queues** (`mode: "pull"`) expect an HTTP endpoint an external
   worker polls. No adapter serves that. Runtime concern or adapter concern?
4. **Does the engine own long delays** that exceed an adapter's native cap, or does
   each adapter degrade and document? (Ties to §8 risk 1.)

## 10. Proposed API

Illustrative, not final — the contract in §3.1 is what binds. Shaped to match
`PaymentAdapter` (§2.1), which solves the same problem for payment providers.

### 10.1 The adapter contract

**`QueueAdapter`, not `QueueDriver`** — in this repo `*Driver` already means a
deploy target (`DeployDriver`), and this is a provider translator, which is what
`*Adapter` means. As with `PaymentAdapter`, the adapter owns no durable state of
its own: the backend does.

```ts
/** Stable identifier per adapter, so logs and errors name the backend. */
export type QueueProviderId = "amqp" | "jetstream" | "postgres" | "pubsub" | "servicebus" | "sqlite" | "sqs";

/**
 * What a backend can do — encoded in types so operational limits are not tribal
 * knowledge. Mirrors `ProviderCapabilities` in `@lunora/payment`; the booleans
 * are enforced by `assertCapability` before the engine reaches for the matching
 * behaviour, the way `@openqueue/sdk` gates its transport (§2.2).
 * @experimental
 */
export interface QueueProviderCapabilities {
    /** True when a message survives a process restart. False only for in-memory test adapters. */
    readonly durable: boolean;
    /**
     * Native delay ceiling in seconds. SQS is 900 against the contract's 43200;
     * the engine holds the remainder itself (§9 Q4).
     */
    readonly maxDelaySeconds: number;
    /** Largest batch `receive` can return. SQS caps at 10; SQLite is unbounded. */
    readonly maxReceive: number;
}

export type QueueCapability = keyof QueueProviderCapabilities;

/**
 * Thrown when the engine needs something the adapter declared it cannot do.
 * Named after the adapter, so the message says which backend is the problem.
 * @experimental
 */
export class UnsupportedQueueCapabilityError extends LunoraError {
    readonly capability: QueueCapability;
    readonly provider: QueueProviderId;
}

/**
 * Committed schema steps plus a read-only probe. Present **only** on adapters
 * that own durable SQL state — SQLite and Postgres do, SQS does not. Without
 * this, "did the queue table get created" is answered by trying it and reading
 * the error.
 * @experimental
 */
export interface QueueMigrations {
    readonly steps: readonly { checksum: string; id: string; sql: string }[];
    status: () => Promise<{ appliedAt?: Date; id: string; state: "applied" | "checksum_mismatch" | "pending" }[]>;
}

/**
 * One message claimed from a backend.
 * @experimental
 */
export interface ClaimedMessage {
    /** Deliveries so far, including this one. */
    readonly attempts: number;
    /** Raw payload; the engine decodes it per `contentType`. */
    readonly body: Uint8Array;
    readonly contentType: QueueContentType;
    /** Backend-native handle — SQS receipt handle, AMQP delivery tag, row id. Opaque to the engine. */
    readonly handle: unknown;
    readonly id: string;
    readonly queue: string;
    readonly timestamp: Date;
}

/**
 * A translator between a queue backend and Lunora's normalized vocabulary.
 *
 * Adapters do not own state — the backend does. Batch assembly, the implicit-ack
 * rule, `attempts` accounting and the dead-letter threshold all live in the
 * engine above (§4.1), so an adapter implements transport only.
 * @experimental
 */
export interface QueueAdapter {
    readonly capabilities: QueueProviderCapabilities;

    /**
     * Contract version this adapter was built against. Checked by
     * `validateQueueAdapter()` so a third-party adapter compiled against an
     * older contract fails with "upgrade in lockstep" rather than at the first
     * missing method. Borrowed from `@openqueue/sdk`'s `WORLD_SPEC_VERSION`.
     */
    readonly specVersion: number;

    /**
     * Route an exhausted message. Backends with a native dead-letter facility
     * delegate to it; the rest re-publish onto `target`.
     */
    deadLetter: (message: ClaimedMessage, target: string | undefined) => Promise<void>;

    /** Stable provider identifier. */
    readonly identifier: QueueProviderId;

    /**
     * Claim up to `max` messages, invisible for `visibilityMs`. Fewer than `max`
     * is normal; none means nothing is due.
     */
    receive: (queue: string, max: number, visibilityMs: number) => Promise<ClaimedMessage[]>;

    send: (queue: string, body: Uint8Array, options: AdapterSendOptions) => Promise<void>;
    sendBatch: (queue: string, messages: AdapterSendRequest[]) => Promise<void>;

    /**
     * Settle one message independently of its neighbours.
     *
     * **Optional, and its absence is the point.** A backend whose settlement is
     * positional rather than per-message — Kafka, where committing an offset
     * settles everything below it — cannot implement this, and an absent method
     * cannot be called by mistake where a `supportsPartialSettle: false` flag
     * could. The engine falls back to `settleBatch` and documents the resulting
     * at-least-once reprocessing. Follows the `checkEntitlement?` /
     * `reportUsage?` idiom in `@lunora/payment`.
     */
    settle?: (message: ClaimedMessage, outcome: SettleOutcome, options?: SettleOptions) => Promise<void>;

    /** Settle a whole claimed batch. Every adapter implements this; `settle` is the finer-grained opt-in. */
    settleBatch: (messages: ClaimedMessage[], outcome: SettleOutcome, options?: SettleOptions) => Promise<void>;

    /** Schema this adapter owns, if any. Absent for adapters over a managed service. */
    readonly migrations?: QueueMigrations;

    /**
     * Release connections. Async, unlike `NodePlatform`'s synchronous
     * `Symbol.dispose` (`node-platform.ts:31`), because a network-backed adapter
     * has in-flight requests to drain — `Symbol.asyncDispose` is the matching
     * disposal protocol. A local adapter may resolve immediately.
     */
    close: () => Promise<void>;
    [Symbol.asyncDispose]: () => Promise<void>;
}
```

`validateQueueAdapter(adapter)` returns the adapter so it can be checked inline,
and rejects a `specVersion` mismatch before any shallow method check — the order
matters, because a version skew produces a _more useful_ error than the missing
method it causes.

**The contract entry point imports no backend client.** `@visulima/queue` must
be installable without pulling `@aws-sdk/*`, `pg` or `better-sqlite3` into the
graph; each lives behind its own subpath with the client as an optional peer.
This is a gate in §7, not a convention — `@openqueue/sdk` states the same
constraint for the same reason, and it is the kind that erodes silently.

### 10.2 Building a host from an adapter

The engine takes an adapter and the declared queues, and returns what
`createNodeQueueHost` returns today — so a host swaps backends without changing
how it wires `ctx.queues`.

```ts
import { dispatchQueueBatch } from "@lunora/queue";
import { createQueueEngine } from "@visulima/queue";
import { sqliteAdapter } from "@visulima/queue/sqlite";

import * as queues from "./lunora/queues";

await using engine = createQueueEngine({
    adapter: sqliteAdapter({ database }),
    onBatch: (batch) => dispatchQueueBatch(batch, registry, { env }),
    queues,
});

// Producers, ready for `ctx.queues`
await engine.bindings.emailQueue.send({ to: "a@example.com" }, { delaySeconds: 30 });

// Consumer, driven by the caller
await engine.poll();
```

### 10.3 Swapping the backend

Only the adapter line changes. Subpaths are flat provider names, following
`@lunora/payment`'s `./stripe` / `./polar` rather than `@lunora/replica`'s
nested `./adapters/*`.

```ts
import { sqsAdapter } from "@visulima/queue/sqs";

const adapter = sqsAdapter({ client: new SQSClient({ region: "eu-central-1" }), queueUrls });
```

```ts
import { postgresAdapter } from "@visulima/queue/postgres";

const adapter = postgresAdapter({ pool, schema: "lunora_queue" });
```

### 10.4 Conformance

```ts
import { runQueueAdapterConformance } from "@visulima/queue/conformance";

runQueueAdapterConformance({
    // Fresh, isolated backend per test.
    createAdapter: async () => sqliteAdapter({ database: new Database(":memory:") }),
});
```

The suite reads `capabilities` and `settle`'s presence off the adapter and
asserts §3.1 accordingly: delay honoured up to `maxDelaySeconds` and held by the
engine beyond it, partial settle where `settle` exists and documented
reprocessing where it does not, redelivery after a dropped consumer, dead-letter
routing, and content-type round-trips.
