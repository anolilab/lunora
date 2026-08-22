# Plan 380: Fail loud when repeated `ctx.runStep`/`ctx.waitForEvent` calls collide on one durable step name

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/workflow/src packages/workflow/__tests__`
> On any drift, compare the "Current state" excerpts against live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

Cloudflare Workflows' `step.do` memoizes by step name. A reusable `StepDefinition` run twice in one instance (e.g. a loop over items — the documented purpose of reusable steps) issues two `step.do` calls under the same `step.name`; the second silently returns the first's memoized result. Two `ctx.waitForEvent` calls on the same event type share the default name `event:${event.type}` and the second waits on an already-consumed event — wrong output or a hang, with no error. The framework's own fan-out code documents this exact hazard and guards it for branches (`fan-out.ts`: "step.do memoization would silently drop the second spawn… Fail loud and non-retryable instead"), but nothing equivalent exists for user steps and waits, and `RunStepOptions` offers no `name` override to disambiguate. Silently-wrong durable output is the failure class this package exists to prevent.

Deliberately NOT auto-suffixing names: that changes step identity for in-flight instances mid-deploy. Detection + an explicit `name` override is the safe cut.

## Current state

- `packages/workflow/src/run-step.ts:137`:
    ```ts
    return config === undefined ? deps.step.do(step.name, callback, rollbackOptions) : deps.step.do(step.name, config, callback, rollbackOptions);
    ```
- `packages/workflow/src/types.ts:274-277`:
    ```ts
    /** Per-call options for {@link WorkflowRunStepFunction}. */
    export interface RunStepOptions {
        /** Override the step's declared durability config for this call. */
        config?: WorkflowStepConfigLike;
    }
    ```
    (Check how `RunStepOptions` reaches `createRunStep`'s returned function — read `run-step.ts` top-to-bottom first.)
- `packages/workflow/src/wait-for-event.ts:55`:
    ```ts
    const received = await deps.step.waitForEvent(options?.name ?? `event:${event.type}`, { timeout: options?.timeout, type: event.type });
    ```
    `WaitForEventOptions` already HAS `name` — only the collision detection is missing there.
- The exemplar guard — `packages/workflow/src/fan-out.ts:229-244`: a `Set<string>` of seen ids, throwing `NonRetryableError` with a message explaining the memoization hazard.
- Both factories are built in `packages/workflow/src/run-context.ts:89-92`:
    ```ts
    runStep: createRunStep({ env: options.env, log, nonRetryableErrorClass: options.nonRetryableErrorClass, run, step: options.step }),
    ...
    waitForEvent: createWaitForEvent({ nonRetryableErrorClass: options.nonRetryableErrorClass, step: options.step }),
    ```
    One run context = one workflow invocation, so a Set created here is naturally per-invocation.
- `wait-for-event.ts` uses a `raiseNonRetryable(message, cause, deps.nonRetryableErrorClass)` helper — reuse it / its pattern for the new throws.

## Commands you will need

| Purpose    | Command                                            | Expected on success                                                                                 |
| ---------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Install    | `pnpm install`                                     | exit 0                                                                                              |
| Build deps | `pnpm --filter "@lunora/workflow..." run build`    | exit 0                                                                                              |
| Tests      | `pnpm --filter "@lunora/workflow" run test`        | all pass                                                                                            |
| Typecheck  | `pnpm --filter "@lunora/workflow" run lint:types`  | exit 0                                                                                              |
| Lint       | `pnpm --filter "@lunora/workflow" run lint:eslint` | exit 0                                                                                              |
| API gate   | `pnpm run build:packages && pnpm run api:check`    | exit 0 (`pnpm run api:update` + commit snapshot for the intentional `RunStepOptions.name` addition) |

## Scope

**In scope**:

- `packages/workflow/src/run-step.ts`
- `packages/workflow/src/wait-for-event.ts`
- `packages/workflow/src/run-context.ts`
- `packages/workflow/src/types.ts` (`RunStepOptions.name`)
- `packages/workflow/__tests__/` (extend existing step/event tests)

**Out of scope**:

- `fan-out.ts` — its branch-id guard already covers the parallel path; its `lunora:` reserved prefixes must keep working (the new tracker must either include them consistently or exclude framework-internal names — pick ONE and document it in a comment).
- Any auto-suffix/rename scheme — explicitly rejected for in-flight-instance safety.

## Git workflow

- Branch: `improve/wave22-workflow`
- Commit: `fix(workflow): reject duplicate durable step names`

## Steps

### Step 1: Per-invocation name tracker

In `run-context.ts`, create `const usedStepNames = new Set<string>()` per context and pass it into both `createRunStep` and `createWaitForEvent` deps. Decide (and comment) the framework-name question from the Out-of-scope note: the simplest consistent rule is to track ONLY user-issued names (runStep + waitForEvent), leaving `ctx.parallel`'s reserved `lunora:`-prefixed steps to its own existing guard.

**Verify**: `pnpm --filter "@lunora/workflow" run lint:types` → exit 0.

### Step 2: Add `RunStepOptions.name` and the collision throw

- `types.ts`: add `/** Override the durable step name for this call — required when running one StepDefinition more than once per instance. */ name?: string;` to `RunStepOptions`.
- `run-step.ts`: resolve `const stepName = options?.name ?? step.name`; before `deps.step.do`, check the tracker:
    ```ts
    if (deps.usedStepNames.has(stepName)) {
        /* raise NonRetryableError, message modeled on fan-out.ts's: name the collision, tell the caller to pass a unique `name` option */
    }
    deps.usedStepNames.add(stepName);
    ```
    Reject `options.name` starting with the reserved framework prefix the same way `wait-for-event.ts` rejects reserved event names.
- `wait-for-event.ts`: same tracker check on the resolved name (`options?.name ?? `event:${event.type}``).

Replay caveat (read before writing the guard): on a Cloudflare Workflows **replay**, the body re-executes from the top and each `step.do` returns memoized results — the tracker is rebuilt identically, so a legitimate replay never trips the guard; only a genuinely duplicate call within one body execution does. State this in the tracker's docstring.

**Verify**: `pnpm --filter "@lunora/workflow" run test` → existing tests pass (any that legitimately run one step twice must now pass distinct `name`s — update them and note it).

### Step 3: Tests

In the existing test files (`packages/workflow/__tests__/define-step.test.ts` for runStep, `events.test.ts` for waitForEvent — follow their harness setup):

1. running the same StepDefinition twice without `name` → throws NonRetryableError naming the step;
2. running it twice with distinct `name` options → both run, distinct `step.do` names observed by the step double;
3. two `waitForEvent` on one event type without names → throws; with distinct `name`s → OK;
4. a replayed body (invoke the workflow body function twice against the same memoizing step double, as the existing replay-style tests do — if none exists, build the double so `step.do` returns cached results by name) does NOT throw.

**Verify**: `pnpm --filter "@lunora/workflow" run test` → all pass, 4+ new tests.

## Test plan

Covered in Step 3; pattern files named there.

## Done criteria

- [ ] `RunStepOptions` has `name`; `grep -n "usedStepNames" packages/workflow/src/run-step.ts packages/workflow/src/wait-for-event.ts run-context` shows the shared tracker
- [ ] All commands in the table exit 0, including the api-snapshot gate
- [ ] No files outside the in-scope list modified

## STOP conditions

- The run context turns out to be created once per **replay attempt** rather than once per body execution (would make the tracker accumulate across replays and false-positive) — verify where `createRunContext` is called from the generated `WorkflowEntrypoint` before writing the guard; if it is not per-body-execution, stop and report.
- Existing tests legitimately depend on duplicate-name memoization as a feature.
- The fix appears to require changes to codegen's emitted workflow entrypoints.

## Maintenance notes

- If Cloudflare later documents duplicate-name `step.do` semantics as safe, this guard can be relaxed to a warning — keep the `name` option regardless.
- Reviewer: check the error message quality (it must tell the user exactly what to do: pass `name`), and the replay test's fidelity.
