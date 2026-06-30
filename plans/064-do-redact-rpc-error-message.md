# Plan 064: Stop the shard DO from echoing raw error messages to clients

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9f779358..HEAD -- packages/do/src/shard-do.ts packages/runtime/src/errors.ts`
> If `shard-do.ts` changed since this plan was written, compare the
> "Current state" excerpt against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `9f779358`, 2026-06-29

## Why this matters

When a query/mutation/action handler throws anything that isn't a
`ConflictError`, `ValidationError`, or `LunoraError`, the shard Durable Object's
`errorToResponse` falls through to a branch that puts the raw `error.message`
straight into the JSON response body. The runtime forwards that DO response to
the client **verbatim**, so an unexpected exception leaks its message — which can
contain SQL fragments, file paths, internal identifiers, or third-party API
error text — to any caller over RPC and WebSocket. The runtime's own
`toErrorResponse` helper already does the right thing for this exact case
(redacts to `"Internal error"`, logs the raw error server-side); the DO's
fall-through contradicts it. This closes an information-disclosure gap with a
one-branch change that matches an existing in-repo convention.

## Current state

- `packages/do/src/shard-do.ts` — the shard DO. `errorToResponse(error)`
  (private method, starts at line 4269) maps a thrown value to a JSON `Response`.
  The first three branches are intentional, client-safe messages and must NOT
  change:
    - `ConflictError` → keeps `error.code` / `error.message` (an OCC conflict the
      client needs to see).
    - `ValidationError` (`@lunora/values`) → 400 with the validator message
      (developer-facing schema message, intentional).
    - `LunoraError` → keeps its declared `code` / `message` / `status` (an
      author-thrown, intentionally-surfaced error).
    - **The final fall-through is the bug** (lines 4290–4292):

        ```ts
        const message = error instanceof Error ? error.message : "unknown error";

        return jsonResponse({ error: { code: "RPC_FAILED", message } }, 500);
        ```

- `packages/runtime/src/create-worker.ts:2079-2091` — the runtime returns the
  DO's `Response` (or a clone preserving the `x-d1-bookmark` header) to the
  client unchanged, so whatever the DO put in the body reaches the caller.

- `packages/runtime/src/errors.ts:79-90` — **the convention to match.** For an
  unrecognized error it logs the raw error server-side and returns a generic
  body:

    ```ts
    // Do NOT echo arbitrary error.message values to clients — they may
    // contain stack traces, file paths, or internal identifiers. Log the
    // raw error server-side and return a generic message.
    // eslint-disable-next-line no-console
    console.error("[lunora] unhandled error:", error);

    const body: LunoraErrorBody = { error: { code: "INTERNAL", message: "Internal error" } };

    return Response.json(body, {
        headers: { "content-type": "application/json" },
        status: 500,
    });
    ```

    Note `shard-do.ts` already uses `console.warn` with an eslint-disable comment
    (around line 4256), so `console.error` with the same disable is in keeping with
    the file.

## Commands you will need

| Purpose          | Command                                     | Expected on success      |
| ---------------- | ------------------------------------------- | ------------------------ |
| Build deps first | `pnpm run build:packages`                   | exit 0 (run once)        |
| Typecheck        | `pnpm --filter "@lunora/do" run lint:types` | exit 0, no errors        |
| Tests            | `pnpm --filter "@lunora/do" run test`       | all pass, incl. new test |
| Lint             | `pnpm run lint:eslint`                      | exit 0 (0 errors)        |

> `dist/` is gitignored and built on demand; a raw per-package test does not
> rebuild workspace deps. Run `pnpm run build:packages` once before the first
> typecheck/test so cross-package `@lunora/*` types resolve.

## Scope

**In scope** (the only files you should modify):

- `packages/do/src/shard-do.ts` — only the `errorToResponse` fall-through branch.
- `packages/do/__tests__/shard-do.test.ts` — add one regression test.

**Out of scope** (do NOT touch, even though they look related):

- The `ConflictError`, `ValidationError`, and `LunoraError` branches of
  `errorToResponse` — their messages are intentional, client-safe surfaces.
- `packages/runtime/src/errors.ts` — already correct; it's the exemplar, not a
  target.
- `packages/runtime/src/create-worker.ts` — forwarding the DO response is correct.

## Git workflow

- Branch: `advisor/064-do-redact-rpc-error-message` (or match the repo's
  convention if one is evident in `git branch`).
- Commit message style: Angular conventional commits, e.g.
  `security(do): redact unhandled error messages in errorToResponse`.
  (Enforced commit types: `build, chore, ci, deps, docs, feat, fix, perf,
refactor, revert, security, style, test, translation` — `security` fits.)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Redact the fall-through and log the raw error server-side

Replace the fall-through branch (the last two statements of `errorToResponse`,
currently lines 4290–4292) so it no longer puts `error.message` in the body.
Mirror `runtime/src/errors.ts:79-90`: log the raw error with `console.error`,
return a generic message. Keep the `RPC_FAILED` code (it's the DO's established
code for an unhandled handler throw; only the message is the leak).

Target shape:

```ts
// Do NOT echo arbitrary error.message values to clients — an unhandled
// throw may carry SQL fragments, file paths, or internal identifiers. Log
// the raw error server-side and return a generic message (mirrors
// `@lunora/runtime`'s `toErrorResponse`).
// eslint-disable-next-line no-console -- server-side diagnostic for an unhandled handler error
console.error("[@lunora/do] unhandled RPC error:", error);

return jsonResponse({ error: { code: "RPC_FAILED", message: "internal error" } }, 500);
```

**Verify**: `pnpm --filter "@lunora/do" run lint:types` → exit 0, no errors.

### Step 2: Add a regression test

In `packages/do/__tests__/shard-do.test.ts`, add a test that drives a handler
throwing a plain `Error` with a recognizable sensitive-looking message and
asserts the resulting RPC response body's `error.message` is the generic
`"internal error"` (NOT the thrown text), with code `RPC_FAILED` and status 500.

- First read `packages/do/__tests__/shard-do.test.ts` to find how it already
  exercises the RPC path and `RPC_FAILED` (it references that code today). Reuse
  that harness — do not invent a new one.
- The assertion that matters: the thrown message string does **not** appear
  anywhere in the response body, and `error.message === "internal error"`.

**Verify**: `pnpm --filter "@lunora/do" run test` → all pass, including the new test.

## Test plan

- New test in `packages/do/__tests__/shard-do.test.ts`: a handler that throws
  `new Error("table users column secret_token does not exist")` (a stand-in for a
  leaky internal message) produces a 500 whose body is
  `{ error: { code: "RPC_FAILED", message: "internal error" } }` and contains
  none of the thrown substring.
- Structural pattern: model after the existing `RPC_FAILED` / error-path test in
  the same file.
- Verification: `pnpm --filter "@lunora/do" run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter "@lunora/do" run lint:types` exits 0.
- [ ] `pnpm --filter "@lunora/do" run test` exits 0; the new regression test passes.
- [ ] `pnpm run lint:eslint` exits 0.
- [ ] The fall-through branch no longer references `error.message`
      (`grep -n "RPC_FAILED" packages/do/src/shard-do.ts` shows the message is a
      string literal, not `error.message`).
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- `errorToResponse` no longer matches the "Current state" excerpt (the file
  drifted).
- The existing tests assert that a raw handler message IS returned to the client
  anywhere — that would mean the leak is load-bearing somewhere and the change
  needs a wider discussion.
- Redacting the fall-through breaks a test that depended on the raw message in a
  non-test-double, production-path assertion.

## Maintenance notes

- If a future change wants to surface a _specific_ internal error to clients,
  the correct path is to throw a `LunoraError` with an intentional, vetted
  message — not to widen the fall-through.
- Reviewer should confirm the three intentional branches
  (Conflict/Validation/Lunora) are untouched and only the generic fall-through
  changed.
