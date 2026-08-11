# Plan 318 — Stop the Vite dev loop emitting codegen from a stale TypeScript program

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO

> **Executor instructions**: follow this file top to bottom, run every verification
> command, stop on any §8 STOP condition, and update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first):**
> `git diff --stat 70b7451b5..HEAD -- packages/vite/src/codegen-plugin.ts packages/codegen/src/run-codegen.ts`
>
> **Build before you measure:** `pnpm run build:packages` once.

## 0. Headline finding

`vite dev` reuses one long-lived ts-morph `Project` across codegen runs. The refresh
that keeps it in sync only refreshes files **inside `lunora/`**. Files outside it —
the user's shared validators, shared types, anything pulled in by the root tsconfig —
are pinned at the version first parsed. The documented escape hatch ("a tsconfig
change invalidates the whole cached Project upstream") is unreachable: the
invalidation branch sits _after_ an early return that drops every path outside the
schema directory, and no shipped template or example has a `lunora/tsconfig.json`
(every tsconfig is at project root).

Result: edit a shared `v.object(...)` in `src/validators.ts`, then save any
`lunora/*.ts`, and codegen re-emits `_generated/{api,server,dataModel}.ts` from the
**old** definition. `lunora codegen` (fresh Project) and `vite dev` produce different
output from the same source — the worst failure shape a codegen tool has.

## 1. Current state (audit)

`packages/vite/src/codegen-plugin.ts:542-563`:

```ts
const onChange = (file: string): void => {
    // Only react to changes inside the schema dir, and ignore generated output.
    const normalized = resolve(file);

    if (!isInside(normalized, absoluteSchemaDirectory)) {
        return;                                    // <-- everything outside lunora/ leaves here
    }

    if (isInside(normalized, absoluteGeneratedDirectory)) {
        return;
    }

    // A tsconfig change can move path aliases / compiler options out
    // from under a reused Project, so drop the cache and rebuild it
    // from scratch on the next run. Checked before the `.ts` gate so
    // a `tsconfig*.json` save still invalidates ...
    if (normalized.endsWith(`${sep}tsconfig.json`) || TSCONFIG_VARIANT_RE.test(normalized)) {
        cachedProject = undefined;

        return;
    }
```

The comment says "checked before the `.ts` gate" — true, but it is also _after_ the
schema-directory gate, which is the one that matters.

`packages/codegen/src/run-codegen.ts:337-343` builds the Project from the **project
root** tsconfig (`findTsconfig` walks up from `lunora/`) with
`skipAddingFilesFromTsConfig: false`, so the whole program is loaded.

`packages/codegen/src/run-codegen.ts:354-380` — `refreshCodegenProject`, with its own
docblock naming the guard that never fires:

```
 * Files outside `lunoraDirectory` (e.g. those pulled in by the user's tsconfig)
 * are left untouched — they back type resolution and rarely change in the
 * dev-loop; a tsconfig change invalidates the whole cached Project upstream.
```

and a body that only walks `listLunoraSourceFiles(lunoraDirectory)` plus `schema.ts`.

Why it matters for correctness rather than just freshness:
`packages/codegen/src/parse-validator.ts:124-132` (`resolveValidatorAlias`) follows
`getAliasedSymbol()` into other modules, so a validator defined outside `lunora/` is
genuinely read from the stale source file.

Confirmation that no `lunora/tsconfig.json` exists anywhere in the repo's own
templates or examples:

```
find templates examples -path '*lunora*' -name 'tsconfig*'   # → empty
```

## 2. Existing seams (do not reinvent)

- `findTsconfig(lunoraDirectory)` in `@lunora/codegen` — already resolves the tsconfig
  the Project was built from. Reuse it to decide _which_ tsconfig path invalidates.
- `cachedProject = undefined` — the invalidation mechanism already exists and is
  correct. This plan makes it reachable; it does not need a new mechanism.
- `refreshCodegenProject(project, lunoraDirectory)` — the per-run sync point. Widening
  what it refreshes is the second half of the fix.

## 3. The behavioural contract to preserve

1. Dev-loop cost. Plan 063 measured a fresh Project at roughly 900 ms per run; the
   whole point of the cache is avoiding that on every save. A fix that invalidates on
   every keystroke anywhere is a regression, not a fix.
2. `lunora codegen` (CLI, fresh Project) output must remain byte-identical to
   `vite dev` output for the same source. That equality is the acceptance test for
   this plan.
3. No change to emitted code. The golden fixtures under `packages/codegen/__tests__/`
   must not move. (Note: `.js` extensions in emitted output are deliberate — do not
   "fix" them.)

## 4. Design decisions

**Chosen (both halves):**

- **(a)** Move the tsconfig check **above** the schema-directory gate, and widen it
  from "any tsconfig under `lunora/`" to "the tsconfig `findTsconfig` actually
  resolved, plus any tsconfig at or above the project root". A save of the root
  `tsconfig.json` must invalidate.
- **(b)** In `refreshCodegenProject`, also `refreshFromFileSystemSync()` the Project's
  source files **outside** `lunoraDirectory` — but only those already in the Project,
  never adding new ones.

Rejected: "invalidate the whole cached Project on any `.ts` change anywhere". Simplest
to write, and it reinstates the 900 ms cost on every save in a monorepo where the
watcher sees a lot of files. (b) is strictly cheaper: `refreshFromFileSystemSync` on
an unchanged file is a stat, not a reparse.

Rejected: "declare it a known limitation and document it". The two producers disagree
silently; a user cannot tell which one is lying.

**Open, decide during execution:** whether (b) should refresh _every_ non-`lunora/`
file in the Project or only files under the project root (excluding `node_modules`).
Measure both — see §9.

## 5. Workstreams

### WS1 — Make the tsconfig invalidation reachable (S)

In `packages/vite/src/codegen-plugin.ts`, hoist the tsconfig branch above the
`isInside(normalized, absoluteSchemaDirectory)` early return, and match against the
resolved root tsconfig rather than only paths under the schema directory. Keep
`TSCONFIG_VARIANT_RE` for `tsconfig.*.json` variants. Update the comment — the current
one describes behaviour the code did not have.

**Verify:** a new unit test (WS3) that fires `onChange("<root>/tsconfig.json")` and
asserts the cached Project was dropped.

### WS2 — Refresh non-`lunora/` files in the reused Project (S)

In `packages/codegen/src/run-codegen.ts`, extend `refreshCodegenProject` to walk
`project.getSourceFiles()` and `refreshFromFileSystemSync()` those outside
`lunoraDirectory`, skipping anything under `node_modules` (and `.d.ts` from
dependencies — those never change in a dev loop and dominate the file count).

Correct the docblock at `:354-366`: the sentence claiming a tsconfig change
invalidates upstream is what made this bug invisible. State what the function
actually does now.

**Verify:** the WS3 integration test below.

### WS3 — Tests (S)

See §"Test plan".

## 6. Platform parity

Not applicable — build-time codegen and the dev server. No `ctx.*` surface, no
binding, no runtime capability.

## 7. Phasing & ordering

| Phase | Work | Gate                                                                                    |
| ----- | ---- | --------------------------------------------------------------------------------------- |
| 0     | WS2  | new codegen test: editing an out-of-dir validator changes the next run's output         |
| 1     | WS1  | new vite test: a root-tsconfig save drops the cached Project                            |
| 2     | WS3  | `pnpm --filter "@lunora/codegen" run test` and `--filter "@lunora/vite" run test` green |

WS2 before WS1: WS2 is the half that fixes the common case (a shared validator edit),
and it is verifiable without touching the plugin.

## Commands you will need

| Purpose       | Command                                              | Expected                           |
| ------------- | ---------------------------------------------------- | ---------------------------------- |
| Build         | `pnpm run build:packages`                            | exit 0                             |
| Codegen tests | `pnpm --filter "@lunora/codegen" run test`           | all pass (was 363/363 at plan 057) |
| Vite tests    | `pnpm --filter "@lunora/vite" run test`              | all pass                           |
| Typecheck     | `pnpm --filter "@lunora/codegen" run lint:types`     | exit 0                             |
| Format, lint  | `pnpm run lint:prettier:fix && pnpm run lint:eslint` | exit 0                             |

## Scope

**In scope:**

- `packages/vite/src/codegen-plugin.ts`
- `packages/codegen/src/run-codegen.ts`
- `packages/vite/__tests__/codegen-plugin.test.ts` (extend)
- `packages/codegen/__tests__/` — one new spec

**Out of scope:**

- `packages/codegen/src/emit.ts` and every golden fixture — emitted output must not
  change. If your fix moves a fixture, you have changed behaviour you were not asked
  to change: STOP.
- `packages/codegen/src/parse-validator.ts` — the alias resolution is correct; it is
  the _input_ that was stale.
- The debounce/watcher wiring in the plugin.

## Git workflow

- Branch: `advisor/318-vite-stale-codegen-project`
- Suggested commits: `fix(codegen): refresh reused project files outside lunora/`
  and `fix(vite): invalidate cached project on root tsconfig save`

## Test plan

**`packages/codegen/__tests__/reused-project-refresh.test.ts`** (new). Model the
fixture-project setup on the existing specs in that directory.

1. Build a temp project: `lunora/schema.ts`, `lunora/listThings.ts` importing a
   validator from `../src/validators.ts`, and a root `tsconfig.json`.
2. `createCodegenProject` → `runCodegen` → capture emitted `api.ts`.
3. Rewrite `src/validators.ts` so the validator's shape changes (add a field).
4. `refreshCodegenProject` → `runCodegen` again.
5. Assert the second emit reflects the new field. **Fails on today's code.**
6. Control: the same sequence with a fresh `createCodegenProject` produces the same
   output as step 4 — this is the "both producers agree" contract from §3.2.

**`packages/vite/__tests__/codegen-plugin.test.ts`** (extend):

7. `onChange("<projectRoot>/tsconfig.json")` drops the cached Project (assert the next
   run constructs a new one — the existing spec already has a seam for observing this;
   if not, expose the cache via the plugin's test hook rather than inventing one).
8. `onChange("<projectRoot>/src/unrelated.md")` does **not** drop it (the perf contract).

## Done criteria

- [ ] `pnpm --filter "@lunora/codegen" run test` exits 0, including the new spec
- [ ] `pnpm --filter "@lunora/vite" run test` exits 0, including both new cases
- [ ] `git diff --stat -- packages/codegen/__tests__/**/__fixtures__` is empty (no golden fixture moved)
- [ ] The step-5 assertion fails when WS2 is reverted (prove it)
- [ ] `pnpm run lint:eslint` and `pnpm run lint:prettier` exit 0
- [ ] `plans/README.md` row updated

## 8. Risks & STOP conditions

- **STOP** if any golden fixture changes. That means the fix altered emitted output,
  which is out of scope.
- **STOP** if refreshing non-`lunora/` files pushes a single dev-loop codegen run past
  roughly 300 ms on the repo's own `examples/todo-app` (measure it — see §9). At that
  point the cheap-refresh assumption is wrong and the design needs revisiting.
- **Risk:** `refreshFromFileSystemSync()` on a file deleted from disk may throw. Guard
  it, and prefer removing the source file from the Project over letting it throw.
- **Risk:** ts-morph may keep a large `.d.ts` set from `node_modules` in the Project.
  Excluding those from the refresh walk is what keeps this cheap; verify the exclusion
  actually matches (`node_modules` can appear mid-path in a monorepo).

## 9. Open questions

1. Measure: how long does `refreshCodegenProject` take before and after WS2 on
   `examples/todo-app`? Record both numbers here. If the delta is under ~50 ms,
   refresh everything outside `node_modules` and stop tuning.
2. Should the plugin also invalidate on a change to a tsconfig that the root one
   `extends`? Cheap to add (the extends chain is readable from the resolved config),
   but only if step 1 shows headroom.
