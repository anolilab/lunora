# Plan 240 — Durable run queue for `onConcurrentRun: "queue"` (design spike)

- **Category**: correctness (silent feature degradation)
- **Status**: SPIKE — design + single-surface prototype only, no production wiring
- **Baseline**: `2d4f71511` (drift check passed — no changes to `packages/agent/src` since)
- **Goal**: decide how a durable per-thread run queue would work for
  `defineAgent({ onConcurrentRun: "queue" })`, which today silently degrades to
  `"reject"` (`packages/agent/src/component.ts:228-230`). Produce a design +
  a test-only prototype proving the ordering/seq-claim correctness holds. Do
  **not** wire the real thing into `agentEnsureThread` or any trigger path.

## Current state (verified)

- `packages/agent/src/types.ts:579-592` documents `onConcurrentRun: "queue" |
"reject" | "replace"` and says `"queue"` is "reserved for a future durable
  queue; currently degrades to `reject`."
- `packages/agent/src/component.ts:184-250` (`agentEnsureThread`) is the actual
  guard: it detects a genuine second run (different, live `instanceId` on a
  `"running"`/`"awaiting_input"` thread) and either throws `CONFLICT`
  (`"reject"`, the default, and today also `"queue"`) or takes the thread over
  (`"replace"`, `component.ts:237-249`).
- `packages/agent/src/agent-loop.ts:983-997` calls `ensureThread` at the very
  top of `runAgentLoop`, **outside** `step.do` — the comment there explains why:
  "get-or-create; keyed append ... so a replay converges" without needing
  Workflow-level memoization. A `CONFLICT` throws before any message is
  persisted, so a rejected/queued run never touches the winning run's thread.
- The HITL approval pause (`packages/agent/src/agent-loop.ts:207-241`,
  `awaitApproval`) is the existing precedent for "durably park a workflow
  instance and wake it selectively": it persists a marker, patches the thread
  to `"awaiting_input"`, then calls `step.waitForEvent<ApprovalDecision>(
`approval:${call.id}`, { type: `agent-approval:${call.id}` })`. Resolution
  (`component.ts:512-557`, `agentResolveApproval`) calls
  `ctx.agents[agent].sendEvent(instanceId, { type: `agent-approval:${toolCallId}`,
payload })` — the SAME `AgentHandle.sendEvent` producer
  (`types.ts:1161-1187`) a queue resume would use.
- `packages/scheduler/src/create-workpool.ts:24-34` is explicit about its own
  boundary: "Why not Cloudflare Queues? ... do NOT grow multi-step
  orchestration on top of this — that's Cloudflare **Workflows** (`step.do` /
  `step.sleep` / `step.waitForEvent`)." A workpool is a bounded-concurrency
  **action dispatcher** (fire-and-report-completion via `POST /complete`) with
  no notion of "this specific already-created workflow instance is paused,
  wake exactly it, and hand it durable state." An agent run **is** the
  multi-step orchestration the workpool's own doc tells callers to keep off
  it.

## Recommendation: park on the agent's own DO table + `step.waitForEvent`, not the scheduler workpool

Do **not** route `"queue"` through `@lunora/scheduler`'s workpool. Two reasons,
both load-bearing:

1. **Wrong unit of work.** The workpool dispatches a `FunctionReference` call
   and waits for `POST /complete`; it has no concept of "resume workflow
   instance `wf-b` at its `waitForEvent` point." Fitting a park/resume queue
   onto it means building exactly the orchestration primitive
   `create-workpool.ts` says belongs in Workflows — i.e. reimplementing
   `step.waitForEvent` on top of a tool whose doc comment says not to.
2. **Wrong ownership boundary.** The seq-claim correctness (below) depends on
   the dequeue-and-handoff happening in the _same_ DO mutation that frees the
   thread, so no third party can observe a briefly-ownerless thread. That
   mutation already lives on the agent's own `agent_threads` table inside the
   shard DO. Routing through a second DO (`SchedulerDO`) would split that
   atomic step across two storage backends and reopen the exact race the
   design has to close.

Instead: add a bounded, per-thread durable queue **table** to the same schema
extension `agent_threads`/`agent_messages` already live in
(`packages/agent/src/component.ts:35-132`), and drive parking with
`step.waitForEvent` — the same primitive the HITL approval path already
proves out end-to-end (persist marker → patch status → wait on a scoped event
type → resume → patch status back).

### Shape (not implemented outside the prototype)

```ts
// A NEW bare table alongside "threads"/"messages" in the same extension.
const RUN_QUEUE_BARE_TABLE = "run_queue";

defineTable({
    agent: v.string(),
    enqueuedAt: v.number(),
    instanceId: v.string(),
    // Monotonic per-thread position — see "ordering" below for why this beats
    // sorting by `enqueuedAt` alone.
    position: v.number(),
    threadKey: v.string(),
})
    .index("byThread", ["threadKey", "position"]) // FIFO dequeue
    .index("byThreadInstance", ["threadKey", "instanceId"], { unique: true }) // idempotent enqueue
    .public();
```

## Ordering + seq claim — the correctness core

The STOP condition this plan was written under is: _"the per-thread seq
counter can't be claimed by a resuming run without racing the in-flight
run."_ Working through it: **it doesn't race**, provided both halves of the
handoff stay inside the DO's existing single-threaded mutation serialization
— the same property that already makes today's `"reject"`/`"replace"` branches
race-free.

**Enqueue (on conflict, policy `"queue"`).** Inside the _same_ mutation that
today throws `CONFLICT` (`component.ts:230-235`), instead:

- Look up an existing queue row for `(threadKey, instanceId)` (the
  `byThreadInstance` unique index). If found, return its existing `position`
  — **do not** insert a second row. This is the fix for the replay hazard
  (below): `ensureThread` runs outside `step.do`, so a workflow replay of a
  still-parked run re-executes this mutation for real, and it must be a
  no-op, not a duplicate enqueue.
- Otherwise, if the queue is at its depth bound, throw `CONFLICT` (the same
  message shape as `"reject"` today) — see "Bound + overflow" below.
- Otherwise, insert `{ threadKey, instanceId, agent, enqueuedAt: now,
position: nextPosition }`, where `nextPosition` is a per-thread counter
  (stored on the thread row, incremented like `messageCount` already is) —
  **not** `Date.now()`. Two runs parking in the same millisecond must still
  get a strict, unambiguous order; a counter allocated inside the same
  serialized mutation gives that for free, the same way `messageCount` already
  gives `seq` its ordering.
- Return `{ created: false, queued: true, position }` instead of throwing.

**Resume (on completion).** Inside the _same_ mutation that today patches the
finishing thread to `"idle"`/`"error"`/`"cancelled"` (there is no such
mutation yet — today's `patchThreadByKey` in `agent-loop.ts` just sets
`status`; the prototype adds the "check the queue" step to that call site):

- Guard on `thread.instanceId === callerInstanceId` first — the same
  ownership check `agentResolveApproval` already applies
  (`component.ts:533-537`). This makes the dequeue step idempotent under a
  replay of the _finishing_ run's own completion: a second execution sees the
  thread's `instanceId` has already moved to the dequeued run and no-ops
  rather than dequeuing the _next_ entry too.
- Query `byThread` ordered by `position` ascending, take the first row (FIFO).
- If none: patch the thread to the terminal status as today.
- If found: **in the same mutation**, delete the queue row and patch the
  thread to `{ instanceId: head.instanceId, status: "running", updatedAt:
now }` — i.e. skip the terminal-status write entirely; ownership transfers
  directly from the finishing instance to the head of the queue. Return
  `{ dequeued: head.instanceId }` to the caller (the finishing run's
  workflow), which then calls `ctx.agents[agent].sendEvent(head.instanceId,
{ type: `agent-dequeue:${threadKey}:${head.instanceId}`, payload: {} })`.

Because both enqueue and dequeue-and-handoff are single mutations on a
single-threaded DO, there is no window where the thread is observably
"free": a third run — genuinely new, or a replay of anyone else — either
sees the thread still owned by the run that's about to finish, or already
owned by the dequeued instance. Nobody can wedge in between. The resumed run
never re-claims anything for its first message: by the time its
`waitForEvent` resolves, `thread.instanceId` already names it, so it goes
straight to `agentAppendMessage` (which — same as today — isn't itself
instance-gated; the gate is entirely "who is allowed to become `running`").

## Resume trigger

`step.waitForEvent` on a queue-entry-scoped type: `agent-dequeue:<threadKey>:
<instanceId>` — mirrors the HITL approval's `agent-approval:<toolCallId>`
scoping exactly (`agent-loop.ts:216-220`'s reasoning applies verbatim: native
CF Workflows matches a waiter by `type`, so an unscoped type would let one
parked run's wake event resolve a different one). No alarm or cron: delivery
piggybacks on the finishing run's own completion step, which already has a
workflow context to call `sendEvent` from (same call site `agentResolveApproval`
already demonstrates is reachable via `ctx.agents`).

Open question (below): what happens if the DB mutation commits (ownership
already transferred) but the subsequent `sendEvent` RPC fails or the process
dies before making it — the dequeued run then owns the thread but is never
told to wake up.

## Replay safety

- **A parked run's own replay never double-enqueues** — the
  `byThreadInstance` unique lookup makes enqueue idempotent (see above).
- **A REPLAY re-entering under the same instance id is never treated as a new
  parked run** — inherited unchanged from the existing guard: `isConcurrentRun`
  in `component.ts:220-223` already excludes `args.instanceId === priorInstanceId`,
  and that check runs _before_ the queue branch, so it never fires for a
  replay of the run that currently owns the thread.
- **A finishing run's own replay never double-dequeues** — the
  `thread.instanceId === callerInstanceId` guard on the completion mutation
  (above) makes the handoff idempotent, same pattern as
  `agentResolveApproval`'s instance check.

## Prototype (test-only)

`packages/agent/src/run-queue.prototype.ts` implements exactly the two
mutations described above (`ensureThreadOrQueue`, `completeRunAndDequeue`)
against the SAME minimal `ctx.db` shape `__tests__/component.test.ts`'s
`fakeDatabase` already models (`insert`/`patch`/`query().withIndex().first()/
.collect()`) — **not** wired into `component.ts`, `agent-loop.ts`, or any
trigger path. It exists to prove the ordering/replay claims above, not to
ship.

`packages/agent/__tests__/run-queue.prototype.test.ts` drives:

- A starts and runs (`"running"`).
- B starts with `onConcurrentRun: "queue"` while A is in flight → parks
  (`queued: true`, not rejected — `CONFLICT` is never thrown).
- C starts the same way while A and B are both ahead of it → parks behind B
  (`position` strictly greater than B's).
- A completes → dequeue-and-handoff returns B's instance id; the thread now
  shows `instanceId: B`, `status: "running"`; the queue now holds only C.
- B completes → dequeue-and-handoff returns C's instance id; ordering
  A → B → C is asserted end to end via the sequence of `instanceId` values
  the thread took on, not just the two happy-path hops.
- A REPLAY of B's bootstrap while B is still parked (before A completes) does
  **not** create a second queue row and does **not** change B's `position`.
- A REPLAY of A's completion (called twice with the same finishing instance
  id) dequeues B only once — the second call is a no-op, not a double-dequeue
  that would skip C's turn.
- The queue enforces its depth bound: parking past the cap throws `CONFLICT`
  (the honest fallback), not an unbounded row count.

## Bound + overflow

The prototype hardcodes a small constant (`MAX_QUEUE_DEPTH = 5`) rather than
inventing a config surface — see open questions. Overflow throws the same
`CONFLICT` shape `"reject"` already throws today, so a caller that floods a
thread past the cap gets an honest, immediate failure instead of unbounded
durable rows or a run that silently never gets its turn.

## Open questions (unresolved by this spike)

1. **Queue depth + overflow policy as a real config surface.** The prototype
   hardcodes 5. Production needs this as a per-agent (or per-`onConcurrentRun`)
   knob — e.g. `onConcurrentRun: { mode: "queue", maxDepth: 5 }` — which is a
   breaking shape change to the current flat string literal union in
   `AgentConfig` (`types.ts:592`). Whether overflow should always be `"reject"`
   or itself configurable (e.g. drop-oldest) is unresolved.
2. **Wake-delivery failure.** If the completion mutation commits the
   ownership handoff but the follow-up `ctx.agents[agent].sendEvent(...)` call
   fails or never runs (crash between the two), the dequeued instance owns the
   thread but sits hibernating forever with nothing to wake it. The HITL
   approval path has the same theoretical gap today (an approval mutation that
   commits `sendEvent` failure) but it's user-triggered and retryable from a
   client; a queue resume has no user in the loop to retry it. Needs either a
   reconciliation sweep (an alarm that re-sends to any thread whose owner has
   been "running" with zero messages appended for N minutes) or a stronger
   guarantee that the mutation and the `sendEvent` call succeed atomically —
   both out of scope for a spike.
3. **What a client observes while parked.** `AgentThreadStatus` today is
   `"awaiting_input" | "cancelled" | "error" | "idle" | "running"` — none of
   these mean "your run is queued behind another." While B is parked, the
   thread it would attach to still shows A's status (`"running"`), since
   ownership hasn't transferred. Does the _caller_ of the queued run (which
   dispatched a workflow that's now parked, not the thread's live subscriber)
   need a way to observe `{ queued: true, position }`? The prototype's queue
   table could back a query, but adding a public query is a real feature
   decision, not a spike deliverable.
4. **Interaction with `"replace"`.** If a thread has A running and B, C parked
   behind it (`"queue"`), and a fourth run D calls with `onConcurrentRun:
"replace"`, does D take over from A only (leaving B, C to resume after D
   finishes — B/C queued behind a run they never knew about), or does replace
   flush the queue (terminate B and C too, since they were waiting for A
   specifically)? Both are defensible; this spike takes no position.
5. **Durable-state cost.** Each parked run is a live Cloudflare Workflow
   instance hibernating on `waitForEvent` for the parked duration — bounded by
   the depth cap, but a cap of 5 during a real burst is still 5 concurrently
   billed, paused Workflow instances per busy thread. Whether the default cap
   in question 1 should be smaller (e.g. 2-3) pending real usage data is
   unresolved.

## Non-goals (this spike)

- Wiring `"queue"` into `agentEnsureThread`/`agent-loop.ts` for real.
- Changing `"reject"`/`"replace"` behavior or their tests.
- Adding a `queueDepth` (or similar) field to `AgentConfig`/`defineAgent`.
- A client-facing "queued" status or query.
- The reply-out path (plan 242) — unrelated surface.
