# Plan 324 — Test the shared client mutation path three adapters depend on, and floor `@lunora/client`

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO

> **Executor instructions**: follow this file top to bottom, run every verification
> command, stop on any §8 STOP condition, and update this plan's row in
> `plans/README.md` when done. Tests only — no change under `packages/client/src/`
> except where §5 explicitly says otherwise.
>
> **Drift check (run first):**
> `git diff --stat 70b7451b5..HEAD -- packages/client/src/mutation-runner.ts packages/client/src/snapshot-precondition.ts packages/client/vitest.config.ts`
>
> **Build before you measure:** `pnpm run build:packages` once.

## 0. Headline finding

`createMutationRunner` is the framework-neutral half of the mutate hook in
`@lunora/solid`, `@lunora/vue` and `@lunora/svelte` — every non-React adapter's writes
go through it. It has **no test**: measured 7.14% statements, **0% branches, 0%
functions**. `snapshot-precondition.ts` — the staleness guard that decides whether a
queued offline mutation is dropped on replay — is 10% / 0% / 0%. Neither has a spec
file in `packages/client/__tests__/` (36 files, none matching `mutation-runner`,
`precondition`).

And `packages/client/vitest.config.ts` defines its coverage block inline **without
`thresholds`**, so nothing notices. That is the same silent-floor-drop
`packages/auth/vitest.config.ts:24-28` calls out by name.

The runner's whole reason to exist is the `inFlight` ref-count that keeps `pending`
from clearing while a second call is still running. That is the bug class it was
written to prevent, and there is not one assertion on it. The seam for testing it is
already built and unused — its client interface is deliberately narrowed to a single
method, documented as "narrowed so adapters can test against a stub".

## 1. Current state (audit)

`packages/client/src/mutation-runner.ts` in full is 62 lines. The load-bearing part:

```ts
// Ref-counted across overlapping calls of this one handle instance.
let inFlight = 0;

return async (args, options) => {
    inFlight += 1;
    sinks.setPending(true);

    try {
        const result = await client.mutation(function_, args, options);

        sinks.setResult(result);

        return result;
    } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));

        sinks.setError(normalized);

        throw normalized;
    } finally {
        inFlight -= 1;
        sinks.setPending(inFlight > 0);
    }
};
```

The stub seam, `mutation-runner.ts:4-7`:

```ts
/** The single transport method a mutation runner needs — narrowed so adapters can test against a stub. */
interface MutationCapableClient<F extends FunctionReference> {
    mutation: (function_: F, args: ArgsOf<F>, options?: MutationCallOptions<unknown, unknown, ArgsOf<F>>) => Promise<ReturnOf<F>>;
}
```

Consumers: `packages/solid/src/create-mutation.ts:42`,
`packages/vue/src/use-mutation.ts:55`, `packages/svelte/src/mutation.ts:60`.
(`packages/react/src/use-mutation.ts:59-75` duplicates the ref-count instead, forced by
TanStack's `onMutate`/`onSettled` state model — that duplication is deliberate and out
of scope.)

`packages/client/src/snapshot-precondition.ts:20-45` — four branches, all uncovered:
both-undefined, snapshot-only, current-only, and the `stableWireKey` comparison.

Other measured zeros in the package, listed for §9 rather than fixed here:
`src/auth/index.ts` 0% (27-121), `src/sw/client-sw.ts` 0%, `src/sw/sw.ts` 0%,
`src/sw/message-bridge.ts` 40.9%/22.2%, `src/upload.ts` 0%.

Package-wide measured: 80.94 statements / 72.86 branches / 73.83 functions / 81.03
lines — unenforced.

## 2. Existing seams (do not reinvent)

- **`MutationCapableClient`** — the one-method stub interface. Build a plain object
  literal against it; no mocking library, no `LunoraClient` instance.
- **`MutationRunnerSinks`** — three setters. Record calls into arrays and assert the
  _sequence_, which is where the ref-count bug would show.
- **`peekActiveQueryValue`** — the only client method `snapshot-precondition` calls.
  Stub it the same way.
- `packages/auth/vitest.config.ts:24-28` — the worked example for adding thresholds to
  an inline config that must stay inline.

## 3. The behavioural contract to preserve

The tests pin today's behaviour. In particular:

1. `setPending(true)` fires on entry, `setPending(inFlight > 0)` in `finally` — so with
   two overlapping calls, `setPending(false)` happens **once**, after the second
   settles.
2. A thrown non-`Error` is normalized to `Error` and the **normalized** value is both
   handed to `setError` and re-thrown (not the original).
3. `setResult` fires before the return; `setError` before the re-throw.
4. Options pass through to `client.mutation` untouched — optimistic-update options
   included.
5. `snapshot-precondition` returns `true` only when both sides are undefined or the
   `stableWireKey` values are equal.

## 4. Design decisions

**Chosen: test the runner directly, not through an adapter.** Rejected: covering it
via the Solid/Vue/Svelte hook specs. Those need a framework runtime, and a failure
there cannot distinguish a bug in the shared runner from a bug in the adapter's sinks —
which is precisely the confusion this module was extracted to remove.

**Chosen: add thresholds pinned just under today's measured package numbers.**
Rejected: pinning at the repo default (70/80/80/80) — `functions` measures 73.83, so
the default would red the build on arrival and the change would be reverted rather
than ratcheted.

**Chosen: `src/sw/**` stays out.** Its 0% is real but service-worker testing needs an
environment decision this plan should not make. Either exclude it from the coverage
denominator with a comment, or floor it separately — record which in §9.

## 5. Workstreams

### WS1 — `mutation-runner.test.ts` (S)

New file `packages/client/__tests__/mutation-runner.test.ts`. Cases:

1. **Happy path** — resolves, `setResult` called once with the value, `setPending`
   sequence is exactly `[true, false]`, `setError` never called.
2. **Overlapping calls (the regression case)** — two invocations against a deferred
   stub; resolve the first only. Assert `setPending` has **not** yet been called with
   `false`. Resolve the second → now it has, exactly once. This test fails if the
   ref-count is replaced with a naive boolean.
3. **Rejection with an `Error`** — `setError` receives that same instance; the mutate
   call rejects with it; `setPending` still returns to `false`.
4. **Rejection with a non-`Error`** (throw a string) — `setError` receives an `Error`
   whose message is `String(thrown)`, and the **same normalized instance** is what
   rejects. Assert identity, not just shape.
5. **Options pass-through** — the options object handed to `mutate` arrives at
   `client.mutation` unchanged (assert by reference).

Use fake timers or explicit deferred promises; do not `sleep`.

### WS2 — `snapshot-precondition.test.ts` (S)

New file, four cases mapping one-to-one to the four branches at
`snapshot-precondition.ts:32-44`: both undefined → `true`; snapshot undefined, current
present → `false`; snapshot present, current undefined → `false`; both present and
`stableWireKey`-equal → `true`; both present and different → `false`. Stub
`peekActiveQueryValue` to return different values on the two reads.

### WS3 — Add the floor (S)

Re-measure after WS1/WS2, then add a `thresholds` block to
`packages/client/vitest.config.ts` pinned just under the measured values, following
`packages/auth/vitest.config.ts:24-28`. Include a one-line comment saying why the file
is inline (the workers pool) _and_ that the floor is deliberate — the absence of that
sentence is how it went missing.

If `src/sw/**` is excluded rather than floored, put the exclusion in the same block
with its reason.

## 6. Platform parity

Not applicable — client-side tests and test configuration.

## 7. Phasing & ordering

| Phase | Work | Gate                                                                                          |
| ----- | ---- | --------------------------------------------------------------------------------------------- |
| 0     | WS1  | `pnpm --filter "@lunora/client" run test` green; case 2 fails if the ref-count is stubbed out |
| 1     | WS2  | all four precondition branches covered                                                        |
| 2     | WS3  | `pnpm --filter "@lunora/client" run test:coverage` passes with thresholds present             |

## Commands you will need

| Purpose      | Command                                              | Expected                        |
| ------------ | ---------------------------------------------------- | ------------------------------- |
| Build        | `pnpm run build:packages`                            | exit 0                          |
| Tests        | `pnpm --filter "@lunora/client" run test`            | all pass (647 today)            |
| Coverage     | `pnpm --filter "@lunora/client" run test:coverage`   | exit 0; read the per-file table |
| Typecheck    | `pnpm --filter "@lunora/client" run lint:types`      | exit 0                          |
| Format, lint | `pnpm run lint:prettier:fix && pnpm run lint:eslint` | exit 0                          |

## Scope

**In scope:**

- `packages/client/__tests__/mutation-runner.test.ts` (create)
- `packages/client/__tests__/snapshot-precondition.test.ts` (create)
- `packages/client/vitest.config.ts` (thresholds only)

**Out of scope:**

- Everything under `packages/client/src/`. If a test reveals a defect, that is a STOP
  condition (§8) — report it.
- `packages/react/src/use-mutation.ts`'s duplicated ref-count. It is ~5 lines forced by
  TanStack's state model; consolidating it is not worth the coupling.
- `src/auth/index.ts`, `src/upload.ts`, `src/sw/**` — real gaps, recorded in §9, not
  this plan's job.
- The Solid/Vue/Svelte adapter specs.

## Git workflow

- Branch: `advisor/324-client-mutation-path-tests`
- Suggested commit: `test(client): cover the shared mutation runner`

## Test plan

WS1 and WS2 are the test plan: 5 + 5 cases. Model the file layout and import style on
any existing spec in `packages/client/__tests__/`.

Prove case 2 is load-bearing: temporarily replace `inFlight` with a boolean, confirm the
test reds, restore.

## Done criteria

- [ ] `pnpm --filter "@lunora/client" run test` exits 0 with ~10 new cases
- [ ] `pnpm --filter "@lunora/client" run test:coverage` shows `mutation-runner.ts` and `snapshot-precondition.ts` at 100% branches (both are small and fully reachable — if not, say why in §9)
- [ ] `grep -n "thresholds" packages/client/vitest.config.ts` → match
- [ ] Lowering one threshold by hand reds the run (prove the floor is live)
- [ ] `git diff --stat -- packages/client/src` is empty
- [ ] `plans/README.md` row updated

## 8. Risks & STOP conditions

- **STOP and report** if the overlapping-calls test fails against today's code — that
  would mean the ref-count is already broken, which is a bug fix, not a coverage plan.
- **STOP** if `packages/client`'s workers pool refuses to run a plain node-environment
  spec. The config is workerd-gated; if the new specs cannot run in the existing
  projects, report rather than restructuring the package's test setup.
- **Risk:** pinning thresholds from a run that includes `src/sw/**` at 0% sets a floor
  that any later sw work perturbs. Decide the exclusion question (§9) before pinning.

## 9. Open questions

1. `src/sw/**` — exclude from coverage with a reason, or floor separately? Record the
   decision and the numbers behind it.
2. `src/auth/index.ts` is 0% across 95 lines of client auth surface. Worth its own
   plan? Record a yes/no with one line of reasoning.
3. Do the Solid/Vue/Svelte adapters have their own pending-state tests that would now
   be redundant? If so, note them; do not delete them in this plan.
