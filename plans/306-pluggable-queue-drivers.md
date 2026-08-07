# 306 — A pluggable queue-driver package

**Status:** proposed
**Owner:** unassigned
**Depends on:** the SQLite queue host in `@lunora/platform-node` (shipped; the reference driver)

## Why

`ctx.queues` is defined by `@lunora/queue` and backed, per target, by whatever
that target's host provides. Today there are exactly two backings: Cloudflare
Queues on the Cloudflare host, and a `better-sqlite3` table on the Node host.

Neither is a choice the user gets to make. A Node deployment that already runs
Postgres, Redis or SQS has to use the SQLite table anyway, which is correct for
one process and wrong for several — SQLite's writer lock is a real ceiling once
consumers outnumber cores, and it cannot span machines at all.

The fix is a driver seam: one contract, several implementations, and the user
names the one they want. That belongs in a standalone package rather than in
`@lunora/platform-node`, because nothing about it is Node-host-specific — the
Cloudflare host could consume it for local `wrangler dev` parity, and a third
host gets queues for free.

## The contract the drivers have to satisfy

This is the hard part, and it is why an off-the-shelf library cannot be dropped
in. `@lunora/queue` is **message-shaped**, mirroring Cloudflare Queues:

- a consumer receives a **batch** — up to `maxBatchSize` messages, or fewer once
  `maxBatchTimeout` elapses;
- each message in that batch is settled **individually**: `ack()`,
  `retry({ delaySeconds })`, or left undecided, which means an implicit ack when
  the handler returns and a retry when it throws;
- `attempts` is visible to the handler, and exceeding `maxRetries` routes to a
  declared `deadLetterQueue`;
- producers get `send(body, { contentType, delaySeconds })` and
  `sendBatch(messages, { delaySeconds })`, with `delaySeconds` up to 12 hours and
  four wire content types (`json`, `text`, `bytes`, `v8`);
- an in-flight message must become visible again if its consumer dies.

Most Node queue libraries are **job-shaped** instead: one job goes to one
handler, and the handler's return value or throw settles it. That shape cannot
express "a batch of ten where the third one retries and the rest ack", so an
adapter over a job library has to reimplement the batch layer regardless — which
is most of the work.

The broker and cloud tier, by contrast, maps almost exactly, because Cloudflare
Queues is itself modelled on it.

## Provider survey

Grouped by whether the backend can satisfy the contract directly. Download
figures are npm monthly at time of writing, as a maintenance signal only.

### Maps cleanly — receive-batch plus per-message settle is native

| Backend               | Client                           | Batch receive               | Per-message settle                               | Delay                   | DLQ                      | Visibility    |
| --------------------- | -------------------------------- | --------------------------- | ------------------------------------------------ | ----------------------- | ------------------------ | ------------- |
| **AWS SQS**           | `@aws-sdk/client-sqs` (40M)      | `ReceiveMessage` ≤10        | `DeleteMessageBatch` / `ChangeMessageVisibility` | `DelaySeconds`          | redrive policy           | native        |
| **Google Pub/Sub**    | `@google-cloud/pubsub` (23M)     | pull with `maxMessages`     | per-message `ack()`/`nack()`                     | via publish schedule    | dead-letter topic        | ack deadline  |
| **Azure Service Bus** | `@azure/service-bus` (2.8M)      | `receiveMessages(maxCount)` | `complete`/`abandon`/`deadLetter`                | `scheduledEnqueueTime`  | native sub-queue         | lock duration |
| **RabbitMQ / AMQP**   | `amqplib` (12M), `rascal` (196k) | `prefetch(n)`               | per-delivery `ack`/`nack`                        | delayed-exchange plugin | dead-letter exchange     | consumer ack  |
| **NATS JetStream**    | `@nats-io/jetstream` (1.3M)      | `fetch({ batch })`          | `ack()`/`nak(delay)`                             | `nak` with delay        | `max_deliver` + advisory | ack wait      |
| **SQLite**            | `better-sqlite3`                 | shipped                     | shipped                                          | shipped                 | shipped                  | shipped       |

SQS is the closest of all — it is effectively the same model Cloudflare Queues
presents, including the 12-hour delay cap.

### Maps with work — batch or settlement has to be built

| Backend      | Client                                                                                      | Gap                                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Postgres** | `pg-boss` (4.7M)                                                                            | advertises batch work and dead-letter queues with redrive; option names to confirm against its API docs before adapting. Alternatively raw `SELECT … FOR UPDATE SKIP LOCKED`, which gives full control over the contract at the cost of owning the schema |
| **Kafka**    | `@confluentinc/kafka-javascript` (3.6M, active), `kafkajs` (14M but last published 2023-02) | `eachBatch` gives the batch, but the offset model has no per-message ack — a partial settle means committing the lowest un-acked offset and reprocessing the rest. Documented as at-least-once with duplicates, or skip Kafka                             |
| **MySQL**    | —                                                                                           | `SELECT … FOR UPDATE SKIP LOCKED` since 8.0; same shape as the raw Postgres option                                                                                                                                                                        |

### Job-shaped — would need the batch layer rebuilt

| Library                   | Downloads  | Why it does not fit                                                                                                                                                                                       |
| ------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bullmq`                  | 31M        | one job per worker; no batch, no visibility window (lock instead), DLQ is the failed set                                                                                                                  |
| `@openqueue/sdk`          | small      | has the right _idea_ — a "world" abstraction with `world-bullmq` and `world-postgres` drivers, worth reading for the seam shape — but no batch delivery, no documented DLQ or visibility timeout, pre-1.0 |
| `@platformatic/job-queue` | small      | no delay, no batch, no DLQ; requires a caller-supplied id                                                                                                                                                 |
| `@boringnode/queue`       | 28k        | has delay and backoff, but no batch, no DLQ, and `engines.node >= 24`                                                                                                                                     |
| `glide-mq`                | small      | closest on features (batch, DLQ, delay) but requires a Valkey/Redis server plus a Rust NAPI binding                                                                                                       |
| `sidequest`               | 8k         | batch absent, and **LGPL-3.0-or-later** against this repo's FSL-1.1-Apache-2.0                                                                                                                            |
| `liteque`, `plainjob`     | ~10k / ~1k | SQLite-backed but no batch; `plainjob` has no retry at all                                                                                                                                                |

The pattern is consistent enough to state as a finding: **no general-purpose
Node job library delivers batches whose members settle independently.** That is
a broker feature, and the drivers worth writing are broker drivers.

## Proposed shape

A single package exporting the driver contract plus a driver per backend as its
own entry point, so a consumer pulls in one client library and not six.

```ts
interface QueueDriver {
    /** Publish. `delaySeconds` is 0–43200; `contentType` picks the wire encoding. */
    send: (queue: string, body: unknown, options?: SendOptions) => Promise<void>;
    sendBatch: (queue: string, messages: SendRequest[], options?: SendBatchOptions) => Promise<void>;

    /**
     * Claim up to `max` messages, invisible for `visibilityMs`. Returning fewer
     * than `max` is normal; returning none means nothing is due.
     */
    receive: (queue: string, max: number, visibilityMs: number) => Promise<DriverMessage[]>;

    /** Settle one claimed message. `retry` re-arms it after `delaySeconds`. */
    settle: (message: DriverMessage, outcome: "ack" | "retry", options?: SettleOptions) => Promise<void>;

    /** Route an exhausted message. Drivers with a native DLQ delegate; others re-publish. */
    deadLetter: (message: DriverMessage, target: string | undefined) => Promise<void>;
}
```

Batch assembly (`maxBatchSize` / `maxBatchTimeout`), the implicit-ack-on-return
rule, `attempts` accounting and the `maxRetries` threshold live **above** the
driver, in shared code, so every backend gets identical semantics and a driver
author only implements transport. That is the same split the shipped SQLite host
already has internally — extracting it is most of the work for the first
release.

Conformance is a TCK, the way `@lunora/platform/conformance` gates hosts: one
suite every driver must pass, covering delay, partial settle, redelivery after a
dropped consumer, DLQ routing, and content-type round-trips.

### Staging

1. Extract the batch/settlement engine out of `createNodeQueueHost`, leaving it
   a thin `QueueDriver` over SQLite. Ship the SQLite driver and the TCK.
2. SQS and Postgres — the two most-asked-for, and the two that exercise opposite
   ends of the contract (native everything vs. build-it-yourself).
3. Pub/Sub, Service Bus, AMQP, JetStream as demand appears.
4. Wire the selection into `@lunora/config` so a target names its driver, and
   rate it in `PlatformCapabilities` per target.

## Open questions

- **Package home.** Proposed as a `@visulima/*` package, since nothing in it is
  Lunora-specific and the queue contract is generic enough to stand alone. The
  alternative is `@lunora/queue-drivers`, which keeps versioning in lockstep with
  the contract it serves at the cost of making it un-reusable. Decide before the
  first driver is written — it sets the dependency direction.
- **Does Kafka belong at all?** Its offset model cannot express partial settle
  without reprocessing. Better to exclude it than to ship a driver that silently
  duplicates.
- **Pull-mode queues.** `mode: "pull"` expects an HTTP endpoint an external
  worker polls. No driver serves that today; it may belong in the runtime rather
  than in a driver.
