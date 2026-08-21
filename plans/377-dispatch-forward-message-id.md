# Plan 377: Forward `messageId` as the dispatch idempotency id so at-least-once redelivery stops re-applying mutations

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/dispatch/src packages/queue/src packages/queue/__tests__`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

Cloudflare Queues is at-least-once. When a queue handler's `ctx.run` mutation succeeds but the batch later throws (or the consumer times out), redelivery re-runs the handler and the mutation is applied twice. The receiving endpoint already supports exactly-once: `packages/runtime/src/create-worker.ts` (~line 2847) reads a body `id` field and forwards it to the shard as the replay-dedup `mutationId` — that's how the SchedulerDO path achieves its "idempotent dispatch keyed by record id" contract. But `@lunora/dispatch`'s runner never sends an `id`, so queue and workflow dispatches are at-least-once while scheduler dispatches are exactly-once, with no note anywhere saying so. The per-message id is already in hand at the call site: `@lunora/queue`'s `pinRunToMessage` threads `message.id` into every `run(...)` call as `runOptions.messageId`.

## Current state

- `packages/dispatch/src/create-dispatch-runner.ts:258` — the POST body:
  ```ts
  body: JSON.stringify({ args: args ?? {}, functionPath: function_.__lunoraRef, shardKey: runOptions.shardKey }),
  ```
  `runOptions.messageId` is used only to stamp deterministic-failure errors (`toDispatchError(label, response.status, errorBody, runOptions.messageId)`).
- `packages/dispatch/src/types.ts:17-26` — `RunFunctionOptions.messageId` docstring currently says: "Purely local bookkeeping — **never sent to the dispatch endpoint**". This plan deliberately changes that contract; the docstring must be rewritten.
- `packages/runtime/src/create-worker.ts` (~2847) — the receiver:
  ```ts
  const mutationId = typeof candidate.id === "string" && candidate.id.length > 0 ? candidate.id : undefined;
  ...
  const response = await dispatchToShard(candidate.functionPath, args, shardKey, mutationId, identity);
  ```
  with a comment explaining the id is the at-least-once dedup key. An absent `id` is ignored — the change is backward-compatible.
- `packages/queue/src/dispatch.ts:131-134` — `pinRunToMessage` already sets `messageId` on every `message.run(...)` call.
- `packages/workflow/src/run-context.ts:38` — workflow builds one runner per context with `createDispatchRunner({ env, fetchImpl, label: "@lunora/workflow" })` and never sets `messageId`. (Workflow step-scoped pinning is Step 3, investigate-only.)

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/queue..." run build` | exit 0 |
| Dispatch tests | `pnpm --filter "@lunora/dispatch" run test` | all pass |
| Queue tests | `pnpm --filter "@lunora/queue" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/dispatch" run lint:types && pnpm --filter "@lunora/queue" run lint:types` | exit 0 |
| Lint | `pnpm --filter "@lunora/dispatch" run lint:eslint` | exit 0 |
| API gate | `pnpm run build:packages && pnpm run api:check` | exit 0 (run `pnpm run api:update` and commit the snapshot if it reports the intentional surface change) |

## Scope

**In scope**:
- `packages/dispatch/src/create-dispatch-runner.ts`
- `packages/dispatch/src/types.ts` (docstring)
- `packages/dispatch/__tests__/` (extend existing runner tests)
- `packages/queue/__tests__/` (one redelivery test)
- `packages/workflow/src/run-step.ts` + `run-context.ts` — ONLY if Step 3's investigation succeeds cheaply

**Out of scope**:
- `packages/runtime/src/create-worker.ts` — the receiver already handles `id`; do not touch.
- `packages/scheduler` — its DO path already sends the id (plan 378 covers its queue-workpool copy).
- The shard dedup table in `packages/do` — existing mechanism, do not touch.

## Git workflow

- Branch: `improve/wave22-dispatch` (shared with plan 379; commit per plan).
- Commit: `fix(dispatch): forward messageId as dispatch dedup id`

## Steps

### Step 1: Send the id

In `create-dispatch-runner.ts:258`, add `id: runOptions.messageId` to the JSON body (omit-when-undefined falls out of `JSON.stringify`). Update the `RunFunctionOptions.messageId` docstring in `types.ts` to state both roles: failure attribution AND the at-least-once dedup id forwarded to the dispatch endpoint.

**Verify**: `grep -n "id: runOptions.messageId" packages/dispatch/src/create-dispatch-runner.ts` → 1 match.

### Step 2: Tests

- In the existing dispatch-runner test file (`ls packages/dispatch/__tests__/`), add a test asserting the POSTed body includes `id` when `messageId` is set and omits the key when unset (the tests already capture `fetchImpl` calls — follow that pattern).
- In `packages/queue/__tests__/` (model after the existing `dispatch` capture-harness tests), add a test: deliver a batch whose handler runs `message.run(...)`, throw after, redeliver the same message, and assert the second dispatch body carries the same `id` as the first.

**Verify**: `pnpm --filter "@lunora/dispatch" run test && pnpm --filter "@lunora/queue" run test` → all pass including new tests.

### Step 3: Workflow step pinning (investigate; stop if non-trivial)

Check whether the workflow instance id and step name are reachable where `deps.run` is used in `packages/workflow/src/run-step.ts`. If a step-scoped wrapper (`(fn, args, o) => deps.run(fn, args, { ...o, messageId: `${instanceId}:${step.name}` })`) is a ≤15-line change with instanceId already in scope, do it and add one unit test in `packages/workflow/__tests__/define-step.test.ts`'s style. If instanceId is NOT already plumbed to `createRunStep`, SKIP this step and note it in your report — do not add new plumbing.

**Verify** (only if done): `pnpm --filter "@lunora/workflow" run test` → all pass.

## Test plan

- Dispatch: body includes/omits `id` (2 cases).
- Queue: redelivered message re-dispatches with the same `id` (1 case).
- Pattern files: the existing tests in `packages/dispatch/__tests__/` and `packages/queue/__tests__/`.

## Done criteria

- [ ] `grep -n '"id"\|id: runOptions.messageId' packages/dispatch/src/create-dispatch-runner.ts` shows the body field
- [ ] `packages/dispatch/src/types.ts` no longer claims messageId is "never sent"
- [ ] All commands in the table exit 0
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The receiver code at `create-worker.ts` (~2847) doesn't match the excerpt (drift).
- The dispatch endpoint rejects bodies carrying an unknown `id` field in any existing test (would mean a validator strips/denies extra fields — report, don't work around).
- Step 3 requires plumbing instanceId through more than one call site.

## Maintenance notes

- The dedup is per `(identity, mutationId)` in the shard — reviewers should confirm queue dispatches carry no end-user identity (system identity), which they do today.
- If a future consumer wants at-least-once deliberately, it can omit `messageId`; document that in the consumer, not by reverting this.
