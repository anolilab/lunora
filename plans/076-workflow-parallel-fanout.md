# Plan 076: Workflow fan-out with child-DO resource isolation

> **Executor instructions**: This is a **design spike + phased rollout**, not a
> single surgical change. Phase 0 is a written design the maintainer signs off on
> BEFORE any code lands. Each later phase is independently shippable and gated on
> the phase before it. Do NOT start Phase 1 until Phase 0's open questions
> (§ Decisions) have answers. When a phase ships, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**: confirm the "Current state" excerpts still match
> live code at HEAD:
> `git diff --stat HEAD -- packages/workflow/src packages/codegen/src/discover-workflows.ts packages/codegen/src/emit.ts`
> On a mismatch, re-read the cited symbols before trusting this plan.

## Status

> **Implementation status (2026-06-30):** Phases 1 + 2 **shipped**. `ctx.spawn`
> and `ctx.parallel` (with the `branch(...)` builder) are implemented in
> `packages/workflow/src/fan-out.ts`, wired through `run-context.ts` + the
> `src/do` base class, and unit-tested (`__tests__/fan-out.test.ts`, full suite
> 66 green; `lint:types` + `eslint` clean). The Phase-0 decisions were resolved
> with the defaults recorded below. **Not yet done:** Phase 3 (group saga
> compensation) and a real-workerd e2e of the spawn/join handshake. The decisions
> below are now "as-built" notes, not open questions.

- **Priority**: P2 (a real DX gap many workflow authors hit; aligned with the
  "scale invisibly" principle — but not a correctness bug, so below the wave-4
  sync-engine work)
- **Effort**: XL (multi-phase; child-spawn protocol + codegen + runtime)
- **Risk**: MED (new public `ctx` surface on the workflow body, new owner↔child
  signalling; the existing single-instance path must stay byte-identical)
- **Depends on**: nothing landed — but reuses the existing workflow binding
  registry (`WORKFLOW_*`) and `ctx.workflows.create()` producer surface, so do
  NOT start before reading how those are emitted (`emit.ts` / `create-workflows.ts`).
- **Category**: feat / architecture
- **Planned at**: commit `0d0c8f1e`, 2026-06-30
- **Origin**: Competitive gap analysis vs. `mksglu/workflais` (declarative CF
  Workflows DSL). workflais' one genuinely novel primitive is `parallel(...)`,
  which spawns **each branch as its own child workflow instance** so each gets an
  isolated Durable Object (128 MB memory, 5 min CPU, independent retry budget),
  with the parent hibernating at zero cost via `waitForEvent`. Lunora has **no
  parallel primitive at all** today — a user fanning out heavy work writes
  `Promise.all(branches.map((b) => ctx.runStep(b, …)))`, which runs every branch
  inside the **same** workflow instance, sharing one DO's memory / CPU / retry
  budget. One OOM or timeout kills the whole batch.

## Why this matters

Cloudflare Durable Objects (which back Workflows) enforce hard per-instance
limits: ~128 MB memory and a 5-minute CPU budget per invocation, plus a shared
retry budget. Lunora already spreads _data_ load by partition (`shardBy`) and
replicates reads with `.global()`. Neither helps the **fan-out compute** shape:
N heavy branches (ML inference, image/video transcode, large aggregations) that
should each run with full, isolated resources.

Today the only fan-out a user can express collapses onto one instance:

```ts
// ❌ all three share ONE DO's 128 MB / 5 min CPU / retry budget
const [ml, img, vid] = await Promise.all([
    ctx.runStep(mlInference, { … }),
    ctx.runStep(imageProcess, { … }),
    ctx.runStep(videoTranscode, { … }),
]);
```

The fix is a typed primitive that spawns each branch as its **own** workflow
instance — own DO, own resources, independent retry — while the parent hibernates
at zero cost until the branches report back:

```ts
// ✅ each branch runs in its own DO; parent hibernates while they execute
const [ml, img, vid] = await ctx.parallel([
    branch(mlInference, { … }),
    branch(imageProcess, { … }),
    branch(videoTranscode, { … }),
]);
```

This is squarely the **"scale invisibly"** principle (see saved memory): the user
declares "these run in parallel", and the runtime — not the user — decides to
isolate them across DOs. No region knobs, no manual `create()`/poll loop.

## Current state

- **No parallel/spawn primitive on the workflow body.** `WorkflowRunContext`
  (`packages/workflow/src/types.ts` ≈299) exposes `env`, `event`, `log`,
  `params`, `run`, `runStep`, `step` — and nothing else. `run-context.ts`
  (`createWorkflowRunContext`) assembles exactly those. A workflow can only reach
  child workflows through the **raw** `ctx.env.WORKFLOW_*` binding — untyped, and
  with no join/await helper.

- **The typed producer surface exists, but only on Mutation/Action.**
  `ctx.workflows.get(name).create()/createBatch()/get()` (`types.ts` ≈354
  `WorkflowHandle`, ≈367 `Workflows`) is wired onto Mutation/Action ctx by
  codegen, NOT onto the workflow body's ctx. So an app starts a workflow, but a
  workflow cannot yet start a typed child. **This is the surface to extend** —
  reuse `WorkflowHandle.create()`; do not invent a parallel binding scheme.

- **Each workflow is already its own registered DO-backed entrypoint.** Codegen
  emits one `WorkflowEntrypoint` subclass per `defineWorkflow` export
  (`emit.ts` → `emitWorkflows`, golden-tested in
  `packages/codegen/__tests__/discover-workflows.test.ts`) and the config layer
  reconciles a wrangler `workflows[]` entry + a `WORKFLOW_<NAME>` binding
  (`workflowBindingName`/`workflowClassName` in `define-workflow.ts`). **A branch
  that is itself a declared workflow therefore needs no new registry** — it is
  already addressable. This strongly favors "branch = child workflow" over
  "branch = step shipped to a generic runner" (a step handler is a closure and is
  not serialisable across the create() boundary).

- **Native join primitive is `waitForEvent` + instance `sendEvent`.** The step
  API mirror (`WorkflowStepLike`, `types.ts` ≈140) already includes
  `waitForEvent(name, { type, timeout })`. Cloudflare instances expose
  `sendEvent({ type, payload })`. The parent→children→parent handshake (parent
  spawns, hibernates on `waitForEvent`; each child `sendEvent`s its result/error
  back to the parent's instance id) is the zero-cost-hibernation pattern. **Pin
  the exact child→parent correlation token + event-name scheme in Phase 0.**

- **`NonRetryableError` conversion + per-step rollback already exist.**
  `run-step.ts` forwards a step's `rollback` to native `step.do(name, cb,
{ rollback })`. A parallel group's "if any branch fails, compensate the others"
  saga (workflais' LIFO-across-the-group behaviour) is a Phase-3 concern built on
  top of this, not part of the core spawn/join.

## Scope

**In scope (phased)**:

- `packages/workflow/src/types.ts` — a `branch(...)` descriptor type + a
  `ctx.parallel(branches)` signature returning a typed tuple of branch outputs;
  extend `WorkflowRunContext`.
- `packages/workflow/src/run-context.ts` — assemble `ctx.parallel`, bound to the
  workflow's `env` bindings + the native `step` (for the `waitForEvent` join).
- A child→parent completion-signal protocol (internal; not part of the public
  client/WS protocol).
- `packages/codegen` — make declared workflows addressable as branch targets from
  inside a workflow body (the spawn binding map the parent needs); reuse the
  existing `WORKFLOW_*` discovery, do not add a parallel registry.
- Docs: `packages/workflow/docs/index.mdx` (the tracked source — the
  `apps/docs/**/packages/workflow` tree is generated & gitignored).

**Out of scope**:

- The string-DSL surface from workflais (`step().retry().timeout()`, `ctx.prev`
  auto-chaining, `compile`/`execute`). It conflicts with Lunora's explicit,
  schema-validated `defineStep`/`runStep` style — an intentional non-goal.
- Cross-region placement of children (Cloudflare schedules instances; we do not
  pin regions — consistent with "no user-facing region knobs").
- The saga-across-a-group compensation (Phase 3 only, gated separately).
- Any change to the single-instance sequential path — it must stay byte-identical.

## Decisions (Phase 0 — answer before any code)

1. **Branch unit: child workflow vs. promoted step.** Strong proposal: a branch
   targets a **declared `defineWorkflow`** (already DO-backed + registered), via a
   `branch(workflowRef, params)` descriptor. Confirm whether authors also want to
   fan out a bare `defineStep` (would require a generic child-runner workflow +
   a name-keyed step registry so the child can resolve the closure — a meaningfully
   bigger surface). Default: workflows only in v1; revisit steps if demand exists.
2. **Join mechanism.** `sendEvent` → `waitForEvent` (zero-cost hibernation) vs.
   durable status-poll loop (`sleep` + `instance.status()`). Proposal:
   **sendEvent/waitForEvent**, because the parent truly hibernates. Pin: the
   correlation scheme (parent instance id + per-branch event type), how the child
   learns them (passed in its params), and the failure-event shape.
3. **Failure semantics.** If one branch fails after others succeed: fail-fast
   (reject `ctx.parallel` as soon as any branch errors) vs. settle-all (return a
   per-branch ok/err tuple, à la `Promise.allSettled`). Proposal: **fail-fast by
   default** (mirrors `Promise.all` intuition + workflais), with a settle-all
   option later. Define how a still-running sibling is handled on fail-fast
   (left to finish? signalled to stop? — CF cannot force-cancel cleanly, so
   document the real behaviour, do not promise cancellation we can't deliver).
4. **Result typing & ordering.** `ctx.parallel([branch(a,…), branch(b,…)])`
   must return `[OutputOf<a>, OutputOf<b>]` in declaration order regardless of
   completion order. Confirm the TS inference carries each branch's `__output`
   phantom (mirror how `runStep` infers `Result`).
5. **Timeout / bound.** A per-branch timeout (the parent's `waitForEvent`
   timeout) and a cap on branch count per `parallel` call (cost ceiling — a
   fan-out of 10 000 must not silently spawn 10 000 DOs). Proposal: a default
   max-branches with a clear error past it (auto-scale, never _silently
   unbounded_ — same discipline as plan 075).
6. **Determinism on replay.** The parent body replays on every step. Spawning
   children must be wrapped so a replay does not re-spawn them (idempotent
   create, keyed by a deterministic per-branch instance id derived from the
   parent instance id + branch index). Pin the id derivation.

## Phases

### Phase 0 — Design doc + sign-off (no code)

Write the `branch(...)`/`ctx.parallel(...)` API, the spawn/join protocol (event
names, correlation token, idempotent-create id scheme), the failure model, and
answers to all six Decisions into this file (or a sibling design doc).
**Maintainer sign-off required before Phase 1.** Deliverable also includes a
worked end-to-end example (the `parallel-fan-out` shape) showing the generated
child entrypoints and the parent's hibernation point.

### Phase 1 — Typed child-spawn from the workflow body (no join yet)

Add `ctx.spawn(workflowRef, params)` → a typed instance handle, wired through the
existing `WORKFLOW_*` bindings, with idempotent (replay-safe) create. This is the
fire-and-forget half and is independently useful (a workflow kicking off a child
pipeline). No `waitForEvent` join yet.

**Verify**: a workflow spawns a declared child workflow; replaying the parent
does not double-spawn (Decision 6); `pnpm --filter "@lunora/workflow" run test`
green; codegen golden fixtures unchanged except the new binding map; no change to
the sequential path.

### Phase 2 — `ctx.parallel(...)` spawn + hibernating join

Build the fan-out/fan-in: spawn each branch (Phase 1), hibernate the parent on
`waitForEvent`, collect results into the declaration-order tuple, fail-fast on the
first branch error (Decision 3). Each child signals completion back to the parent
via the Phase-0 protocol.

**Verify**: a 3-branch `ctx.parallel` returns the correctly-typed,
declaration-ordered tuple; each branch demonstrably runs in its own instance
(distinct instance ids in `wrangler tail`); the parent consumes zero resources
while waiting (hibernation observable); a failing branch rejects `ctx.parallel`
with the branch's error; the branch-count cap (Decision 5) errors cleanly.

### Phase 3 — group saga compensation (optional, gated)

When a branch fails after siblings completed, run the completed branches' rollback
(workflais' "compensate every branch in the group"). Builds on the existing
per-step native rollback (`run-step.ts`). Only ship if Phase 2's failure model
proves insufficient in practice.

**Verify**: in a 3-branch group where branch 3 fails, branches 1 & 2's rollbacks
run; a group with no rollbacks behaves exactly as Phase 2.

## Commands you will need

| Purpose          | Command                                                                       | Expected on success                               |
| ---------------- | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| Build deps first | `pnpm --filter "@lunora/workflow..." --filter "@lunora/codegen..." run build` | exit 0 (run once)                                 |
| Workflow tests   | `pnpm --filter "@lunora/workflow" run test`                                   | all pass                                          |
| Codegen tests    | `pnpm --filter "@lunora/codegen" run test`                                    | all pass (golden fixtures)                        |
| Typecheck        | `pnpm --filter "@lunora/workflow..." run lint:types`                          | exit 0                                            |
| Lint             | `pnpm run lint:eslint`                                                        | exit 0                                            |
| workerd e2e      | `LUNORA_WORKERD_TESTS=1 pnpm --filter "@lunora/runtime" run test`             | spawn/join e2e passes (see pinned workerd memory) |

## Git workflow

- Branch per phase: `feat/076-workflow-fanout-phaseN`.
- Commit style: `feat(workflow): …` / `feat(codegen): …` per phase.
- Do NOT push or open a PR unless instructed. Phase 0 lands as docs only.

## Done criteria (per phase; ALL must hold for the phase)

- [ ] The sequential single-instance path is unchanged (`git diff` shows the new
      surface is purely additive; existing workflow tests pass untouched).
- [ ] `pnpm --filter "@lunora/workflow..." run lint:types` exits 0.
- [ ] `pnpm --filter "@lunora/workflow" run test` and `@lunora/codegen` tests
      exit 0.
- [ ] `pnpm run lint:eslint` exits 0.
- [ ] Phase 1+: replay-safety proven — replaying the parent does not re-spawn
      children (explicit test).
- [ ] Phase 2+: branch outputs are declaration-ordered and correctly typed; a
      failing branch propagates; the branch-count cap errors.
- [ ] `packages/workflow/docs/index.mdx` updated (tracked source, not the
      generated tree).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- The design requires shipping a **non-serialisable closure** across the
  `create()` boundary (the "branch = bare step" trap from Decision 1) — fall back
  to "branch = declared workflow" and report.
- Cloudflare's instance API does not expose a usable `sendEvent` (or equivalent)
  for the child→parent signal — the hibernating-join premise breaks; reassess
  Decision 2 (status-poll fallback) before proceeding.
- Replay re-spawns children and no deterministic idempotent-create id can be
  derived (Decision 6 has no clean answer) — do NOT ship a fan-out that
  double-executes branches on parent replay.
- Any change leaks into the **public client/WS protocol** or the sequential
  workflow path — this feature is additive server-side surface only.

## Maintenance notes

- **Reuse the existing workflow registry.** Branches are declared workflows,
  already DO-backed and bound as `WORKFLOW_*`. Do not build a parallel binding or
  step registry unless Decision 1 explicitly opts into fan-out over bare steps.
- **The parent stays the join authority.** Children are leaf instances that signal
  back; all ordering/result-collection truth lives in the parent so a parent
  replay reconstructs the tuple deterministically.
- **Idempotent create is the correctness boundary.** Every spawn must be keyed by
  a deterministic id so the parent's replay attaches to the existing child instead
  of starting a second one. This is the workflow analog of step memoization (and
  the same class of bug the new `workflow_duplicate_step_name` advisor lint guards
  against on the sequential path).
- **Additive only.** Below a `ctx.parallel` call there is zero new overhead — the
  sequential `runStep`/`step.do` path that 99% of workflows use must not regress.
- **Visible, not configurable.** The user declares "parallel"; the runtime
  isolates across DOs. No region/placement knobs — consistent with `shardBy` /
  `.global()` staying the only explicit topology controls.
- **Do not resurrect the workflais DSL.** `ctx.prev`/`compile`/`execute` are an
  explicit non-goal; the value taken from workflais is the child-DO isolation
  idea, not its string API.

```

```
