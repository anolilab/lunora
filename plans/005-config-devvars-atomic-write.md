# Plan 005: `.dev.vars` generation writes atomically (temp file + rename)

> **Executor instructions**: Follow step by step; verify each step; obey STOP
> conditions; update `plans/README.md` when done.
>
> **Drift check**: `git diff --stat 151a3eca..HEAD -- packages/config/src/scaffold-dev-variables.ts`
> Reconcile the excerpt on any change; mismatch ⇒ STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (touches the same file as plan 002 — land 002 first to avoid a trivial merge conflict)
- **Category**: bug
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

`ensureDevVariables` checks `!existsSync(devVariablesPath)` and then
`writeFileSync(devVariablesPath, plan.content)`. Between the check and the write
another process (parallel `pnpm install`, a second `cirrus dev`, the Vite dev
server running concurrently with the CLI) can create or write the same file. The
later writer silently clobbers the earlier one, and because `plan.content`
contains freshly **generated secrets**, one process's secrets can be lost. An
atomic write (write to a temp file in the same directory, then `rename`) makes
the create-or-skip decision and the write a single observable step.

## Current state

`packages/config/src/scaffold-dev-variables.ts:244-275` — the create branch:

```ts
if (!existsSync(devVariablesPath)) {
    const plan = planDevVariablesScaffold({ devVarsExists: false, exampleContent, randomHex: deps.randomHex });
    if (plan.status !== "generate") {
        return { addedKeys: [], generatedKeys: [], status: "no-example" };
    }
    const proceed = deps.yes === true || (await deps.confirm(`No ${DEV_VARS_FILE} found. Generate it ...?`));
    if (!proceed) {
        /* ... */ return { addedKeys: [], generatedKeys: [], status: "declined" };
    }
    writeFileSync(devVariablesPath, plan.content, "utf8");
    deps.info(`Created ${DEV_VARS_FILE}${generatedSuffix(plan.generatedKeys)}.`);
    return { addedKeys: [], generatedKeys: plan.generatedKeys, status: "generated" };
}
// File present → augment path follows (line 278+)
```

The augment path (`:278+`) reads then writes the existing file; it is an update,
not a create, so the TOCTOU that loses generated secrets is the **create**
branch. Focus there.

## Commands

| Purpose           | Command                                         | Expected |
| ----------------- | ----------------------------------------------- | -------- |
| Build deps (once) | `pnpm run build:packages`                       | exit 0   |
| Typecheck         | `pnpm --filter "@cirrus/config" run lint:types` | exit 0   |
| Tests             | `pnpm --filter "@cirrus/config" run test`       | all pass |

## Scope

**In scope**: `packages/config/src/scaffold-dev-variables.ts` (the create
branch's write), plus its test file.
**Out of scope**: the placeholder logic (plan 002), the augment path's content
computation, `existsSync` usage elsewhere.

## Steps

### Step 1: Write to a temp file then rename, using exclusive create

Replace the create-branch `writeFileSync(devVariablesPath, plan.content, "utf8")`
with an atomic sequence using Node `fs`:

1. Write `plan.content` to a sibling temp path (e.g. `${devVariablesPath}.tmp-${process.pid}`)
   with `writeFileSync(tmp, plan.content, { encoding: "utf8", flag: "wx" })` —
   `wx` fails if the temp already exists.
2. `renameSync(tmp, devVariablesPath)` — atomic on the same filesystem.
3. On any error, attempt to `rmSync(tmp, { force: true })` and rethrow.

To close the create-race fully, prefer detecting a concurrent create: if
`renameSync` would overwrite, that is acceptable for a fresh generate (the target
didn't exist at decision time), but if you can cheaply re-check `existsSync`
right before the rename and bail with `status: "skipped-exists"` when another
process won the race, do so. Keep the public `EnsureDevVariablesResult` shape;
if you add a status variant, update its type and all consumers in this file.

Add the `fs` imports you need (`renameSync`, `rmSync`) alongside the existing
imports — do not add `.js` extensions.

**Verify**: `pnpm --filter "@cirrus/config" run lint:types` → exit 0.

### Step 2: Test

Add a test that the generate path still produces the file with the expected
content (existing behavior preserved) and that a temp file is not left behind on
success. If feasible with the existing test seams (the deps object is injected),
add a test simulating a write error and assert the temp file is cleaned up.
Model on the existing scaffold tests.

**Verify**: `pnpm --filter "@cirrus/config" run test` → all pass.

## Done criteria

- [ ] Create branch writes via temp-file + `rename`; temp removed on error
- [ ] `pnpm --filter "@cirrus/config" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/config" run test` exits 0; generate-path test still green + cleanup test added
- [ ] `git status` shows only in-scope files
- [ ] `plans/README.md` updated

## STOP conditions

- The create branch no longer matches the excerpt.
- Adding a new result status would ripple into out-of-scope files — report instead.

## Maintenance notes

- If the augment path is ever changed to rewrite the whole file, give it the same
  atomic treatment.
- Reviewer: confirm `rename` targets the same directory (cross-device rename is
  not atomic and throws `EXDEV`).
