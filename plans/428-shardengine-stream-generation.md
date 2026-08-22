# Plan 428: Refuse to splice a durable-stream resume onto a different generation's transcript

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/shard-engine/src/durable-stream-runner.ts packages/shard-engine/src/durable-stream.ts packages/do/src/shard-do.ts packages/client/src/lunora-client.ts protocol/README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (protocol extension; must stay compatible with clients that don't send the new field)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

A durable-stream consumer resuming with `sinceChunk > 0` can be silently spliced onto a **different run's** transcript. `runKey` is deliberately shared across a user's tabs (`packages/do/src/shard-do.ts:7987` — `caller\u0000functionPath:stableWireKey(args)`), so: tab A holds chunks 1..5 of run #1; tab B asks fresh, hits `"reclaim"` (delete + re-claim the same key) and starts run #2; A reconnects with `sinceChunk: 5` and receives run #2's chunks 6..N appended to run #1's 1..5 — two generations concatenated into one transcript, with no error. Separately, a resuming caller whose run row was TTL-trimmed gets `"attach"` (a brand-new run from seq 1) instead of the honest `"interrupted"`. The module's own docblock says `"interrupted"` exists precisely so the tail is never spliced onto a foreign prefix; the guard just doesn't cover these two paths.

## Current state

- `packages/shard-engine/src/durable-stream-runner.ts:83-94`:
    ```ts
    const decideDurableAttach = (run: DurableStreamRun | undefined, context: { live: boolean; resuming: boolean }): DurableAttachDecision => {
        if (run === undefined || context.live) {
            return "attach";
        }
        if (run.status === "complete" || run.status === "error") {
            return context.resuming ? "replay-terminal" : "reclaim";
        }
        // `running` with no live producer: the instance died mid-generation.
        return context.resuming ? "interrupted" : "reclaim";
    };
    ```
    Hole 1: `run === undefined` with `resuming` returns `"attach"`. Hole 2: `context.live` with `resuming` returns `"attach"` with no check that the live run is the caller's generation.
- `attachOrThrow` (same file, ~`:166-210`): `const resuming = sinceChunk > 0;` … the `live` branch replays `readStreamChunks(sql, runKey, sinceChunk)` then `live.sinks.add(sink)`.
- The run row already carries a generation stamp: `packages/shard-engine/src/durable-stream.ts:46-55` — `DurableStreamRun.startedAt` ("Wall-clock millis when the run started").
- The client resume envelope carries only `sinceChunk`: `protocol/README.md:251` — `stream` frame is `{ type, id, query, sinceChunk? }`; `packages/client/src/lunora-client.ts:4916` re-sends `sinceChunk: stream.lastSeq` on reconnect. There is no run-identity field anywhere in the protocol today.
- `decideDurableAttach` is exported from `@lunora/shard-engine` (pure, directly testable).
- `packages/shard-engine/__tests__/` has **no** durable-stream test file today (plan 429 adds the suite; this plan adds only the tests for the new behavior).

## Commands you will need

| Purpose       | Command                                                                           | Expected on success                                                                                                  |
| ------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Install       | `pnpm install`                                                                    | exit 0                                                                                                               |
| Build deps    | `pnpm --filter "@lunora/do..." run build`                                         | exit 0 (builds shard-engine + platform deps too)                                                                     |
| Engine tests  | `pnpm --filter "@lunora/shard-engine" run test`                                   | all pass                                                                                                             |
| DO tests      | `pnpm --filter "@lunora/do" run test`                                             | all pass (mocks project; workerd project needs `LUNORA_WORKERD_TESTS=1`, skip if it cannot boot in your environment) |
| Client tests  | `pnpm --filter "@lunora/client" run test`                                         | all pass                                                                                                             |
| Typecheck     | `pnpm --filter "@lunora/shard-engine" run lint:types` (repeat for `do`, `client`) | exit 0                                                                                                               |
| API snapshots | `pnpm run build:packages && pnpm run api:update`                                  | snapshot updated for shard-engine/do/client surface changes                                                          |

## Scope

**In scope**:

- `packages/shard-engine/src/durable-stream-runner.ts` (decision function + attach envelope)
- `packages/shard-engine/src/durable-stream.ts` (only if the chunk/run read helpers need to surface `startedAt` — read first; the run row already has it)
- `packages/do/src/shard-do.ts` — ONLY the stream-attach handler region (~`:7975-8060`) and the frame emission it owns: pass the caller-echoed generation into the attach, include the run's `startedAt` as `generation` on outbound stream frames (find the exact frame builder — `streamFrames(ws, id)` near `:7990`).
- `packages/client/src/lunora-client.ts` — the stream resume state (~`:4916`) and wherever `stream.lastSeq` is updated on chunk receipt: store the frame's `generation` beside `lastSeq`, echo it on resume.
- `packages/client/src/types.ts` — `ClientStreamMessage` gains optional `generation?: number` beside `sinceChunk` (`:597-600`).
- `protocol/README.md` — the `stream` frame row (`:251`) and the durable-stream note (`:260-266`).
- Tests: new `packages/shard-engine/__tests__/durable-stream-runner.test.ts` (decision-function cases), plus the client resume test file that covers `sinceChunk` today (find it: `grep -rln "sinceChunk" packages/client/__tests__`).

**Out of scope**:

- Any other part of `shard-do.ts` (the file is ~8.5k lines with a frozen-surface check — touch only the stream region).
- The ephemeral (non-durable) stream path — `protocol/README.md:266` says it ignores `sinceChunk`; it must also ignore `generation`.
- Server-side TTL/trim policy (`trimStreamRuns`).

## Git workflow

- Branch: `improve/wave22-shard-engine`
- Commits (one per logical unit):
    - `fix(shard-engine): gate stream resume on run generation`
    - `fix(client): echo stream generation on resume`

## Steps

### Step 1: Close the run-missing hole (server-only, no protocol change)

In `decideDurableAttach`, make `run === undefined && context.resuming` return `"interrupted"` (the transcript the caller holds a prefix of no longer exists; restarting silently splices). Keep `run === undefined && !resuming` → `"attach"`.

**Verify**: a new unit test in `durable-stream-runner.test.ts` asserting `decideDurableAttach(undefined, { live: false, resuming: true }) === "interrupted"` and `(undefined, { live: true, resuming: true }) === "interrupted"` (a live run under a key whose row is gone means it is a different generation by construction — check whether this combination is reachable; if `claimStreamRun` always writes the row before chunks flow, `run === undefined && live` cannot occur and the first assertion suffices).

### Step 2: Thread the generation through the decision

- Extend `decideDurableAttach`'s context with `generation?: number` (the caller-echoed `startedAt`) and compare when both sides have one: `resuming && run !== undefined && context.generation !== undefined && context.generation !== run.startedAt` → `"interrupted"`, checked BEFORE the `live` short-circuit. An absent `context.generation` (older client) preserves today's behavior on the live path.
- Extend `DurableStreamAttach` with `generation?: number`; `attachOrThrow` passes it through.

**Verify**: unit tests — matching generation attaches/replays; mismatched generation returns `"interrupted"`; absent generation behaves as today.

### Step 3: Emit and echo the generation

- In `shard-do.ts`'s stream handler: read the caller's `generation` off the envelope next to where `sinceChunk` is read (`:4560` shows the envelope-field pattern), pass it into the attach request, and stamp the run's `startedAt` as `generation` on outbound chunk frames (and on the ack, if the ack is what the client keys resume state from — read `streamFrames` to decide; pick the frame the client already processes for `lastSeq`).
- In `lunora-client.ts`: store `generation` beside `lastSeq` when a frame carries it; include it in the resume message at `:4916`.
- Update `protocol/README.md`'s `stream` row and the durable-stream paragraph: `generation` is the run stamp echoed on resume; a mismatch yields the existing `STREAM_INTERRUPTED` error.

**Verify**: `pnpm --filter "@lunora/client" run test` and `pnpm --filter "@lunora/shard-engine" run test` → all pass; the client resume test asserts the resume frame carries the stored generation.

### Step 4: API snapshots

`pnpm run build:packages && pnpm run api:update` (the attach-envelope and client-type additions change public surfaces).

**Verify**: `pnpm run api:check` → exit 0.

## Test plan

- `packages/shard-engine/__tests__/durable-stream-runner.test.ts` (new): the decision-table cases from Steps 1–2 (model file structure on any small suite, e.g. `aggregate-tally.test.ts`).
- Client: extend the existing resume test (the one asserting `sinceChunk: stream.lastSeq`) with generation storage + echo.
- Integration (if the DO mocks project has a stream test today — check `grep -rln "durable" packages/do/__tests__`): one case reproducing the splice — run #1 produces chunks, reclaim starts run #2, a resume carrying run #1's generation gets `STREAM_INTERRUPTED`, not run #2's chunks.

## Done criteria

- [ ] All three packages' `test` + `lint:types` exit 0
- [ ] `decideDurableAttach(undefined, { live: false, resuming: true })` → `"interrupted"` (unit-asserted)
- [ ] Mismatched-generation resume yields `STREAM_INTERRUPTED` (unit- or integration-asserted)
- [ ] `protocol/README.md` documents `generation`
- [ ] `pnpm run api:check` exits 0 after `api:update`
- [ ] No files outside the in-scope list modified

## STOP conditions

- The "Current state" excerpts don't match (especially the `decideDurableAttach` body or the client resume line).
- The frame the client keys `lastSeq` from has no room for an extra field without breaking existing frame parsing (report the frame shape you found).
- Closing the live-splice hole requires the client change to be mandatory (i.e. absent-generation cannot stay compatible) — report rather than break older clients.
- The DO workerd suite is required to prove Step 3 and cannot boot in your environment — implement, run the mocks + unit suites, and report the workerd gap.

## Maintenance notes

- Old clients that never send `generation` keep today's (unsafe-only-on-live-splice) behavior; once the client change has been released for a while, a follow-up may make the server require the echo for `sinceChunk > 0`.
- Reviewer: scrutinize that `generation` is compared before the `live` short-circuit, and that the ephemeral stream path ignores the new field.
