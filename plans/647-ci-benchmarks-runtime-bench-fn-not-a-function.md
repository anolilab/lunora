# Plan 647: The CodSpeed `Benchmarks` CI job runs the `@lunora/runtime` bench files again

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/runtime/__bench__ packages/runtime/vitest.config.ts .github/workflows/codspeed.yml pnpm-workspace.yaml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Revised design after the first execution (2026-11-21)

The first run found the real cause: commit `aab7c32f0` pinned `"@noble/hashes": 2.2.0` in the `storage` catalog (`pnpm-workspace.yaml` ~781) for `@lunora/runtime`. jsdom resolves `@noble/hashes@2.4.0` elsewhere, so pnpm gave `packages/runtime` its own vitest variant (peer set differs) while `@codspeed/vitest-plugin` stays on the root variant. Benches register in one vitest copy and the CodSpeed analysis runner looks them up in the other: `fn is not a function`. The catalog comment gives no reason for 2.2.0 specifically (it only explains why the package is needed), and nothing else depends on that version.

Decided fix (scope widened to the catalog and lockfile):

1. Set `"@noble/hashes": 2.4.0` in the `storage` catalog. Run `pnpm install` (not frozen) so pnpm regenerates `pnpm-lock.yaml` — never edit the lockfile by hand. The lockfile diff must be limited to this change and its dedupe (the `@noble/hashes@2.2.0` entry and the extra vitest variant should disappear); if unrelated packages move, STOP.
2. Confirm `packages/runtime` now resolves the same vitest copy as the plugin (repeat your variant scan) and that the runtime bench files run to completion in **both** modes: CodSpeed analysis mode (`CODSPEED_ENV=1 CODSPEED_RUNNER_MODE=simulation ...`) and plain `pnpm --filter "@lunora/runtime" run test:bench`.
3. `@lunora/runtime` ships this dependency: check its use (`rg -n "noble/hashes" packages/runtime/src`) against the 2.2.0 → 2.4.0 changelog in `node_modules` (same major; confirm the imported entry points still exist), then build `@lunora/runtime...` and run its tests, `lint:types`, `lint:eslint`. Run `pnpm run lint:package-json` and `pnpm run lint:catalog-drift`.
4. `apps/cloud` has the same symptom. Find which peer splits its vitest variant. If the `@noble/hashes` change already fixed it, say so. If it is a second pin of the same kind, fix it the same way in this commit. If the cause is different in kind, leave it and report it.
5. Update the stale remedy comment in `tools/get-bench-config.ts` so it also names this cause (a peer pin splitting the vitest variant) — one or two sentences, why-style.

Commit on `ci/fix-runtime-benchmarks`: `deps(runtime): align noble hashes so benches share one vitest`. The earlier STOP about config-only fixes stands: do not alias vitest.

## Why this matters

The `Benchmarks` job (`.github/workflows/codspeed.yml`, job `benchmark`) fails on every pull request that touches runtime-affected code, including ones unrelated to benchmarks, so a red check is being ignored. Observed in CI on several PRs:

```
runtime:test:bench (exit 1):
 FAIL  __bench__/import-throughput.bench.ts
 FAIL  __bench__/orchestrate-migration-export.bench.ts
 FAIL  __bench__/rpc-dispatch.bench.ts
TypeError: fn is not a function
 ❯ optimizeFunction  @codspeed/core/src/optimization.ts:4:2
 ❯ runAnalysisBench  @codspeed/vitest-plugin/dist/analysis.mjs
 ❯ runAnalysisBenchmarkSuite
 ❯ AnalysisRunner.runSuite
[CodSpeed] @codspeed/vitest-plugin v5.7.1 - teardown
```

`packages/runtime/__bench__/` has four files; `cross-shard-fanout.bench.ts` is **not** in the failing list, the other three are. `@codspeed/vitest-plugin` is pinned at 5.7.1 in `pnpm-workspace.yaml` (~line 427; read the comment beside it about `vitest/runners`). The error only appears under CodSpeed's instrumented ("analysis") runner, which CI enables; a plain local `vitest bench` may pass.

## Steps

1. Reproduce locally. Read how CI invokes it (`codspeed.yml` and the `test:bench` script in `packages/runtime/package.json` / `project.json`). The CodSpeed runner switches to analysis mode from environment (read `node_modules/.pnpm/@codspeed+vitest-plugin@5.7.1*/node_modules/@codspeed/vitest-plugin/dist/` and `@codspeed/core` for the variable, e.g. `CODSPEED_ENV` / runner mode) — set what is needed to take the `runAnalysisBench` path without the real CodSpeed service, build `@lunora/runtime...` first, and run only the runtime bench files. If analysis mode cannot run locally at all (needs valgrind or a Linux-only binary), reproduce by reading: open `analysis.mjs` `runAnalysisBench` and `optimizeFunction` and determine exactly which value it calls as `fn`.
2. Find the cause by comparing the three failing files with the passing one: what do they pass to `bench(...)` that the analysis runner does not accept? Candidates: `bench(name, options, fn)` argument order, a `bench` with only an options object, `bench.skip/todo/each`, a bench whose function is produced by a helper that returns something other than a function, or a hook-only suite. State the cause with file:line in the bench file and file:line in the plugin.
3. Fix it in the bench files (preferred — keep the same measurements), or in config if the cause is configuration. Do not delete or skip a benchmark, do not disable the job, and do not bump or patch the plugin unless the cause is a plugin bug with no bench-side fix — then STOP.
4. Check the other packages for the same pattern so the job does not just fail on the next package: `rg -l "bench\(" --glob '**/__bench__/**' packages | head -60` and apply the same correction wherever the identical construct appears.
5. Verify: the runtime bench files run to completion in the mode from step 1 (or, if only readable, in plain `vitest bench` mode plus a written argument why the analysis runner now gets a function); `lint:eslint` and `lint:types` for `@lunora/runtime` (and any other touched package).

### Repo conventions that apply (from the repo's AGENTS.md — you have not read it, so they are inlined)

- TypeScript, ESM, `"moduleResolution": "bundler"`: relative imports have **no** file extension (`from "./foo"`, never `"./foo.js"`).
- Never mix a default export with named exports in one file. More than one export ⇒ named only.
- This is a pre-release (`1.0.0-alpha.*`) line: do **not** keep backward-compat shims or deprecated aliases; change the behaviour and update every call site.
- Comments say _why_ (a constraint or invariant), never restate the code or record history.
- An `eslint-disable` must be line-scoped, name the rule, and give a reason after `--`. Never add a file-level disable. Never skip or silence a test, type error or lint rule to get green.
- Tests are Vitest, live in the package's `__tests__/`, and **wait on a milestone, never on a clock** (no `sleep`, no real `setTimeout` waits). Existing tests start with `expect.assertions(n)`; match that.
- **A test must fail without the fix.** After writing a test, temporarily revert your fix, run the test, confirm it goes red, then restore the fix. Report that you did this.
- If you fix by hand: run Prettier before ESLint.
- Never run `pnpm -r run test`, never `pnpm run test:workerd`, never `pnpm run build:packages` (other sessions share this machine; those have crashed it). Use the single-package commands below.
- Never kill a process by name/pattern. Never `git add -A` / `git commit -a` / `git stash`; stage explicit paths.

## Scope

**In scope**: `packages/*/__bench__/**`, a package's vitest bench config, `codspeed.yml` only if the invocation itself is wrong. **Out of scope**: source code under `packages/*/src`; benchmark thresholds; the CodSpeed dashboard.

## Git workflow

- Branch: `ci/fix-runtime-benchmarks`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `ci(runtime): make the bench files run under codspeed`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- The failure is a bug or incompatibility in `@codspeed/vitest-plugin` 5.7.1 / vitest with no bench-side fix: STOP and report the exact incompatibility and the version that fixes it, if one exists.
- The failing construct was introduced by a recent commit on alpha that a simple revert would fix: report the commit (`git log --oneline -8 origin/alpha -- packages/runtime/__bench__ packages/runtime/vitest.config.ts pnpm-workspace.yaml`) and fix forward, not by reverting.
