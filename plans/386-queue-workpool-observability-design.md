# Plan 386 design: Observability for the Queues-backed workpool

> Deliverable of plans/386-queue-workpool-observability-spike.md. Design only —
> no code ships from this document. Drift check at `207be1b63` (HEAD): zero
> drift in `queue-workpool.ts`, `scheduler-do.ts`, `capture.ts`. Plan 378 has
> not landed; where it matters, this design is written against 378's specified
> end-state (its plan keeps `createQueueConsumer`'s shape and the
> retry-everything-to-DLQ semantics; only `httpDispatcher`'s internals move onto
> `createDispatchRunner`).

## Summary of the recommendation

Wire a scheduler-owned capture hook into `createQueueConsumer` that reuses the
**existing** `recordQueueMessage` → `getQueueMessages` → Studio Queues panel
pipeline (section 1). Do **not** build a backlog number — document its absence
and point at the Cloudflare dashboard (section 2). For the DLQ, choose option
(b)+(c)-lite: the capture sink already mirrors the terminal failure into the
root shard with `deadLettered: true`, and the Studio panel's existing
`replayQueueMessage` requeue is the retry verb; ship no canned DLQ consumer
(section 3). Studio needs **zero new pages** — the Queues panel and its
reliability banner already render everything the read model carries
(section 4).

The through-line: `@lunora/queue` consumers already have full consumed-message
observability; the Queues workpool consumer is the one consumer in the repo
that bypasses it. The fix is parity with that pipeline, not parity with
SchedulerDO's `/status`+`/dead` surface — the module docstring
(`packages/scheduler/src/queue-workpool.ts:9-11`) is explicit that per-job
status/cancel/concurrency is what you give up by choosing this backend, and
plan 055 records the two backends coexisting by design.

## Evidence base (what exists today)

| Piece | Location | What it does |
|---|---|---|
| Queues workpool consumer | `packages/scheduler/src/queue-workpool.ts:109-127` | `createQueueConsumer({ dispatch })` — per-message `ack()` on success, `retry()` on any failure. No capture, no logging. |
| Consumer options | `packages/scheduler/src/types.ts:392-395` | `QueueConsumerOptions` = `{ dispatch }` only. |
| Message projection | `packages/scheduler/src/types.ts:328-346` | `QueueMessageLike` carries `id`, `attempts`, `body`, `timestamp`, `ack`, `retry`; `MessageBatchLike` carries `queue`. Everything a capture record needs is already in the type. |
| Capture record contract | `packages/queue/src/dispatch.ts:54-76` (`CapturedQueueMessage`), `:81` (`QueueCaptureSink`) | `{ attempts, body, deadLettered, error?, exportName, messageId, outcome, queue, timestamp }`. Doc comment says it "structurally matches `@lunora/do`'s `RecordQueueMessageInput` … keep them in sync by hand" — deliberately no dependency edge. |
| Outcome/deadLettered derivation | `packages/queue/src/dispatch.ts:287-322` (`buildCaptureRecords`), `deadLettered` at `:311`: `outcome !== "ack" && attempts > maxRetries` | The `@lunora/queue` side flags the terminal failed attempt as it happens. |
| Capture sink | `packages/queue/src/capture.ts:90-162` | POSTs the batch to root shard `__lunora_admin__:recordQueueMessage` with the admin bearer; 5s abort (`CAPTURE_FETCH_TIMEOUT_MS`, `:35`); no-ops without `SHARD` binding or `LUNORA_ADMIN_TOKEN`; best-effort by contract. Dev-gating in `shouldCaptureQueue` (`:69-81`, `LUNORA_QUEUE_CAPTURE` override). |
| Shard-side write | `packages/do/src/shard-do.ts:6216`, `:6612-6622` | `recordQueueMessages(sql, messages, now)` into the queue catcher table. |
| Shard-side read | `packages/do/src/shard-do.ts:7602`, `:7654-7666` | `getQueueMessages` — newest-first, optional per-queue filter, poll-refreshed (no live push). |
| Shard-side requeue | `packages/do/src/shard-do.ts:6810-6851` | `replayQueueMessage` — re-enqueues a captured message onto its declared producer binding; refuses truncated bodies; audited. |
| Studio surface | `packages/studio/src/features/queues/queues-panel.tsx` (log, outcome badges, replay/send), `packages/studio/src/features/queues/reliability.ts` (`computeQueueReliability`: flags queues without a DLQ, counts `deadLettered` in the loaded window) | Already renders exactly the read model above. |
| SchedulerDO parity target | `packages/scheduler/src/scheduler-do.ts:391-418` (routes), `:1030-1066` (`/status`), `:1191-1248` (`/dead`, `/dead/retry`, `/dead/cancel`) | Consumed in Studio via `client.schedulerStatus()` (`packages/client/src/lunora-client.ts:2232`) in `scheduler-pools-panel.tsx` and `client.listDeadJobs()`/`retryDeadJob`/`removeDeadJob` (`lunora-client.ts:2261`) in `dead-letter-jobs.tsx`. |
| Wrangler consumer schema in-repo | `packages/config/src/cloudflare/wrangler-validator.ts:79-87` (`WranglerQueueConsumer`: `dead_letter_queue`, `max_batch_size`, `max_batch_timeout`, `max_retries`, `queue`, `retry_delay`, `type`) and `reconcile-bindings.ts:655-659` (tuning → `max_retries`/`dead_letter_queue`) | Note: the validator does **not** model `max_concurrency`, so every claim about it below is marked "needs verification against CF docs". |

## 1. Consumed-job visibility

**Proposal: add an optional `capture` hook to `createQueueConsumer`, and a
scheduler-owned copy of the sink builder.** Signature sketch:

```ts
// packages/scheduler/src/types.ts
export interface QueueConsumerOptions {
    /** How each job is executed; e.g. the `httpDispatcher`. */
    dispatch: QueueDispatch;
    /**
     * Optional consumed-message sink (the dev queue catcher). Best-effort:
     * a rejection is swallowed and never changes ack/retry semantics.
     */
    capture?: (messages: CapturedWorkpoolMessage[]) => Promise<void> | void;
}

/** Field-compatible with @lunora/queue's CapturedQueueMessage / @lunora/do's
 *  RecordQueueMessageInput — kept in sync by hand, same as the existing
 *  queue↔do pairing (dispatch.ts:54-56) and the MAX_QUEUE_BATCH mirror
 *  (queue-workpool.ts:37-43). No dependency edge. */
export interface CapturedWorkpoolMessage {
    attempts: number;
    body: unknown;              // the QueueJob (functionPath/args/shardKey)
    deadLettered: boolean;      // outcome !== "ack" && attempts > maxRetries
    error?: string;
    exportName: string;         // the job's functionPath — see below
    messageId: string;
    outcome: "ack" | "error" | "retry";
    queue: string;              // batch.queue
    timestamp: number;          // epoch-ms
}
```

`createQueueConsumer` grows a second options field, `maxRetries?: number`
(default 3, mirroring `DEFAULT_MAX_RETRIES` in `packages/queue/src/dispatch.ts`
— the consumer cannot read `wrangler.jsonc` at runtime, so the wrangler value
must be repeated here to compute `deadLettered`; same compromise `@lunora/queue`
makes via `definition.maxRetries`). The consumer body changes from
"ack-or-retry" to "ack-or-retry, then build one record per message and hand the
array to `capture` inside a `try {} catch {}`" — ~25 lines. No proxy harness is
needed: unlike `@lunora/queue`, this consumer *owns* the ack/retry calls
(`queue-workpool.ts:120-123`), so outcomes are known directly, not observed.

Per-record field notes:

- `exportName` carries `job.functionPath` (prefixed, e.g.
  `workpool:${functionPath}`) — the Queues panel groups/filters on this column,
  and the function path is the only identity a workpool job has.
- `error` carries the dispatcher's thrown message. Today
  `createQueueConsumer`'s `catch` (`queue-workpool.ts:121-124`) discards the
  error entirely — capture is also the first time a workpool dispatch failure
  becomes diagnosable at all. Post-378 this will be `createDispatchRunner`'s
  classified error, which is strictly better content for the same field.
- `outcome` is only ever `ack` or `retry` here (`error` is `@lunora/queue`'s
  attributed-failure disposition, which 378 explicitly does not adopt —
  "retry-everything-to-DLQ" is a recorded design choice). Record `retry` with
  `error` set; the panel's badge variants already handle it.

**The sink**: copy `createQueueCaptureSink` + `shouldCaptureQueue`
(`packages/queue/src/capture.ts`) into `packages/scheduler/src/` (or extract
nothing and let codegen/the app wire `@lunora/queue`'s sink in when both
packages are present). Recommendation: **copy** (~130 lines, mostly comments).
The repo has twice chosen hand-synced mirrors over a `scheduler→queue`
dependency edge (`dispatch.ts:54-56`, `queue-workpool.ts:41-42`); an app using
the Queues workpool without `@lunora/queue` is precisely the lightweight case
this backend serves, and it should not need `@lunora/queue` installed to get
the log.

**Does the 5s bounded write suit a workpool batch?** Yes. The budget bounds one
POST per *batch* (up to 100 records — `MAX_QUEUE_BATCH`,
`queue-workpool.ts:43`), not per message; `recordQueueMessages`
(`shard-do.ts:6622`) is a batch insert on the shard side. The workpool batch is
byte-wise smaller than a `@lunora/queue` batch of the same size (bodies are
`QueueJob` envelopes, not arbitrary user payloads). The sink is awaited after
dispositions are already decided, so the worst case — a full 5s stall on an
unresponsive root shard — delays completion of an already-settled `queue()`
invocation but can never flip an ack. Same contract, same number, no change.

## 2. Backlog approximation

**Recommendation: not offered; document it.** Reasoning against each
alternative:

- **Producer-side counting** requires a durable counter both producer and
  consumer agree on — i.e. a DO (or a root-shard row with two RPC writes per
  job). That is the SchedulerDO architecture re-introduced at ~2 subrequests
  per job, on the backend whose whole point (`queue-workpool.ts:2-11`) is *not*
  paying for a DO hop per job. It also cannot be accurate: messages retried by
  the platform, delayed messages, and DLQ routing all mutate depth outside the
  producer's view.
- **Platform APIs**: Cloudflare exposes queue depth/backlog via the dashboard
  and the GraphQL analytics API, and `wrangler queues info <name>` reports
  backlog — *needs verification against CF docs* (the in-repo wrangler schema,
  `packages/config/src/cloudflare/wrangler-validator.ts:79-87`, models consumer
  settings only and says nothing about a read API). All of these are
  account-API surfaces requiring an API token — a credential class the worker
  and Studio (which talks only to the app's own admin RPCs, see
  `packages/studio/src/lib/admin.ts`) do not hold today. Staleness of the
  analytics path is minutes, not seconds — fine for an SLO view, but the
  credential plumbing (token storage, scoping, per-environment account IDs) is
  a whole feature for one number.
- **In-worker peek**: none exists. The Studio reliability helper already
  records this as a known constraint — "Cloudflare Queues expose no peek API"
  (`packages/studio/src/features/queues/reliability.ts:23-24`, needs
  verification against CF docs, but it is the assumption the shipped panel is
  built on).

What to do instead: extend the module docstring
(`queue-workpool.ts:1-19`) — which already owns the "what you give up" list —
with one sentence: backlog depth is visible in the Cloudflare dashboard /
`wrangler queues info`, not in Studio. The docs page for the workpool choice
(wherever plan 055's tradeoff table lives) gets the same row. If account-API
credentials ever land in Studio for another reason, backlog becomes a
one-query add-on; do not build the credential plumbing for this.

## 3. DLQ story: what retry/cancel mean when the DLQ is a queue

SchedulerDO's verbs are storage operations on `dead:` rows
(`scheduler-do.ts:1204-1248`): retry = reset attempts + re-index; cancel =
delete row. A Cloudflare DLQ is another queue: messages in it are invisible
without a consumer, and "cancel" has no direct analogue (an unconsumed message
ages out at the queue's retention — needs verification against CF docs; the
in-repo schema models `dead_letter_queue` as just a queue name,
`wrangler-validator.ts:80`).

Options from the spike:

**(a) Canned DLQ consumer that re-enqueues on demand.** Ship a
`createDeadLetterConsumer({ mainQueue })` the app attaches to the DLQ, which
holds messages (retry with long `delaySeconds`) until an admin RPC flips a
"drain" flag, then forwards to the main queue. Failure modes: the consumer must
keep `retry()`ing every message on every visibility cycle just to keep it
parked, which burns invocations forever and — worse — a DLQ consumer's own
`max_retries` applies, so parked messages fall off the end of *its* retry
budget into either a second DLQ or the void. Poison messages loop
main→DLQ→main indefinitely once drained. This is a state machine impersonating
a storage system. **Rejected.**

**(b) Document wrangler-CLI inspection, build nothing.** Honest, zero risk, but
it leaves the Studio panel blind to the one event an operator must see
(permanent failure) — and we already have the mirror for free:

**(c) Mirror dead letters into the root shard via the capture sink —
already 90% shipped.** With section 1 wired, the terminal failed delivery of
every workpool job is captured with `deadLettered: true` (the
`attempts > maxRetries && outcome !== "ack"` derivation,
`dispatch.ts:311`) at the moment the consumer `retry()`s it for the last time —
no DLQ consumer needed, because the *main* queue's consumer witnesses the final
attempt. The Studio Queues panel already renders the dead-lettered badge and
the reliability banner counts these rows
(`reliability.ts:32`). "Retry" is the panel's existing **replay** button:
`replayQueueMessage` (`shard-do.ts:6810-6851`) re-enqueues the captured body
onto the producer binding — for a workpool message the body is the full
`QueueJob`, so a replay is a faithful re-dispatch with a fresh retry budget,
functionally identical to SchedulerDO's `/dead/retry` attempt reset. "Cancel"
is a no-op verb in this model: the real message is already in the DLQ and will
age out; the mirrored row is just a log entry (the panel's clear-log action
covers tidiness).

Failure modes of (c), stated: the mirror is best-effort (a capture write that
times out loses that record — the DLQ still holds the message, so nothing is
lost, only unlisted); a replayed job that fails again produces a second
dead-lettered row (visible, not a silent loop — each replay is an audited
operator action, `shard-do.ts:6851`, not an automatic requeue, so no poison
loop is possible); and truncated-body messages refuse replay explicitly
(`shard-do.ts:6825-6834`). The DLQ itself remains the durable source of truth
and stays inspectable/drainable via wrangler.

**Recommendation: (c) for visibility + replay-as-retry, with (b)'s
documentation for the raw-DLQ escape hatch.** One caveat to document: for the
replay button to work, the workpool queue needs a declared producer binding in
the registry the shard resolves against (`shard-do.ts:6836-6844` refuses
replay with no declared producer) — the workpool producer
(`createQueueWorkpool`) already requires exactly that binding
(`queue-workpool.ts:63-65`), so this holds wherever the workpool is actually
in use; the build plan must confirm the codegen queue-registry includes
workpool queues, and wire it if not (this is the only genuinely new plumbing
in the whole design).

## 4. Studio surface

**No new pages, no new components.** The read model is the existing
`getQueueMessages` result (`shard-do.ts:7654-7666`), which
`packages/studio/src/features/queues/queues-panel.tsx` already renders:
outcome badges (`outcomeVariant`), dead-letter badge, per-queue filter, body
preview, replay/send actions, poll refresh via `useAutoRefresh`. The
reliability banner (`packages/studio/src/features/queues/reliability.ts`)
already counts dead-lettered rows in the window and flags queues without a
`deadLetterQueue`. Once the workpool consumer feeds the same
`recordQueueMessage` RPC, its jobs appear in this panel with zero UI work.

Optional polish (defer until asked for): the panel's `exportName` column would
show `workpool:<functionPath>` — a small formatter could label these "workpool
job", but the raw string is already self-describing.

The SchedulerDO panels (`scheduler-pools-panel.tsx`, `dead-letter-jobs.tsx`)
stay what they are: the surface of the *other* backend. Do not try to merge the
two into one abstract "workpool" page — the data models are genuinely
different (live semaphore state vs. an append-only consumed log), and plan 055
made the backends explicitly distinct.

## 5. Open questions for the maintainer

1. **Should the scheduler get its own copy of the capture sink, or should the
   sink move to `shared/`?** Recommended: a package-local copy in
   `@lunora/scheduler`, matching the two existing hand-synced mirrors
   (`CapturedQueueMessage` ↔ `RecordQueueMessageInput`, and `MAX_QUEUE_BATCH`).
   `shared/` requires zero-dependency files; the sink imports `LunoraError`
   from `@lunora/errors`, so it does not qualify without rework.
2. **Who wires `capture` into `createQueueConsumer` — codegen or the app?**
   Recommended: same wiring as `@lunora/queue`'s consumer — the generated
   worker builds the sink when `shouldCaptureQueue(env)` passes and passes it
   in; a hand-rolled consumer opts in manually. Keeps production zero-cost by
   default.
3. **Does `maxRetries` in `QueueConsumerOptions` risk drifting from
   `wrangler.jsonc`?** Yes, same as `@lunora/queue`'s `definition.maxRetries`.
   Recommended: accept the drift risk (a wrong value only mis-flags
   `deadLettered`, never changes delivery) and have the wrangler validator
   (`packages/config`) warn when the two are both present and disagree — as a
   follow-up, not in the first build.
4. **Is the workpool queue present in the codegen queue registry that
   `replayQueueMessage` resolves producers from?** Must be answered in the
   build plan (section 3 caveat). If not, replay for workpool rows needs the
   registry entry added — small, but it is real code in `@lunora/codegen`.
5. **Should backlog absence be surfaced in Studio (an explanatory empty state)
   rather than only in docs?** Recommended: no. The Queues panel makes no
   backlog claim today; adding UI to explain a missing number is UI for a
   feature that does not exist.

## What the build plan inherits

Scope: (1) `CapturedWorkpoolMessage` + `capture`/`maxRetries` options +
record-building in `createQueueConsumer` (~60 lines incl. docs);
(2) scheduler-local `createQueueCaptureSink`/`shouldCaptureQueue` copy
(~130 lines, mostly ported comments); (3) codegen wiring per open question 2 +
registry confirmation per open question 4; (4) docs: module docstring +
tradeoff table row for backlog. Tests model on `@lunora/queue`'s existing
capture tests (plain-object batches; the consumer is already Node-safe by
design, `capture.ts:10-13`). No Studio changes, no new admin RPCs, no DO
changes, no new endpoints.
