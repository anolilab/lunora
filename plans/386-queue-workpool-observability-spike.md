# Plan 386: [Spike] Design the observability story for the Queues-backed workpool

> **Executor instructions**: This is a DESIGN SPIKE — the deliverable is a
> design document, NOT production code. Investigate, prototype only if a
> question cannot be answered by reading, and write the design doc described
> under "Deliverable". Do not modify any source file. If anything in the
> "STOP conditions" section occurs, stop and report. Your reviewer maintains
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/scheduler/src/queue-workpool.ts packages/scheduler/src/scheduler-do.ts packages/queue/src/capture.ts`
> On drift, re-read the drifted files before writing.

## Status

- **Priority**: P3
- **Effort**: M (investigation + design doc)
- **Risk**: LOW (no code)
- **Depends on**: none (plan 378 will change `queue-workpool.ts`'s dispatcher internals — read its plan file if it landed first)
- **Category**: direction
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

The repo ships two workpool backends by explicit design (plans/README.md, plan 055: "the two workpool backends coexist by design"). The SchedulerDO backend has a full operational surface — `GET /status` (backlog, per-pool inFlight/queued), `GET /dead`, `POST /dead/retry`, `POST /dead/cancel` (`packages/scheduler/src/scheduler-do.ts:392-416, 1185-1248`) — and Studio reads it. The Queues backend (`packages/scheduler/src/queue-workpool.ts`) documents its own gap: "There is NO hard concurrency cap, per-job cancellation, or per-job status here". Picking the cheaper backend silently costs the whole operational story: no backlog number, no dead-letter list, no requeue. Meanwhile `packages/queue/src/capture.ts:90-161` already flows a consumed-message log to the root shard — but only from `@lunora/queue`'s consumer, not from `createQueueConsumer`. The cheap-looking move is wiring the existing capture sink through; the open half is what "DLQ inspection/requeue" even means when Cloudflare's DLQ is another queue, not a `dead:` row.

## Current state (read all before writing)

- `packages/scheduler/src/queue-workpool.ts` — producer (`createQueueWorkpool`), consumer (`createQueueConsumer`), `httpDispatcher`; module docstring records the design tradeoff.
- `packages/scheduler/src/scheduler-do.ts:1016-1066` (`/status`), `:1185-1248` (`/dead*`) — the surface to reach parity with, and its Studio consumer (grep the studio package for these routes to see what the UI actually renders).
- `packages/queue/src/capture.ts` — the capture sink: what it records, its 5s bounded write, its best-effort contract ("cannot change delivery").
- Cloudflare Queues consumer semantics: `max_concurrency`, `max_retries`, `dead_letter_queue` in `wrangler.jsonc`; a DLQ is itself a queue that needs its own consumer.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Install | `pnpm install` | exit 0 |
| Find Studio consumers | `grep -rn "dead/retry\|/status" apps/studio packages/studio 2>/dev/null` | locates the UI pages |

## Scope

**In scope**: creating `plans/386-queue-workpool-observability-design.md` (the deliverable).
**Out of scope**: ANY source-code change. Building the feature. Changing plan 378's dispatcher work.

## Git workflow

- Branch: `improve/wave22-scheduler` (same as 378; separate commit)
- Commit: `docs(scheduler): queue workpool observability design`

## Deliverable

Write `plans/386-queue-workpool-observability-design.md` answering, with evidence from the files above:

1. **Consumed-job visibility**: exact wiring to pass the `@lunora/queue` capture sink (or a scheduler-owned equivalent) into `createQueueConsumer` — signature sketch, what each record carries, and whether the 5s bounded write budget suits a workpool batch.
2. **Backlog approximation**: can `/status`-style backlog be answered without a DO? Enumerate what Cloudflare exposes (queue depth via API? producer-side counting?) and recommend one option with its staleness bound — or recommend "not offered; document it".
3. **DLQ story**: define what `retry`/`cancel` mean when the DLQ is a queue. Options to evaluate: (a) ship a canned DLQ consumer that re-enqueues to the main queue on demand; (b) document wrangler-CLI-based inspection and don't build; (c) mirror dead letters into the root shard via the capture sink and drive requeue from there. Recommend one, with the failure modes (visibility timeout, poison loops) each option carries.
4. **Studio surface**: which existing Studio page/components would render this (name files), and what minimal read model they need.
5. **Open questions** for the maintainer, each with a recommended answer.

Every claim about Cloudflare Queues behavior must cite either the wrangler config schema in-repo (`packages/config` validates `wrangler.jsonc` — check what it knows about queue consumers) or be marked "needs verification against CF docs".

## Done criteria

- [ ] The design doc exists and answers all five sections with file-level evidence
- [ ] `git status` shows ONLY the new design doc (and this plan file's status row edit if instructed)
- [ ] No source files modified

## STOP conditions

- Plan 378 landed and rewrote `queue-workpool.ts` so heavily that the consumer shape assumed here is gone — re-read, then write against the new shape; if the capture-sink premise itself died, report instead.

## Maintenance notes

- This spike feeds a future build plan; its recommendation section should be written so the build plan can inline it as "Why this matters".
