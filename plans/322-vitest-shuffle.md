# Plan 322 — Make the randomized test seed actually randomize something

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO

> **Executor instructions**: follow this file top to bottom, run every verification
> command, stop on any §8 STOP condition, and update this plan's row in
> `plans/README.md` when done. This plan is expected to **turn suites red** — that
> is the finding, not a failure. §5 says what to do with the fallout.
>
> **Drift check (run first):** `git diff --stat 70b7451b5..HEAD -- tools/get-vitest-config.ts`

## 0. Headline finding

`tools/get-vitest-config.ts` computes a fresh `sequence.seed` on every run, prints it,
and passes it to Vitest. Vitest ignores `sequence.seed` unless `sequence.shuffle` is
truthy, and `shuffle` appears **nowhere** in the repo — not in the helper, not in any
of the 55 `vitest.config.ts` files. Every run executes in identical declaration order.

So the one mechanism installed to catch order-dependent tests does nothing across all
38 helper-driven packages, while printing a seed on every run that implies otherwise.
`packages/auth/vitest.config.ts:44-45` even states "the seed keeps order-dependence
from hiding" and then pins `sequence: { seed: 1 }` — a fixed value for a knob that was
already inert.

Shared module-level state is exactly what this would catch — e.g. the
`directoryCache` at `packages/runtime/src/resolve-shard.ts:37`, and singleton
registries elsewhere — and today nothing would surface a leak between files.

## 1. Current state (audit)

`tools/get-vitest-config.ts:5`:

```ts
const VITEST_SEQUENCE_SEED = Date.now();
```

`:36` — printed on every invocation:

```ts
console.log("VITEST_SEQUENCE_SEED", VITEST_SEQUENCE_SEED);
```

`:77-79`:

```ts
sequence: { seed: VITEST_SEQUENCE_SEED },
```

`grep -rn "shuffle" tools/ packages/*/vitest.config.ts` → zero matches.

`packages/auth/vitest.config.ts:44-45,62` — the comment and the `seed: 1` override.

## 2. Existing seams (do not reinvent)

- The `sequence` block already exists in the helper. This is a one-key addition, not
  new infrastructure.
- Vitest's own `sequence.shuffle` accepts `{ files: boolean, tests: boolean }`. File-level
  shuffling is the cheap, high-signal half; test-level shuffling inside a file is far
  more disruptive and is deliberately out of scope (§4).

## 3. The behavioural contract to preserve

1. A green suite must stay green _for the right reason_. If enabling shuffle reds a
   package, the fix is the leaking test, not a per-package opt-out — unless §8's STOP
   applies.
2. The printed seed must remain reproducible: a failure report has to be replayable
   with `--sequence.seed=<value>`. Verify that replaying a seed reproduces the same
   order before declaring the rollout done.
3. Do not make CI non-deterministic in a way that produces unexplainable failures. The
   seed print is what makes this debuggable; keep it.

## 4. Design decisions

**Chosen: `shuffle: { files: true, tests: false }`.** Rejected: `tests: true` as well.
Within-file order is load-bearing in plenty of legitimate suites (a `describe` block
that builds state across `it`s is a style choice, not always a bug), and turning both
on at once produces fallout nobody can triage. File-level shuffling catches the
dangerous class — module-level state leaking _between_ files.

**Chosen: roll out package by package, behind a per-package opt-in, then flip the
helper default once the tail is clean.** Rejected: flipping the helper in one commit.
That reds an unknown number of the 38 helper-driven packages simultaneously, and the
predictable outcome is a revert.

**Chosen: keep `Date.now()` as the seed source.** Rejected: a fixed seed. A fixed seed
shuffles once and then tests the same non-declaration order forever, which finds one
class of bug once and never again.

## 5. Workstreams

### WS1 — Prove the knob works (S)

Add `shuffle: { files: true, tests: false }` to the helper's `sequence` block **behind
an env flag** (e.g. `LUNORA_SHUFFLE=1`), so nothing changes for anyone by default:

```ts
sequence: {
    seed: VITEST_SEQUENCE_SEED,
    // `seed` is inert without `shuffle` — Vitest only consumes the seed when it
    // is randomizing. File-level only: within-file order is legitimately
    // load-bearing in some suites.
    ...(process.env.LUNORA_SHUFFLE === "1" ? { shuffle: { files: true, tests: false } } : {}),
},
```

**Verify:** run one package twice with `LUNORA_SHUFFLE=1` and confirm the file order in
the reporter output differs between runs; run once with a pinned
`--sequence.seed=<value>` twice and confirm it is identical.

### WS2 — Sweep the 38 helper-driven packages (M)

Run each with `LUNORA_SHUFFLE=1`, three times (one run can pass by luck). Record in
§9: package, pass/fail, and for each failure the first failing test and a one-line
diagnosis (shared module state / fixture file reuse / ordering assumption).

Do **not** fix the failures in this plan unless a fix is genuinely one line and
obviously correct. The deliverable of WS2 is the list — an inventory of real
order-coupling is worth more than a half-finished cleanup, and each non-trivial fix
deserves its own reviewed change.

### WS3 — Flip the default for the clean packages (S)

Once the list exists: make shuffle the default in the helper, and add an explicit
per-package opt-out (with a `// TODO(order-coupling):` comment naming the failing
test) for the ones WS2 found dirty. An opt-out that names the reason is a work item;
a silent one is where this drift started.

### WS4 — Delete the misleading override (S)

Remove `sequence: { seed: 1 }` from `packages/auth/vitest.config.ts:62` (or align it
with the helper) and fix the comment at `:44-45`, which currently describes a
behaviour that did not exist.

## 6. Platform parity

Not applicable — test-runner configuration only.

## 7. Phasing & ordering

| Phase | Work | Gate                                                                                           |
| ----- | ---- | ---------------------------------------------------------------------------------------------- |
| 0     | WS1  | two `LUNORA_SHUFFLE=1` runs of one package show different file order; a pinned seed reproduces |
| 1     | WS2  | the §9 inventory is filled for all 38 packages, three runs each                                |
| 2     | WS3  | `pnpm run test` green with shuffle on by default and every opt-out commented                   |
| 3     | WS4  | `grep -l "seed: 1" packages/*/vitest.config.ts` → no matches (**CORRECTED 2026-08-11**: the original repo-wide `grep -rn "seed: 1" packages/` is too broad and can never pass — `@lunora/seed`'s public `createSeedClient(schema, { seed: 1 })` option appears in its source, docs, README and tests, plus codegen JSDoc. Scope the check to `vitest.config.ts` files, which is what this workstream is actually about)                                                    |

WS3 must not start before WS2 is complete for every package. A partial sweep plus a
default flip is the one-commit rollout this plan exists to avoid.

## Commands you will need

| Purpose               | Command                                                         | Expected                                                                                              |
| --------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Build first           | `pnpm run build:packages`                                       | exit 0                                                                                                |
| One package, shuffled | `LUNORA_SHUFFLE=1 pnpm --filter "@lunora/<pkg>" run test`       | pass or a reproducible failure                                                                        |
| Replay a seed         | `pnpm --filter "@lunora/<pkg>" run test -- --sequence.seed=<n>` | identical order both times                                                                            |
| Whole repo            | `pnpm run test`                                                 | all pass (**never** `pnpm -r run test` — it fails an arbitrary set each run from resource contention) |

## Scope

**In scope:**

- `tools/get-vitest-config.ts`
- `packages/auth/vitest.config.ts` (WS4)
- Per-package opt-out comments in `packages/*/vitest.config.ts` (WS3 only)
- The §9 inventory in this file

**Out of scope:**

- **Fixing the order-coupled tests WS2 finds** (beyond genuine one-liners). Each is its
  own change; list them, do not chase them.
- `sequence.concurrent`, `pool`, `maxWorkers` and any other runner tuning.
- The 17 packages that do not use the helper — they inherit nothing from this change.
  Note them in §9 as untouched.

## Git workflow

- Branch: `advisor/322-vitest-shuffle`
- Suggested commits: `test(repo): make the vitest sequence seed take effect` then
  `test(repo): shuffle test files by default`

## Test plan

The verification is empirical, not a new unit test:

1. Order actually changes between two shuffled runs (WS1).
2. A pinned seed reproduces an order exactly (WS1) — without this, a shuffled CI
   failure is unactionable.
3. Every package runs three times shuffled (WS2).
4. `pnpm run test` is green after WS3.

## Done criteria

- [ ] `grep -n "shuffle" tools/get-vitest-config.ts` → match
- [ ] Two consecutive shuffled runs of one package produce different file order (paste both orders into §9)
- [ ] A pinned `--sequence.seed` reproduces an identical order twice
- [ ] §9's inventory covers all 38 helper-driven packages with three runs each
- [ ] `pnpm run test` exits 0 with shuffle on by default
- [ ] Every opt-out carries a `// TODO(order-coupling):` comment naming the failing test
- [ ] `grep -l "seed: 1" packages/*/vitest.config.ts` → no matches (**CORRECTED 2026-08-11**: the original repo-wide `grep -rn "seed: 1" packages/` is too broad and can never pass — `@lunora/seed`'s public `createSeedClient(schema, { seed: 1 })` option appears in its source, docs, README and tests, plus codegen JSDoc. Scope the check to `vitest.config.ts` files, which is what this workstream is actually about)
- [ ] `plans/README.md` row updated

## 8. Risks & STOP conditions

- **STOP** if more than roughly a third of the 38 packages fail under shuffle. That is
  not a cleanup, it is a repo-wide property, and the right answer is a staged
  programme with an owner — not one executor pushing through it.
- **STOP** if a failure is not reproducible with its printed seed. Then the failure is
  not order-dependence but genuine flakiness (real timers, network, worker contention),
  which is a different investigation.
- **Risk:** `pnpm -r run test` fails an arbitrary set every run from resource
  contention, unrelated to order. Never use it to measure this; use `pnpm run test`
  (vis-orchestrated) or per-package filters.
- **Risk:** a shuffled failure in CI with no seed in the log is unactionable. Confirm
  the seed print survives into the CI job output before WS3.

## 9. Inventory (fill in during execution)

| package | run 1 | run 2 | run 3 | first failing test | diagnosis |
| ------- | ----- | ----- | ----- | ------------------ | --------- |
|         |       |       |       |                    |           |

Packages not covered by this plan (they do not use the helper): agent, angular,
browser, client, container, d1, dispatch, do, queue, replica, runtime, scheduler,
search-core, seed, storage, workflow, x402.
