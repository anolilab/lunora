# Plan 101: Typed error discriminators for the client + framework adapters

> **Executor instructions**: Follow step by step; run each verify. STOP
> conditions halt you. Update `plans/README.md` when done unless a reviewer owns it.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- packages/client/src packages/react/src packages/server/src/error.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

Lunora's headline features are RLS and realtime, so the two most common per-call
errors a UI must handle are an RLS `FORBIDDEN` and a rate-limit
`TOO_MANY_REQUESTS` (which carries `data.retryAfterMs`). But the client exports
only `isConflictError`; `LunoraClientError.code` is typed as bare `string` and
`data` as `unknown`, and `@lunora/react` re-exports **no** error helpers at all
(`useMutation` returns `error: Error | null`). A React user must reach into
`@lunora/client`/`lunorash/client` and hand-write `(error as { code?: string
}).code === "FORBIDDEN"` and cast `error.data` to read `retryAfterMs`. Shipping
typed discriminators + a client-safe code union closes a daily-use ergonomics gap
central to the framework's story.

## Current state

Server error codes (`packages/server/src/error.ts:13-54`) — the full set:
`BAD_REQUEST(400)`, `CONFLICT(409)`, `COUNT_RLS_UNSUPPORTED(422)`,
`FORBIDDEN(403)`, `INTERNAL_SERVER_ERROR(500)`, `MASK_UNSUPPORTED(422)`,
`NOT_FOUND(404)`, `NOT_IMPLEMENTED(501)`, `RELATION_PREDICATE_UNSUPPORTED(422)`,
`TOO_MANY_REQUESTS(429)`, `UNAUTHORIZED(401)`, `UNPROCESSABLE(422)`.
`export type LunoraErrorCode = keyof typeof CODE_STATUS;` The `data` payload
(e.g. `{ retryAfterMs }`) is propagated verbatim only for an explicit
`LunoraError`.

Client error surface today (`packages/client/src/errors.ts`, entire file):
```ts
const CONFLICT_ERROR_CODE = "CONFLICT";
const isConflictError = (error: unknown): error is Error & { code: "CONFLICT" } =>
    error instanceof Error && (error as Error & { code?: unknown }).code === CONFLICT_ERROR_CODE;
export { CONFLICT_ERROR_CODE, isConflictError };
```
Re-exported at `packages/client/src/index.ts:6`:
```ts
export { CONFLICT_ERROR_CODE, isConflictError } from "./errors";
```

The client error type (`packages/client/src/lunora-client.ts:463-475`):
```ts
/** An `Error` carrying the server's machine-readable `code` and (for a `LunoraError`) structured `data`. The client's public error contract for RPC/batch failures. */
type LunoraClientError = Error & { code?: string; data?: unknown };
const reconstructError = (errorBody: { code?: string; data?: unknown; message?: string }): LunoraClientError => {
    const error = new Error(errorBody.message ?? "request failed") as LunoraClientError;
    error.code = errorBody.code;
    if (errorBody.data !== undefined) error.data = decodeWire(errorBody.data);
    return error;
};
```
`LunoraClientError` is exported at `lunora-client.ts:4566`.

React (`packages/react/src/index.ts`) re-exports no error helpers; `useMutation`
types `error: Error | null` (`packages/react/src/use-mutation.ts:17`).

**Convention notes**:
- The client is framework-neutral and dependency-free; `@lunora/server` is a
  server package. **Do NOT** import `@lunora/server` into `@lunora/client` (wrong
  dependency direction / would pull the server into the browser bundle). Define
  the client-safe code union locally in `@lunora/client`, mirroring the server's
  string literals. The two lists drifting is a risk — see Maintenance notes for
  how to guard.
- Named exports only; no mixed default + named (see `CLAUDE.md`).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Build (deps) | `pnpm --filter "@lunora/react..." run build` | exit 0 |
| Typecheck client | `pnpm --filter "@lunora/client" run lint:types` | exit 0 |
| Typecheck react | `pnpm --filter "@lunora/react" run lint:types` | exit 0 |
| Test client | `pnpm --filter "@lunora/client" run test` | all pass |
| Lint | `pnpm --filter "@lunora/client" run lint:eslint` | exit 0 |

## Scope

**In scope**:
- `packages/client/src/errors.ts` — add discriminators + a client-safe code union
  + a typed `getErrorCode`.
- `packages/client/src/index.ts` — export the new helpers/types.
- `packages/client/src/lunora-client.ts` — tighten `LunoraClientError["code"]` to
  the new union (keep `data` accessor typed helpers rather than widening the base
  type if that risks breakage — see Step 2).
- `packages/react/src/index.ts` — re-export the error helpers from
  `@lunora/client` so a React-only user gets them without a second import.
- New test file `packages/client/__tests__/errors.test.ts`.

**Out of scope**:
- `@lunora/vue` / `@lunora/solid` / `@lunora/svelte` re-exports — do them in a
  follow-up if desired, but keep this plan to client + react to bound risk. (Note
  the follow-up in the index.)
- Changing the wire/`reconstructError` decode logic beyond the `code` type.
- The server error definitions.

## Git workflow

- Branch: `advisor/101-typed-client-error-discriminators`
- Commit: `feat(client): typed error-code discriminators; re-export from react`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Add the client-safe code union + discriminators

In `packages/client/src/errors.ts`, add a union of the codes a client can
observe (mirror the server list; you may omit purely server-internal ones if
justified, but include at minimum `CONFLICT`, `FORBIDDEN`, `UNAUTHORIZED`,
`TOO_MANY_REQUESTS`, `BAD_REQUEST`, `NOT_FOUND`, `UNPROCESSABLE`,
`INTERNAL_SERVER_ERROR`). Add:
- `type LunoraErrorCode = "CONFLICT" | "FORBIDDEN" | …;`
- `getErrorCode(error: unknown): LunoraErrorCode | undefined` — structural read
  of `.code` narrowed to the union (unknown strings → return the raw string typed
  as the union? No — return `undefined` for unrecognized, OR return the raw
  string widened; pick: return the `.code` value typed `LunoraErrorCode |
  undefined`, returning it only when it matches the union, else `undefined`. Keep
  it simple and total.)
- `isForbiddenError`, `isUnauthorizedError`, `isRateLimitedError` — each an
  `error is Error & { code: "<CODE>" }` guard mirroring `isConflictError`.
- For rate-limit, add a typed data reader:
  `getRetryAfterMs(error: unknown): number | undefined` that reads
  `(error as { data?: { retryAfterMs?: unknown } }).data?.retryAfterMs` when it
  is a finite number. This is the concrete payoff (no hand-casting `data`).

Keep `CONFLICT_ERROR_CODE`/`isConflictError` exactly as-is (back-compat).

**Verify**: `pnpm --filter "@lunora/client" run lint:types` → exit 0.

### Step 2: Tighten `LunoraClientError["code"]`

In `lunora-client.ts`, change `type LunoraClientError = Error & { code?: string;
data?: unknown }` so `code?` is the new `LunoraErrorCode | (string & {})` union
(the `string & {}` keeps unknown server codes assignable without losing
autocomplete). Import the union type from `./errors`. If widening breaks any
internal assignment, prefer the `LunoraErrorCode | (string & {})` form over a
hard union. Leave `data?: unknown` (the typed reader in Step 1 is the safe
access path).

**Verify**: `pnpm --filter "@lunora/client" run lint:types` → exit 0.

### Step 3: Export from client + react

- `packages/client/src/index.ts`: add the new names to the existing
  `export { … } from "./errors"` line and export the `LunoraErrorCode` type.
- `packages/react/src/index.ts`: re-export the error helpers + type from
  `@lunora/client` (`export { getErrorCode, getRetryAfterMs, isConflictError,
  isForbiddenError, isRateLimitedError, isUnauthorizedError } from
  "@lunora/client"; export type { LunoraErrorCode } from "@lunora/client";`).
  Match the file's existing re-export style.

**Verify**: `pnpm --filter "@lunora/react" run lint:types` → exit 0.

### Step 4: Tests

Create `packages/client/__tests__/errors.test.ts` covering each guard
(true/false), `getErrorCode` (known code, unknown code → undefined, non-Error →
undefined), and `getRetryAfterMs` (present number, missing, non-number).

**Verify**: `pnpm --filter "@lunora/client" run test` → all pass, new tests included.

## Test plan

- `packages/client/__tests__/errors.test.ts` — model after any existing small
  unit test in `packages/client/__tests__` for structure. Cases:
  - `isForbiddenError` true for `{ code: "FORBIDDEN" }`, false otherwise.
  - `isRateLimitedError` true for `{ code: "TOO_MANY_REQUESTS" }`.
  - `getRetryAfterMs` returns the number from `{ data: { retryAfterMs: 1500 } }`,
    `undefined` when absent/non-number.
  - `getErrorCode` returns the union member for a known code, `undefined` for an
    unknown string and for a non-Error.
  - `isConflictError` unchanged (regression).
- Verification: `pnpm --filter "@lunora/client" run test` → all pass.

## Done criteria

- [ ] `@lunora/client` exports `isForbiddenError`, `isUnauthorizedError`, `isRateLimitedError`, `getErrorCode`, `getRetryAfterMs`, and the `LunoraErrorCode` type, alongside the unchanged `isConflictError`/`CONFLICT_ERROR_CODE`.
- [ ] `@lunora/react` re-exports those helpers + the type.
- [ ] `LunoraClientError["code"]` is the typed union (not bare `string`).
- [ ] `pnpm --filter "@lunora/client" run lint:types` + `run test` exit 0; `pnpm --filter "@lunora/react" run lint:types` exits 0.
- [ ] `pnpm --filter "@lunora/client" run lint:eslint` exits 0.
- [ ] `git status` shows only in-scope files.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- Tightening `code` to a union breaks internal client assignments that can't be
  resolved with `LunoraErrorCode | (string & {})` — STOP and report rather than
  scattering `as` casts.
- You find yourself importing `@lunora/server` into `@lunora/client` — that is the
  wrong dependency direction; define the union locally instead.
- `@lunora/react`'s `index.ts` cannot re-export from `@lunora/client` without a
  new dependency edge that isn't already declared in its `package.json` — check
  `packages/react/package.json` deps first; `@lunora/client` should already be a
  dep (react wraps the client). If not, STOP.

## Maintenance notes

- **Drift guard**: the client-side `LunoraErrorCode` union mirrors
  `packages/server/src/error.ts`'s `CODE_STATUS` keys by hand. When a server code
  is added/removed, update the client union. Consider a shared const in a
  dependency-free location (e.g. `shared/`) if this drifts in practice — but that
  is a follow-up, not this plan.
- Follow-up (deferred): re-export the same helpers from `@lunora/vue`,
  `@lunora/solid`, `@lunora/svelte` for adapter parity.
- A reviewer should confirm `data` is still only read via `getRetryAfterMs`-style
  typed helpers and not widened to a structured type on `LunoraClientError`
  itself (the wire `data` is genuinely `unknown`).
