# Plan 391: Clamp the fingerprint stacktrace parser like the message paths already are

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/fingerprint/src/superlog.ts`
> On a mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (clamps change canonical strings only for degenerate input)
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`@lunora/fingerprint` folds attacker-influenced error text into issue fingerprints on a single-threaded runtime. The message paths are explicitly clamped: `MESSAGE_INPUT_MAX = 1024` exists because "an unbounded message would let one crafted error stall the DO's single thread" (superlog.ts:111-120), and both `messageBucketFor` and `normalizeMessage` slice before their regexes run. The stacktrace path got neither clamp: `parseFrames` splits the whole stacktrace on `\n` with no line-count or line-length bound, and `splitFramedLocation` loops over every `(` in a line, calling `splitLocation` on an O(len) slice per candidate — O(k·len) for a line with k whitespace-preceded parens. The module's own docs record that stacktraces "can carry a user-supplied string in a frame name" and that the regex predecessors were replaced for exactly this ReDoS class. One crafted `exception.stacktrace` line stalls whichever runtime is folding errors into Issues.

## Current state

- `packages/fingerprint/src/superlog.ts:111-120` — the exemplar clamp + rationale (`MESSAGE_INPUT_MAX = 1024`), applied at `:127` (`messageBucketFor`) and `:167` (`normalizeMessage`).
- `packages/fingerprint/src/superlog.ts:232-249` — `splitFramedLocation`:
    ```ts
    for (let index = body.indexOf("("); index > 0; index = body.indexOf("(", index + 1)) {
        const separator = body[index - 1] ?? "";
        if (!/\s/.test(separator)) { continue; }
        const path = splitLocation(body.slice(index + 1, -1));
        ...
    ```
    Each candidate slices O(len) and `splitLocation` scans with `lastIndexOf` — quadratic on adversarial lines.
- `packages/fingerprint/src/superlog.ts:254-262` — `parseFrames` iterates `stacktrace.split("\n")` unbounded; lines not starting with `at ` are skipped (so the adversarial line must start with `at ` — the shape is reachable).
- Consumer: `packages/observability/src/request-log.ts:38` imports `fingerprintError`; `fingerprint`/`fingerprintLog` are exported public API for out-of-repo OTLP pipelines.
- Zero-dep package — the fix must stay dependency-free.

## Commands you will need

| Purpose   | Command                                               | Expected on success |
| --------- | ----------------------------------------------------- | ------------------- |
| Install   | `pnpm install`                                        | exit 0              |
| Build     | `pnpm --filter "@lunora/fingerprint..." run build`    | exit 0              |
| Tests     | `pnpm --filter "@lunora/fingerprint" run test`        | all pass            |
| Typecheck | `pnpm --filter "@lunora/fingerprint" run lint:types`  | exit 0              |
| Lint      | `pnpm --filter "@lunora/fingerprint" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/fingerprint/src/superlog.ts`
- The existing test file covering frame parsing (`grep -rln "parseFrames\|splitFramedLocation\|stacktrace" packages/fingerprint/__tests__/`)

**Out of scope**:

- `packages/observability/*` — the caller is fine once the library is bounded.
- The message-path clamps — already correct; don't touch.
- Changing hashes for well-formed stacks — the clamps must be sized so no realistic stack is affected (see Step 1 bounds).

## Git workflow

- Branch: `improve/wave22-fingerprint`
- Commit: `perf(fingerprint): clamp stacktrace parsing`

## Steps

### Step 1: Add the bounds

Next to `MESSAGE_INPUT_MAX`, add (with a docstring mirroring its rationale, referencing that a stacktrace is attacker-influenced):

- `STACK_LINE_MAX = 1024` — a frame line longer than this is sliced before parsing (real frame lines are <300 chars; V8 caps stack frames well below this).
- `STACK_FRAMES_MAX = 64` — stop after this many parsed frames (V8's default `Error.stackTraceLimit` is 10; 64 is generous).
- `STACK_PAREN_CANDIDATES_MAX = 32` — `splitFramedLocation` gives up (returns null) after this many `(` candidates; a real frame has 1-2.

Apply them: in `parseFrames`, slice each line to `STACK_LINE_MAX` before `splitFramedLocation`, and `break` once `out.length === STACK_FRAMES_MAX`; in `splitFramedLocation`, count candidates and return `null` past the cap.

**Verify**: `pnpm --filter "@lunora/fingerprint" run test` → existing hash-stability tests pass unchanged (proves well-formed stacks are unaffected).

### Step 2: Regression test

Add to the existing frame-parsing test file:

1. A pathological line — `"at " + "x (".repeat(20000) + "f.js:1:1)"` — parses (or returns no frame) in bounded time; assert wall-clock under a generous bound (e.g. `expect(elapsed).toBeLessThan(200)` ms) and, more importantly, that the function returns rather than hanging.
2. A 100-line stack yields at most `STACK_FRAMES_MAX` frames.
3. A canonical well-formed stack (copy one from an existing test) produces the same frames/fingerprint as before the change — pin the value.

**Verify**: `pnpm --filter "@lunora/fingerprint" run test` → all pass including the 3 new tests.

## Test plan

As Step 2 — pathological-input bound, frame-count cap, and a pinned well-formed fingerprint proving hash stability. Model on the existing superlog tests in the same directory.

## Done criteria

- [ ] `grep -n "STACK_LINE_MAX\|STACK_FRAMES_MAX" packages/fingerprint/src/superlog.ts` → definitions + usages
- [ ] `pnpm --filter "@lunora/fingerprint" run test` exits 0 with the new tests
- [ ] All pre-existing fingerprint/hash tests pass byte-identical (no snapshot updates)
- [ ] `pnpm --filter "@lunora/fingerprint" run lint:types` + `lint:eslint` exit 0

## STOP conditions

- Any pre-existing hash/fingerprint test changes value under the clamps — the bounds are then too tight for a legitimate input shape in the corpus; report which test.
- The pathological test cannot be made to pass without restructuring `splitLocation` itself — report; the cap should be sufficient.

## Maintenance notes

- The three constants and `MESSAGE_INPUT_MAX` are the package's complete input-bounding story; any new parse path over attacker-influenced text must add its clamp in the same commit.
- Hash caveat for the changelog: inputs past the clamps (degenerate by construction) may fingerprint differently than before — same argument as the NUL-stripping change (plan 152).
