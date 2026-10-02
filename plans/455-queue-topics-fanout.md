# Plan 455 — Pub/Sub topics: one publish, N durable subscriptions

**Baseline:** `30823cc90` (2026-10-01)
**Status:** IN PROGRESS (core shipped in #916; Studio grouping, the topic send target and skill docs shipped in #917; the >10-subscription lint and the publish bench remain)

## What shipped, and where it differs from the design below

- **Workstreams A, B, C, D, F: done.** E (`lunoraTest`) was skipped because the
  harness has no queue support today, so topics have nothing to plug into.
  Workerd round trip is in `packages/queue/__tests__/workerd`.
- **Topics live in `lunora/queues.ts`, not a new `lunora/topics.ts`** (changes §4.3).
  A subscription is a `defineQueue`-shaped export of that file, so the existing
  discovery, `LUNORA_QUEUE_REGISTRY` import, config reconcile, `platform-node`
  queue host and Studio list pick it up with no new wiring. One
  `discoverQueueDeclarations` parse returns queues and topics; a subscription's
  `QueueIR.topic` is the only record of the link.
- **A subscription is named like a queue** (changes §4.3). Queue `<export-kebab>`,
  binding `QUEUE_<EXPORT>`, from the existing `queueDefaultName`/`queueBindingName`,
  not `<topic>--<sub>` / `TOPIC_<T>__<S>`. The runtime (`platform-node`) derives
  names without knowing the topic, so the topic cannot be part of the name.
  Workstream C's orphan warning was therefore dropped: a rename orphans a queue
  exactly as renaming a `defineQueue` export does today.
- **No payload validator, no shared `messageId`** (changes §2 and §4.2). Payloads
  are typed by generic only, matching `defineQueue`. Cloudflare's `send` takes no
  caller-supplied id, so a shared id would mean wrapping the body. Handlers dedupe
  on their own payload keys.
- **A missing subscription binding rejects the publish before anything is sent**,
  rather than skipping that subscription (which would silently lose its copy) or
  sending to the rest (which would duplicate on every retry of a config error).
- **The security lints cover topics**: `privileged_dispatch_unvalidated_payload`
  reads `defineSubscription` handlers (and now `message.run`, which it missed for
  plain queues too), and `privileged_fanout_from_public_procedure` sees
  `ctx.topics.*.publish`. Node round trip is in `platform-node`'s queue host test.
- **Cloudflare rating is `emulated`, not `native`** (changes §6): the fan-out is
  Lunora's, the same reasoning as `crossShardFanout`.

## 0. Headline finding

Lunora has no topic or fan-out primitive. `@lunora/queue` is point-to-point: one
`defineQueue` gives one consumer. Cloudflare Queues allows **one consumer Worker
per queue**, and Cloudflare Pub/Sub is a private-beta MQTT broker, not a Workers
event bus. So "topic → many subscriptions" has to be built by Lunora. The cheap
way: **each subscription is its own Cloudflare queue**, and `publish` sends to
all of them. Codegen expands every subscription into a synthetic `QueueIR`.
Dispatch, retries, DLQ, wrangler reconcile, Studio capture and redrive then all
apply unchanged.

This is the Encore `Topic` / `Subscription` model (at-least-once, per-subscription
retry policy and DLQ). Ordering and exactly-once are explicitly out of scope (§4.4).

## 1. Current state (audit)

- `defineQueue` (`packages/queue/src/define-queue.ts:63`) brands a config with
  `isLunoraQueue`. Tuning fields are `deadLetterQueue`, `maxBatchSize`,
  `maxBatchTimeout`, `maxRetries` (default 3) and `retryDelay`
  (`packages/queue/src/types.ts:100-111`).
- Discovery reads only `lunora/queues.ts` (`packages/codegen/src/discover/queues.ts:14`).
- `emitQueues` → `_generated/queues.ts` `LUNORA_QUEUE_REGISTRY`, keyed by queue name
  (`packages/codegen/src/emit/shard-runtime.ts:266-300`). The `ctx.queues` producer
  is emitted at `shard-runtime.ts:346` and typed at `emit/server.ts:362-367`.
- The Worker `queue()` entry routes on `batch.queue` into `dispatchQueueBatch`
  (`packages/codegen/src/emit-app.ts:1089-1106`; `packages/queue/src/dispatch.ts:609`).
  The engine already handles per-message ack/retry, blame isolation, the DLQ
  threshold (`dispatch.ts:426-444`) and signed requeue envelopes.
- Wrangler `queues.producers[]` / `consumers[]` are reconciled in
  `packages/config/src/reconcile-queues.ts:199` and validated in
  `validate-bindings.ts:531-555`.
- `PlatformCapabilities.features.queues` (`packages/platform/src/capabilities/types.ts:435`):
  native on cloudflare and celld, emulated on node.
- Studio: `packages/studio/src/features/queues/queues-panel.tsx` (message log,
  send, DLQ redrive/replay). It has no topic view.
- No fan-out or topic concept exists in code. Plan 306 (pluggable brokers) chose a
  receive/settle contract and has no topics. Plan 133 phase 3 wants
  "per-tenant fan-out" over `@lunora/queue`, which would be a future consumer of this plan.

## 2. Existing seams (do not reinvent)

- `QueueIR` + `LUNORA_QUEUE_REGISTRY` + `dispatchQueueBatch`: subscriptions **are** queues.
- `createQueues` (`packages/queue/src/create-queues.ts:101`) already enforces the
  100-per-batch and 12h delay limits and the reserved-key check. `publish` loops it.
- `reconcile-queues.ts`: it provisions producer and consumer entries per synthetic queue.
- `recordQueueMessage` / Studio queue capture: subscription traffic shows up for free.
- `@lunora/values` validators for the payload. The pattern is the same as `args` on functions.

## 3. The behavioural contract to preserve

- Existing `defineQueue` apps generate byte-identical `_generated/queues.ts` and
  `wrangler.jsonc` when no `lunora/topics.ts` exists (golden fixture).
- `ctx.queues` stays as it is. Topics add `ctx.topics`. They do not overload queues.
- Delivery is at-least-once per subscription. One subscription failing never blocks or
  retries another.

## 4. Design decisions

### 4.1 npm packages: none fit (checked 2026-10-01)

| Candidate                     | Why not                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `partysub` (PartyServer)      | WebSocket broadcast, **at-most-once**, README: "experimental, not recommended for production"     |
| `@cloudflare/pubsub`          | Auth helper for Cloudflare Pub/Sub, an MQTT broker in **private beta**; it is not a Workers queue |
| `@dldc/pubsub`, `nano-pubsub` | In-process emitters, so nothing survives the request                                              |
| `@danielfroz/eventbus`        | At-least-once, but over Redis Streams / NATS / Iggy, which can't run inside Workers; pre-1.0      |

Delivery, retry and DLQ come from Cloudflare Queues, which we already wrap. The
missing piece is about 150 lines of fan-out plus codegen expansion. A dependency
would add a second broker beside the one we have.

### 4.2 One queue per subscription, chosen over a single topic queue with a fan-out consumer

- **Chosen:** `publish(msg)` validates once, then `sendBatch`es to every subscription's
  queue in parallel. It is one hop, and each subscription keeps independent retry and DLQ.
- **Rejected:** publish to one `topic-<t>` queue whose consumer re-sends to the
  subscription queues. That makes publish atomic (one send). The cost is double the
  queue operations and the latency, plus a second retry layer whose failures blame no one.
- **Trade-off accepted:** publish to N queues is not atomic. If send #2 of 3 fails,
  `publish` throws, the caller retries, and subscription #1 sees a duplicate. That is
  inside at-least-once, and it is the same contract Encore documents ("handlers must be
  idempotent"). Each message carries `messageId` (one UUID per publish, the same across
  subscriptions) so handlers can dedupe.

### 4.3 API: subscriptions live next to their topic file, not inside `defineTopic`

```ts
// lunora/topics.ts
export const signups = defineTopic({ payload: v.object({ userId: v.id("users") }) });

export const welcomeEmail = defineSubscription(signups, {
    handler: async (ctx, batch) => {
        /* same shape as a defineQueue handler */
    },
    maxRetries: 5,
    deadLetterQueue: true, // provisions `<queue>-dlq`
});

// in a mutation/action
await ctx.topics.signups.publish({ userId });
```

- The handler signature is the `QueueHandler` signature. A subscription is a queue, so
  nothing new needs learning.
- **Chosen:** separate `defineSubscription` exports, so another file (later: another
  service, plan 456) can subscribe without editing the topic. **Rejected:** a
  `subscriptions: {}` map inside `defineTopic`, which couples every subscriber to one file.
- v1 discovery reads `lunora/topics.ts` only, like queues. Multi-file discovery comes with plan 456.
- Synthetic queue name: `<topic-kebab>--<subscription-kebab>`. Binding:
  `TOPIC_<TOPIC>__<SUB>`. Both are deterministic, so renaming a subscription is a new
  queue (§8).
- Lives in `@lunora/queue` as a new `defineTopic` / `defineSubscription` export. It is
  **not** a new package: the dispatch code it reuses is all in there.

### 4.4 Out of scope

- **Ordering key** (Encore `orderingAttribute`): Cloudflare Queues has no ordering, so
  it is `unsupported`. Revisit only if a host gains ordered delivery.
- **Exactly-once:** not offered. Dedupe on `messageId`.
- **Attribute filters per subscription:** YAGNI. A handler can early-return.
- **Pull subscriptions:** push only in v1.

## 5. Workstreams

| #   | Work                                                                                                                                                                                                                            | Size |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| A   | `@lunora/queue`: `defineTopic`, `defineSubscription` (brands `isLunoraTopic` / `isLunoraSubscription`), `createTopics({ bindings, topics })` → `publish` (validate → parallel `sendBatch`, shared `messageId`), `publishBatch`  | S    |
| B   | `@lunora/codegen`: `discover/topics.ts` (ts-morph, same as `discover/queues.ts`), expand each subscription into a `QueueIR`, merge into the queue registry, emit the `ctx.topics` producer + types, feature probe               | M    |
| C   | `@lunora/config`: reconcile/validate the synthetic queues (+ DLQs) through the existing `reconcile-queues.ts` path. Warn when a queue in wrangler has a `topic--sub` name with no matching subscription (orphan after a rename) | S    |
| D   | Studio queues panel: group synthetic queues under their topic (`QueueMetadata` gains `topic?: string`), plus a "publish test message" button to the topic                                                                       | S    |
| E   | `@lunora/testing`: `lunoraTest` delivers a publish to every subscription handler synchronously                                                                                                                                  | S    |
| F   | Docs page `apps/docs` + `lunora-functions` skill section, api-snapshot update                                                                                                                                                   | S    |

## 6. Platform parity

New key `features.topics` in `PlatformCapabilities`, in the same change as workstream A:

| Feature      | `cloudflare` | `node`      | `celld`     | Notes                                                                                                                                                                                                       |
| ------------ | ------------ | ----------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.topics` | native       | emulated    | native      | Same level as `queues` on every target, because each subscription is a queue. Node inherits the queue emulation **and its dispatch gap** (handler `ctx.run` hits an unserved `/_lunora/scheduler/dispatch`) |
| ordering key | unsupported  | unsupported | unsupported | Not offered (§4.4)                                                                                                                                                                                          |

There is no new host contract. It rides on whatever carries `queues`, so a host without
queues gets `unsupported`, and codegen omits `ctx.topics` with
`platform_unsupported_feature`.

## 7. Phasing & ordering

| Phase | Work  | Gate                                                                                                                                       |
| ----- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | A     | Unit tests: publish fans out to N fake bindings with one `messageId`; a failing binding rejects `publish`; validator rejects a bad payload |
| 1     | B + C | Codegen golden fixture with 1 topic × 2 subscriptions; byte-identical golden for a queues-only app; `lint:types`                           |
| 2     | E     | `lunoraTest` test: one publish runs both handlers, and one handler throwing doesn't stop the other                                         |
| 3     | D + F | `pnpm run test:workerd` for `@lunora/queue` with a real two-subscription round trip; `api:check`                                           |

## 8. Risks & STOP conditions

- **STOP** if the Cloudflare per-account queue limit turns out to be low enough that
  realistic apps (say 20 topics × 5 subscriptions, ×2 with DLQs) hit it. In that case
  switch to §4.2's rejected single-queue design, with in-consumer routing per subscription.
- **Risk:** renaming a subscription orphans its queue and any in-flight messages.
  Mitigate: the workstream C orphan warning, and docs that say "rename = new subscription".
- **Risk:** a publish fan-out to many subscriptions inside a mutation adds latency.
  Mitigate: parallel sends, plus an advisor lint when a topic has more than 10 subscriptions.
- **Perf watch:** publish latency vs subscription count in `packages/queue/__bench__`
  (new `publish.bench.ts`).

## 9. Open questions (answer during execution)

1. What is the current Cloudflare queues-per-account limit? (It feeds the §8 STOP.)
2. Should `publish` be allowed from queries? (No for queues today. Keep it the same.)
3. Should a subscription opt into a delay (`retryDelay` only, or also an initial `delaySeconds`)?
