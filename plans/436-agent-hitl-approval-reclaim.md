# Plan 436: Stop the abandoned-run reclaim from stranding pending HITL approvals

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/agent/src/agent-loop.ts packages/agent/src/component.ts packages/agent/src/types.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

A human-in-the-loop approval that a person takes longer than 13 hours to give (overnight, a weekend) becomes permanently unresolvable. The HITL pause hibernates on `step.waitForEvent` with **no timeout**; meanwhile the staleness reclaim in `agentEnsureThread` treats any thread untouched for `ABANDONED_RUN_MS` (13h) as free — including `awaiting_input` threads — and re-stamps a new caller's `instanceId` onto it. The client still shows the `awaiting_approval` message row, but `agentResolveApproval` then throws `FORBIDDEN` (`instance "…" does not own thread "…"`) forever. A slow approver is the _normal_ HITL case, so this is a first-encounter failure. The two comments in `component.ts` state contradictory intentions: the concurrency-guard comment says `awaiting_input` "still owns the thread and will resume", while the reclaim two lines later overrides exactly that.

## Current state

- `packages/agent/src/agent-loop.ts:216-226` — `awaitApproval` persists the `awaiting_approval` marker, patches the thread to `awaiting_input`, then:
    ```ts
    const event = await step.waitForEvent<ApprovalDecision>(`approval:${call.id}`, { type: `agent-approval:${call.id}` });
    ```
    No `timeout` — although the host type supports it: `packages/workflow/src/types.ts:152`:
    ```ts
    waitForEvent: <T = unknown>(name: string, options: { timeout?: number | string; type: string }) => Promise<...>;
    ```
- `packages/agent/src/component.ts:44` — `const ABANDONED_RUN_MS = 13 * 60 * 60 * 1000;`
- `packages/agent/src/component.ts:387-392` (inside `agentEnsureThread`):
    ```ts
    const updatedAt = typeof existing["updatedAt"] === "number" ? existing["updatedAt"] : 0;
    const abandoned = now - updatedAt > ABANDONED_RUN_MS;
    const isConcurrentRun =
        !abandoned &&
        (existing["status"] === "running" || existing["status"] === "awaiting_input") &&
        priorInstanceId !== undefined &&
        (args.instanceId === undefined || args.instanceId !== priorInstanceId);
    ```
    The comment block above it (`:363-368`) says `awaiting_input` "is a HITL pause hibernating on step.waitForEvent, which still owns the thread and will resume."
- `packages/agent/src/component.ts:413-419` — the fall-through patches `status: "running"` and re-stamps the new `instanceId`.
- `packages/agent/src/component.ts:780-784` — `agentResolveApproval` throws `FORBIDDEN` when `readable["instanceId"] !== args.instanceId`.
- `packages/agent/src/component.ts:561-577` — `agentCompleteRun`'s not-the-owner branch releases the parked run-queue slot; the reclaim exists to reap runs terminated while parked. Do not break this.
- `packages/agent/src/types.ts:194` — `needsApproval?: ((input, context) => boolean | Promise<boolean>) | boolean;` on `AgentToolDefinition` — the natural home for a per-tool approval timeout option is alongside it (or on the agent definition; see Step 2).

## Commands you will need

| Purpose    | Command                                         | Expected on success |
| ---------- | ----------------------------------------------- | ------------------- |
| Install    | `pnpm install`                                  | exit 0              |
| Build deps | `pnpm --filter "@lunora/agent..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/agent" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/agent" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/agent" run lint:eslint` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `packages/agent/src/component.ts`
- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/types.ts` (only if adding the timeout option here)
- `packages/agent/__tests__/component.test.ts`, `packages/agent/__tests__/agent-loop.test.ts` (extend)
- `api-snapshots/agent.api.md` (only if the public option is added — via `pnpm run api:update`)

**Out of scope**:

- `packages/workflow/` — the `waitForEvent` host contract already supports `timeout`; do not change it.
- The run-queue dequeue/parking machinery (`run-queue.ts`) and `agentCompleteRun`'s slot release.
- The MCP surface.

## Git workflow

- Branch: shared wave branch `improve/wave22-agent` (your dispatcher creates it).
- Commits (one per step): `fix(agent): keep awaiting_input threads out of the reclaim`, `feat(agent): time out HITL approvals with a terminal marker`

## Steps

### Step 1: Exclude `awaiting_input` from the abandoned reclaim

In `component.ts`, change the `abandoned` computation so a thread whose `status` is `"awaiting_input"` is **not** treated as abandoned at 13h. Two acceptable shapes — pick the first unless you find a reason not to:

1. `const abandoned = existing["status"] !== "awaiting_input" && now - updatedAt > ABANDONED_RUN_MS;`
2. A separate, much longer `ABANDONED_APPROVAL_MS` horizon for `awaiting_input` threads (e.g. 14 days, chosen to exceed any plausible approval timeout from Step 2).

Prefer shape 2 only if Step 2's timeout is configurable beyond 13h with no upper bound — an `awaiting_input` thread must never outlive its ability to be reclaimed _eventually_ (a workflow instance can die without ever timing out its wait). If you use shape 1, note in the commit body that Step 2's timeout is what ultimately frees the thread. Update the comment block at `:363-368` and the reclaim comment so the two no longer contradict each other.

**Verify**: `pnpm --filter "@lunora/agent" run test` → existing `component.test.ts` concurrency/reclaim tests still pass.

### Step 2: Add an approval timeout to `awaitApproval`

In `agent-loop.ts`, pass a `timeout` to the `waitForEvent` call. Default: `"3 days"`. Make it configurable — add an optional `approvalTimeout?: number | string` to the agent definition's tool-loop options (find where `needsApproval` tools are configured — `packages/agent/src/types.ts` — and place the option at the level that reaches `TurnContext`; if threading it to `awaitApproval` requires touching more than `types.ts` + the context assembly + `agent-loop.ts`, STOP and report the actual thread-through path first).

When the wait times out (Cloudflare Workflows rejects the `waitForEvent` promise on timeout — verify how the host surfaces it by reading `packages/workflow/src/wait-for-event.ts` and its tests), catch that specific timeout rejection and:

1. `persist` a terminal marker updating the approval row: `status: "rejected"`, content `"Approval timed out."` (reuse the same `messageKey` `${instanceId}:approval:${call.id}` so the row is patched, not duplicated — verify `persist`'s upsert semantics by reading it first).
2. Return `{ decision: "rejected", note: "approval timed out" }` so the loop proceeds down the existing rejection path.

**Verify**: `pnpm --filter "@lunora/agent" run test` → new tests pass (Step 3).

### Step 3: Tests

- In `component.test.ts` (model on the existing concurrency-policy tests in that file): a thread with `status: "awaiting_input"` and `updatedAt` older than 13h is **not** reclaimed by a differing-instance `agentEnsureThread` (the concurrency policy still applies).
- In `agent-loop.test.ts` (model on the existing `awaitApproval` tests; the loop harness is `loop-harness.ts`): a timed-out wait persists the `rejected` marker and resolves the decision as rejected.

**Verify**: `pnpm --filter "@lunora/agent" run test` → all pass including the new cases.

### Step 4: API snapshot (only if a public option was added)

`pnpm run build:packages && pnpm run api:update` — commit the `api-snapshots/agent.api.md` delta. (Skip if the timeout option landed on an internal type only.)

**Verify**: `pnpm run api:check` → exit 0.

## Test plan

- New: reclaim exclusion for `awaiting_input` (component), approval-timeout marker + rejected decision (agent-loop).
- Existing suites must stay green — notably the run-queue release tests around `agentCompleteRun`.

## Done criteria

- [ ] `pnpm --filter "@lunora/agent" run test` exits 0 with the new tests
- [ ] `pnpm --filter "@lunora/agent" run lint:types` exits 0
- [ ] `grep -n "waitForEvent" packages/agent/src/agent-loop.ts` shows a `timeout` in the approval wait's options
- [ ] The `abandoned` computation no longer reclaims `awaiting_input` at 13h (read the diff)
- [ ] `pnpm run api:check` exits 0 (after api:update if surface changed)

## STOP conditions

- The excerpts don't match the live code (drift).
- Threading the timeout option to `awaitApproval` requires touching files beyond `types.ts` + the turn-context assembly + `agent-loop.ts`.
- You cannot determine from `packages/workflow` code/tests how a `waitForEvent` timeout is surfaced (rejection vs. sentinel) — do not guess.
- Any existing run-queue/`agentCompleteRun` test fails after Step 1.

## Maintenance notes

- Plan 445 (approvals-inbox spike) builds on the terminal-marker semantics added here.
- Reviewer: scrutinize the Step 1 choice (exclusion vs. longer horizon) against the queue-slot-leak rationale at `component.ts:561-577`; the parked-corpse reclaim must keep working for `running` threads.
