# Plan 382: Bound the R2 SQL and Analytics Engine HTTP clients with a configurable timeout

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/bindings/src/r2sql packages/bindings/src/analytics`
> On any drift, compare the "Current state" excerpts against live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/379-abort-signal-timeout-worker-runtime.md (uses `shared/abort-deadline.ts` created there; if executing standalone, inline the same controller+timer pattern from `packages/queue/src/capture.ts:126-132` instead)
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

Both HTTP SQL clients in `@lunora/bindings` issue fetches with no `signal`. `ctx.r2sql.query(...)` is ActionCtx-mounted, so a stalled R2-SQL or Analytics Engine endpoint holds the action — and its shard request — open to the platform limit. Both clients are also imported by Studio panels and `@lunora/advisor` runtime lints, so one slow query stalls an admin page with no diagnostic. The repo's stated posture for inline remote calls is a bounded abort (`packages/queue/src/capture.ts`: "an unresponsive root shard would stall the whole invocation … without this abort"). Analytical scans legitimately take tens of seconds, so the default must be generous (60s), not the 5s side-channel value.

## Current state

- `packages/bindings/src/r2sql/client.ts:105-112`:
    ```ts
    const response = await fetchImpl(endpoint, {
        body: JSON.stringify({ query: statement, warehouse }),
        headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
        method: "POST",
    });
    if (!response.ok) {
        throw new R2SqlError(response.status, await response.text());
    }
    ```
- `packages/bindings/src/analytics/sql-api.ts:86-93` — same shape (`body: sql`, `"Content-Type": "text/plain"`), throws `AnalyticsSqlError(response.status, await response.text())` on non-ok.
- Config types: `R2SqlConfig` (same dir as client.ts, check `types.ts`/the config interface actually used) and `AnalyticsSqlConfig` — read them first; neither has a timeout today.
- Both error classes carry an HTTP status as first argument — map a timeout to status `504`.
- The body reads (`response.json()`/`response.text()` after the ok-check) must be covered by the same signal — a hang after headers is the harder failure (see the comment block in `packages/dispatch/src/create-dispatch-runner.ts:227-233` for the rationale).

## Commands you will need

| Purpose    | Command                                            | Expected on success                                                       |
| ---------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| Install    | `pnpm install`                                     | exit 0                                                                    |
| Build deps | `pnpm --filter "@lunora/bindings..." run build`    | exit 0                                                                    |
| Tests      | `pnpm --filter "@lunora/bindings" run test`        | all pass                                                                  |
| Typecheck  | `pnpm --filter "@lunora/bindings" run lint:types`  | exit 0                                                                    |
| Lint       | `pnpm --filter "@lunora/bindings" run lint:eslint` | exit 0                                                                    |
| API gate   | `pnpm run build:packages && pnpm run api:check`    | exit 0 (`api:update` + commit snapshot for the two config-type additions) |

## Scope

**In scope**:

- `packages/bindings/src/r2sql/client.ts` (+ its config type file)
- `packages/bindings/src/analytics/sql-api.ts` (+ its config type file)
- `packages/bindings/__tests__/r2sql/`, `packages/bindings/__tests__/analytics/` (extend)
- `packages/bindings/tsconfig.json` ONLY if it still sets `outDir`/`rootDir` and the shared import needs the drop (add the breadcrumb comment other such tsconfigs carry)

**Out of scope**:

- Every other subpath of `@lunora/bindings` (kv/images/pipelines/vectors) — different transports.
- Studio/advisor call sites — they inherit the default.

## Git workflow

- Branch: `improve/wave22-bindings`
- Commit: `fix(bindings): bound r2sql and analytics sql fetches`

## Steps

### Step 1: Add `timeoutMs` to both configs

`timeoutMs?: number` with JSDoc: default 60_000; `undefined` means default, not unbounded. Named constant `DEFAULT_SQL_TIMEOUT_MS = 60_000` per client file (or one shared constant if both configs live near each other — prefer whatever keeps the diff smallest).

### Step 2: Thread the deadline

Import `abortDeadline` from `shared/abort-deadline` (relative path; see plan 379). Wrap fetch AND body reads:

```ts
const deadline = abortDeadline(undefined, config.timeoutMs ?? DEFAULT_SQL_TIMEOUT_MS, () => new DOMException("r2sql query timed out", "TimeoutError"));
try {
    const response = await fetchImpl(endpoint, { ..., signal: deadline.signal });
    ... all response.text()/json() reads ...
} catch (error) {
    // TimeoutError → R2SqlError(504, "...timed out after Nms") / AnalyticsSqlError(504, ...)
    ...rethrow others...
} finally {
    deadline.dispose();
}
```

If plan 379 has not landed on this branch's base, inline the controller+setTimeout pattern from `packages/queue/src/capture.ts` instead — do NOT create a second shared helper.

**Verify**: `pnpm --filter "@lunora/bindings" run lint:types` → exit 0.

### Step 3: Tests

In the existing r2sql and analytics test files (`packages/bindings/__tests__/r2sql/`, `__tests__/analytics/` — follow their `fetchImpl` stubbing pattern):

- a `fetchImpl` that never resolves + fake timers → rejects with `R2SqlError`/`AnalyticsSqlError` status 504 mentioning the timeout;
- a fast response leaves no pending timers (`vi.getTimerCount() === 0`);
- `timeoutMs` override is honored.

**Verify**: `pnpm --filter "@lunora/bindings" run test` → all pass, 6 new tests (3 per client).

## Test plan

Covered in Step 3; model on the existing fetch-stub tests in the same directories.

## Done criteria

- [ ] Both fetch calls carry `signal:`; `grep -rn "signal" packages/bindings/src/r2sql/client.ts packages/bindings/src/analytics/sql-api.ts` → matches in both
- [ ] Timeout surfaces as the client's own error type with status 504
- [ ] All commands in the table exit 0
- [ ] No files outside the in-scope list modified

## STOP conditions

- The config types are re-exported through codegen-emitted surfaces in a way that makes the addition ripple into golden fixtures (report which fixture).
- Studio/advisor tests break on the new default (would mean they rely on unbounded waits — report, don't raise the default past 60s silently).

## Maintenance notes

- 60s default is a judgment call for analytical scans; if users hit it, the knob exists. Reviewer: check the 504 message includes the configured value so the knob is discoverable from the error.
