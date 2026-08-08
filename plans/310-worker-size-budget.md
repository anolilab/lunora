# Plan 310 — Measure the deployed Worker's size, and gate on it

**Baseline:** `370994075` (2026-08-08)
**Status:** DONE (2026-08-08) — gate shipped, user-facing warning dropped per the §8 STOP condition.

## Phase 0 — the measurement (done first, as required)

`templates/standalone` scaffolded into a scratch dir, workspace `dist/`
symlinked in, built with `lunora build` → `wrangler deploy --dry-run --outdir`
(wrangler 4.114.0) against a **production** package build:

|                                              | raw                          | gzip                      |
| -------------------------------------------- | ---------------------------- | ------------------------- |
| **`templates/standalone` (production dist)** | **1,725,313 B — 1684.9 KiB** | **422,840 B — 412.9 KiB** |
| same, development dist (`build:packages`)    | 2,190,091 B — 2138.8 KiB     | 533,849 B — 521.3 KiB     |

One uploaded file (`server.js`). `node:zlib`'s `gzipSync` at its default level
reproduces wrangler's own `Total Upload: … / gzip: …` line to the byte, so the
two numbers are directly comparable. The out-dir also holds a 3.0 MB sourcemap
and a 1.2 MB metafile, neither of which is uploaded.

**412.9 KiB is 13.4% of the Free plan's 3 MB ceiling and 4.0% of Paid's 10 MB.**

Heaviest inputs of that bundle (esbuild metafile, bytes-in-output):

| KiB   | input                   |
| ----- | ----------------------- |
| 606.1 | `compromise@14.15.1`    |
| 242.5 | `drizzle-orm@0.45.2`    |
| 197.5 | `@lunora/shard-engine`  |
| 140.2 | `@lunora/runtime`       |
| 131.3 | `@lunora/do`            |
| 56.4  | `@lunora/observability` |

**Finding (separate from this plan): 35% of a hello-world Worker is an English
NLP library.** `compromise` is not a Lunora dependency — it arrives via
`@visulima/redact`'s `stringAnonymize`, imported by
`packages/observability/src/request-log.ts` for log redaction. Every Lunora app
carries 606 KiB raw for it. Worth its own plan: either import redact's
rule-based path without the NLP entity detector, or lazy-load it.

## 0. Headline finding

Nothing in this repo measures how large the Worker a user actually deploys is.
There is no size budget in any CI job (`.github/workflows/` — 19 workflows, none
size-related), no check in `scripts/`, and `dist:check`
(`scripts/check-dist-production.js`) audits _production-cleanliness_ of package
`dist/`, not bytes. Cloudflare enforces a hard compressed-script limit; the
first time anyone learns this framework's floor is when a user's deploy is
rejected — and at that point the cause is a dependency added weeks earlier,
across 55 packages, with no per-commit signal to bisect against.

Per-package measurement won't answer it either: package entrypoints are
re-export shims (`packages/runtime/dist/index.mjs` is 2 KiB; the code lives in
`dist/packem_shared/`, 348 KiB for `@lunora/runtime` alone). Only the bundled
Worker is a real number.

## 1. Current state (audit)

- **`lunora build`** (`packages/cli/src/commands/build/index.ts`) already
  produces exactly the artifact to measure: "Codegen + validate + bundle the
  Worker to disk without deploying", default out-dir `.lunora/build`, via
  `wrangler deploy --dry-run --outdir`. It exists so CI can build once and ship
  with `deploy --prebuilt`.
- It already emits machine-readable output (`--format json`) and a bindings
  manifest (`--emit-bindings <path>`) — so it is the natural place for a size
  field, and nothing new needs to run to obtain the bundle.
- `lunora deploy --dry-run` runs the same bundle step (`handler.ts`), so the
  number is available on the deploy path too, before anything is published.
- No consumer of either measures or reports bytes.
- `tests/vis-templates` and `pnpm run test:templates` already build the
  `templates/*` starters in CI — the hook where a per-template number could be
  recorded without inventing a new build.

## 2. Existing seams (do not reinvent)

- **`lunora build`'s out-dir + `--format json` result** — measure the emitted
  files there; do not add a second bundling path.
- **`packages/cli/src/util/output-format.ts`** — `printJson` / `isJsonFormat`,
  for reporting the number in the existing document rather than a new one.
- **`node:zlib`'s `gzipSync`** — the compressed size Cloudflare's limit is
  stated against. No dependency needed; this is a stdlib call over a file the
  build already wrote.
- **`scripts/check-*.js`** — the established shape for a repo gate run from CI
  (and, for some, from `postinstall`). A size gate follows that shape.
- **`tests/vis-templates`** — the existing template-build harness.

## 3. The behavioural contract to preserve

- `lunora build` and `lunora deploy` keep their exit codes: measuring is
  reporting, and **a user-facing size check warns, never fails**. A framework
  that refuses to deploy a bundle Cloudflare would have accepted is worse than
  the problem it prevents.
- The repo-internal CI gate is the opposite: it **fails**, because a regression
  there is ours to fix before it reaches a user.
- `--format json` stays one document; the size lands as a field inside it.
- No new dependency (`node:zlib` is stdlib).

## 4. Design decisions

- **Two different mechanisms, deliberately.** A _user-facing warning_ in
  `build`/`deploy` (informational, near the real limit) and a _repo CI gate_
  over a fixed reference app (fails on regression). Chosen over one shared
  threshold: the user's number depends on their app and their plan; ours is a
  regression signal about the framework's own floor.
- **The CI gate measures a fixed reference app, not the playground.**
  `apps/playground` accumulates feature demos (it depends on `@lunora/studio`,
  `auth-ui`, `db`, `queue`, `workflow`, …), so its size tracks demo churn rather
  than framework weight. A `templates/*` starter is the honest baseline — it is
  what a new user actually deploys.
- **Gzip, not raw or brotli.** Cloudflare states its limit against the
  compressed script; gzip is the conservative, reproducible choice from stdlib.
  Recorded alongside the raw number so a compression-ratio change is visible.
- **The ceiling is a committed number with headroom, not a computed
  percentage.** A fixture file (like `api-snapshots/`) holding the current
  measured size plus an explicit allowance. Chosen over "fail if it grew at
  all" (every legitimate feature turns the gate red) and over a percentage of
  Cloudflare's limit (which changes under us).
- **Phase 0 is measurement, and the ceiling is not written until it produces a
  number.** Guessing a budget from package `dist/` sizes would be wrong for the
  reason in §0.

## 5. Workstreams

**S — measure in `lunora build`.** After the bundle is written, sum the emitted
JS (and any inlined assets wrangler wrote) raw and gzipped; add
`bundle: { rawBytes, gzipBytes, files }` to the `--format json` result and one
line to the pretty output.

**Done.** `packages/cli/src/commands/build/bundle-size.ts` (`measureBundle`) +
`handler.ts`. Sourcemaps, `bundle-meta.json` and wrangler's README are excluded
— counting them would report ~3× the real weight. An unmeasurable out-dir
returns `undefined` and warns rather than reporting 0 bytes, since a silent 0 is
what a changed wrangler layout looks like and it would read as the healthiest
possible result.

One wrinkle worth recording: `--format json` used to be deploy's document, and
deploy prints it before `build` regains control, so there was nowhere to put the
field. `build` now owns its own document (validating `--format` itself, routing
human output to stderr, and forcing spawned stdout to stderr so the document
stays alone on stdout). `packages/cli/src/commands/deploy/*` is untouched.

**S — user-facing warning.** ~~When `gzipBytes` crosses a "getting close"
threshold, warn…~~

**Dropped — the §8 STOP condition fired.** A starter Worker is 412.9 KiB
gzipped: 13.4% of the Free plan's ceiling, 4.0% of Paid's. A threshold warning
would be a speculative alarm nobody would ever legitimately see, and picking its
trigger point would be inventing a number to defend. `build` reports the size
unconditionally instead (reporting is not warning), and the docs say what the
limit is and which levers to pull. The CI gate is the whole value here.

**M — repo CI gate.** `scripts/check-worker-size.js`: build a reference template
worker, measure it, compare against the committed ceiling fixture, fail with the
delta and the previous value on regression. Wire it as its own job in
`test.yml` (**not** into the root `postinstall` — a failing postinstall gate
turns every CI job red in its setup step and the cause is invisible in the job
that reports the failure).

**Done.** `scripts/check-worker-size.js` + the `worker-size.json` fixture
(422,840 B baseline, 51,200 B allowance → 462.9 KiB ceiling). It scaffolds
`templates/standalone` into a temp dir, links the workspace `dist/` directories
(a symlink farm, not an install — `pnpm install` would try to fetch
`lunorash@^0.0.0` from the registry), and reads the number back out of
`lunora build --format json`, so the gate and the user see one measurement from
one code path. Wired as the `worker-size` job in `test.yml` and added to
`test-required-check`'s `needs`; **not** in `postinstall`. Verified failing on a
hand-lowered fixture and passing on the committed one.

§8's "reuse `test:templates`' build" mitigation does not apply: that harness
packs tarballs and runs each template's `build` script, and `standalone` has no
`build` script — it is explicitly skipped there, so no bundle exists to reuse.
The gate builds its own (~40 s after the package build) and the job is
path-gated on `packages`/`templates` changes.

**S — an accept path.** `pnpm run worker-size:update` (mirroring
`api:update`) rewrites the fixture after an intentional increase, so the gate is
a conversation in review rather than an obstacle.

**Done.** `pnpm run worker-size:check` / `worker-size:update`; the update path
prints the signed delta against the previous baseline.

**S — docs.** A short section in the deployment docs: what the limit is, how to
read the number `lunora build` prints, what to do when it is close.

**Done.** "Worker size" in `apps/docs/src/content/docs/deployment.mdx`.

## 6. Platform parity

Not applicable to the `ctx.*` matrix — no runtime surface, no binding. The
measurement is Cloudflare-specific by nature (it is a Workers script-size
limit), so the check must live behind the Cloudflare build path and must not
present itself as a target-neutral gate; `@lunora/platform-node` has no
equivalent ceiling and must not inherit a spurious warning.

## 7. Phasing & ordering

| Phase | Work                         | Gate                                                                                                          |
| ----- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 0     | Measure and record           | The actual raw + gzip numbers for a `templates/*` worker, written into this plan before the ceiling is chosen |
| 1     | `bundle` in the build result | Test: `lunora build --format json` yields `bundle.gzipBytes` > 0 against a fixture out-dir                    |
| 2     | User-facing warning          | Test: a stubbed oversize measurement warns and still exits 0                                                  |
| 3     | CI gate + fixture            | The job fails when the fixture is lowered by hand, and passes on `alpha` unchanged                            |
| 4     | `worker-size:update` + docs  | Running it after an intentional bump turns the gate green; `pnpm run lint:prettier` clean                     |

## 8. Risks & STOP conditions

- **STOP** if phase 0 shows a starter worker sitting comfortably under the limit
  with no upward trend — then the CI gate is the whole value and the user-facing
  warning is speculative; ship the gate, drop the warning, and say so here.
- **Risk:** the ceiling fixture becomes a rubber stamp that every PR bumps.
  Mitigate: the update script prints the delta and the gate's failure message
  names the previous value, so the increase is visible in review rather than
  buried in a fixture diff.
- **Risk:** wrangler's out-dir layout changes and the measurement silently sums
  the wrong files (or zero). Mitigate: assert a non-zero size and a minimum
  file count; a measurement of 0 must fail loudly, never pass.
- **Risk:** the reference-template build makes CI meaningfully slower.
  Mitigate: reuse `test:templates`' existing build if it already produces the
  artifact; only build separately if it does not.

## 9. Open questions (answered)

1. **What is Cloudflare's current compressed-script limit per plan tier?**
   3 MB on Workers Free, 10 MB on Workers Paid, stated "after compression
   (gzip)" — read from
   <https://developers.cloudflare.com/workers/platform/limits/> on 2026-08-08.
   The same page pairs it with a 1-second startup CPU budget for top-level code,
   which a large bundle can breach before the size limit does (`Script startup
exceeded CPU time limit`, error 10021). Both numbers live in the docs section
   and the fixture comment; neither is repeated in code as a threshold.
2. **Which template is the reference?** `standalone` — it is the smallest
   starter and the only one whose deployed Worker is Lunora and nothing else
   (the meta-framework templates bundle their own SSR runtime, which would make
   the number track Next/Nuxt rather than Lunora).
3. **Does the deployed Worker ever include `@lunora/studio` assets?** No. The
   reference bundle's esbuild metafile has **zero** inputs from
   `packages/studio` — the studio is only ever loaded by the dev-time hosts
   (`@lunora/vite`'s studio plugin, `@lunora/cli`'s studio server), which
   `require.resolve` + `readFileSync` its prebuilt assets on Node. Nothing on
   the Worker path imports it. Two notes, neither a bug: `apps/playground`
   declares `@lunora/studio` under `dependencies` while every template puts it
   in `devDependencies` (it is dev tooling — the playground entry is the odd one
   out, and it costs install weight, not bundle weight); and the templates
   carrying it at all is what lets `lunora dev` serve the studio offline.
4. **Should `--emit-bindings` output carry the size too?** No. `--emit-bindings`
   answers "what must be provisioned", which is a different document with a
   different consumer (an IaC program). The size is already in the
   `--format json` result an external deployer reads anyway, and duplicating it
   into a second file creates two things to keep honest. Revisit only if a real
   deployer asks.
5. **Is a per-add-on breakdown feasible from wrangler's output?** Yes, and it
   needs no bundler-level report: `lunora deploy --outdir` already passes
   `--metafile`, so `<outDir>/bundle-meta.json` holds esbuild's per-input
   `bytesInOutput`. Grouping those paths by `packages/<name>/` produced the phase-0
   table above in a few lines. Not built here — nothing consumes it yet, and
   `lunora analyze` already covers the "what is heavy?" question interactively.

## 10. Follow-ups this work surfaced

- **`compromise` (606 KiB raw) is in every Worker** via `@visulima/redact` ←
  `@lunora/observability`. See phase 0. The single largest lever on this number.
- **`lunora analyze` over-reports.** Its `totalBytes` walks the whole out-dir,
  so it counts the sourcemap and the metafile as bundle weight — for the
  reference app that is 1.6 MiB reported as ~6.9 MiB. `measureBundle` is the
  correct filter; `analyze` should use it (left alone here to keep this change
  inside `commands/build/*`).
