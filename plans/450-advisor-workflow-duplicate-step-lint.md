# Plan 450: Remove the `workflow_duplicate_step_name` lint — its premise is false

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/advisor/src/lints/static/workflow-duplicate-step-name.ts packages/advisor/src/workflows.ts packages/advisor/src/index.ts packages/codegen/src/discover-workflows.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `1699f4317`, 2026-08-21

## Why this matters

`workflow_duplicate_step_name` is an `ERROR`-level static advisor lint built on a claim
about Cloudflare Workflows that is **not true**. It asserts that `step.do` memoizes by
name alone, so a second call under the same name returns the first's cached result. On
that basis it flags — with an `ERROR` — the ordinary loop:

```ts
for (const item of items) {
    await ctx.runStep(processItem, { item });
}
```

and its remediation instructs the user to rename their way out of a non-problem.

Cloudflare keys a durable step by **(name, type, occurrence)**. Their Workers API docs
define `step.count` as "how many times `step.do` has been called with this name in the
current Workflow run (1-indexed)", and `count` as "the 1-based index of the step, used
when multiple steps share the same name and type (for example, inside a loop)".
`instance.restart({ from: { name, count } })` only has meaning under those semantics —
if a name identified one step there would be nothing for `count` to index.

This repo's own vendored type says the same. `packages/workflow/src/types.ts:207-208`:

```ts
    /** The durable step's identity (name + invocation count). */
    readonly step: { count: number; name: string };
```

Wave 22 already acted on this on the **runtime** side. Plan 380 originally proposed a
runtime guard refusing duplicate step names; PR [#447](https://github.com/anolilab/lunora/pull/447)
(commit `4583fc862`) shipped only the reserved-prefix half and recorded the refusal in
its commit body:

> Deliberately NOT added: a refusal of duplicate step names. The premise that `step.do`
> memoizes by name — so a second call under one name returns the first's result — is
> false, and such a guard would break working workflows. … under such a guard iteration 2
> would raise a native `NonRetryableError` and fail the instance with no retry, turning
> working workflows into permanently-dead instances.
>
> Follow-up, out of scope: `packages/advisor`'s `workflow-duplicate-step-name` static
> lint carries the same false premise (pre-existing, advisory-only) and currently tells
> users to rename legitimate loops.

This plan is that follow-up. The lint is advisory-only — **no runtime impact** — but it
is an `ERROR` in the Studio's Advisors pages telling users to break working code.

## Current state

### The lint — `packages/advisor/src/lints/static/workflow-duplicate-step-name.ts:5-13`

```
 * Cloudflare Workflows memoizes every `step.do` / `step.sleep` / `step.sleepUntil`
 * / `step.waitForEvent` call by its name: on replay the runtime returns the cached
 * result for a name it has already seen. Two distinct steps that share a name are
 * therefore a silent bug — the second call never runs its body and instead yields
 * the first's result, skipping the work (a charge, a write, an external wait)
 * without error. Hence `ERROR`/`INTERNAL`: it is a developer-facing correctness
 * defect in the workflow's own code, not a runtime-data nit.
```

Its severity and remediation (`:26-31`):

```ts
    facing: "INTERNAL",
    level: "ERROR",
    name: "workflow_duplicate_step_name",
    remediation:
        "Give every `step.do` / `step.sleep` / `step.sleepUntil` / `step.waitForEvent` call in the workflow a unique name. If a step legitimately repeats (e.g. a loop), make the name distinct per iteration by interpolating the item id into the step name.",
```

The last sentence is the sharpest part of the harm: it names the legitimate case and
tells the user to change it anyway.

### Everything that references it

```
packages/advisor/src/lints/static/workflow-duplicate-step-name.ts   the lint (83 lines)
packages/advisor/src/index.ts:111                                   import
packages/advisor/src/index.ts:249                                   re-export
packages/advisor/src/index.ts:308                                   entry in STATIC_LINTS
packages/advisor/__tests__/workflow-lints.test.ts:7,110-191         its describe block
packages/advisor/docs/index.mdx:169                                 the rule table row
api-snapshots/advisor.api.md:1753-1756                              `workflowDuplicateStepName` (const)
```

### The feeder chain that exists only for this lint

```
packages/codegen/src/discover-workflows.ts:81   stepsFromHandler(): WorkflowStepIR[]
packages/codegen/src/discover-workflows.ts:187  steps: stepsFromHandler(argument)
packages/codegen/src/ir.ts:562                  WorkflowIR.steps
packages/codegen/src/ir.ts:631                  interface WorkflowStepIR
packages/advisor/src/workflows.ts:16-23         interface AdvisorWorkflowStep
packages/advisor/src/workflows.ts:28-38         AdvisorWorkflow.steps
```

Verified: `WorkflowIR.steps` has **no other consumer**
(`grep -rn "\.steps\b" packages/codegen/src/` returns only the doc reference in
`ir.ts:630`), and of the three workflow lints only this one reads `AdvisorWorkflow.steps`
— `workflow-unknown-target.ts` and `workflow-unused.ts` use `exportName` alone.

`AdvisorWorkflow.steps`' own docblock repeats the false premise
(`packages/advisor/src/workflows.ts:32-34`): "Cloudflare memoizes a step by its name, so
a name used twice makes the second call silently return the first's cached result."

## Existing seams (do not reinvent)

- **`STATIC_LINTS`** in `packages/advisor/src/index.ts:303` is the registry. Removing a
  lint means removing its import, its re-export, and its array entry — three edits in
  one file, no mechanism involved.
- **`api-snapshots/advisor.api.md`** is regenerated with `pnpm run api:update` after a
  fresh build. Never hand-edit it.
- **`packages/advisor/docs/index.mdx`** carries the published rule table; a removed lint
  must lose its row or the docs advertise a rule that no longer fires.

## The behavioural contract to preserve

1. The other two workflow lints (`workflow_unknown_target`, `workflow_unused`) keep
   working unchanged.
2. `runAdvisor` still runs cleanly against a `LintContext` that supplies `workflows`.
3. No other lint's findings change. The advisor's finding count is not itself asserted
   anywhere, but a lint disappearing from `STATIC_LINTS` is a public-API change and the
   snapshot must record it.

## Design decisions

**D1 — Remove the lint outright rather than re-scope it.**
Re-scoping was considered: a _correct_ related lint would flag a step name that is
**non-deterministic across replays** (e.g. built from `Date.now()` or `Math.random()`),
since that genuinely breaks replay. But that is a different analysis over a different
input (the name _expression_, not the resolved label), the feeder deliberately omits
dynamic names already ("a step named dynamically … is omitted by the feeder"), and
building it is a new lint, not an edit to this one. Speculative — do not build it here.
If it is wanted, it gets its own plan.

**D2 — Also remove the now-dead feeder plumbing.**
`WorkflowStepIR` / `WorkflowIR.steps` / `AdvisorWorkflowStep` / `AdvisorWorkflow.steps`
exist solely to feed this lint (verified above). Leaving them is dead weight carrying
the same false premise in their own docblocks, where the next reader will find it and
"fix" the missing lint. Removing them is the same commit's work.
Chosen over "remove the lint, keep the feeder": a feeder with no consumer is exactly the
kind of thing a later audit resurrects.

**D3 — Do not deprecate first.** The branch is `alpha`; per the repo convention,
pre-release branches delete the old path and update call sites in the same change. A
`level: "OFF"` or a renamed-to-`legacy*` shim would be the `main` answer.

**D4 — Removing an export is a snapshot-gated change, and that is correct.**
`workflowDuplicateStepName` is re-exported from `@lunora/advisor`'s barrel and appears
in `api-snapshots/advisor.api.md:1753`. `@lunora/advisor` is TIER_2 (stable-adapter), so
this is a SemVer-reviewable removal. On `alpha` that is fine; say so in the commit body
so semantic-release records the break.

## Commands you will need

| Purpose         | Command                                                    | Expected on success |
| --------------- | ---------------------------------------------------------- | ------------------- |
| Install         | `pnpm install`                                             | exit 0              |
| Build           | `pnpm run build:packages`                                  | exit 0              |
| Advisor tests   | `pnpm --filter "@lunora/advisor" run test`                 | all pass            |
| Codegen tests   | `pnpm --filter "@lunora/codegen" run test`                 | all pass            |
| Typecheck       | `pnpm run lint:types`                                      | exit 0              |
| Lint            | `pnpm run lint:eslint`                                     | exit 0              |
| Update snapshot | `pnpm run api:update` (after a **fresh** build)            | exit 0              |
| Verify snapshot | `pnpm run api:check`                                       | exit 0              |
| Prettier        | `pnpm run lint:prettier:fix` then `pnpm run lint:prettier` | exit 0              |

## Scope

**In scope**:

- `packages/advisor/src/lints/static/workflow-duplicate-step-name.ts` — **delete**
- `packages/advisor/src/index.ts` — drop the import (`:111`), the re-export (`:249`), and
  the `STATIC_LINTS` entry (`:308`)
- `packages/advisor/src/workflows.ts` — drop `AdvisorWorkflowStep` and
  `AdvisorWorkflow.steps`
- `packages/advisor/__tests__/workflow-lints.test.ts` — drop the
  `describe("workflow_duplicate_step_name")` block (`:110-193`) and the import (`:7`)
- `packages/advisor/docs/index.mdx:169` — drop the rule-table row
- `packages/codegen/src/discover-workflows.ts` — drop `stepsFromHandler` and the
  `steps:` field it feeds
- `packages/codegen/src/ir.ts` — drop `WorkflowStepIR` and `WorkflowIR.steps`
- `api-snapshots/advisor.api.md` — **regenerated**, never hand-edited
- `api-snapshots/codegen.api.md` — regenerated if `WorkflowStepIR` is in it

**Out of scope**:

- `packages/workflow/**` — PR #447 already settled the runtime side. Do **not** touch
  `run-step.ts` or the reserved-prefix guard.
- `workflow-unknown-target.ts` / `workflow-unused.ts`.
- Building a replacement determinism lint — see D1.
- `apps/studio` — it renders whatever `STATIC_LINTS` provides; nothing to change.

## Git workflow

- Branch: `improve/followup-advisor-duplicate-step-lint`
- Commit: `fix(advisor): drop the duplicate step-name lint` (46 chars)
- Commit body must: state the false premise and the correct (name, type, occurrence)
  semantics with the `step.count` evidence; note the export removal so semantic-release
  records the break; and reference PR #447 as the runtime-side decision this follows.

## Steps

### Step 1: Confirm the premise is still false against the live vendored type

Read `packages/workflow/src/types.ts:200-210`. `StepRunContext.step` must still be
`{ count: number; name: string }` documented as "The durable step's identity (name +
invocation count)". If the type has changed to name-only, STOP — the whole plan rests
on this.

**Verify**: `grep -n "invocation count" packages/workflow/src/types.ts` → 1 match.

### Step 2: Delete the lint and deregister it

Delete `packages/advisor/src/lints/static/workflow-duplicate-step-name.ts` and remove
the three references in `packages/advisor/src/index.ts`.

**Verify**: `grep -rn "workflowDuplicateStepName\|workflow_duplicate_step_name" packages/advisor/src/`
→ **no matches**.

### Step 3: Remove the test block and the docs row

Drop `describe("workflow_duplicate_step_name")` (`workflow-lints.test.ts:110-193`) and
its import at `:7`. Drop the `packages/advisor/docs/index.mdx:169` table row.

Leave the other two describes in `workflow-lints.test.ts` untouched — the file is
shared across the three workflow lints.

**Verify**:

- `pnpm --filter "@lunora/advisor" run test` → all pass
- `grep -rn "workflow_duplicate_step_name" packages/advisor/` → **no matches**

### Step 4: Remove the now-dead feeder plumbing (D2)

Drop `AdvisorWorkflowStep` and `AdvisorWorkflow.steps` from
`packages/advisor/src/workflows.ts` (including the docblock repeating the false
premise), then `stepsFromHandler` / `WorkflowIR.steps` / `WorkflowStepIR` from
`packages/codegen/src/discover-workflows.ts` and `packages/codegen/src/ir.ts`.

Before deleting each, re-confirm it has no other consumer:

**Verify**:

- `grep -rn "WorkflowStepIR\|AdvisorWorkflowStep" packages --include='*.ts' | grep -v node_modules`
  → **no matches** after the edit
- `grep -rn "workflow.steps\|\.steps\b" packages/codegen/src packages/advisor/src` → no
  live reference remains
- `pnpm --filter "@lunora/codegen" run test` → all pass
- `git status --porcelain packages/codegen/__tests__/fixtures/` → **empty** (the
  emitted output never contained step evidence, so no golden should move)

### Step 5: Regenerate the snapshots from a fresh build

```
pnpm run build:packages
pnpm run api:update
```

**Verify**:

- `pnpm run api:check` → exit 0
- `git diff api-snapshots/` shows the `workflowDuplicateStepName` const removed from
  `advisor.api.md` and (if present) `WorkflowStepIR` removed from `codegen.api.md` —
  and **nothing else**

### Step 6: Whole-repo gates

**Verify**:

- `pnpm run lint:types` → exit 0
- `pnpm run lint:eslint` → exit 0
- `pnpm run lint:prettier` → exit 0

## Test plan

- **Exemplar file**: `packages/advisor/__tests__/workflow-lints.test.ts`. It is the
  shared suite for all three `workflow_*` lints; after this change it keeps its
  `workflow_unknown_target` and `workflow_unused` blocks and loses one. Its structure
  (a `context({ workflows })` helper feeding `lint.run(...)` and asserting finding
  counts) is the model for anything added.
- No new tests. This plan removes behaviour; the assertion that it is gone is the
  absence of the describe block plus the api-snapshot diff.
- `pnpm --filter "@lunora/codegen" run test` is the guard that Step 4's feeder removal
  did not break discovery.

## Platform parity

Not applicable — this removes an advisory lint and its codegen feeder. It touches no
`ctx.*` surface, no provider binding, and no `PlatformCapabilities` rating. Cloudflare
Workflows' capability rating is unchanged; only a wrong claim _about_ it is removed.

## Done criteria

- [ ] `grep -rn "workflow_duplicate_step_name\|workflowDuplicateStepName" packages apps --include='*.ts' --include='*.tsx' --include='*.mdx'` → **no matches**
- [ ] `grep -rn "WorkflowStepIR\|AdvisorWorkflowStep" packages --include='*.ts'` → **no matches**
- [ ] `pnpm --filter "@lunora/advisor" run test` exits 0
- [ ] `pnpm --filter "@lunora/codegen" run test` exits 0
- [ ] `pnpm run lint:types` exits 0
- [ ] `pnpm run lint:eslint` exits 0
- [ ] `pnpm run api:check` exits 0, and `git diff api-snapshots/` shows only the two
      expected removals
- [ ] `git status --porcelain packages/codegen/__tests__/fixtures/` is empty
- [ ] `git status --porcelain packages/workflow/` is empty (PR #447's work untouched)

## STOP conditions

- **STOP** if `packages/workflow/src/types.ts` no longer documents `step` as
  "(name + invocation count)" — the premise this plan rests on would have changed.
- **STOP** if `WorkflowIR.steps` turns out to have a consumer outside the advisor lint.
  In that case remove the lint (Steps 2-3) and **keep** the feeder, correcting its
  docblocks instead of deleting them.
- **STOP** if any golden fixture under `packages/codegen/__tests__/fixtures/` changes —
  step evidence never reached emitted output, so a diff means the edit went too far.
- **STOP** if `pnpm run api:update` touches a snapshot other than `advisor.api.md` and
  `codegen.api.md`.
- **STOP** if removing the lint breaks a test in `apps/studio` — that would mean the
  Studio hard-codes the rule id somewhere, which needs its own handling.

## Maintenance notes

- The genuinely dangerous workflow-step mistake is a **non-deterministic** step name
  (built from `Date.now()`, `Math.random()`, or an unsorted iteration), not a repeated
  one. If a lint for that is ever wanted, it is a new rule over the name _expression_
  and needs its own plan — do not resurrect this one under a new name.
- The failure class this plan closes is the one PR #447's commit body names: a claim
  about a second party's behaviour that was never checked against the second party. The
  lint, its remediation text, and the `AdvisorWorkflow.steps` docblock all repeated one
  unverified sentence in three places. When adding a lint that asserts what a provider
  does, cite the provider's docs in the lint file.
- Reviewer: confirm nothing in `packages/workflow/` moved. PR #447 deliberately shipped
  only the reserved-prefix guard; a well-meaning "while we're here" runtime change would
  reintroduce exactly the breakage it avoided.
