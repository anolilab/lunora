# Plan 553 — Build the production packages once per Tests run and share them as an artifact

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in "STOP conditions"
> occurs, stop and report — do not improvise. Do NOT update `plans/README.md`; the reviewer
> maintains the index.
>
> **Drift check (run first)**:
> `git diff --stat 90c9b63f4..HEAD -- .github/workflows/test.yml .github/file-filters.yml`
> must print nothing. If it prints anything, STOP.

## Status

- **Priority**: P3 · **Effort**: S · **Risk**: LOW · **Category**: ci / dx
- **Depends on**: none
- **Planned at**: commit `90c9b63f4` (origin/alpha), 2026-11-12. Supersedes the 2026-11-11 draft
  (`4a7c48bfd`), which was unmeasured.
- **State**: DONE — PR anolilab/lunora#1591, all checks green (run 43242672264). Measured after:
  `build-prod` 4.9 min (2.5 build), downloads+unpack 0.4 min across 17 jobs, consumer job minutes
  104.5 → 67.6 (72.5 incl. build-prod): ~32 runner-min saved per run; artifact 6.4 MB.

## Measurement (done by the advisor, 2026-11-12)

I sampled 11 successful `Tests` runs on PRs that touched `packages/**`, run ids
43131528929 to 43224029121, and read step timings from the Actions jobs API.

| Per PR run (average of 11)                                          | Minutes                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| All job minutes in the run                                          | 270.6                                                                                             |
| Wall clock, first job start to last job end                         | 33.1                                                                                              |
| Jobs that run `pnpm run build:packages:prod`                        | 17: 13 `templates` legs, `templates-expo`, `worker-size`, `worker-startup` (plus 1 template list) |
| "Build packages (production artifacts)" across those 17 jobs        | **34.1 (12.6% of all job minutes)**; each leg takes 1.4–2.4 min                                   |
| Setup (checkout + install) in those 17 jobs, unchanged by this plan | 31.2                                                                                              |
| Longest of those jobs                                               | about 8 min. The critical path is `Test (node-24.11)` at about 18 min                             |

**Does the existing vis cache already help?** No. In run 43224029121, `Test (node-22.22)`
logged `Cache not found for input keys: vis-cache-test-22.22-…-test-…` at restore. The composite
action `anolilab/workflows/step/node` keys the vis cache on `github.job` plus the lockfile hash plus
the SHA, and saves only on `push` or same-repo PRs. `test.yml` never runs on `push`, so `alpha`
never stores an entry, and a PR's first run starts cold. The `[cache]` hits in that log come from
earlier tasks in the same job.

**Decision: fix it**, using one `build-prod` job that uploads `packages/*/dist` as an artifact.
The share is above the 10% threshold and no existing cache covers it.

**Rejected alternative: enable `enable-vis-cache` on the 17 jobs.** A PR's first run still
misses, because `alpha` never saves. The 17 jobs run in parallel within a run, so none can warm
another. The key is per `github.job`, so `templates`, `worker-size` and `worker-startup` would
each need their own warm entry. The cache would help only a re-push of the same PR.

**Expected effect, to be confirmed from the PR's own run:**

- Gross: removes 34.1 build-minutes.
- Adds one build (about 2.4 min), one job setup (about 1.8 min) and 17 downloads plus extracts
  (about 0.2–0.4 min each).
- Net saving of about 21–24 runner-minutes per run, roughly 8–9%. Do not claim 12.6%.
- Latency: the template, size and startup jobs now start after `build-prod`, adding about 3–5 min.
  Those jobs end around 11 min, still under the 18-min critical path.

**Evidence from the audit, settled here so nobody re-audits it:**

- `test-workerd`, 22 legs at about 0.1–2.0 min each: these are DEV builds of different package
  subsets (`vis run build --query project=<pkg>`), so they cannot use a prod artifact. Left as is.
- `e2e` runs a DEV build (`pnpm run build:packages`, about 1.9 min). A prod artifact cannot replace
  it. Left as is.
- `client-size` (about 0.8 min) and `studio-size` (about 1.0 min) build prod subsets and could
  consume the artifact later. Deferred, to keep this change small.

## Why this matters

Every Tests run on a package PR builds the same production packages 17 times from scratch, each
time in a separate job. That costs about 34 runner-minutes per run. It also competes for runner
concurrency with every other open PR. Building once and sharing the output cuts about 21–24
runner-minutes per run. Correctness does not change: the build still runs from scratch in every
run, and is still checked.

## Current state (`.github/workflows/test.yml` at `90c9b63f4`)

- `files-changed` (lines 21–53) exposes outputs `packages`, `templates`, `templates_expo`,
  `worker_size`, `worker_startup` (among others). `.github/file-filters.yml` includes
  `.github/workflows/test.yml` in all of these filters, so editing test.yml triggers every job.
- The four consumers, each with this step (comments differ per job):
    ```yaml
    - "name": "Build packages (production artifacts)"
      "run": "pnpm run build:packages:prod"
    ```
    - `templates` (line ~766): `"if": "needs.files-changed.outputs.templates == 'true' && needs.templates-matrix.outputs.list != '[]'"`,
      `"needs": ["files-changed", "templates-matrix"]`, step at ~806, Node `22.23.4`.
    - `templates-expo` (~834): `"if": "needs.files-changed.outputs.templates_expo == 'true'"`, `"needs": "files-changed"`, step at ~864.
    - `worker-size` (~885): `"if": "needs.files-changed.outputs.packages == 'true' || needs.files-changed.outputs.templates == 'true' || needs.files-changed.outputs.worker_size == 'true'"`, step at ~915.
    - `worker-startup` (~1004): `"if": "needs.files-changed.outputs.packages == 'true' || needs.files-changed.outputs.templates == 'true' || needs.files-changed.outputs.worker_startup == 'true'"`, step at ~1033.
- `test-required-check` (~1291) lists every job in `needs` and fails on any `failure`/`cancelled`.
- What consumers read: `scripts/template-build-smoke.sh` packs each `packages/*/dist` and itself
  runs `scripts/check-dist-production.js` (it fails on a dev build).
  `scripts/check-worker-size.js` and `scripts/check-worker-startup.js` read
  `packages/cli/dist/bin.mjs` and the workspace `dist/`. `vis.config.ts` declares
  `build:prod` outputs as `{projectRoot}/dist` only, and the studio extras
  (`dist/styles.css`, `dist/standalone`) also live under `dist/`. Every `type:package` project is
  under `packages/` (61 of them), so `packages/*/dist` is the complete output.
- Style: JSON-style YAML. Every key and string value is double-quoted, jobs are indented 4
  spaces, steps 12, and step keys 14. Actions are pinned by full SHA with a trailing version
  comment. Copy these pins exactly; they are already used in this file:
    - `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2` (supports `overwrite`)
    - `actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2`

## Commands you will need

| Purpose    | Command (from the worktree root)                                    | Expected                                                  |
| ---------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| Install    | `pnpm install`                                                      | exit 0                                                    |
| actionlint | `actionlint .github/workflows/test.yml`                             | no output, exit 0                                         |
| yamllint   | `uvx yamllint -c .yamllint.yaml .github/workflows/test.yml`         | exit 0                                                    |
| zizmor     | `uvx zizmor --config .github/zizmor.yml .github/workflows/test.yml` | no new findings vs `git stash`-free baseline (see Step 4) |
| oxfmt      | `pnpm exec oxfmt --check .github/workflows/test.yml`                | exit 0                                                    |

You cannot run CI locally; the PR's own run is the functional test (the reviewer handles it). Do
NOT run `pnpm run build`, `pnpm run build:packages`, `pnpm run test`, `pnpm run test:workerd` or
`pnpm -r …`.

## Scope

**In scope:** `.github/workflows/test.yml` only.

**Out of scope:** `.github/file-filters.yml`, `nightly.yml` and every other workflow, the
`e2e`, `test-workerd`, `client-size`, `studio-size` jobs, any script, any package.

## Git workflow

Branch `ci/improve-553-share-production-build` is checked out. One commit:
`ci(test): build production packages once and share them as an artifact`. Header ≤ 100 chars,
body lines ≤ 100 chars (say: 17 jobs each rebuilt the prod packages, ~34 runner-min per run; vis
cache misses on first runs because Tests never runs on push). End the body with your harness's
Co-Authored-By line. Stage the one file explicitly; no `git add -A`, no `git stash`, no
`--no-verify`. Do not push.

## Steps

### Step 1: Baseline the linters

`pnpm install`. Run actionlint, yamllint, zizmor and oxfmt (table above) on the UNCHANGED file and
save each output into the report (zizmor may already report findings; you only need to add none).
If `uvx` cannot run a tool, note it and continue.

### Step 2: Add the `build-prod` job

Insert this job immediately before the comment block that starts
`    # Scaffold every template, install it, add the auth-ui payload, build, typecheck.` (i.e.
after the `e2e` job's last step), separated by one blank line on each side:

```yaml
# The production build the template, Worker-size and Worker-startup jobs consume, built
# once per run instead of once per job (17 jobs, ~34 runner-minutes per run). Not the
# vis cache: Tests never runs on `push`, so `alpha` never saves one and a PR's first run
# starts cold, and parallel jobs in one run cannot warm each other. The artifact belongs
# to this run and this commit and is built from scratch here, so it cannot carry a stale
# build; `dist:check` rejects a development build before upload.
#
# `:prod` because users install the production build: the development build keeps
# `react/jsx-dev-runtime` (a Next prerender dies with `jsxDEV is not a function`) and
# measures ~25% heavier. tar keeps the CLI's executable bit, which a plain artifact drops.
#
# Keep "if" equal to the OR of its consumers' conditions (templates, templates-expo,
# worker-size, worker-startup): a consumer whose condition holds while this job is
# skipped is skipped too, silently.
"build-prod":
    "name": "Build packages (production artifacts)"
    "if": "needs.files-changed.outputs.packages == 'true' || needs.files-changed.outputs.templates == 'true' || needs.files-changed.outputs.templates_expo == 'true' || needs.files-changed.outputs.worker_size == 'true' || needs.files-changed.outputs.worker_startup == 'true'"
    "needs": "files-changed"
    "runs-on": "ubuntu-latest"
    "timeout-minutes": 30
    "steps":
        - "name": "Harden Runner"
          "uses": "step-security/harden-runner@46b06cea07f9e64621fdf066ba77ac6915163d43" # v2.22.3
          "with":
              "egress-policy": "audit"

        - "name": "Git checkout"
          "uses": "anolilab/workflows/step/checkout-with-retry@1f3a7f7e561f7690fe19dea5d2ed225def53c908" # v26.0.6

        - "name": "Setup resources and environment"
          "uses": "anolilab/workflows/step/node@1f3a7f7e561f7690fe19dea5d2ed225def53c908" # v26.0.6
          "with":
              "node-version": "22.22"
              "cache-prefix": "build-prod"
              "install-node-gyp": "true"
              "skip-playwright": "true"
              "enable-nx-cache": "false"
              "npm-version": "11"
              "run-npm-audit": "false"
              "run-signatures-audit": "false"

        - "name": "Build packages (production artifacts)"
          "run": "pnpm run build:packages:prod"

        - "name": "Check dist/ is production-clean"
          "run": "pnpm run dist:check"

        # Every `tag=type:package` project lives under packages/, and `build:prod` writes only to dist/.
        - "name": "Pack the production dist/ directories"
          "run": 'tar -cf "${RUNNER_TEMP}/packages-dist-prod.tar" packages/*/dist'

        # 3 days so re-running one failed leg the next day can still download it; `overwrite`
        # so "Re-run all jobs" can replace the earlier attempt's upload.
        - "name": "Upload the production dist/ directories"
          "uses": "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9" # v7.0.2
          "with":
              "name": "packages-dist-prod"
              "path": "${{ runner.temp }}/packages-dist-prod.tar"
              "retention-days": 3
              "if-no-files-found": "error"
              "overwrite": true
```

(The `.github/workflows/test.yml` run steps elsewhere use `|` blocks for multi-line commands;
the tar command is one line, so a quoted scalar is fine. If oxfmt/yamllint prefer a different
quoting, follow their output.)

**Verify**: `actionlint .github/workflows/test.yml` → no output.

### Step 3: Point the four consumers at the artifact

In each of `templates`, `templates-expo`, `worker-size`, `worker-startup`:

1. Add `"build-prod"` to `needs`:
    - `templates`: `"needs": ["files-changed", "templates-matrix", "build-prod"]`
    - the other three: `"needs": ["files-changed", "build-prod"]`
      Leave every `if` unchanged.
2. Replace the step `"name": "Build packages (production artifacts)"` + its `"run"` line, and the
   comment block directly above that step, with:

```yaml
# Built once by `build-prod` (see the comment there).
- "name": "Download the production dist/ directories"
  "uses": "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333" # v8.0.2
  "with":
      "name": "packages-dist-prod"
      "path": "${{ runner.temp }}"

- "name": "Unpack the production dist/ directories"
  "run": 'tar -xf "${RUNNER_TEMP}/packages-dist-prod.tar"'
```

Keep the step AFTER "Setup resources and environment", where the build used to be. Keep all
other comments, including the job-level ones; only the comment directly above the build step
moves (its reasoning now lives on `build-prod`). Exception: in `templates`, the comment above
the build step also contains nothing else you must keep, so delete it; check the other three
the same way. If a comment above a build step says something that is NOT in the new
`build-prod` comment, STOP and report it. 3. In `test-required-check.needs`, add `"build-prod",` on its own line directly after `"e2e",`.

**Verify**:

- `grep -c 'pnpm run build:packages:prod' .github/workflows/test.yml` → `1` (only in `build-prod`).
- `grep -c '"name": "packages-dist-prod"' .github/workflows/test.yml` → `5` (1 upload + 4 downloads).
- `grep -n '"build-prod"' .github/workflows/test.yml` shows the job key, 4 `needs` entries, and the
  `test-required-check` entry (6 lines).
- `git diff --stat` → only `.github/workflows/test.yml`.

### Step 4: Lint

Re-run actionlint, yamllint, zizmor and oxfmt. Each must produce no findings that were not in the
Step 1 baseline. If zizmor flags the new artifact steps (e.g. an `artipacked` / `cache-poisoning`
style audit), report the exact finding instead of suppressing it. Commit.

## Done criteria

- [ ] `git diff --stat origin/alpha..HEAD` → only `.github/workflows/test.yml`.
- [ ] The three grep counts in Step 3 hold.
- [ ] actionlint clean; yamllint, zizmor, oxfmt add no findings over baseline (or a tool was not
      runnable locally, stated).
- [ ] One commit with a conventional `ci(test): …` header.

## STOP conditions

- The drift check prints anything, or a consumer job's current text does not match "Current state".
- A comment above a removed build step carries reasoning that the `build-prod` comment does not.
- A linter reports a new finding you cannot fix without touching out-of-scope files or adding a
  suppression.
- Any step's verification fails twice.

## Verification after push (reviewer, not executor)

From the PR's own Tests run: every job passes; `build-prod` wall time; the four consumers'
download + unpack step time; sum versus the 34.1-min baseline; wall-clock of the run and of the
longest template leg versus the baseline 33.1 / ~8 min. There is no cache, so there is no warm
path to observe; a `gh run rerun` is only needed if a job flakes.

## Maintenance notes

- A new job that needs the prod packages should `needs: build-prod` and download the artifact, and
  `build-prod`'s `if` must grow to cover that job's condition.
- `client-size` and `studio-size` could switch to the artifact too (about 1.8 more minutes per run);
  they were left out to keep this change small.
- If a package ever writes `build:prod` output outside its `dist/`, the tar misses it. The vis
  cache declaration (`outputs: ["{projectRoot}/dist"]`) already assumes it does not.
- The artifact is built on Node 22.22 while the template legs run 22.23.4; the emitted JS does not
  depend on the Node version.
