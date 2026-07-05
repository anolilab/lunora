# Plan 121: Make the D1 suite and studio pure-logic tests actually run (locally and in CI)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- package.json .github/workflows/test.yml packages/d1/vitest.config.ts packages/studio/vitest.config.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED — turning the suites on may surface currently-failing or
  hanging tests that must be triaged (that is the point)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

`packages/d1` has **21 authored test files** (CDC, lazy migration, cross-shard
relations, soft-delete, FTS search, aggregates, migration runner, introspect,
d1-client) that **never execute anywhere**: every root `test*` script filters
`project!=d1`, and the CI comment promising "They run in a dedicated job once
fixed" refers to a job that does not exist. The D1 dialect is the production
`.global()` database backend — regressions there currently ship green, and the
existing test files create false assurance. The same root filter also excludes
`project!=studio` wholesale: the _intent_ was to skip the jsdom component
tests (they hang in some sandboxes), but the studio package sets
`environment: "jsdom"` for **everything**, so its pure-logic tests
(`fold-container-instances`, `lib/internal`, `kv-fields`, `data-view-params`,
…) are collateral damage and studio is effectively guarded by typecheck+lint
alone. This plan wires both back in: a dedicated D1 CI job and a node-env
vitest project for studio's pure tests.

## Current state

- Root `package.json:50-56` — every `test*` script carries
  `--query "project!=lunora-e2e&&project!=studio&&project!=d1&&project!=lunora-playground"`.
- `.github/workflows/test.yml` (~lines 88-95) — the promise:

    ```
    # workerd is intentionally OFF (no LUNORA_WORKERD_TESTS): the v8
    # coverage provider collects via node:inspector, which the
    # @cloudflare/vitest-pool-workers runtime does not implement, and the
    # workerd-pool suites currently hang the runner. They run in a
    # dedicated job once fixed. studio/d1/playground are excluded in the
    # `test*` scripts for the same hang reason.
    ```

    The `test` job: harden-runner → checkout (fetch-depth 0) → the
    `anolilab/workflows/step/node` setup action → `pnpm run build:affected:packages`
    → `pnpm run test:affected(:coverage)` on a node 22.15/24.11 matrix. There is
    a separate `e2e` job gated on `needs.files-changed.outputs.e2e`. A
    `files-changed` job (dorny/paths-filter, `test.yml:45`) provides path gates.

- `packages/d1/vitest.config.ts` — uses raw `defineConfig` (not the shared
  helper) with `@cloudflare/vitest-pool-workers`; **without**
  `LUNORA_WORKERD_TESTS=1` it defines a single project
  `{ name: "mocks", environment: "node", include: ["__tests__/*.test.ts"] }`;
  with the env it adds a `workerd` project
  (`cloudflareTest({ main: "__tests__/workerd/test-worker.ts", wrangler: { configPath: "./__tests__/workerd/wrangler.jsonc" } })`).
  So the top-level `__tests__/*.test.ts` files run on plain node — no workerd
  needed for them.
- `packages/studio/vitest.config.ts` (whole file, 12 lines) — the blanket
  jsdom:

    ```ts
    import { getVitestConfig } from "../../tools/get-vitest-config";

    export default getVitestConfig({
        test: {
            environment: "jsdom",
            globals: true,
            setupFiles: ["./__tests__/setup-reactflow.ts"],
        },
    });
    ```

- Known studio pure-logic test files (verify the full set with
  `grep -rln "environment" packages/studio/__tests__` — none override, and by
  listing `packages/studio/__tests__/**/*.test.ts` files that import no React
  component): `__tests__/features/containers/fold-container-instances.test.ts`,
  `__tests__/lib/internal.test.ts`, `__tests__/features/kv/kv-fields.test.ts`,
  `__tests__/lib/data-view-params.test.ts` (there may be more — inventory in
  Step 3).
- Known environment caveat (documented in the repo's agent notes): the studio
  **jsdom component tests** hang/SIGTERM in sandboxed environments. The pure
  node tests do not. D1's `mocks` project runs on plain node. Do NOT attempt
  to run the jsdom component tests as part of this plan.

Conventions: vis orchestrates tasks (`vis run test --query …`); per-package
scripts are invoked via `pnpm --filter`. Workflow YAML is quoted-key style —
match it exactly. Enforced commit types: `build, chore, ci, deps, docs, feat,
fix, perf, refactor, revert, security, style, test, translation`.

## Commands you will need

| Purpose           | Command                                                                    | Expected on success                  |
| ----------------- | -------------------------------------------------------------------------- | ------------------------------------ |
| Build d1's deps   | `pnpm --filter "@lunora/d1..." run build`                                  | exit 0                               |
| D1 mocks suite    | `pnpm --filter "@lunora/d1" run test`                                      | see Step 1 — currently unknown-green |
| Studio node tests | `pnpm --filter "@lunora/studio" run test -- --project unit` (after Step 3) | all pass                             |
| Workflow lint     | `npx --yes yaml-lint .github/workflows/test.yml` or a YAML parse via node  | parses                               |

## Scope

**In scope**:

- Root `package.json` (adjust the `test*` query filters for studio only — see
  Step 4; d1 stays excluded from the root run and gets its own job)
- `.github/workflows/test.yml` (new `test-d1` job; studio inclusion comes free
  via the root script change)
- `packages/studio/vitest.config.ts` (project split)
- `packages/d1/package.json` / `packages/studio/package.json` ONLY if a new
  script is needed
- Triage-only, minimal fixes to individual failing d1/studio tests **if and
  only if** the failure is a stale expectation (see STOP conditions for
  anything bigger)

**Out of scope**:

- Enabling `LUNORA_WORKERD_TESTS` anywhere (that is plan 122).
- The studio jsdom **component** tests (they stay excluded; the hang is real).
- `lunora-playground` and `lunora-e2e` exclusions (deliberate).
- Coverage wiring for the new jobs (coverage stays off for d1 — the workers
  pool cannot collect v8 coverage; note it in the job comment).

## Git workflow

- Branch: `advisor/121-wire-d1-studio-tests`
- Suggested commits: `test(studio): split pure-logic tests into a node project`,
  `ci: dedicated d1 test job + run studio unit project in the root suite`.

## Steps

### Step 1: Establish the D1 baseline locally

```
pnpm --filter "@lunora/d1..." run build && pnpm --filter "@lunora/d1" run test
```

Record the outcome. Three possibilities:

- **All green** → proceed.
- **A few stale-expectation failures** (assertion text drift, renamed
  exports) → fix those tests only, keep a list for the report.
- **Hangs or structural failures** (pool cannot boot, >5 failing files) →
  STOP and report the exact output; the CI job would only institutionalize a
  broken suite.

**Verify**: `pnpm --filter "@lunora/d1" run test` → exit 0 before moving on.

### Step 2: Add the `test-d1` CI job

In `.github/workflows/test.yml`, add a job modeled on the existing `test` job
(copy its harden-runner/checkout/node-setup steps verbatim, single node
version `22.15`, no matrix, no coverage):

- `needs: files-changed`, gated `if: needs.files-changed.outputs.packages == 'true'`
  — first inspect the `files-changed` job's filter outputs (around
  `test.yml:45`) and reuse the output that covers `packages/**`; if the
  filters are more granular, add a `d1` filter for
  `packages/d1/**`, `packages/sql-store/**`, `packages/do/**`,
  `packages/server/**` (d1's dependency chain).
- Steps: setup → `pnpm --filter "@lunora/d1..." run build` →
  `pnpm --filter "@lunora/d1" run test`.
- `timeout-minutes: 15`.
- Update the stale comment block (lines ~88-95): d1 now has its dedicated job;
  keep the workerd + studio-jsdom sentences accurate.

Also check `.github/workflows/` for a branch-protection contract: the repo's
required checks are only the three always-run gates — do NOT name this job as
a required check or make other jobs `needs` it.

**Verify**: the YAML parses (`node -e "require('node:fs'); const y=require('js-yaml');y.load(require('node:fs').readFileSync('.github/workflows/test.yml','utf8'))"` —
js-yaml is available in the repo's dev deps; if not resolvable, use any local
YAML parse) and `git diff` shows the job matches the existing job's step/style
conventions.

### Step 3: Split studio's vitest config into jsdom + node projects

Rewrite `packages/studio/vitest.config.ts` to two projects (keep using
`getVitestConfig` — read `tools/get-vitest-config.ts` first to see how it
merges `test` options; if it doesn't support `projects`, fall back to
`defineConfig` + inline the coverage block the same way
`packages/d1/vitest.config.ts` does, with a comment explaining why):

- Project `unit`: `environment: "node"`, `include` limited to the pure-logic
  tests. Inventory them: every `packages/studio/__tests__/**/*.test.ts` whose
  transitive imports pull no `.tsx`/DOM — start from the four named in
  "Current state" and add any others you verify are DOM-free. Prefer an
  explicit `include` list over a glob so a future DOM test can't wander in.
- Project `component`: `environment: "jsdom"`, `globals: true`, the
  `setup-reactflow.ts` setupFile, `include` = everything else (the current
  behavior).

**Verify**: `pnpm --filter "@lunora/studio" run test -- --project unit` → all
pass on plain node, in this sandbox, without hanging. Do NOT run the
`component` project here.

### Step 4: Let the root suite run studio's unit project

The root filter `project!=studio` excludes the whole package at the vis layer,
so flipping it would also run the hanging jsdom project. Instead:

1. Keep `project!=studio` in the root `test*` queries (unchanged).
2. Add a studio-scoped script `test:unit` in `packages/studio/package.json`:
   `"test:unit": "vitest run --project unit"` (match the existing `test`
   script's shape in that file).
3. In `.github/workflows/test.yml`'s main `test` job, after the existing
   "Run affected tests" step, add a step:
   `pnpm --filter "@lunora/studio" run test:unit` (unconditional within the
   job — it's seconds of pure node tests).
4. Update the comment block to say studio's _component_ (jsdom) tests are the
   excluded remainder.

**Verify**: `pnpm --filter "@lunora/studio" run test:unit` → all pass locally.

## Test plan

No new test _content_ — this plan's product is that ~21 d1 files and the
studio unit files execute. The gates are Step 1's green run, Step 3's green
`--project unit` run, and the YAML parsing.

## Done criteria

- [ ] `pnpm --filter "@lunora/d1" run test` → exit 0 locally
- [ ] `pnpm --filter "@lunora/studio" run test:unit` → exit 0 locally, ≥4 test
      files executed (visible in the vitest summary)
- [ ] `.github/workflows/test.yml` contains a `test-d1` job + the studio
      unit step; stale comment updated; YAML parses
- [ ] Root `test*` scripts unchanged for d1/e2e/playground; studio exclusion
      documented as component-only
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1 hangs or shows structural failures (see the three-way triage) — the
  d1 suite needs a repair plan first, not a CI job.
- More than ~3 d1 tests need expectation fixes, or any fix requires touching
  `packages/d1/src/**` (a _source_ bug found by the resurrected suite is a
  separate finding — report it, do not fix inline).
- `tools/get-vitest-config.ts` cannot express projects AND the fallback to
  raw `defineConfig` would lose repo-standard config you cannot replicate
  (report what's missing).
- Any studio "pure" test turns out to import DOM transitively and fails on
  node — move it back to the component project and note it; if that leaves
  fewer than 3 unit tests, the split isn't paying its way — report.
- The `files-changed` job's outputs don't cover `packages/**` in a way any
  existing output can express (report the filter map).

## Maintenance notes

- New d1 tests must go in `__tests__/*.test.ts` (mocks project, runs in CI) or
  `__tests__/workerd/**` (gated — see plan 122). New studio logic tests should
  land in the `unit` project's include list.
- Reviewers: check the CI job's path gate actually fires for d1-adjacent
  changes (sql-store/do/server are d1's upstream).
- Deferred: repairing + including the studio jsdom component tests (the
  documented hang), and d1 coverage (workers pool lacks node:inspector).
