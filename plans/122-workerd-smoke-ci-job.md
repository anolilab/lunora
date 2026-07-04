# Plan 122: Give the gated workerd integration suites a scheduled CI smoke job

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- .github/workflows/ packages/do/vitest.config.ts packages/d1/vitest.config.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED — the suites are gated off precisely because they "currently
  hang the runner"; this plan's design (separate, non-required, per-suite
  timeouts, continue-on-error rollout) contains that risk
- **Depends on**: plans/121-wire-d1-and-studio-tests.md (same workflow file —
  land 121 first to avoid conflicts)
- **Category**: tests
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

Ten integration suites run against **real workerd** via
`@cloudflare/vitest-pool-workers` — including the sync engine
(`do/__tests__/workerd/sync-engine.workerd.test.ts`), DO eviction, the relay
tier, scheduler alarms, storage, and the client↔worker integration. They are
gated behind `LUNORA_WORKERD_TESTS=1` and that env is set **nowhere in CI**,
so the layer closest to production runs only when a developer remembers to
opt in manually. Regressions that only manifest under real workerd (alarm
timing, hibernation, eviction, WS upgrade behavior) are invisible to every
merge. The historical blockers are known and both have known shapes: (a) v8
coverage collects via `node:inspector`, which workerd lacks → run with
coverage off; (b) some suites hang → per-suite timeouts, a package allowlist,
and a non-required scheduled job so a hang never blocks a PR.

## Current state

- Gate definition (`packages/do/vitest.config.ts:37-46`, same pattern in d1,
  runtime, scheduler, storage, client):

    ```
     * Gated by `LUNORA_WORKERD_TESTS=1` because the pool-workers
     * integration requires unrestricted localhost-loopback access
     * between workerd and the test host. Sandboxed CI environments …
     * On a developer workstation set the env variable to run the suite:
     *     LUNORA_WORKERD_TESTS=1 pnpm --filter @lunora/do test
    ```

    With the env set, the config adds a `workerd` vitest project
    (`cloudflareTest({ main: …, wrangler: { configPath: … } })`) alongside the
    `mocks` project.

- CI comment (`.github/workflows/test.yml:89-95`): "workerd is intentionally
  OFF … the workerd-pool suites currently hang the runner. They run in a
  dedicated job once fixed."

- The gated suites (verify the live set with
  `grep -rln "workerd" packages/*/vitest.config.ts` and
  `ls packages/*/__tests__/workerd packages/storage/__tests__/*.integration.* packages/client/__tests__/*.integration.* 2>/dev/null`):
  `do` (sync-engine, shard-do, eviction, relay-shape, relay-whisper),
  `d1` (d1-client.workerd), `runtime` (create-worker.workerd),
  `scheduler` (scheduler-do.workerd), `storage` (create-storage.integration),
  `client` (lunora-client.integration).

- Environment note: real workerd + Miniflare **does** boot in the maintainer's
  sandbox (verified previously via `LUNORA_WORKERD_TESTS=1`), and GitHub-hosted
  runners allow localhost loopback. The "sandboxed CI" caveat in the config
  comment refers to restricted environments, not github.com runners.

- Repo YAML style: fully quoted keys, pinned action SHAs with a version
  comment — copy from the existing `test` job in `test.yml`.

## Commands you will need

| Purpose                   | Command                                                                              | Expected on success     |
| ------------------------- | ------------------------------------------------------------------------------------ | ----------------------- |
| Build a pkg + deps        | `pnpm --filter "@lunora/<pkg>..." run build`                                         | exit 0                  |
| One workerd suite locally | `LUNORA_WORKERD_TESTS=1 pnpm --filter "@lunora/<pkg>" run test -- --project workerd` | pass or a recorded hang |
| YAML parse                | any local YAML parse of `test.yml`                                                   | parses                  |

## Scope

**In scope**:

- `.github/workflows/test.yml` (or a new `.github/workflows/workerd.yml` —
  prefer a separate file so a hang never delays the main test workflow)
- The stale comment block in `test.yml`
- Per-suite vitest `testTimeout`/`hookTimeout` for the workerd projects,
  ONLY in `vitest.config.ts` files, if a suite needs it

**Out of scope**:

- Fixing any hanging suite's root cause (triage output feeds a follow-up).
- The root `package.json` test filters, coverage config, branch-protection
  required checks (this job must NOT become required).
- The `LUNORA_WORKERD_TESTS` gate itself (developers' default stays off).

## Git workflow

- Branch: `advisor/122-workerd-smoke-job`
- Suggested commit: `ci: scheduled workerd integration smoke job`.

## Steps

### Step 1: Local triage — which suites are green today?

For each package in {do, d1, runtime, scheduler, storage, client}:

```
pnpm --filter "@lunora/<pkg>..." run build
timeout 600 env LUNORA_WORKERD_TESTS=1 pnpm --filter "@lunora/<pkg>" run test
```

Record per package: green / failing (which tests) / hang (killed by timeout).
This produces the **allowlist** for Step 2. Note: run serially, not in
parallel — pool-workers instances compete for ports.

**Verify**: a written triage table with all six rows filled.

### Step 2: Add the workflow

Create `.github/workflows/workerd.yml`, style-matched to `test.yml`
(harden-runner, pinned checkout, the `anolilab/workflows/step/node` setup with
`node-version: "22.15"`):

- Triggers: `schedule` (daily, e.g. `cron: "17 4 * * *"`) + `workflow_dispatch`
  (manual). NOT on pull_request — a hang must never block a PR.
- One job per **allowlisted** package from Step 1 (matrix over package names),
  `timeout-minutes: 20` per job, `fail-fast: false`.
- Steps per job: checkout → setup → `pnpm --filter "@lunora/<pkg>..." run build`
  → `LUNORA_WORKERD_TESTS=1 pnpm --filter "@lunora/<pkg>" run test`.
- Coverage stays off (these package `test` scripts don't collect coverage;
  the `test:coverage` variants are what do — do not use them here).
- Non-allowlisted packages: list them in a comment at the top of the file
  with the observed failure mode from Step 1 ("excluded: <pkg> — <symptom>").

Update `test.yml`'s comment block (lines ~89-95): workerd suites now run in
the scheduled `workerd.yml`; remove "once fixed" for the allowlisted set.

**Verify**: YAML parses; job names and the matrix match the Step 1 allowlist.

### Step 3 (conditional): per-suite timeouts

If Step 1 showed a suite that passes but is slow/flaky near vitest's default
timeout, raise `testTimeout` **inside that package's workerd project block
only** (see the existing CI-conditional pattern in
`packages/do/vitest.config.ts:51-54`). Do not touch the mocks projects.

**Verify**: re-run that suite locally with the gate on → green.

## Test plan

The deliverable is CI wiring plus the triage table. No new test content. The
allowlist criterion is strict: a package enters the matrix only if Step 1 ran
it green locally.

## Done criteria

- [ ] Triage table for all 6 packages in the final report
- [ ] `.github/workflows/workerd.yml` exists, schedule+dispatch only,
      matrix = exactly the green allowlist, per-job timeout ≤ 20 min
- [ ] `test.yml` comment updated; YAML parses
- [ ] No suite added that wasn't green in Step 1
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- **Zero** packages pass Step 1 locally (environment can't run workerd at all
  — the plan is unactionable here; report the boot error).
- A suite passes locally but you have reason to believe it needs >2 GB memory
  or Docker-only facilities on runners (note it, exclude it, report).
- Updating `test.yml`'s comment conflicts with plan 121's edits (rebase onto
  121's branch or report the conflict).
- You are tempted to "quickly fix" a hanging suite — don't; record the
  symptom and move on (fixing hangs is explicitly a follow-up).

## Maintenance notes

- The scheduled job is a canary, not a gate. If it stays green for a few
  weeks, a follow-up can promote the allowlisted suites into the PR-path
  `test` job behind the same env var.
- Every new `__tests__/workerd/**` suite should be run once under
  `workflow_dispatch` before relying on the nightly signal.
- The excluded-suite comment in `workerd.yml` is the living hang-triage list —
  keep it updated as suites are repaired.
