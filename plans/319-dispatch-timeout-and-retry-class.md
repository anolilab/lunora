# Plan 319 — Bound the server-initiated dispatch call, and make the 4xx classification its docblock promises real

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO

> **Executor instructions**: follow this file top to bottom, run every verification
> command, stop on any §8 STOP condition, and update this plan's row in
> `plans/README.md` when done. §4 carries one decision the maintainer may want to
> make before WS2 — read it before starting.
>
> **Drift check (run first):**
> `git diff --stat 70b7451b5..HEAD -- packages/dispatch/src packages/workflow/src/run-step.ts packages/queue/src/dispatch.ts`
>
> **Build before you measure:** `pnpm run build:packages` once.

## 0. Headline finding

`createDispatchRunner` is the single path every `ctx.run(...)` takes from
`@lunora/workflow`, `@lunora/queue` and `@lunora/scheduler`. It has two gaps:

1. **No timeout.** The `fetch` has no `signal`, no `AbortController`, no deadline. An
   unresponsive origin holds the queue consumer or scheduled invocation open until the
   platform kills it. The _same package family_ already solved this for its
   best-effort observability POST — `queue/src/capture.ts` bounds its fetch at 5 s and
   explains why in a comment — so the load-bearing path is the one without the guard.
2. **The retry classification is documented but not implemented.** The docblock at
   `create-dispatch-runner.ts:30-40` states that a consumer "can distinguish a
   deterministic 4xx (map to a non-retryable failure / ack-without-retry) from a
   transient one". No consumer does: `workflow/src/run-step.ts` converts only a
   brand-checked portable `NonRetryableError`, and `queue/src/dispatch.ts` rethrows the
   handler's value verbatim. Nothing inspects `status`.

So a step whose `ctx.run(...)` fails with `VALIDATION_ERROR` burns its whole retry
budget with backoff — re-running the step body's side effects each time — on a failure
that can never succeed. On the queue side the whole batch is redelivered
`max_retries` times and then dead-lettered, taking healthy sibling messages with it.

## 1. Current state (audit)

`packages/dispatch/src/create-dispatch-runner.ts:129-136` — the unbounded call:

```ts
const response = await fetchImpl(url, {
    body: JSON.stringify({ args: args ?? {}, functionPath: function_.__lunoraRef, shardKey: runOptions.shardKey }),
    headers,
    method: "POST",
});

if (!response.ok) {
    throw toDispatchError(label, response.status, await response.text());
}
```

`packages/dispatch/src/create-dispatch-runner.ts:30-40` — the promise:

```
 * error's status. Reconstruct a `LunoraError` from that shape so the original
 * `code`/`status`/`data` survive and a consumer (`@lunora/workflow`'s
 * `createRunStep`, `@lunora/queue`'s consumer) can distinguish a deterministic
 * 4xx (map to a non-retryable failure / ack-without-retry) from a transient
 * one.
```

`packages/queue/src/capture.ts:35,126-129` — the pattern that already exists:

```ts
const CAPTURE_FETCH_TIMEOUT_MS = 5000;
...
const controller = new AbortController();
```

with the rationale in-comment: "an unresponsive root shard would stall the whole
`queue()` invocation (risking the consumer's execution limit)".

`packages/workflow/src/run-step.ts:82-88` — the consumer that does not classify:

```ts
} catch (error: unknown) {
    // The step BODY threw — that may be a transient failure (network
    // blip, a contended write), so it stays retryable: only a portable
    // NonRetryableError is converted, everything else rethrown as-is.
    return convertNonRetryableError(error, deps.nonRetryableErrorClass);
}
```

`packages/workflow/src/errors.ts:79-85` — `convertNonRetryableError` is brand-checked
via `isNonRetryableError`; a `LunoraError` with `status: 400` does not match.

`packages/queue/src/dispatch.ts:355-359` — verbatim rethrow, preserving
workerd's retry-on-throw.

Grep confirmation: `status >= 400` / `isNonRetryableError` appear nowhere in
`workflow`, `queue` or `scheduler` src except the `errors.ts` definition itself.

## 2. Existing seams (do not reinvent)

- `AbortController` + `setTimeout` + `clearTimeout` in `packages/queue/src/capture.ts:126-137`
  — copy this shape exactly, including the `finally` clear.
- `NonRetryableError` / `isNonRetryableError` / `convertNonRetryableError` in
  `packages/workflow/src/errors.ts` — the portable brand already exists and is already
  honoured at both the portable and native boundary. Promote to it; do not invent a
  second classification channel.
- `toDispatchError` in `create-dispatch-runner.ts:71+` — already reconstructs
  `code`/`status`/`data`. The status you need is already on the error.
- `RunFunctionOptions` (`packages/dispatch/src/types.ts`) — the existing per-call
  options bag; a `timeoutMs` belongs here, not in a new parameter.

## 3. The behavioural contract to preserve

1. A successful dispatch is unchanged — same body, same headers, same return value.
2. Workerd's retry-on-throw stays intact for everything _not_ classified as
   deterministic. Do not convert transient failures.
3. `408` and `429` are **never** non-retryable. A timeout and a rate limit are exactly
   the cases where retrying is correct.
4. An abort must surface as a **retryable** error — a timeout is transient by
   definition.
5. The identity headers (`x-lunora-userid`, `x-lunora-identity`) and their encoding are
   untouched.

## 4. Design decisions

**Chosen: default timeout, overridable per call.** A generous default (30 s) plus
`RunFunctionOptions.timeoutMs`. Rejected: no default, opt-in only — that leaves every
existing caller exposed, and the whole point is that the load-bearing path has no
guard. Rejected: matching `capture.ts`'s 5 s — that budget is right for a best-effort
side-channel and far too tight for a real function call.

**Chosen: an explicit deterministic-status allowlist — `400`, `403`, `404`, `422`.**
Rejected: "any 4xx". `408` (timeout) and `429` (rate limit) are retryable, and an
intermediary can emit either; treating them as permanent turns a recoverable failure
into a dead-lettered batch. Rejected: keying off `code` strings — statuses are the
stable, already-transported signal.

**Decision the maintainer may want to make first (§9 Q1):** the docblock and the code
disagree, and either one can be made true. This plan implements the docblock. If the
maintainer prefers today's retry-everything behaviour, the correct change is to delete
the claim from `create-dispatch-runner.ts:30-40` instead — that is a two-line edit and
WS2/WS3 are dropped. Ask before implementing WS2 if you can; if you cannot, implement
it as written and flag it in the handoff.

## 5. Workstreams

### WS1 — Bound the dispatch fetch (S)

In `packages/dispatch/src/create-dispatch-runner.ts`:

- Add `DEFAULT_DISPATCH_TIMEOUT_MS = 30_000` next to the other module constants.
- Add `timeoutMs?: number` to `RunFunctionOptions` in `packages/dispatch/src/types.ts`,
  documented as "abort the dispatch after this many ms; the abort is retryable".
- Wrap the `fetch` in an `AbortController` with `setTimeout`, pass `signal`, and
  `clearTimeout` in a `finally`. Mirror `packages/queue/src/capture.ts:126-137`.
- Map an abort to a `LunoraError` that is **not** in the deterministic set — give it a
  5xx-class status (503) so WS2's classifier leaves it retryable, and a message naming
  the function path and the elapsed budget.

**Verify:** `pnpm --filter "@lunora/dispatch" run test` green, plus the new abort test.

### WS2 — Classify deterministic failures at the two consumers (S–M)

Add one shared predicate. Put it in `@lunora/dispatch` (it owns the error
reconstruction) and export it:

```ts
/** Statuses a dispatch will fail on identically every time — retrying re-runs side effects for nothing. `408`/`429` are deliberately absent: a timeout and a rate limit are transient. */
const DETERMINISTIC_DISPATCH_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 422]);

const isDeterministicDispatchFailure = (error: unknown): boolean => {
    /* LunoraError guard + status membership */
};
```

Then:

- `packages/workflow/src/run-step.ts` — in the catch at `:82`, if
  `isDeterministicDispatchFailure(error)`, wrap into a portable `NonRetryableError`
  (preserving message and `cause`) **before** calling `convertNonRetryableError`, so
  both the portable and native boundaries keep working.
- `packages/queue/src/dispatch.ts` — at the rethrow (`:357`), a deterministic failure
  must **not** re-throw (throwing is what triggers workerd's retry). Ack the message
  instead and record the failure through whatever the module already uses for a
  dead-letter/failed accounting. **Read the surrounding batch/ack accounting before
  changing this** — if there is no ack-without-retry path already, that is a STOP
  condition (§8), because inventing one is a redelivery-semantics change, not a bug fix.

**Verify:** new tests in both packages (see §Test plan).

### WS3 — Docblock truth-up (S)

Update `create-dispatch-runner.ts:30-40` to describe what now happens, naming the
allowlist. A docblock promising a behaviour is what let this drift for as long as it
did.

## 6. Platform parity

Not applicable to the capability matrix — this changes the reliability of an existing
call path, not a `ctx.*` surface. `ctx.run` itself is already mapped. Note for the
Node host: `AbortController` and `fetch` signals are available on both targets, so the
timeout is `native` on each; no matrix row changes.

## 7. Phasing & ordering

| Phase | Work | Gate                                                                 |
| ----- | ---- | -------------------------------------------------------------------- |
| 0     | WS1  | new test: a never-resolving `fetchImpl` rejects within the budget    |
| 1     | WS2  | new tests: a 400 is non-retryable in workflow; a 429 stays retryable |
| 2     | WS3  | docblock matches the allowlist constant (grep both)                  |

WS1 ships alone and is worth landing even if WS2 is deferred by the §9 Q1 decision.

## Commands you will need

| Purpose        | Command                                              | Expected                                                                  |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Build          | `pnpm run build:packages`                            | exit 0                                                                    |
| Dispatch tests | `pnpm --filter "@lunora/dispatch" run test`          | all pass                                                                  |
| Workflow tests | `pnpm --filter "@lunora/workflow" run test`          | all pass                                                                  |
| Queue tests    | `pnpm --filter "@lunora/queue" run test`             | all pass                                                                  |
| Typecheck      | `pnpm --filter "@lunora/dispatch" run lint:types`    | exit 0                                                                    |
| API snapshot   | `pnpm run api:check`                                 | exit 0, or `api:update` after a fresh build if the new export is intended |
| Format, lint   | `pnpm run lint:prettier:fix && pnpm run lint:eslint` | exit 0                                                                    |

## Scope

**In scope:**

- `packages/dispatch/src/create-dispatch-runner.ts`, `packages/dispatch/src/types.ts`,
  `packages/dispatch/src/index.ts` (export the predicate)
- `packages/workflow/src/run-step.ts`
- `packages/queue/src/dispatch.ts`
- Tests in `packages/{dispatch,workflow,queue}/__tests__/`

**Out of scope:**

- `packages/queue/src/capture.ts` — already correct; it is the exemplar, not a target.
- `packages/workflow/src/errors.ts` — the `NonRetryableError` machinery is correct.
  Use it, do not modify it.
- Retry counts, backoff schedules, `max_retries`, dead-letter thresholds. This plan
  changes _whether_ something is retryable, never _how often_.
- `@lunora/scheduler` — it goes through the same runner and inherits WS1 for free.
  Do not add a third consumer-side classifier there in this plan.

## Git workflow

- Branch: `advisor/319-dispatch-timeout-and-retry-class`
- Suggested commits: `fix(dispatch): bound the server-initiated run fetch` then
  `fix(workflow): stop retrying deterministic dispatch failures`
- `@lunora/dispatch` is internal and not published, but `@lunora/workflow` and
  `@lunora/queue` are — note the behaviour change in the commit body so
  semantic-release records it.

## Test plan

**`packages/dispatch/__tests__/`** (extend the existing runner spec):

1. A `fetchImpl` that never settles rejects within `timeoutMs`, with an error whose
   status is not in the deterministic set.
2. `clearTimeout` runs on the success path — assert no pending timer keeps the test
   process alive (use fake timers; do not `sleep`).
3. `timeoutMs` from `RunFunctionOptions` overrides the default.

**`packages/workflow/__tests__/`** (extend the run-step spec):

4. A `ctx.run` rejecting with `LunoraError{status: 400}` surfaces as a
   `NonRetryableError` (portable brand, and native when the class is injected).
5. `status: 429` and `status: 500` stay retryable — rethrown unchanged.
6. A non-`LunoraError` throw is unchanged (regression guard on the existing path).

**`packages/queue/__tests__/`** (extend the dispatch spec):

7. A deterministic failure does not rethrow (no redelivery); a transient one still does.

Model all of these on the existing specs in each directory — do not introduce a new
mocking style.

## Done criteria

- [ ] All three suites exit 0 with the seven new cases passing
- [ ] `grep -n "AbortController" packages/dispatch/src/create-dispatch-runner.ts` → matches
- [ ] `grep -rn "408\|429" packages/dispatch/src` shows both statuses excluded from the deterministic set (in the constant or its comment)
- [ ] `pnpm run api:check` exits 0 (run `pnpm run build:packages` first — `api:update` reads `dist/`)
- [ ] `pnpm --filter "@lunora/workflow" run lint:types` exits 0
- [ ] `git status` shows no files outside the in-scope list
- [ ] `plans/README.md` row updated

## 8. Risks & STOP conditions

- **STOP** if `packages/queue/src/dispatch.ts` has no existing ack-without-retry /
  failed-message accounting path. Adding one changes delivery semantics for every
  consumer and needs its own plan. In that case land WS1 + the workflow half of WS2
  and report the queue half as blocked.
- **STOP** if `RunFunctionOptions` is part of a committed API snapshot in a way that
  makes adding an optional field a breaking change (check
  `api-snapshots/dispatch.api.md` — `@lunora/dispatch` is internal, so it likely has
  none, but `workflow`/`queue` do).
- **Risk:** a 30 s default may be shorter than a legitimately slow function on a cold
  shard. It is per-call overridable, and 30 s is well inside the platform's own
  invocation ceiling — but say so in the changelog so a user hitting it knows the knob
  exists.
- **Risk:** `AbortController` availability. Both workerd and Node ≥18 have it; no
  polyfill needed. Confirm no test environment stubs `fetch` in a way that ignores
  `signal` — if one does, the timeout test will hang rather than fail, which is worse
  than a red test.

## 9. Open questions

1. **Docblock or code? — ANSWERED 2026-08-11: the docblock is right, keep the
   classification.** The maintainer confirmed that a deterministic `ctx.run` failure
   burning the full retry budget — re-running the step body's side effects on each
   attempt — is the bug, and that the docblock describes the intent. Commit
   `970244c04` (workflow steps map a `400`/`403`/`404`/`422` dispatch failure to a
   portable `NonRetryableError`) **stays**. This is a retry-semantics change on a
   pre-1.0 surface and should be called out in the release notes. `408` and `429`
   remain retryable, and the timeout error is minted at `503` precisely so an abort
   stays outside the deterministic set.
2. Should `@lunora/scheduler` get the same consumer-side classification? It shares the
   runner, so WS1 covers it; the retry-classification half is a separate call.
3. Is 30 s the right default, or should it derive from the platform's remaining
   invocation budget where that is readable? Record the reasoning, not just the number.
