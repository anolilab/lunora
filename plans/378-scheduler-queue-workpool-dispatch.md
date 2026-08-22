# Plan 378: Route the scheduler's queue-workpool dispatcher through `createDispatchRunner`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/scheduler/src/queue-workpool.ts packages/scheduler/package.json packages/scheduler/packem.config.ts`
> On any drift, compare the "Current state" excerpts against live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/377-dispatch-forward-message-id.md (the `id` forwarding it inherits)
- **Category**: bug / tech-debt
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`packages/scheduler/src/queue-workpool.ts`'s `httpDispatcher` is a third hand-rolled copy of the `/_lunora/scheduler/dispatch` wire contract (the others: `@lunora/dispatch`'s `createDispatchRunner` and `SchedulerDO`). This copy has **no timeout/abort** — a hung origin holds the whole `queue()` invocation open until the platform kills it, taking the batch with it — and sends **no idempotency `id`**, so each Queues redelivery re-applies the job's mutation. `createDispatchRunner` already provides the timeout, the `TimeoutError` mapping, deterministic-failure classification, and (after plan 377) the dedup id. Three copies of one wire contract drift independently; this removes one.

Deliberately **kept**: the consumer's retry-everything-to-DLQ semantics. The module docstring documents that a permanently-bad message "rides retries into the dead-letter queue where you can inspect it" — that is a recorded design choice, not a defect. Do not add ack-on-deterministic-failure here.

## Current state

- `packages/scheduler/src/queue-workpool.ts:135-155`:
    ```ts
    const httpDispatcher = (options: HttpDispatcherOptions): QueueDispatch => {
        const fetchImpl = options.fetchImpl ?? ...;
        const url = `${trimTrailingSlashes(options.originUrl)}/_lunora/scheduler/dispatch`;
        return async (job: QueueJob): Promise<void> => {
            const response = await fetchImpl(url, {
                body: JSON.stringify({ args: job.args ?? {}, functionPath: job.functionPath, shardKey: job.shardKey }),
                headers: { authorization: `Bearer ${options.adminToken}`, "content-type": "application/json" },
                method: "POST",
            });
            if (!response.ok) { throw new LunoraError("INTERNAL", `...`); }
        };
    };
    ```
    No `signal`, no `id`, error shape diverges from `@lunora/dispatch`'s `toDispatchError`.
- `packages/dispatch/src/create-dispatch-runner.ts` — POSTs to the same `SCHEDULER_DISPATCH_PATH = "/_lunora/scheduler/dispatch"` with a bounded timeout (`DEFAULT_DISPATCH_TIMEOUT_MS`), TimeoutError→retryable-503 mapping, and (post-377) the `id` field. Its options include `env`, `fetchImpl`, `label`.
- Dependency wiring: `@lunora/dispatch` is internal/not published; consumers bundle it. `packages/queue/package.json` lists `"@lunora/dispatch": "workspace:*"` under **devDependencies** and its `packem.config.ts` inlines it into `dist`. `packages/scheduler/package.json` has NO `@lunora/*` devDependencies today (`dependencies`: errors, platform, cron-parser).
- `QueueJob` (in `packages/scheduler/src/types.ts`) carries `functionPath`, `args`, `shardKey` — string function path, whereas `createDispatchRunner` takes a `FunctionReference` (`function_.__lunoraRef`).

## Commands you will need

| Purpose        | Command                                             | Expected on success                                  |
| -------------- | --------------------------------------------------- | ---------------------------------------------------- |
| Install        | `pnpm install`                                      | exit 0                                               |
| Build deps     | `pnpm --filter "@lunora/scheduler..." run build`    | exit 0                                               |
| Tests          | `pnpm --filter "@lunora/scheduler" run test`        | all pass                                             |
| Typecheck      | `pnpm --filter "@lunora/scheduler" run lint:types`  | exit 0                                               |
| Lint           | `pnpm --filter "@lunora/scheduler" run lint:eslint` | exit 0                                               |
| Manifest order | `pnpm run lint:package-json`                        | exit 0                                               |
| Dist gate      | `pnpm run dist:check`                               | exit 0 (dispatch must be inlined, not left as a dep) |

## Scope

**In scope**:

- `packages/scheduler/src/queue-workpool.ts`
- `packages/scheduler/package.json` (add `@lunora/dispatch` devDependency — same placement as queue's)
- `packages/scheduler/packem.config.ts` (mirror queue's inlining of dispatch)
- `packages/scheduler/__tests__/` (the existing queue-workpool test file)

**Out of scope**:

- `createQueueConsumer`'s retry semantics — documented design, keep as-is.
- `SchedulerDO`'s own dispatch (HMAC-signed, different trust model).
- `packages/dispatch` itself (plan 377/379 own it).

## Git workflow

- Branch: `improve/wave22-scheduler`
- Commit: `fix(scheduler): bound queue dispatch via dispatch runner`

## Steps

### Step 1: Add the bundled dependency

Add `"@lunora/dispatch": "workspace:*"` to `packages/scheduler/package.json` devDependencies (alphabetical position, matching `packages/queue/package.json`). Compare `packages/queue/packem.config.ts` and replicate whatever makes `@lunora/dispatch` inline into `dist` (rollup/noExternal entry); copy the same lines into scheduler's packem config.

**Verify**: `pnpm install` exit 0; `pnpm run lint:package-json` exit 0.

### Step 2: Rewrite `httpDispatcher` over `createDispatchRunner`

Replace the hand-rolled fetch with a runner built once per dispatcher:

```ts
const run = createDispatchRunner({
    env: { LUNORA_ADMIN_TOKEN: options.adminToken, LUNORA_ORIGIN_URL: options.originUrl },
    fetchImpl: options.fetchImpl,
    label: "@lunora/scheduler",
});
```

First READ `createDispatchRunner`'s options type in `packages/dispatch/src/create-dispatch-runner.ts` / `types.ts` — the exact env-key names and whether origin/token are options or env come from the source, not from this sketch. Then dispatch each job as:

```ts
await run({ __lunoraRef: job.functionPath } as FunctionReference, job.args ?? {}, { messageId: job.id, shardKey: job.shardKey });
```

again checking how `FunctionReference` is shaped in dispatch's types (if the runner accepts a plain string path via an existing helper, prefer that). `job.id` — check `QueueJob` for the id field name; if `QueueJob` has no id, use the queue message id from the consumer (thread it through `QueueDispatch`'s signature: `dispatch(job, messageId)`) so redeliveries dedupe.

Keep `httpDispatcher`'s public signature (`HttpDispatcherOptions → QueueDispatch`) unless threading the message id forces the `QueueDispatch` signature change — that is an allowed, pre-1.0 breaking change; update `createQueueConsumer`'s call site in the same file.

**Verify**: `pnpm --filter "@lunora/scheduler" run lint:types` → exit 0.

### Step 3: Tests

Update/extend the existing queue-workpool tests (find them: `grep -rln "httpDispatcher" packages/scheduler/__tests__/`):

- a dispatch that exceeds the timeout rejects with the runner's retryable timeout error (use a `fetchImpl` that never resolves + fake timers, following how `packages/dispatch/__tests__/` does it);
- the POST body carries `id` (the message id) and the existing `args`/`functionPath`/`shardKey`;
- a non-2xx response still throws (consumer retries — assert `message.retry()` is called, existing pattern).

**Verify**: `pnpm --filter "@lunora/scheduler" run test` → all pass.

### Step 4: Dist gate

**Verify**: `pnpm run build:packages && pnpm run dist:check` → exit 0 (proves dispatch is inlined and `dist/` stays production-clean). If `pnpm run api:check` reports a changed public surface (the `QueueDispatch` signature), run `pnpm run api:update` and commit the snapshot, stating the break in the commit body.

## Test plan

- 3 cases listed in Step 3; model on the existing scheduler queue-workpool tests and `packages/dispatch/__tests__/`'s fake-timer timeout tests.

## Done criteria

- [ ] `grep -n "fetchImpl(url" packages/scheduler/src/queue-workpool.ts` → no matches (hand-rolled POST gone)
- [ ] `grep -n "createDispatchRunner" packages/scheduler/src/queue-workpool.ts` → 1+ match
- [ ] All commands in the table exit 0
- [ ] No files outside the in-scope list modified

## STOP conditions

- `createDispatchRunner`'s options genuinely cannot express the admin-bearer + origin-URL wiring (e.g. it derives the URL from env keys the scheduler cannot provide) — report the mismatch instead of forking the runner.
- Inlining `@lunora/dispatch` into scheduler's dist fails `dist:check` after mirroring queue's packem config.
- The `QueueDispatch` signature change ripples beyond `queue-workpool.ts` and its tests.

## Maintenance notes

- After this, the wire contract has two implementations (runner + SchedulerDO's HMAC path). A future consolidation of the DO path should note the HMAC difference.
- Reviewer: check the timeout default is generous enough for long actions (the runner's `DEFAULT_DISPATCH_TIMEOUT_MS`), and that error classification doesn't change which failures the consumer retries (all of them, by design).
