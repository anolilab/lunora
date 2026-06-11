# Plan 003: Extend the clean-machine smoke to scaffold and build every template

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 491e6314..HEAD -- scripts/clean-machine-smoke.sh templates/ packages/cli/src/commands/init/`
> Note: a recent refactor moved the init command from `commands/init.ts` to
> `commands/init/{handler,index}.ts` (cerebro v3 lazy structure). The
> `cirrus init` CLI behavior is unchanged. On mismatches with "Current state",
> STOP.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED (new CI surface can be flaky; no production code changes)
- **Depends on**: none (102 is unrelated; can run in parallel)
- **Category**: tests / dx
- **Planned at**: commit `491e6314`, 2026-06-11 (drift-baseline bumped after the cerebro v3 CLI restructure; smoke script itself unchanged)

## Why this matters

Template quality is currently verified only statically:
`tests/vis-templates/__tests__/templates.test.ts` checks `package.json`
invariants, and `scripts/clean-machine-smoke.sh` scaffolds **one** template
(`vite`) and runs codegen — it never installs the scaffold's framework deps or
runs its build. The cost of this gap is already on record: HEAD commit
`999c9e1` discovered, via manual smoke testing, that the SvelteKit class-B
composition "does not survive a real build" (`@sveltejs/adapter-cloudflare`
clobbers the wrangler `main` the Cirrus composition wrote). A scripted
scaffold→install→build matrix over all 8 templates makes that class of
breakage visible the day it happens instead of at release time.

## Current state

- `scripts/clean-machine-smoke.sh` (126 lines) — the existing "Phase 5
  verification gate". What it does today:
  - packs 4 workspace packages into tarballs:
    `for pkg in cirrus-cli cirrus-codegen cirrus-config cirrus-vite` (line 46),
  - installs the CLI flat in a scratch dir with `file:` overrides for
    `@cirrus/codegen` (around line 69),
  - runs `cirrus init -t vite --from "$REPO_ROOT/templates"` (line 96) — the
    `--from` flag copies templates from disk so the script is
    offline-deterministic (no giget network fetch),
  - runs `cirrus codegen` in the scaffold and asserts `_generated` output
    (lines 112–118).
  - Its header comment explicitly lists as NOT covered: installing the
    scaffold's `@cirrus/*` runtime deps ("none of them are published yet")
    and booting/building the app.
- Root `package.json` script: `"test:clean-machine": "./scripts/clean-machine-smoke.sh"`.
- `templates/` — 8 templates: `astro, nuxt, react-router, solid-start,
  standalone, sveltekit, tanstack-start, vite`. Their `@cirrus/*` deps use the
  `^0.0.0` registry contract (never `workspace:*`), so installing a scaffold
  requires `pnpm` **overrides mapping every `@cirrus/*` dep to a packed
  tarball** — the same technique the script already uses for codegen.
- Known-broken at planning time: the **sveltekit** template's single-worker
  build (class-B blocker, commit `999c9e1`). Expect its build step to fail;
  the matrix must support an expected-fail list rather than going red forever.
- Conventions: bash scripts use `set -euo pipefail` and verbose `echo "==> …"`
  progress lines (match the existing script's style).

## Commands you will need

| Purpose            | Command                                  | Expected on success                |
| ------------------ | ---------------------------------------- | ---------------------------------- |
| Install            | `pnpm install`                           | exit 0                             |
| Build all packages | `pnpm run build:packages`                | exit 0 (needed before packing)     |
| Existing smoke     | `pnpm run test:clean-machine`            | exit 0 (baseline — run it FIRST)   |
| New matrix         | `pnpm run test:templates` (added here)   | exit 0; per-template PASS/XFAIL log |

## Scope

**In scope**:

- `scripts/template-build-smoke.sh` (create — a sibling of, not a rewrite of,
  `clean-machine-smoke.sh`)
- Root `package.json` — add one script entry: `"test:templates": "./scripts/template-build-smoke.sh"`
- Optionally `.github/workflows/test.yml` — ONLY if Step 6 applies; otherwise skip.

**Out of scope** (do NOT touch):

- `scripts/clean-machine-smoke.sh` — keep the fast existing gate intact.
- `templates/**` and `packages/**` — if a template fails to build, that is a
  *result to record*, not something this plan fixes.
- The giget/network fetch path — stay offline-deterministic via `--from`.

## Git workflow

- Branch: `test/template-build-smoke` off `alpha`.
- Commit style: conventional commits, e.g. `test(templates): add scaffold+install+build smoke matrix`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Baseline

Run `pnpm run build:packages` then `pnpm run test:clean-machine`. Read
`scripts/clean-machine-smoke.sh` fully — you will reuse its tarball-packing,
override-injection, and `init --from` techniques.

**Verify**: existing smoke exits 0. If it fails on a clean tree, STOP.

### Step 2: Script skeleton

Create `scripts/template-build-smoke.sh` with the same defensive header
(`set -euo pipefail`, scratch dir + `trap … EXIT` cleanup, verbose `echo`
progress) as the existing script. Define:

```sh
TEMPLATES=(astro nuxt react-router solid-start standalone sveltekit tanstack-start vite)
# Templates whose BUILD is expected to fail; scaffold+install must still pass.
# sveltekit: class-B composition blocker — adapter-cloudflare clobbers the
# composed worker entry (see commit 999c9e1). Remove when fixed.
XFAIL_BUILD=(sveltekit)
```

Derive `TEMPLATES` dynamically from `ls "$REPO_ROOT/templates"` instead of
hard-coding if straightforward.

### Step 3: Pack ALL workspace packages once

Unlike the existing script (4 packages), pack **every** publishable package a
template might depend on: run `pnpm --filter "./packages/*" exec pnpm pack --pack-destination "$PACK_DIR"`
(or loop `packages/*/` like the existing script does). Build first
(Step 1 already did `build:packages`). Then build a shell function that, given
a scaffold dir, reads its `package.json` `@cirrus/*` deps and writes a
`pnpm.overrides` block mapping each to its `file:` tarball — extend the
technique at `clean-machine-smoke.sh:69` (it already does this for
`@cirrus/codegen`; you are generalizing it). A small embedded `node -e`
snippet editing the scaffold's `package.json` is the simplest robust approach.

**Verify**: after packing, `ls "$PACK_DIR"/*.tgz | wc -l` ≥ the number of
directories under `packages/`.

### Step 4: The per-template loop

For each template: `cirrus init -t <name> --from "$REPO_ROOT/templates"` into
a fresh scratch subdir (reuse the CLI-install technique from the existing
script), inject overrides (Step 3), then inside the scaffold:

1. `pnpm install` — must succeed for **every** template,
2. `pnpm run build` (skip with a logged notice if the template has no `build`
   script) — must succeed unless the template is in `XFAIL_BUILD`,
3. record `PASS` / `XFAIL (expected)` / `XPASS (unexpectedly passed — remove from XFAIL)` / `FAIL`.

Accumulate results; print a summary table at the end; exit non-zero if any
template hit `FAIL`, or if an `XFAIL` entry passed (`XPASS` — forces the list
to stay honest).

**Verify**: `./scripts/template-build-smoke.sh` runs the full matrix and the
summary lists all 8 templates.

### Step 5: First real run — calibrate XFAIL

Run the matrix. For each template that fails its build, read enough of the
error to classify: environment problem (fix your env / STOP) vs. genuine
template breakage (add to `XFAIL_BUILD` **with a one-line reason comment and
this plan's reference**). `sveltekit` is pre-listed; others discovered here
get the same treatment. Do not silently grow the list — every entry needs its
reason comment.

**Verify**: `pnpm run test:templates` exits 0 with the calibrated list.

### Step 6 (conditional): CI wiring

Open `.github/workflows/test.yml`. If it has an obvious job structure where a
long-running (10–25 min) job can be added without restructuring (e.g. a
separate job with `if: github.event_name == 'push'` or a nightly `schedule:`),
add a `test:templates` job mirroring the setup steps of an existing job
(checkout, pnpm/node setup, install). If the workflow is complex or uses
unfamiliar reusable workflows, SKIP this step and note in `plans/README.md`
that CI wiring is a follow-up — a runnable local script is the deliverable;
mis-wired CI is worse than none.

**Verify** (only if done): `pnpm exec prettier --check .github/workflows/test.yml`
exits 0 and the YAML parses (`node -e "require('js-yaml')"` is NOT available —
use `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/test.yml'))"`).

## Test plan

The script is the test. It must demonstrably catch breakage: as a one-off
check (then revert), introduce a syntax error into
`templates/standalone/cirrus/schema.ts`, rerun the matrix for just that
template if your script supports an arg filter (add `[template-name]` as an
optional positional arg — worth it for iteration speed), and confirm a `FAIL`.
Revert carefully: `templates/` had pre-existing uncommitted changes, so undo
your edit manually rather than `git checkout`.

## Done criteria

- [ ] `scripts/template-build-smoke.sh` exists, is executable (`chmod +x`), and `pnpm run test:templates` exits 0
- [ ] Summary output lists all templates with PASS/XFAIL status; XFAIL entries each have a reason comment in the script
- [ ] Tamper check demonstrated a FAIL and was reverted
- [ ] `scripts/clean-machine-smoke.sh` is untouched (`git diff --stat` confirms)
- [ ] No changes outside the in-scope list (`git status`)
- [ ] `plans/README.md` status row updated (note whether Step 6 CI wiring was done or deferred)

## STOP conditions

Stop and report back (do not improvise) if:

- The baseline `test:clean-machine` fails on an unmodified tree.
- `cirrus init --from` does not support one of the template names (the CLI's
  `-t` mapping diverges from the `templates/` directory names) — report the
  mapping mismatch instead of guessing.
- More than 3 of 8 templates fail `pnpm install` (not build — install): the
  tarball/override approach has a systemic problem; report the errors.
- A template's build requires network access, credentials, or a real
  Cloudflare account to complete.

## Maintenance notes

- Every `XFAIL_BUILD` entry is tracked debt: when the class-B composition
  blocker (commit `999c9e1`) is resolved, the matrix turns the fix's
  verification into `XPASS` → contributor removes the entry.
- This matrix is install-heavy (~minutes per template). Keep it out of the
  pre-commit path; nightly or on-demand CI is the right cadence.
- When a 9th template lands, dynamic discovery (Step 2) covers it
  automatically; the reviewer should confirm the summary shows it.
