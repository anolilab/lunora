# Plan 379: Replace `AbortSignal.timeout` with a strongly-held deadline at the Worker-runtime call sites

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/dispatch/src packages/container/src shared/`
> On any drift, compare the "Current state" excerpts against live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (merge-compatible with plan 377; both touch `create-dispatch-runner.ts` — land 377 first on the shared branch)
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

The repo contains two contradictory, load-bearing comments about the same API. `packages/container/src/exec.ts` documents — from observation in this repo ("written with `AbortSignal.timeout` this failed roughly three runs in eight") — that the built-in's signal is **weakly held**: once the only strong reference goes out of scope it can be collected and the deadline **silently never fires**, turning `timeoutMs` into an unbounded call. Meanwhile `packages/dispatch/src/create-dispatch-runner.ts` uses `AbortSignal.timeout` for the 30s bound on `ctx.run` — the call every workflow step, queue handler, and scheduled job takes back into Lunora — with a comment asserting no controller is needed. Both cannot be right. If exec.ts's empirical finding holds, an unresponsive origin can pin a queue consumer open until the platform kills it (taking the whole batch). The controller+timer form is strictly stronger and already proven in-repo.

## Current state

- The empirically-safe exemplar — `packages/container/src/exec.ts:184-200` (`execDeadline`): explicit `AbortController` + `setTimeout` + `AbortSignal.any`, returning `{ signal, dispose }`, with the weak-hold rationale in its docstring. Its abort reason is a container-specific `LunoraError`.
- The contradicting sites (all Worker-runtime code):
    - `packages/dispatch/src/create-dispatch-runner.ts:233` — `const timeoutSignal = AbortSignal.timeout(timeoutMs);` used for BOTH the fetch and the later `response.text()` body reads. Its `rethrowAsTimeoutOrOriginal` helper (~:246) matches `error.name === "TimeoutError"` to map the abort to a retryable 503.
    - `packages/container/src/otel.ts` (~:340) — `signal: AbortSignal.timeout(timeoutMs)` on the OTLP POST.
    - `packages/container/src/do/index.ts` (~:352) — `signal: AbortSignal.timeout(attemptTimeoutMs)` in the readiness poll loop.
- The already-correct sibling: `packages/queue/src/capture.ts:126-132` uses the controller+timer form.
- `shared/` (repo root) is the home for tiny zero-dep helpers inlined by the bundler (e.g. `shared/constant-time-equal.ts`); consumers import by relative path. **Both `packages/dispatch/tsconfig.json` and `packages/container/tsconfig.json` already omit `outDir`/`rootDir` with the breadcrumb comment**, so no tsconfig change is needed.

## Commands you will need

| Purpose   | Command                                                                                                 | Expected on success |
| --------- | ------------------------------------------------------------------------------------------------------- | ------------------- |
| Install   | `pnpm install`                                                                                          | exit 0              |
| Build     | `pnpm --filter "@lunora/dispatch..." run build && pnpm --filter "@lunora/container..." run build`       | exit 0              |
| Tests     | `pnpm --filter "@lunora/dispatch" run test && pnpm --filter "@lunora/container" run test`               | all pass            |
| Typecheck | `pnpm --filter "@lunora/dispatch" run lint:types && pnpm --filter "@lunora/container" run lint:types`   | exit 0              |
| Lint      | `pnpm --filter "@lunora/dispatch" run lint:eslint && pnpm --filter "@lunora/container" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `shared/abort-deadline.ts` (create)
- `packages/dispatch/src/create-dispatch-runner.ts`
- `packages/container/src/exec.ts` (rebase `execDeadline` onto the shared helper, keeping its LunoraError reason)
- `packages/container/src/otel.ts`, `packages/container/src/do/index.ts`
- `packages/dispatch/__tests__/`, `packages/container/__tests__/` (adjust/extend)

**Out of scope**:

- CLI / Node-only `AbortSignal.timeout` call sites (per the repo's prior decision, the CLI sites are fine — long-lived process, strong refs).
- `packages/queue/src/capture.ts` — already correct.

## Git workflow

- Branch: `improve/wave22-dispatch` (shared with plan 377; separate commit, after 377's).
- Commit: `fix(dispatch): strongly-held abort deadline for ctx.run`

## Steps

### Step 1: Create `shared/abort-deadline.ts`

Zero-dep (no imports beyond built-ins). Generalize `execDeadline` with a caller-supplied reason:

```ts
interface AbortDeadline {
    /** Clear the deadline timer. Always call in a `finally`, or a fast response leaves a pending timer. */
    dispose: () => void;
    signal: AbortSignal | undefined;
}

const abortDeadline = (signal: AbortSignal | undefined, timeoutMs: number | undefined, reason: () => unknown): AbortDeadline => { ... };
export { type AbortDeadline, abortDeadline };
```

Copy the weak-hold rationale docstring from `exec.ts` (it is the record of why this exists). Named exports only; no `.js` extensions.

**Verify**: `pnpm --filter "@lunora/container" run lint:types` after Step 2 (shared files typecheck transitively via consumers).

### Step 2: Rebase `execDeadline` onto it

In `exec.ts`, implement `execDeadline` as a thin call to `abortDeadline(signal, timeoutMs, () => new LunoraError("INTERNAL", `ctx.containers: exec timed out after ...`))` (relative import `../../../shared/abort-deadline`). Behavior identical; existing exec tests must stay green unchanged.

**Verify**: `pnpm --filter "@lunora/container" run test` → all pass.

### Step 3: Convert the dispatch runner

In `create-dispatch-runner.ts`, replace `AbortSignal.timeout(timeoutMs)` with the helper, aborting with a `DOMException` named `TimeoutError` so the existing `rethrowAsTimeoutOrOriginal` name-match keeps working:

```ts
const deadline = abortDeadline(undefined, timeoutMs, () => new DOMException(`dispatch timed out after ${timeoutMs}ms`, "TimeoutError"));
```

Pass `deadline.signal` to the fetch; call `deadline.dispose()` in a `finally` that wraps the ENTIRE fetch+body-read region (the signal must stay live for the `response.text()` calls — read the existing comment at :227-233 and keep that property). Delete the now-false "no manual AbortController needed" comment. Confirm `DOMException` is constructible in the package's test environment (Node ≥18 global); if the runtime lacks it, fall back to `Object.assign(new Error(...), { name: "TimeoutError" })`.

**Verify**: `pnpm --filter "@lunora/dispatch" run test` → all pass (the existing timeout tests assert the TimeoutError mapping).

### Step 4: Convert the two remaining container sites

`otel.ts` (~~:340) and `do/index.ts` (~~:352): same pattern, `dispose()` in `finally`. In the readiness poll loop, dispose per attempt. Update the otel comment that claims the unref'd timer is sufficient.

**Verify**: `pnpm --filter "@lunora/container" run test` → all pass; `grep -rn "AbortSignal.timeout" packages/dispatch/src packages/container/src` → no matches.

## Test plan

- Existing dispatch timeout tests keep passing (they are the regression net for the TimeoutError mapping).
- Add one dispatch test: a fetch that resolves quickly leaves no pending timer (assert via `vi.getTimerCount()` with fake timers — model on the fake-timer usage already in `packages/dispatch/__tests__/`).
- Container: existing exec deadline tests keep passing unchanged.

## Done criteria

- [ ] `grep -rn "AbortSignal.timeout" packages/dispatch/src packages/container/src` → no matches
- [ ] `shared/abort-deadline.ts` exists, zero-dep, named exports
- [ ] All commands in the table exit 0
- [ ] No files outside the in-scope list modified

## STOP conditions

- Any existing dispatch test asserts on the exact `AbortSignal.timeout` reason object shape in a way `DOMException` can't satisfy after a reasonable adjustment.
- `dist:check` or the bundler fails on the `shared/` relative import from dispatch (would indicate dispatch's build doesn't inline shared files the way other consumers do — report, don't restructure the build).

## Maintenance notes

- Any NEW Worker-runtime timeout must use `shared/abort-deadline.ts`; `AbortSignal.timeout` remains acceptable only in CLI/Node-process code. Worth a line in a future lint rule.
- Reviewer: scrutinize the `finally` placement in Step 3 — disposing before the body read re-opens the "deadline resets after headers" bug the original comment guards against.
