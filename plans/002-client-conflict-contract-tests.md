# Plan 002: Pin the client-side OCC conflict contract (CONFLICT code) with tests and a typed guard

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c865cfa6..HEAD -- packages/client/src packages/client/__tests__/cirrus-client.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (tests + one additive named export)
- **Depends on**: none (thematically pairs with plan 001)
- **Category**: tests
- **Planned at**: commit `c865cfa6`, 2026-06-13

## Why this matters

The server side promises a conflict contract: `ConflictError` in
`packages/do/src/transaction.ts` documents *"The runtime maps this to a 409
response so clients can decide whether to refetch + retry or surface the
conflict"*, and carries own-properties `code: "CONFLICT"` / `status: 409`.
The client *generically* propagates coded errors from the worker's
`{ error: { code, message } }` envelope — but nothing anywhere asserts that a
CONFLICT survives the trip: `grep -rn "CONFLICT" packages/client/src
packages/client/__tests__` returns zero hits. An envelope or error-mapping
change in the runtime would break every consumer's retry logic with no failing
test. This plan pins the contract with tests and gives users a typed
`isConflictError` guard so "refetch + retry" is writable without string
comparison against a magic constant.

## Current state

- `packages/do/src/transaction.ts:1-19` — the server-side error (do NOT modify;
  shown for context):

```ts
export class ConflictError extends Error {
    public readonly code: string = "CONFLICT";
    public readonly status: number = 409;
    ...
}
```

- `packages/client/src/cirrus-client.ts` — the HTTP RPC path (queries and
  mutations both go through `rpc()` → `fetch`) decodes the error envelope at
  ~lines 1775–1780:

```ts
if ("error" in body) {
    const error = new Error(body.error.message);

    (error as Error & { code?: string }).code = body.error.code;
    throw error;
}
```

  A similar decode exists for WS frames (`toCodedError`, ~lines 316–326) and
  for `adminFetch` (~lines 1852–1857). So the mechanism exists; the contract is
  just unpinned.

- `packages/client/__tests__/cirrus-client.test.ts` — the test suite. The
  exemplar for an error-envelope test is at ~line 160:

```ts
it("query surfaces server errors as thrown Error objects", async () => {
    expect.assertions(1);

    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: "NOT_FOUND", message: "missing" } }, { status: 404 }));

    const client = new CirrusClient({
        fetch: fetchMock,
        url: "https://app.example",
        WebSocket: createMockWebSocket(),
    });
    ...
```

  The file defines `jsonResponse`, `createMockWebSocket` (lines ~33–98), and
  `fnRef` helpers — reuse them.

- `packages/client/src/index.ts` — the package's public export surface; new
  exports are added here as named exports.
- Conventions: TypeScript ESM, **no `.js` extensions on relative imports**,
  **named exports only** (never mix default + named), Vitest.

## Commands you will need

| Purpose   | Command                                            | Expected on success |
|-----------|----------------------------------------------------|---------------------|
| Install   | `pnpm install`                                     | exit 0              |
| Tests     | `pnpm --filter "@cirrus/client" run test`          | all pass            |
| Typecheck | `pnpm --filter "@cirrus/client" run lint:types`    | exit 0              |
| Lint      | `pnpm --filter "@cirrus/client" run lint:eslint`   | exit 0              |

## Scope

**In scope** (the only files you should modify/create):
- `packages/client/src/errors.ts` (create — the guard + code constant)
- `packages/client/src/index.ts` (add the new named exports)
- `packages/client/__tests__/cirrus-client.test.ts` (add contract tests)
- `packages/client/__tests__/errors.test.ts` (create — guard unit tests)
- `plans/README.md` (status row update)

**Out of scope** (do NOT touch, even though they look related):
- `packages/client/src/cirrus-client.ts` — the envelope decoding works; this
  plan only pins it. No retry logic, no automatic refetch.
- `packages/do/**`, `packages/runtime/**` — server side is covered by plan 001
  and existing suites.
- Any automatic retry-on-conflict feature — explicitly deferred (see
  Maintenance notes).

## Git workflow

- Branch: `test/client-conflict-contract` off `alpha`.
- Conventional commits, e.g. `test(client): pin the conflict (409) error contract`
  and `feat(client): add isConflictError guard` (imperative, lowercase, ≤50 chars).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the typed guard

Create `packages/client/src/errors.ts` with named exports only:

```ts
/** Error code the server uses for optimistic-concurrency conflicts (HTTP 409). */
export const CONFLICT_ERROR_CODE = "CONFLICT";

/**
 * Whether an unknown rejection is an optimistic-concurrency conflict —
 * the server lost a write race and the caller should refetch and retry
 * (or surface the conflict). Structural check on the `code` property the
 * client attaches when decoding the worker's error envelope.
 */
export const isConflictError = (error: unknown): error is Error & { code: "CONFLICT" } =>
    error instanceof Error && (error as Error & { code?: unknown }).code === CONFLICT_ERROR_CODE;
```

Adjust doc-comment style to match neighboring files (e.g. read
`packages/client/src/offline-queue.ts` headers first). Export both symbols
from `packages/client/src/index.ts` alongside the existing named exports.

**Verify**: `pnpm --filter "@cirrus/client" run lint:types` → exit 0.

### Step 2: Unit-test the guard

Create `packages/client/__tests__/errors.test.ts` covering: a coded
`Error` with `code: "CONFLICT"` → true; `code: "NOT_FOUND"` → false; a plain
`Error` → false; non-Error values (`undefined`, a string, an object with
`code: "CONFLICT"` but not an Error) → false.

**Verify**: `pnpm --filter "@cirrus/client" run test -- errors` → all pass.

### Step 3: Pin the wire contract in `cirrus-client.test.ts`

Add tests next to the existing "query surfaces server errors" test (~line 160),
modeled on it:

1. **Mutation conflict carries the code**: `fetchMock` returns
   `jsonResponse({ error: { code: "CONFLICT", message: "optimistic concurrency conflict" } }, { status: 409 })`;
   call `client.mutation(fnRef("posts:update"), {...})` (use the suite's actual
   mutation-call helper/signature — read how other mutation tests in this file
   invoke it); assert the rejection satisfies `isConflictError(error)` and
   `error.message` is the server message.
2. **Query conflict carries the code**: same envelope via a query call;
   assert `isConflictError` is true.
3. **Other codes are not conflicts**: the existing 404/NOT_FOUND envelope
   rejection does NOT satisfy `isConflictError`.

**Verify**: `pnpm --filter "@cirrus/client" run test -- cirrus-client` → all pass.

### Step 4: Full package gates

**Verify**:
- `pnpm --filter "@cirrus/client" run test` → all pass
- `pnpm --filter "@cirrus/client" run lint:types` → exit 0
- `pnpm --filter "@cirrus/client" run lint:eslint` → exit 0

## Test plan

Covered by Steps 2–3. Structural pattern: the NOT_FOUND envelope test at
`packages/client/__tests__/cirrus-client.test.ts:160-170`.

## Done criteria

- [ ] `isConflictError` + `CONFLICT_ERROR_CODE` exported from `@cirrus/client` (named exports)
- [ ] `grep -n "CONFLICT" packages/client/__tests__/cirrus-client.test.ts` returns ≥2 hits (the new contract tests)
- [ ] `pnpm --filter "@cirrus/client" run test` exits 0
- [ ] `pnpm --filter "@cirrus/client" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/client" run lint:eslint` exits 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The error-envelope decode in `cirrus-client.ts` no longer matches the
  excerpt (e.g. errors are now class instances instead of coded plain Errors).
- The mutation contract test fails because the client does NOT attach the code
  on the mutation path — that's the latent bug this plan exists to catch;
  report it with the failing test rather than changing `cirrus-client.ts`.
- `packages/client/src/errors.ts` already exists with different content.

## Maintenance notes

- The guard makes `"CONFLICT"` part of the public API; renaming the server
  code is now a breaking change — that's the point.
- Explicitly deferred: an opt-in automatic refetch-and-retry helper for
  mutations (product decision: retry count, backoff, idempotency caveats), and
  an end-to-end workerd test provoking a *real* OCC conflict through
  runtime+do (backlog item in `plans/README.md`).
- Reviewer should scrutinize: that the new tests assert via `isConflictError`
  (so the guard itself is exercised against the real wire shape).
