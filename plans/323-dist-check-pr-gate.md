# Plan 323 — Run `dist:check` on pull requests, where the regression it catches is still cheap to fix

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO

> **Executor instructions**: follow this file top to bottom, run every verification
> command, stop on any §8 STOP condition, and update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first):**
> `git diff --stat 70b7451b5..HEAD -- .github/workflows CLAUDE.md`

## 0. Headline finding

`CLAUDE.md:42` tells contributors that "`api:check` and `dist:check` have their own CI
jobs and fail on changes the linters cannot see". `api:check` does — `.github/workflows/lint.yml:223`.
`dist:check` does not. Its only occurrence is `.github/workflows/semantic-release.yml:127`,
inside the release job, which runs on **push to `main`/`alpha`/`next`/`beta`** — after
merge.

The regression it exists to catch is described one comment above it
(`semantic-release.yml:118-122`): a development build shipping the React dev JSX
runtime, "which crash consumers whose bundler stubs `react/jsx-dev-runtime` in
production. That is exactly what `@lunora/react@1.0.0-alpha.31` did on npm."

So today that class of defect merges green and first fails inside the release job —
the one job the workflow deliberately marks non-cancellable
(`semantic-release.yml:19-21`), because interrupting it leaves tags without channel
notes. The failure mode is: PR merges, release aborts, `alpha` is blocked until a fix
lands, and the author has moved on.

## 1. Current state (audit)

- `.github/workflows/semantic-release.yml:127` — `"run": "pnpm run dist:check"`, the
  only occurrence in `.github/workflows/`.
- `.github/workflows/semantic-release.yml:5-9` — the workflow triggers on push to the
  release branches.
- `.github/workflows/semantic-release.yml:19-21` — the job is explicitly
  non-cancellable.
- `.github/workflows/lint.yml:223` — `pnpm run api:check`, the sibling gate that _is_
  a PR job. **This job is the structural template for the new one.**
- `.github/workflows/lint.yml:220` and `.github/workflows/test.yml:89` — every existing
  PR job builds `--development`. Nothing on a PR currently produces a production build,
  which is why this gate costs CI minutes rather than being free.

## 2. Existing seams (do not reinvent)

- The `api-surface` job in `lint.yml` — same shape: build, then run one check script.
  Copy its structure, its runner, its setup steps, and its `files-changed` gating.
- The repo's existing `files-changed` output (used by `api-surface`) — reuse it so the
  job is skipped on docs-only PRs rather than adding a new path filter.
- `pnpm run build:packages:prod` — the production build the check needs. Do not invent
  a narrower build.

## 3. The behavioural contract to preserve

1. `dist:check` itself is unchanged. This plan changes _when_ it runs.
2. The release job keeps its copy. A PR gate is not a substitute — a release can be
   cut from a commit that never went through a PR.
3. PR wall-clock must not regress meaningfully for changes that cannot trip the gate.
   Gate the job on packages having changed.

## 4. Design decisions

**Chosen: a new job in `lint.yml`, mirroring `api-surface`, gated on the existing
packages-changed output.** Rejected: adding `dist:check` to an existing job — every
current PR job builds `--development`, and a production build inside one of them
would either double its build time or change what that job verifies.

**Chosen: fix `CLAUDE.md:42` in the same change.** Whichever way the decision goes,
the doc and the pipeline must agree; a doc that overstates the gates is how a
contributor concludes a defect class is covered when it is not.

## 5. Workstreams

### WS1 — Add the job (S)

In `.github/workflows/lint.yml`, add a `dist-production` job modelled on
`api-surface`:

- same runner and setup steps (Node version matrix entry, pnpm install with the repo's
  existing cache configuration — copy, do not compose from memory),
- `pnpm run build:packages:prod`,
- `pnpm run dist:check`,
- gated on the same `files-changed` condition `api-surface` uses.

**Verify:** `pnpm exec actionlint .github/workflows/lint.yml` if actionlint is
available; otherwise at minimum a YAML parse (`node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/lint.yml','utf8'))"`).

### WS2 — Prove the gate can fail (S)

A gate nobody has seen fail is a gate nobody knows works. Locally:

1. `pnpm run build:packages:prod && pnpm run dist:check` → exits 0.
2. Deliberately break it — the cheapest reproduction is to run `dist:check` against a
   `--development` build (`pnpm run build:packages && pnpm run dist:check`) and confirm
   it exits non-zero, which is precisely the alpha.31 shape.
3. Restore with a clean production build.

Record both outcomes in §9.

### WS3 — Correct `CLAUDE.md` (S)

Update the CI-gates note at `CLAUDE.md:42` so the listed PR gates match reality after
WS1.

## 6. Platform parity

Not applicable — CI configuration.

## 7. Phasing & ordering

| Phase | Work | Gate                                                   |
| ----- | ---- | ------------------------------------------------------ |
| 0     | WS2  | `dist:check` demonstrably fails on a development build |
| 1     | WS1  | workflow parses; the job appears in the PR check list  |
| 2     | WS3  | `CLAUDE.md`'s gate list matches `.github/workflows/`   |

WS2 first: confirm the check detects the defect before wiring CI minutes to it.

## Commands you will need

| Purpose             | Command                                           | Expected                                              |
| ------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| Production build    | `pnpm run build:packages:prod`                    | exit 0                                                |
| The gate            | `pnpm run dist:check`                             | exit 0 after a prod build; non-zero after a dev build |
| Dev build (for WS2) | `pnpm run build:packages`                         | exit 0                                                |
| Workflow lint       | `pnpm exec actionlint .github/workflows/lint.yml` | exit 0 (skip if not installed)                        |
| Format              | `pnpm run lint:prettier:fix`                      | exit 0                                                |

## Scope

**In scope:**

- `.github/workflows/lint.yml`
- `CLAUDE.md` (the CI-gates note only)

**Out of scope:**

- `.github/workflows/semantic-release.yml` — the release-side check stays exactly where
  it is.
- `scripts/` — `dist:check`'s implementation is not changing.
- Any other CI job's build mode. Do not switch an existing job from `--development` to
  `--production` to piggyback; that changes what those jobs verify.

## Git workflow

- Branch: `advisor/323-dist-check-pr-gate`
- Suggested commit: `ci: run dist:check on pull requests`

## Test plan

No unit tests. The evidence is:

1. The WS2 pair — dev build fails the check, prod build passes it.
2. The job appears in the PR's check list and passes on a no-op PR.
3. The job is skipped on a docs-only PR (confirm the `files-changed` gating actually
   excludes it, rather than assuming).

## Done criteria

- [ ] `grep -rn "dist:check" .github/workflows/` returns **two** matches (`lint.yml` and `semantic-release.yml`)
- [ ] `pnpm run build:packages:prod && pnpm run dist:check` exits 0 locally
- [ ] `pnpm run build:packages && pnpm run dist:check` exits non-zero locally (WS2 evidence, recorded in §9)
- [ ] `CLAUDE.md`'s CI-gates note matches the workflows
- [ ] `plans/README.md` row updated

## 8. Risks & STOP conditions

- **STOP** if `pnpm run dist:check` passes against a `--development` build. Then the
  check does not detect the regression it is documented to detect, and the real finding
  is in `scripts/` — report it instead of wiring a gate that cannot fail.
- **STOP** if `build:packages:prod` takes long enough on CI to dominate PR wall-clock
  (compare against the existing `api-surface` job's duration). Report the numbers and
  let the maintainer decide between a PR gate and a merge-queue gate.
- **Risk:** a postinstall check failure turns every CI job red in its setup step, and
  the cause is invisible in the job that reports it. If the new job goes red for a
  reason unrelated to `dist:check`, look at the root `postinstall` chain before
  debugging the job.
- **Risk:** duplicated setup steps drift from `api-surface`'s. Copy them verbatim and
  keep the two adjacent in the file so the next editor sees both.

## 9. Record (fill in during execution)

- `dist:check` after a production build: __________
- `dist:check` after a development build: __________ (expected: non-zero, naming the
  dev artifact)
- `api-surface` job duration vs the new `dist-production` job duration: __________
