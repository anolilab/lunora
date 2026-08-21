# Plan 441: Cover `compileAgentWorkflow` and `withAutoOtlpTelemetry` with characterization tests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/agent/src/workflow.ts`
> On any change, compare the "Current state" excerpts; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (coordinate with 436 if both run on the same branch — different files, no conflict)
- **Category**: tests
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`compileAgentWorkflow` is the sole compile step codegen emits for every deployed agent (`packages/codegen/src/emit.ts` emits `compileAgentWorkflow(${agent.exportName}, "${agent.exportName}")` into each generated `<Name>AgentWorkflow` class), and `withAutoOtlpTelemetry` silently attaches a platform-injected OTLP sink carrying `LUNORA_OTLP_TOKEN` to every deployed agent. Neither is imported by any test file (`grep -rn "compileAgentWorkflow\|withAutoOtlpTelemetry" packages/agent/__tests__` → nothing). A regression here — e.g. dropping the `resolveAgentRun` identity wiring that lets a run read its own owner-gated thread — breaks every agent at deploy time with nothing in CI to catch it.

## Current state

- `packages/agent/src/workflow.ts:26-50` — `withAutoOtlpTelemetry(agent, env, conversationId?)`:
  - returns `agent` unchanged when `env.LUNORA_OTLP_ENDPOINT` is not a non-empty string, or when `agent.telemetry?.isEnabled === false`;
  - reads `env.LUNORA_OTLP_TOKEN` when a string;
  - normalizes `agent.telemetry?.integrations` (single value | array | absent) via `[x].flat().filter(...)`;
  - returns a copy with `integrations: [...existing, otlpTelemetry({ conversationId, endpoint, token })]` and `isEnabled: true`.
- `packages/agent/src/workflow.ts:~72-123` — `compileAgentWorkflow(agent, exportName, options?)` returns a workflow definition whose handler calls `runAgentLoop` with, among other seams: `paths: options?.paths ?? DEFAULT_AGENT_FUNCTION_PATHS`, `run: resolveAgentRun(context.run, context.params.owner, context.env)`, `step: context.step`, `streamGenerate: createStreamGenerate(runtimeAgent, context.env)`, and `name: agent.name ?? agentDefaultName(exportName)`.
- Test dir `packages/agent/__tests__/` has suites for nearly every other `src` module (`agent-loop.test.ts`, `component.test.ts`, `resolve-run.test.ts`, …) but no `workflow.test.ts`. `loop-harness.ts` in the same dir is the shared harness.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/agent..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/agent" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/agent" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/agent" run lint:eslint` | exit 0 |

## Scope

**In scope**:
- `packages/agent/__tests__/workflow.test.ts` (create)

**Out of scope**:
- `packages/agent/src/workflow.ts` — characterization only; if a test reveals a bug, STOP and report rather than fixing source in this plan.
- Codegen's emit of the entrypoint class.

## Git workflow

- Branch: shared wave branch `improve/wave22-agent`.
- Commit: `test(agent): characterize compileAgentWorkflow wiring`

## Steps

### Step 1: `withAutoOtlpTelemetry` branch table

If the function is not exported, export-test it the way sibling suites handle internals (check how e.g. `resolve-run.test.ts` imports its subject; if a non-exported helper blocks you, test the behavior through `compileAgentWorkflow`'s compiled definition instead — do NOT add an export just for tests unless a sibling test already established that pattern; note which route you took).

Table-driven cases:
1. No `LUNORA_OTLP_ENDPOINT` → definition unchanged (same reference or deep-equal with no added integration).
2. Endpoint set + `telemetry.isEnabled: false` → unchanged.
3. Endpoint set, no prior integrations → one integration appended, `isEnabled: true`.
4. Endpoint set, prior `integrations` as a single value and as an array → normalized to an array with the OTLP integration appended after the existing ones.

**Verify**: `pnpm --filter "@lunora/agent" run test -- workflow` → 4+ cases pass.

### Step 2: compiled handler seam wiring

Call `compileAgentWorkflow(minimalAgentDefinition, "support")` and assert:
- `name` falls back to the default derived from the export name when `agent.name` is absent, and honors `agent.name` when set.
- Invoking the compiled `handler` with a stubbed context (stub `runAgentLoop`'s collaborators the way `loop-harness.ts` stubs them — or stub at module boundary with `vi.mock` if the handler imports `runAgentLoop` directly; match whichever mocking style the sibling suites use) reaches the loop with: the default `paths` when no override, the `paths` override when given, and a `run` that is NOT the raw `context.run` when `context.params.owner` is set (the `resolveAgentRun` wrapping — assert via a spy on what the loop receives).

**Verify**: `pnpm --filter "@lunora/agent" run test -- workflow` → all pass.

## Test plan

As above — one new file, `workflow.test.ts`, modeled structurally on `resolve-run.test.ts` (small pure-wiring suite) and `loop-harness.ts` stubbing conventions.

## Done criteria

- [ ] `packages/agent/__tests__/workflow.test.ts` exists with ≥6 passing assertions
- [ ] `pnpm --filter "@lunora/agent" run test` exits 0
- [ ] `pnpm --filter "@lunora/agent" run lint:types` and `lint:eslint` exit 0
- [ ] No `src/` files modified (`git status`)

## STOP conditions

- A characterization test reveals actual wrong behavior in `workflow.ts` — report the finding; do not fix here.
- Stubbing `runAgentLoop` requires restructuring `workflow.ts` itself.

## Maintenance notes

- When the dormant `streamGenerate`/`onTokenDelta` seam is wired to a live sink, extend Step 2's seam assertions to cover it.
