# Plan 648: A reused provider tool-call id cannot replay an earlier approval or tool result

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/agent/src/agent-loop.ts packages/agent/src/component.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: security
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Revised design after the first execution (2026-11-21)

The first run stopped correctly: renaming every step to `<turn>:<id>` would drop the memoized results of every run in flight at deploy time, so their earlier tools would run again and a run awaiting approval would ask twice. Decided design, replacing "Design (decided)" above:

1. **Only a repeated id gets the turn-scoped slot.** While walking the turns, keep the set of tool-call ids already seen in earlier turns of the same run. It is derived from the memoized `llm:turn:N` outputs, so it is identical on every replay. The first occurrence of an id keeps today's names exactly (gate step, `approval:request`, wait name and event type, tool step, `idempotencyKey`, message keys). A later occurrence uses `<turn>:<id>` in all of them. In-flight runs therefore keep their saved results and need no fallback. A duplicate id _within one turn_ is out of scope (say what happens today).
2. **Lookups by provider id.** Rows and `traceToolExecution` keep `toolCallId: call.id`. The approval lookup (now `pendingApprovalMarker` after plan 650, plus `grantApprovalForThread`) finds the marker by scanning the `${instanceId}:approval:` key range for `status === "awaiting_approval"` and the given `toolCallId`, and refuses with CONFLICT unless exactly one row matches. The marker stores the slot it waits under (optional field; absent means the bare id) and the resolve path sends the event typed with that slot.
3. The documented `idempotencyKey` format in `types.ts` (~75) gains one sentence: a call whose id repeats an earlier turn's id carries the turn in its key.

Tests: the four cases (a)–(d) from the Steps still apply, plus (e) a run whose turn 1 used id `x` and completed, replayed from the start: the turn-1 tool step is **not** executed again (same step name as before this change — assert the exact name), and (f) existing assertions on step names in `agent-loop.test.ts` and the tool test files pass **unchanged**; if any needs editing, STOP. Commit on the same branch, on top of plans 649 and 650: `security(agent): give a repeated tool-call id its own approval`.

## Why this matters

`@lunora/agent` runs durable agent loops on Cloudflare Workflows: every side effect is a named `step.do(...)` whose result is memoized by **name**, and a paused run waits on a named `step.waitForEvent(...)`. Tool calls that need a human decision write an "awaiting_approval" marker message and wait; `agentResolveApproval` in `packages/agent/src/component.ts` retires the marker and sends the wake event.

The step, wait and message keys for approvals and tool results use the provider's bare tool-call id. The same file states that ids can repeat within a run and scopes **secret** requests by turn for that reason:

```ts
};

/**
 * The key one secret request is stored, waited on and settled under. A provider can reuse a tool-call id in a later
 * turn of the same run, and every step, wait and row keyed on the bare id would then replay the earlier request. The
 * turn makes the slot unique within the run; the call id still correlates the tool result.
 */
const secretSlotOf = (turn: number, callId: string): string => `${String(turn)}:${callId}`;
```

Approvals and tool results were not given the same treatment:

```ts
    await step.do(`approval:request:${call.id}`, async (): Promise<void> => {
        await persist({
            content: `Awaiting approval to run tool "${call.name}".`,
            expiresAt: Date.now() + timeoutMs,
            messageKey: `${instanceId}:approval:${call.id}`,
            role: "tool",
            approvalAgent: turnContext.agentName,
            status: "awaiting_approval",
            toolCallId: call.id,
            toolName: call.name,
        });
        await patchThread({ status: "awaiting_input" });
    });

    const decision = await step
        .waitForEvent<ApprovalDecision>(`approval:${call.id}`, {
            timeout: timeoutMs,
            type: `agent-approval:${call.id}`,
        })
        .then((event): ApprovalDecision => {
```

```ts
        step,
        threadKey,
        tools,
    } = turnContext;
    const stepName = `tool:${call.name}:${call.id}`;
    const tool: AnyAgentTool | undefined = tools[call.name];
    const messageKey = `${instanceId}:tool:${call.id}`;

    // The model can only call declared tools (the schema constrains it), but a
...
    // replay-stable identity `stepName` and `approval:${call.id}` already
    // trust), so it stays collision-free per call.
    const gateStepName = `tool:approval-gate:${call.id}`;

    // Human-in-the-loop: a gated tool pauses the run until a client approves or
```

(`generate.ts` passes `call.toolCallId` through unchanged; `agentAppendMessage` in `component.ts` returns the existing row when a `messageKey` already exists.) If a later turn reuses an id that an earlier, **approved** call used: the memoized gate step returns the earlier `true`, the `approval:request` step is skipped so no marker is written and the owner sees nothing, and the wait returns the earlier "approve" — a _different_ gated tool then runs new, unreviewed arguments (its own step is keyed `tool:<name>:<id>`, so it does execute). A predicate gate that returned `false` earlier is reused the same way. If the same tool repeats the id it gets the stale memoized output and its result row is silently dropped.

### Repo conventions that apply (from the repo's AGENTS.md — you have not read it, so they are inlined)

- TypeScript, ESM, `"moduleResolution": "bundler"`: relative imports have **no** file extension (`from "./foo"`, never `"./foo.js"`).
- Never mix a default export with named exports in one file. More than one export ⇒ named only.
- This is a pre-release (`1.0.0-alpha.*`) line: do **not** keep backward-compat shims or deprecated aliases; change the behaviour and update every call site.
- Comments say _why_ (a constraint or invariant), never restate the code or record history.
- An `eslint-disable` must be line-scoped, name the rule, and give a reason after `--`. Never add a file-level disable. Never skip or silence a test, type error or lint rule to get green.
- Tests are Vitest, live in the package's `__tests__/`, and **wait on a milestone, never on a clock** (no `sleep`, no real `setTimeout` waits). Existing tests start with `expect.assertions(n)`; match that.
- **A test must fail without the fix.** After writing a test, temporarily revert your fix, run the test, confirm it goes red, then restore the fix. Report that you did this.
- If you fix by hand: run Prettier before ESLint.
- Never run `pnpm -r run test`, never `pnpm run test:workerd`, never `pnpm run build:packages` (other sessions share this machine; those have crashed it). Use the single-package commands below.
- Never kill a process by name/pattern. Never `git add -A` / `git commit -a` / `git stash`; stage explicit paths.

## Commands you will need

Run everything from the repo (worktree) root. `dist/` is not committed, so build the package and its workspace dependencies once before testing or type-checking.

| Purpose                       | Command                                                          | Expected on success |
| ----------------------------- | ---------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                 | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/agent..." run build`                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/agent" exec vitest run __tests__/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/agent" run test`                         | all pass            |
| Types                         | `pnpm --filter "@lunora/agent" run lint:types`                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/agent" run lint:eslint`                  | exit 0, 0 warnings  |

## Design (decided)

Give approvals and tool results the slot the secrets already have: key every step name, wait name, event type and `messageKey` that today embeds `call.id` on `<turn>:<callId>` (reuse `secretSlotOf`, renamed to something neutral such as `callSlotOf`). The **provider's** call id must stay what the client sends back and what correlates the tool result for the model. So: the marker row keeps `toolCallId: call.id` and additionally stores its slot; `agentResolveApproval` (and the inbox that lists pending approvals, and `grantApprovalForThread` / `retireApprovalMarker` / `pendingApprovalAgent`) resolve the pending marker for `(thread, instance, toolCallId)` — read how the **secret** path maps a call id back to its slot (`rg -n "byThreadCallId|secretSlotOf|callId" packages/agent/src/component.ts | head -40`) and do the same — then send the event typed with the slot. If two markers with the same `toolCallId` could be pending at once on one instance, resolve the one that is `awaiting_approval` (only one call waits at a time; assert that).

Runs parked across a deploy hold waits under the old names: when resolving, if the marker has no stored slot, send the event with the old type (`agent-approval:<toolCallId>`); the loop for a marker-less-slot replay is whatever the memoized steps already recorded. Say explicitly in your report what happens to a run that was awaiting approval at deploy time.

## Steps

1. Read the loop's tool path end to end (`rg -n "call.id" packages/agent/src/agent-loop.ts`) and list every key that embeds the bare id.
2. Tests first, modelled on `secret-request-loop.test.ts` ("pauses for a new request when a later turn reuses the provider's call id…"): (a) turn 1 gated tool A id `x` approved; turn 2 gated tool B id `x` → a new marker is written, the run waits again, and B does not run until a second approval; (b) predicate gate false in turn 1, true in turn 2 with the same id → turn 2 asks; (c) same tool, same id, two turns → the tool runs twice and both result rows exist; (d) an approval for a marker without a slot (old shape) still wakes its wait. Red at baseline for (a)–(c).
3. Implement. 4. Build, test, types, eslint for `@lunora/agent`; run the package's own workerd-free tests only.

## Scope

**In scope**: `agent-loop.ts`, the approval functions in `component.ts`, tests, the marker row's optional slot field (schema extension of the agent component — an **optional** column only). **Out of scope**: the secret path (already scoped); provider adapters; client packages.

## Git workflow

- Branch: `security/agent-approval-and-secret-wakeups`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `security(agent): scope approvals and tool results per turn`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- The marker table cannot take an optional field without a migration step the component does not already have a pattern for: STOP and report.
- Scoping the tool **result** key changes what the model sees as the tool-result id (it must not): STOP and report.
