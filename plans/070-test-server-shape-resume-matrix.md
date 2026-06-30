# Plan 070: Characterization tests for the server shape resume-vs-reseed decision

> **Executor instructions**: This is a **tests-only** plan. Do NOT change any
> source under `src/` — if a test reveals a real bug, STOP and report it. Follow
> the steps, run the verification commands, update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 9f779358..HEAD -- packages/do/src/shard-do.ts`
> If it changed, compare the "Current state" excerpt against the live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (recommended to land before plan 072, which optimizes the
  same `buildShapeDiff` path these tests cover)
- **Category**: tests
- **Planned at**: commit `9f779358`, 2026-06-29

## Why this matters

When a client `shape_subscribe`s with a resume hint (`sinceSeq` + `sinceEpoch`),
the DO decides between two paths: a lightweight **resume** (diff the op range
`(sinceSeq, cursor]` via `buildShapeDiff`) or a full **re-seed**
(`buildShapeSeed`). The decision (`canResume`) is a five-way conjunction
involving CDC enablement, epoch match, the client not running ahead, and the
op-log retention floor still covering the client's checkpoint. Getting any clause
wrong means either missed rows (resumed when it shouldn't have) or wasted
bandwidth (re-seeded when resume was safe). This branch has integration coverage
of the happy poke path but no focused matrix over the `canResume` clauses. These
tests pin each clause, and they're the safety net for plan 072's optimization of
`buildShapeDiff`.

## Current state

- `packages/do/src/shard-do.ts` — the resume decision in `seedSubscription`'s
  shape path (around lines 5957–5987):

    ```ts
    const floor = this.cdcEnabled() ? minCdcSeq(sql) : undefined;
    const canResume =
        this.cdcEnabled() &&
        shape.sinceSeq !== undefined &&
        shape.sinceEpoch === epoch &&
        shape.sinceSeq <= cursor &&
        (shape.sinceSeq === cursor || (floor !== undefined && floor <= shape.sinceSeq + 1));

    const rowsPatch =
        canResume && shape.sinceSeq !== undefined ? this.buildShapeDiff(sql, resolved, shape.sinceSeq, cursor) : this.buildShapeSeed(sql, resolved);
    ```

    The comment above it (lines 5961–5966) is the spec to encode: _"Resume only
    when CDC is on, the client is on this epoch, its checkpoint doesn't run ahead of
    ours, and the log still covers it (else a gap means we can't prove what it
    missed → full re-seed). A fully-compacted log (`floor === undefined`) only
    proves 'nothing missed' when the client is already at `cursor`."_

## Commands you will need

| Purpose          | Command                                     | Expected on success       |
| ---------------- | ------------------------------------------- | ------------------------- |
| Build deps first | `pnpm run build:packages`                   | exit 0 (run once)         |
| Tests            | `pnpm --filter "@lunora/do" run test`       | all pass, incl. new tests |
| Typecheck        | `pnpm --filter "@lunora/do" run lint:types` | exit 0                    |
| Lint             | `pnpm run lint:eslint`                      | exit 0                    |

## Scope

**In scope** (the only files you should modify):

- `packages/do/__tests__/shard-do.shape-poke.test.ts` — add resume-matrix cases,
  or a new sibling `shard-do.shape-resume.test.ts` using the same harness.

**Out of scope** (do NOT modify):

- Any `packages/do/src/**` file. Tests-only.

## Git workflow

- Branch: `advisor/070-test-server-shape-resume-matrix`.
- Commit style: `test(do): cover shape resume-vs-reseed decision matrix`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Study the existing harness

Read `packages/do/__tests__/shard-do.shape-poke.test.ts`. It builds a real
`ShardDO` (subclassed to override `resolveShape` with a flat `{ channelId }`
predicate), a `FakeWebSocket`, a real `createShardCtxDb` writer over the
`node-sqlite` exec helper (`./_helpers/node-sqlite`) and `./_helpers/messages-schema`.
This is the canonical harness — reuse it. Note how the test drives
`shape_subscribe` and reads the emitted poke frames off `FakeWebSocket.sent`.

### Step 2: Drive each `canResume` clause

Add cases that subscribe with a resume hint and assert which path ran by
inspecting the emitted poke frame (a **resume/diff** carries only the changed
row-ops over `(sinceSeq, cursor]` and stamps the resume base; a **re-seed**
carries the full current membership and no resume base). Cover:

1. **Resume happy path** — `sinceEpoch === epoch`, `sinceSeq <= cursor`, log
   covers it → diff path; only rows changed since `sinceSeq` appear.
2. **Epoch mismatch** — `sinceEpoch !== epoch` → re-seed (full membership).
3. **Client ahead** — `sinceSeq > cursor` → re-seed.
4. **Retention gap** — `sinceSeq` older than the op-log floor (`minCdcSeq`) so
   `floor <= sinceSeq + 1` is false → re-seed.
5. **Fully-compacted log** (`floor === undefined`): client at `cursor` → resume
   (proves nothing missed); client lagging → re-seed.
6. **CDC disabled** → re-seed.

To control `cursor` / `floor`, write through the real ctx-db writer to advance the
op-log, and use the harness's CDC controls (look for how the existing test
manipulates the changelog / compaction; if there's no helper to force
compaction, cover the clauses you can reach and `log()` in your report which were
not reachable without a source change — do NOT add a source test-hook).

**Verify**: `pnpm --filter "@lunora/do" run test` → all pass.

## Test plan

- New cases as in Step 2, in `shard-do.shape-poke.test.ts` (or
  `shard-do.shape-resume.test.ts`).
- Assertion basis: the emitted poke frame's contents (diff vs full seed) and the
  presence/absence of the resume base — observable on `FakeWebSocket.sent`.
- Structural pattern: the existing shape-poke test.
- Verification: `pnpm --filter "@lunora/do" run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter "@lunora/do" run test` exits 0 with the new cases.
- [ ] `pnpm --filter "@lunora/do" run lint:types` exits 0.
- [ ] `pnpm run lint:eslint` exits 0.
- [ ] At least clauses 1–4 of Step 2 are covered (note any of 5–6 you couldn't
      reach without a source hook, and why).
- [ ] No `packages/do/src/**` file is modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- The `canResume` block no longer matches the "Current state" excerpt.
- A test shows resume firing when the log can't prove what the client missed (a
  real correctness bug — missed rows) — report it, don't fix here.
- Reaching a clause requires adding a test-only hook to `src/` — report instead.

## Maintenance notes

- These tests are the safety net for plan 072 (op-log read sharing in
  `buildShapeDiff`/poke flush). Run them before and after that optimization.
- If the resume protocol gains clauses (e.g. a new compaction mode), extend this
  matrix.
