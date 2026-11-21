# Plan 649: Supplying or declining a secret wakes the agent whose run is waiting

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/agent/src/component.ts packages/agent/src/agent-loop.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`@lunora/agent` runs durable agent loops on Cloudflare Workflows: every side effect is a named `step.do(...)` whose result is memoized by **name**, and a paused run waits on a named `step.waitForEvent(...)`. Tool calls that need a human decision write an "awaiting_approval" marker message and wait; `agentResolveApproval` in `packages/agent/src/component.ts` retires the marker and sends the wake event. Secret requests work the same way, but their wake-up picks the wrong agent on a reused thread:

```ts
 * wakes a paused secret wait.
 */
const secretWaitHandle = (
    context: unknown,
    thread: Record<string, unknown>,
): { instanceId: string; sendEvent: (id: string, event: { payload: unknown; type: string }) => Promise<void> } => {
    const { instanceId } = thread;
    const { agents } = context as { agents?: Record<string, { sendEvent?: (id: string, event: { payload: unknown; type: string }) => Promise<void> }> };
    const handle = agents?.[thread["agent"] as string];

    if (typeof instanceId !== "string" || typeof handle?.sendEvent !== "function") {
        throw new LunoraError("INTERNAL", `@lunora/agent: no ctx.agents["${String(thread["agent"])}"] producer to deliver the secret — run codegen/dev`);
    }
```

`thread["agent"]` is set only when the thread is first inserted; when another agent continues the thread, `agentEnsureThread` re-stamps `instanceId` but not `agent`:

```ts
// instance id is (re)stamped so cancel/replace can target it.
// `error` is cleared with `null` — see the column's doc comment.
await context.db.patch(THREADS_TABLE, existing["_id"] as never, {
    // eslint-disable-next-line unicorn/no-null -- `null` is how `ctx.db.patch` clears a nullable column; `undefined` is rejected (shard-engine's `assertNoExplicitUndefined`)
    error: null,
    status: "running",
    updatedAt: now,
    // Taking ownership retires the previous run's completion
    // marker — see `completedInstanceId`. An id-less caller
    // (voice, inbound) takes no ownership and retires nothing,
    // which is what keeps a finished run's re-dispatched
    // completion from waking a run parked behind THIS writer.
    // eslint-disable-next-line unicorn/no-null -- as above: `null` is the only value a patch can clear a column with
    ...(args.instanceId === undefined ? {} : { completedInstanceId: null, instanceId: args.instanceId }),
});

return { outcome: "continued" };
```

So if agent A created a thread and agent B's run now waits on a secret, the wake goes to A's workflow binding with B's instance id and fails; the failure is caught and the mutation still returns `{ resolved: true }` (`component.ts` ~1645-1650, ~1681-1686). B sleeps until the wait times out (default days). The approval path was already fixed for this exact case: it records `approvalAgent: turnContext.agentName` on the marker and resolves through it (see the excerpt in `agent-loop.ts` `approval:request` step, and `component.ts` ~1519 "The agent that owns the pending call, not the thread's creator").

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

Mirror the approval fix: record the requesting agent's name on the secret request (the request row and/or its marker — whichever the supply/decline path reads; add an **optional** field) when the loop writes it (`agent-loop.ts` ~456-463, `component.ts` ~333-361), and make `secretWaitHandle` use that agent, falling back to `thread["agent"]` for requests written before the field existed. Do not change `agentEnsureThread`. Separately, the swallowed wake failure must not report success: if `sendEvent` throws after the request row was settled, read the surrounding comments for why it is swallowed (the wait may already be gone — that is legitimate); keep swallowing only that case if it can be told apart, otherwise leave it and say so.

## Steps

1. Tests first (see `component.test.ts` secret fixtures and how the approval test covers a reused thread): thread created by agent A, run by agent B requests a secret, owner supplies it → `ctx.agents.B.sendEvent` is called with B's instance id, not A's; same for decline; a request row without the new field still uses the thread's agent. Red at baseline.
2. Implement. 3. Build, test, types, eslint for `@lunora/agent`.

## Git workflow

- Branch: `security/agent-approval-and-secret-wakeups (same branch as plan 648, separate commit)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(agent): wake the agent that asked for the secret`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- The request row schema cannot take an optional field (same condition as plan 648): STOP and report.
