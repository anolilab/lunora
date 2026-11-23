# Plan 650: Approving or rejecting an expired approval is refused, not reported as resolved

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/agent/src/component.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE, pushed: `security/agent-approval-and-secret-wakeups`, PR #1657

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`@lunora/agent` runs durable agent loops on Cloudflare Workflows: every side effect is a named `step.do(...)` whose result is memoized by **name**, and a paused run waits on a named `step.waitForEvent(...)`. Tool calls that need a human decision write an "awaiting_approval" marker message and wait; `agentResolveApproval` in `packages/agent/src/component.ts` retires the marker and sends the wake event. When an approval wait times out, the run records the call as rejected and only afterwards deletes the marker, so for a window the marker still reads "awaiting_approval". The inbox comment (`component.ts` ~1428-1430) says: "`agentResolveApproval` refuses it as timed out, so it is not offered." It does not. The deadline check exists only on the lasting-grant path:

```ts
// A timeout ends the wait without running any mutation, so the marker can still read
// "awaiting_approval" after the run has already rejected the call. The deadline is the only
// thing that closes that window.
// A marker with no deadline (one written before deadlines were recorded) cannot show its window is still open,
// so it grants nothing: every marker this code writes carries one.
const { expiresAt } = marker;

if (typeof expiresAt !== "number") {
    throw new LunoraError(
        "CONFLICT",
        `@lunora/agent: the approval for tool call "${toolCallId}" on thread "${threadKey}" has no recorded deadline, so it cannot be granted for the thread`,
    );
}

if (Date.now() >= expiresAt) {
    throw new LunoraError("CONFLICT", `@lunora/agent: the approval for tool call "${toolCallId}" on thread "${threadKey}" has timed out`);
}
```

while a plain approve or reject goes straight through:

```ts
            if (args.decision === "approve_for_thread") {
                // A lasting grant outlives this call, so it takes a verified owner: an ownerless
                // thread is readable by anyone who knows its key, which is fine for a one-off
                // approve or reject but not for skipping the gate on every later call.
                ownedSecretThread(thread, context.auth, "grant a lasting approval for a tool");
                await grantApprovalForThread(context.db, args.threadKey, agentName, args.instanceId, args.toolCallId);
            }

            await retireApprovalMarker(context.db, args.threadKey, args.instanceId, args.toolCallId);

            await handle.sendEvent(args.instanceId, {
                payload: {
                    decision: args.decision === "reject" ? "reject" : "approve",
                    toolCallId: args.toolCallId,
                    ...(args.decision === "approve_for_thread" ? { scope: "thread" } : {}),
                    ...(args.note === undefined ? {} : { note: args.note }),
                },
                // Scoped per tool call — see the doc comment above.
                type: `agent-approval:${args.toolCallId}`,
            });

            return { resolved: true };
        });
```

A client that holds a stale list, or does not use the inbox, tells the user "approved" for a tool the run already rejected.

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

Apply the same deadline rule to every decision: move the "marker is pending and not past `expiresAt`" check into one helper used by all three decisions, throwing the same `CONFLICT` "has timed out" error before the marker is retired or any event is sent. A marker with no recorded deadline keeps today's behaviour for a plain approve/reject (it is only refused for a lasting grant) — do not widen that. A **reject** of an expired marker is refused too: the run already rejected it, and reporting `resolved: true` would still be a false statement about what happened.

## Steps

1. Tests first in `component.test.ts` (approval fixtures default `expiresAt` to the future — add ones in the past): approve → CONFLICT, marker untouched, `sendEvent` not called; reject → the same; a marker without `expiresAt` → plain approve still resolves. Red at baseline. 2. Implement; make the inbox comment true as written. 3. Build, test, types, eslint for `@lunora/agent`.

## Git workflow

- Branch: `security/agent-approval-and-secret-wakeups (same branch as plans 648-649, separate commit)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(agent): refuse a decision on an expired approval`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- A test documents that a late approve must be accepted (for example to tolerate clock skew between the wait and the mutation): STOP and report it.
