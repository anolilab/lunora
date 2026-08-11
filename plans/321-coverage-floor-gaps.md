# Plan 321 — Put a coverage floor back under the six packages that silently lost one, and stop the generator minting more

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO

> **Executor instructions**: follow this file top to bottom, run every verification
> command, stop on any §8 STOP condition, and update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first):**
> `git diff --stat 70b7451b5..HEAD -- tools/get-vitest-config.ts packages/*/vitest.config.ts .vis/templates/lunora-package.ts`
>
> **Build before you measure:** `pnpm run build:packages` once. A cold tree reports
> nonsense — measured during plan 302, `@lunora/svelte` showed 455 lint findings cold
> and 24 after a build. The same applies to coverage runs that fail on a missing dist.

## 0. Headline finding

`tools/get-vitest-config.ts` carries the repo's coverage ratchet. Its own comment says
six packages sit outside it, all workerd-gated (`client`, `d1`, `do`, `runtime`,
`scheduler`, `storage`) because `@cloudflare/vitest-pool-workers` cannot produce a v8
coverage number. **Seventeen** packages actually bypass it. Eleven of those genuinely
use the workers pool. **Six do not**: `agent` (9.6k LOC), `angular`, `browser`,
`replica` (4.8k LOC), `search-core`, `seed`. They ship `thresholds: undefined` for no
stated reason, and four of them (`agent`, `angular`, `replica`, `search-core`) are
three-line configs with no `include: ["src"]` either — so test helpers land in the
coverage denominator. Measured: `pnpm --filter @lunora/agent test:coverage` reports
`__tests__/loop-harness.ts` as covered source.

`packages/auth/vitest.config.ts:24-28` is the one package that noticed the trap, and
says so in a comment: moving off the helper "otherwise drops its coverage floor
silently — which is a poor trade on an auth package".

The same class recurs by construction: `.vis/templates/lunora-package.ts:38-47` emits
a `scripts` block with no `test:coverage` — a script all 55 existing packages have,
and the one `.github/workflows/test.yml:106-113` invokes via
`test:affected:coverage`. A freshly generated package silently drops out of the CI
coverage leg while every other check stays green.

## 1. Current state (audit)

The 17 packages whose `vitest.config.ts` does not import `getVitestConfig`, classified
by whether they actually use the workers pool:

| workerd-gated (11, keep exempt)                                                         | not workerd (6, this plan)                              |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| client, container, d1, dispatch, do, queue, runtime, scheduler, storage, workflow, x402 | **agent, angular, browser, replica, search-core, seed** |

Of the six, four have a three-line config with no `include` and no coverage block at
all — e.g. `packages/agent/vitest.config.ts:3`:

```ts
export default defineConfig({ test: { environment: "node" } });
```

`browser` (32 lines) and `seed` (21 lines) do set `include`, but no thresholds.

The helper's stale comment, `tools/get-vitest-config.ts:20-26`:

```
 * Thresholds only apply when coverage is enabled (`vitest run --coverage`, the
 * `test:coverage` scripts); plain `vitest run` is unaffected. The workerd-gated
 * packages (client, d1, do, runtime, scheduler, storage) use inline
 * `defineConfig` configs — not this helper — and stay threshold-free ...
```

Six named; eleven in reality.

The defaults it would apply (`tools/get-vitest-config.ts:27-32`):

```ts
export const DEFAULT_COVERAGE_THRESHOLDS: Required<CoverageThresholds> = {
    branches: 70,
    functions: 80,
    lines: 80,
    statements: 80,
};
```

The generator template, `.vis/templates/lunora-package.ts:38-47` — `build`,
`build:prod`, `lint:eslint{,:fix}`, `lint:prettier{,:fix}`, `lint:types`, `test`. No
`test:coverage`. `grep -L '"test:coverage"' packages/*/package.json` returns nothing,
i.e. all 55 existing packages have it — the template is the only source of new
divergence.

## 2. Existing seams (do not reinvent)

- `getVitestConfig(options, coverageThresholds)` — the ratchet. Route packages through
  it rather than hand-writing a coverage block.
- `DEFAULT_COVERAGE_THRESHOLDS` — importable for a package that must keep an inline
  config. `packages/auth/vitest.config.ts:24-28` is the worked example; copy it.
- The `// ratchet:` comment convention (documented at `tools/get-vitest-config.ts:14-18`)
  for a floor set below the default.
- `scripts/check-project-json-targets.js` — the existing "a target that silently does
  nothing" guard. WS3 extends it rather than adding a ninth bespoke `check-*.js`.

## 3. The behavioural contract to preserve

1. **No floor may be set above the measured value.** A floor is a ratchet, not an
   aspiration. Measure first, pin just below, leave a `// ratchet:` comment when it is
   under the default.
2. The eleven workerd-gated packages keep their exemption. Their workers projects run
   without coverage, so a floor there gates on a structurally incomplete number.
3. `pnpm run test` and `pnpm run test:affected` keep working unchanged — thresholds
   only apply under `--coverage`.
4. Adding `include: ["src"]` will _change_ the measured number (helpers leave the
   denominator). Measure **after** adding it, not before.

## 4. Design decisions

**Chosen: route the four three-line configs through `getVitestConfig`; give `browser`
and `seed` thresholds in place.** Rejected: converting all six to the helper —
`browser` and `seed` have real inline config worth keeping, and churning them adds
diff for no gate.

**Chosen: measured floors, not the default 70/80/80/80.** Rejected: applying the
default everywhere — for a package currently below it, that is an immediate red build
and the plan gets reverted rather than ratcheted.

**Chosen: fix the template _and_ the helper's comment in the same change.** Rejected:
template only. The comment is what made the drift invisible; leaving it wrong
guarantees the next reader repeats the mistake.

## 5. Workstreams

### WS1 — Measure (S)

For each of the six, run:

```
pnpm --filter "@lunora/<pkg>" run test:coverage
```

Record statements / branches / functions / lines in a table **in this file** under §9
before changing any config. This is the baseline the floors are pinned to, and the
record of what the ratchet started at.

### WS2 — Route the four, floor the two (S)

- `agent`, `angular`, `replica`, `search-core`: replace the three-line config with
  `getVitestConfig({ test: { environment: "node" } }, { /* measured, rounded down */ })`.
  Adding the helper brings `include: ["src"]` with it — **re-measure after the switch**,
  because dropping the test helpers from the denominator moves the number, sometimes
  down.
- `browser`, `seed`: keep the inline config; add a `coverage.thresholds` block seeded
  from `DEFAULT_COVERAGE_THRESHOLDS` where the measurement allows it, or explicit
  measured values with a `// ratchet:` comment where it does not. Follow
  `packages/auth/vitest.config.ts:24-28` exactly.

**Verify per package:** `pnpm --filter "@lunora/<pkg>" run test:coverage` exits 0.

### WS3 — Stop the generator minting the gap (S)

- `.vis/templates/lunora-package.ts`: add `"test:coverage": "vitest run --coverage"`
  to the generated `scripts` block. Copy the exact command from an existing package
  manifest rather than guessing — check `packages/values/package.json`.
- Extend `scripts/check-project-json-targets.js` to assert every `packages/*/package.json`
  carries the conventional script set (`build`, `build:prod`, `lint:eslint`,
  `lint:prettier`, `lint:types`, `test`, `test:coverage`).

> **⚠️ CORRECTED 2026-08-11 — this workstream BLOCKED on execution, and two of its
> premises were wrong. Read this before attempting it again.**
>
> 1. **The script does NOT run from `postinstall`.** This plan claimed it did and
>    called the gate "free". Its own header comment says "Deliberately NOT in the root
>    postinstall"; it is wired only to `lint:project-json` (`package.json:52`) and the
>    Lint workflow. The postinstall-reds-every-job warning is a true fact about this
>    repo, but it does not apply to this script.
> 2. **The required set as written cannot pass.** `packages/auth-ui/package.json` has
>    no `build` and no `build:prod` — deliberately: it is `private: true`, internal,
>    not published, and ships raw `.ts`/`.css` with no `dist`. So the check would fail
>    on the first run against a package this plan never touches, which is precisely
>    §8's second STOP condition. The executor stopped rather than improvising, and was
>    right to: the three available workarounds (drop `build`/`build:prod` from the
>    required set, add an `auth-ui` allowlist entry mirroring the file's existing
>    `KNOWN_UNMIGRATED` pattern, or give `auth-ui` stub build scripts) are all
>    decisions for the maintainer, not the executor.
>
> **Whoever picks this up must first decide which of those three shapes is wanted.**
> The likely right answer is the allowlist entry, since the file already models
> documented exceptions — but that is a call, not a default.

### WS4 — Correct the helper's comment (S)

`tools/get-vitest-config.ts:20-26`: name the real exempt set (the eleven), and state
that the exemption is _workers-pool only_ — so the next package to move off the helper
has to justify it.

## 6. Platform parity

Not applicable — test configuration and repo tooling. No `ctx.*` surface, no binding.

## 7. Phasing & ordering

| Phase | Work | Gate                                                                                                                              |
| ----- | ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0     | WS1  | six measurements recorded in §9                                                                                                   |
| 1     | WS2  | each of the six: `test:coverage` exits 0 with a threshold block present                                                           |
| 2     | WS3  | `node scripts/check-project-json-targets.js` exits 0; a `vis generate lunora-package` dry run emits `test:coverage`               |
| 3     | WS4  | the comment names eleven packages; `grep -L getVitestConfig packages/*/vitest.config.ts` matches that list plus the six now fixed |

## Commands you will need

| Purpose              | Command                                              | Expected                 |
| -------------------- | ---------------------------------------------------- | ------------------------ |
| Build first          | `pnpm run build:packages`                            | exit 0                   |
| Per-package coverage | `pnpm --filter "@lunora/<pkg>" run test:coverage`    | exit 0, prints the table |
| Postinstall gate     | `node scripts/check-project-json-targets.js`         | exit 0                   |
| Manifest key order   | `pnpm run lint:package-json`                         | exit 0 (CI-only gate)    |
| Format, lint         | `pnpm run lint:prettier:fix && pnpm run lint:eslint` | exit 0                   |

## Scope

**In scope:**

- `packages/{agent,angular,browser,replica,search-core,seed}/vitest.config.ts`
- `tools/get-vitest-config.ts` (comment only)
- `.vis/templates/lunora-package.ts`
- `scripts/check-project-json-targets.js`

**Out of scope:**

- The eleven workerd-gated configs. Their exemption is correct.
- `packages/auth/vitest.config.ts` — already the right pattern.
- **Writing tests.** This plan installs floors at _today's_ measured values. Raising
  coverage is separate work (see plans 324, 325 for two specific gaps).
- `packages/shard-engine`'s 25% branch floor — a known, documented post-extraction
  ratchet, deliberately left alone.
- Adding `fallow:*` scripts to the six packages that lack them. That job is
  `continue-on-error` in CI and buys a report, not a gate; recorded in §9 instead.

## Git workflow

- Branch: `advisor/321-coverage-floor-gaps`
- Suggested commits: `test(repo): floor coverage on the six unratcheted packages`
  then `dx(generate): emit test:coverage in the package template`

## Test plan

No new unit tests. The gates are:

1. Each of the six `test:coverage` runs exits 0 with thresholds present.
2. Lowering any one floor by hand and re-running makes it **fail** — prove the floor is
   live for at least one package, rather than assuming.
3. `node scripts/check-project-json-targets.js` fails when you temporarily delete
   `test:coverage` from one manifest, and passes when restored. Prove the new
   assertion works before trusting it.

## Done criteria

- [ ] `for p in agent angular browser replica search-core seed; do pnpm --filter "@lunora/$p" run test:coverage; done` — all exit 0
- [ ] ~~`grep -L "thresholds" packages/{agent,angular,browser,replica,search-core,seed}/vitest.config.ts` returns nothing~~ — **CORRECTED 2026-08-11: this criterion was wrong and must not be used.** A package routed through `getVitestConfig(options, floors)` passes its floors as the second argument; the literal word `thresholds` lives in `tools/get-vitest-config.ts`, not the call site — true of every package already on the helper (`fingerprint`, `cli`, `payment`, `shard-engine`, `svelte`, …). Prove the floors are live the only way that means anything: **raise one by hand and watch the run fail**, then restore
- [ ] The six measured baselines are recorded in §9 of this file
- [ ] `grep -n "test:coverage" .vis/templates/lunora-package.ts` → match
- [ ] `node scripts/check-project-json-targets.js` exits 0 against all 55 packages
- [ ] `tools/get-vitest-config.ts`'s comment names the eleven genuinely-exempt packages
- [ ] `pnpm run lint:package-json` exits 0
- [ ] `plans/README.md` row updated

## 8. Risks & STOP conditions

- **STOP** if any of the six cannot produce a coverage number at all (a pool or
  environment error rather than a low number). That is a different problem and this
  plan's premise — "these six could be measured and simply are not" — is wrong for
  that package.
- **STOP** if extending `check-project-json-targets.js` fails against an existing
  package you did not touch. Do not "fix" that package's manifest to make your gate
  pass; report it, because a postinstall failure reds every job in CI.
- **Risk:** adding `include: ["src"]` can _lower_ a package's number by removing
  well-covered helpers from the denominator. Always measure after the switch, never
  pin a floor from the pre-switch run.
- **Risk:** `angular` may need a non-node environment to measure at all. If its tests
  do not run under the helper's defaults, keep its inline config and add thresholds in
  place (the `browser`/`seed` path) rather than forcing the helper.

## 9. Open questions (fill in during execution)

1. Measured baselines — fill this table in WS1 and update it after WS2's `include`
   change:

    | package     | statements | branches | functions | lines | floor set |
    | ----------- | ---------- | -------- | --------- | ----- | --------- |
    | agent       |            |          |           |       |           |
    | angular     |            |          |           |       |           |
    | browser     |            |          |           |       |           |
    | replica     |            |          |           |       |           |
    | search-core |            |          |           |       |           |
    | seed        |            |          |           |       |           |

2. Should the six packages missing `fallow:*` scripts (`agent`, `angular`, `auth-ui`,
   `notify`, `replica`, `search-core`) get them? The job is `continue-on-error`, so it
   is a lost report rather than a lost gate — record a yes/no and, if yes, file it
   separately.
3. Do any of the eleven workerd-gated packages run a _second_, non-workers project
   that could be floored independently? If so, that is a follow-up worth naming.
