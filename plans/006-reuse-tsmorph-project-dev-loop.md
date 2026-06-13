# Plan 006: Reuse the ts-morph Project across dev-loop codegen runs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c865cfa6..HEAD -- packages/codegen/src/run-codegen.ts packages/vite/src/codegen-plugin.ts packages/codegen/__tests__ packages/vite/__tests__`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (stale-cache bugs would emit wrong generated code in dev; mitigated by refresh-from-disk + tests + full-rebuild fallback)
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `c865cfa6`, 2026-06-13

## Why this matters

Every save of any `.ts` file under the user's `cirrus/` directory triggers the
Vite plugin's debounced `runCodegen`, and `runCodegen` constructs a **fresh
ts-morph `Project`** each time — when a tsconfig is found, with
`skipAddingFilesFromTsConfig: false`, i.e. it re-parses the user's entire
TypeScript program on every keystroke-save. On a non-trivial app this
dominates the dev feedback loop (codegen → overlay → full page reload). Reusing
one `Project` across runs and refreshing changed files from disk removes the
program-construction cost while keeping output identical. This is the cheap,
low-risk slice of "incremental codegen" — full incremental emit (skipping
unchanged functions) is explicitly out of scope.

## Current state

- `packages/codegen/src/run-codegen.ts` — top-level entry (~line 72):

```ts
export const runCodegen = (options: CodegenOptions): CodegenResult => {
    const cirrusDirectory = join(options.projectRoot, options.cirrusDirectory ?? "cirrus");
    const schemaPath = join(cirrusDirectory, "schema.ts");
    ...
    // Prefer the user's tsconfig (when present) so cross-file type resolution
    // and path aliases work. Fall back to an isolated project otherwise.
    const tsconfigPath = findTsconfig(cirrusDirectory);
    const project = tsconfigPath
        ? new Project({ skipAddingFilesFromTsConfig: false, tsConfigFilePath: tsconfigPath, useInMemoryFileSystem: false })
        : new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

    const schema = discoverSchema(project, schemaPath);
    const functions = discoverFunctions(project, cirrusDirectory);
    const httpRoutes = discoverHttpRoutes(project, cirrusDirectory);
    const migrations = discoverMigrations(project, cirrusDirectory);
    const crons = discoverCrons(project, cirrusDirectory);
    ...
```

  `CodegenOptions` is defined in this package (find it via
  `grep -rn "interface CodegenOptions" packages/codegen/src/`).

- `packages/vite/src/codegen-plugin.ts` — the watcher (lines ~260–308):
  `onChange` filters to non-test `.ts` files, debounces (`DEBOUNCE_MS`, 100ms),
  then calls `runCodegenSafely(options, serverLogger, overlay)` and sends
  `{ type: "full-reload" }` on success. `runCodegenSafely` wraps
  `runCodegen` with overlay/error handling (read it before editing).
  Watcher teardown happens in the `configureServer` cleanup (lines ~310–320).

- Tests:
  - `packages/codegen/__tests__/run-codegen.test.ts` — end-to-end codegen runs
    over fixture directories; the structural pattern for new tests.
  - `packages/vite/__tests__/` — plugin tests (13 files); check how they fake
    the dev server/watcher before touching plugin behavior.
- Conventions: TypeScript ESM, no `.js` extensions on relative imports
  **except inside codegen's emitted templates/fixtures** (do not "fix" `.js`
  strings in emit templates or golden fixtures — they are required output),
  named exports only.
- ts-morph is already a dependency. Relevant APIs:
  `project.addSourceFileAtPathIfExists`, `sourceFile.refreshFromFileSystemSync()`,
  `project.removeSourceFile`, `project.getSourceFiles()`.

## Commands you will need

| Purpose   | Command                                             | Expected on success |
|-----------|-----------------------------------------------------|---------------------|
| Install   | `pnpm install`                                      | exit 0              |
| Codegen tests | `pnpm --filter "@cirrus/codegen" run test`      | all pass            |
| Vite tests    | `pnpm --filter "@cirrus/vite" run test`         | all pass            |
| Typecheck | `pnpm --filter "@cirrus/codegen" run lint:types && pnpm --filter "@cirrus/vite" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@cirrus/codegen" run lint:eslint && pnpm --filter "@cirrus/vite" run lint:eslint` | exit 0 |

## Scope

**In scope** (the only files you should modify/create):
- `packages/codegen/src/run-codegen.ts` (accept an injected/reused Project)
- `packages/vite/src/codegen-plugin.ts` (hold + refresh the cached Project)
- `packages/codegen/__tests__/run-codegen.test.ts` (reuse-correctness tests)
- `packages/vite/__tests__/` (one plugin-level test if the existing harness
  supports it cheaply; otherwise skip — see Test plan)
- `plans/README.md` (status row update)

**Out of scope** (do NOT touch, even though they look related):
- Incremental EMIT (skipping unchanged output files, per-function dirty
  tracking) — future work, much higher risk.
- The `full-reload` → HMR change — separate backlog item.
- `packages/codegen/src/emit.ts` and golden fixtures — output must be
  byte-identical before/after this plan.
- The CLI's one-shot `cirrus codegen` path — it constructs a Project once per
  invocation; caching is meaningless there (but it must keep working through
  the same `runCodegen` signature).

## Git workflow

- Branch: `perf/codegen-project-reuse` off `alpha`.
- Conventional commits, e.g. `perf(codegen): accept a reusable ts-morph project`
  then `perf(vite): reuse the codegen project across dev-loop runs`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract Project construction in `run-codegen.ts`

Add to `CodegenOptions` an optional `project?: Project` (doc comment: "reuse a
previously-constructed Project; the caller owns refreshing its source files
from disk"). In `runCodegen`, use `options.project` when provided, else build
exactly as today. Also export a named helper
`createCodegenProject(cirrusDirectory: string): Project` containing the
current tsconfig-or-isolated construction logic, so the plugin can build one
without duplicating it.

**Verify**: `pnpm --filter "@cirrus/codegen" run test` → all pass (behavior
unchanged when `project` is not passed).

### Step 2: Prove reuse-correctness at the codegen level

In `run-codegen.test.ts`, add a describe block "project reuse":

1. Run `runCodegen` twice over the same fixture with one shared Project →
   second result equals the first (same emitted content).
2. Between two runs, **edit** a fixture function file on disk (e.g. rename an
   exported query or change an arg validator), refresh the shared Project
   (the test should do what the plugin will do in Step 3 — call the new
   refresh helper), run again → emitted output reflects the edit.
3. Between two runs, **add** a new function file and **delete** another →
   output includes the new function and drops the deleted one.

Use a temp-dir copy of an existing fixture so edits don't dirty golden
fixtures (check how existing tests in this file create/clean temp dirs and
copy fixtures — follow that pattern exactly).

**Verify**: `pnpm --filter "@cirrus/codegen" run test -- run-codegen` → all pass.

### Step 3: Add the refresh helper + plugin caching

In `run-codegen.ts` (or a sibling module if the file is getting long), export
`refreshCodegenProject(project: Project, cirrusDirectory: string): void` that:

- for every `.ts` file currently under `cirrusDirectory` (excluding
  `_generated/` and test files — mirror the watcher's filter):
  `project.addSourceFileAtPathIfExists(path) ?? project.addSourceFileAtPath(path)`,
  then `sourceFile.refreshFromFileSystemSync()`;
- removes from the Project any source file under `cirrusDirectory` that no
  longer exists on disk (`project.removeSourceFile`).

Then in `packages/vite/src/codegen-plugin.ts`: hold `let cachedProject:
Project | undefined` in the `configureServer` closure. In the debounced
callback, before `runCodegenSafely`: build it on first use via
`createCodegenProject`, otherwise `refreshCodegenProject` it; pass it through
to `runCodegen` (thread the option through `runCodegenSafely`). Invalidate
(`cachedProject = undefined`) when the changed file is a `tsconfig*.json`, and
on ANY codegen error (so a corrupted cache can never wedge the dev loop —
next run rebuilds from scratch). Clear it in the existing server-close
teardown.

**Verify**: `pnpm --filter "@cirrus/vite" run test` → all pass;
`pnpm --filter "@cirrus/codegen" run test` → all pass.

### Step 4: Full gates + manual smoke (optional but recommended)

**Verify**:
- `pnpm --filter "@cirrus/codegen" run lint:types && pnpm --filter "@cirrus/vite" run lint:types` → exit 0
- `pnpm --filter "@cirrus/codegen" run lint:eslint && pnpm --filter "@cirrus/vite" run lint:eslint` → exit 0
- If an example app is runnable without external services (check `apps/` or
  `examples/` for a playground with a `dev` script): start it, save a change
  in its `cirrus/` dir twice, confirm codegen runs and the second run is
  visibly faster (plugin logs timing — check `runCodegenSafely` for an
  existing duration log; if none exists, do not add one in this plan).

## Test plan

- Codegen level (Step 2): reuse-identical-output, edit-reflected,
  add/delete-reflected. Pattern: existing cases in `run-codegen.test.ts`.
- Vite level: only if the existing plugin test harness already simulates
  watcher events (inspect `packages/vite/__tests__/`); if it doesn't, skip the
  plugin-level test rather than building a dev-server harness — the codegen
  tests carry the correctness load, and the plugin wiring is failure-safe by
  construction (cache dropped on any error).

## Done criteria

- [ ] `CodegenOptions` has optional `project`; `createCodegenProject` and `refreshCodegenProject` are named exports
- [ ] The vite plugin passes a cached Project on the second and subsequent dev-loop runs (visible in the code; cache invalidated on tsconfig change, on codegen error, and on server close)
- [ ] `pnpm --filter "@cirrus/codegen" run test` exits 0 with the 3 new reuse tests
- [ ] `pnpm --filter "@cirrus/vite" run test` exits 0
- [ ] Both packages pass `lint:types` and `lint:eslint`
- [ ] No changes under `packages/codegen/src/emit.ts` or any `__fixtures__`/golden files (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `runCodegen` no longer matches the excerpt (Project construction moved or
  changed).
- ts-morph's refresh APIs behave differently than described (e.g.
  `refreshFromFileSystemSync` not available in the installed version — check
  `node_modules/ts-morph` typings) and no equivalent exists.
- Step 2's test 2 fails because discovery caches type information beyond the
  Project (i.e. refresh is insufficient for correctness) — that disproves the
  plan's core assumption; report rather than papering over with workarounds.
- Threading the option through `runCodegenSafely` requires touching more than
  `codegen-plugin.ts` within the vite package (e.g. a shared types file is
  fine; rewriting the overlay machinery is not).

## Maintenance notes

- Anyone later implementing incremental EMIT builds on this: the shared
  Project is the prerequisite.
- Reviewer should scrutinize: the invalidation triggers (tsconfig change,
  error, server close) and that delete-detection works (test 3) — stale
  deleted files are the classic bug in editor-tooling caches.
- Deferred: HMR instead of `full-reload` after codegen (backlog), per-function
  emit skipping, and caching across `cirrus dev` CLI restarts.
