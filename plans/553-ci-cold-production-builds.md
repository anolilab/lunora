# Plan 553 — Measure, then stop rebuilding the production build cold in each CI job

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** TODO (plan only — the finding is inferred from workflow structure; the first deliverable is a measurement)
**Priority / effort / risk:** P3 / M / LOW. **Category:** ci / dx.

## 0. Headline finding (inferred, unmeasured)

On a PR that touches packages, several `test.yml` jobs run `pnpm run build:packages:prod` independently
(`test.yml:806`, `:864`, `:915`, `:1033`; `:806` is inside the per-template matrix, so it runs once per
template leg), and the vis task cache is only enabled in the `test` and coverage jobs
(`enable-vis-cache: "true"` at `:99`, `:247`). `vis.config.ts:51-55` declares `build:prod` cacheable
with `outputs: ["{projectRoot}/dist"]`. If those jobs start cold, each pays a full production build.

## 1. What to measure first (workstream 0, required before any change)

- From the last 10 `Tests` runs on PRs touching `packages/**`, the wall time of the
  "Build packages (production artifacts)" step per job and per template leg (`gh run view --log` or the
  Actions API timing per step).
- Whether `build:prod` in those jobs hits the vis cache at all (log lines from vis).
- Total runner minutes spent on `build:packages:prod` per PR.

Record the numbers in this plan. If the total is under ~10 runner-minutes per PR, mark this plan
REJECTED with the numbers.

## 4. Design options (pick after measuring)

- **A.** One `build-prod` job uploads `packages/*/dist` as an artifact; the size, startup and template
  jobs download it (`needs: build-prod`). Simple; adds an artifact round trip.
- **B.** Turn on `enable-vis-cache` in those jobs so `build:prod` restores from the cache keyed on inputs.
  Least YAML; depends on cache hit rates across jobs (prod vs dev outputs share `dist`).
- **C.** Leave as is if measurement shows it is cheap.

## 5. Workstreams

0. (S) Measurement above.
1. (M) Implement A or B; keep `dist:check` semantics (production-clean dist) intact.

## 6. Platform parity

Not applicable.

## 7. Gates

| Phase | Gate                                                                    |
| ----- | ----------------------------------------------------------------------- |
| 0     | numbers recorded                                                        |
| 1     | same jobs green; measured minutes per PR drop; jactionlint/zizmor clean |

## 8. Risks

- **Risk:** sharing `dist` between dev-built and prod-built jobs (a dev build keeps `jsxDEV`, which
  broke Next prerender before — see the `templates-full` comment in `nightly.yml`). Never let a dev
  `dist` satisfy a prod consumer.

## 9. Open questions

1. Is the templates matrix leg count expected to grow (it is read from `templates/`)?
