# Plan 117: Close the HTTP-action redaction gap, flag internal 500 codes, fix the NOT_UNIQUE hint, add lunorash/errors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- packages/server/src/http.ts packages/errors/src/catalog.ts packages/lunora/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security / bug / dx
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

`@lunora/errors` (#101) introduced `toErrorBody` as the **single wire-redaction
seam**: an internal-coded or unrecognized error never echoes its message to a
client. Every transport edge was migrated — except one: the **non-streaming
HTTP-action error path** in `packages/server/src/http.ts` still returns
`error.message` verbatim for any `LunoraError`, including internal-coded ones.
A concrete reachable leak exists in the same file: `applyOutput` throws
`INTERNAL_SERVER_ERROR` with a message embedding the output-schema validation
failure, which then echoes to the client. Three smaller consistency fixes ride
along: two runtime-throwable status-500 catalog codes are missing
`internal: true` (their messages — env key names, auth-wiring guidance — cross
the wire); the `NOT_UNIQUE` catalog hint gives write-side (`.upsert()`) advice
even though its only producers are read-side `.unique()` calls; and the
`lunorash` umbrella has no `./errors` subpath, so umbrella-only consumers can
throw `LunoraError` (via `lunorash/server`) but cannot import `isLunoraError`
or the catalog helpers.

## Current state

- `packages/server/src/http.ts:327-338` — the gap:

    ```ts
    /** Map a thrown error to its HTTP response, re-throwing anything unrecognised. */
    const errorResponse = (error: unknown): Response => {
        if (error instanceof ValidationError) {
            return Response.json({ code: "BAD_REQUEST", error: error.message }, { status: 400 });
        }

        if (error instanceof LunoraError) {
            return Response.json({ code: error.code, error: error.message }, { status: error.status });
        }

        throw error;
    };
    ```

- `packages/server/src/http.ts:315-321` — the reachable internal-coded leak:

    ```ts
    const applyOutput = (output: Validator, result: unknown): unknown => {
        try {
            return output.parse(result);
        } catch (error: unknown) {
            if (error instanceof ValidationError) {
                throw new LunoraError("INTERNAL_SERVER_ERROR", `Response did not match the declared output schema: ${error.message}`);
            }
    ```

- `packages/server/src/http.ts:458-472` — the **streaming** path in the same
  file was already migrated and is the pattern to mirror:

    ```ts
    const { body, redacted } = toErrorBody(error, { fallbackCode: "INTERNAL_SERVER_ERROR", redactedMessage: "Internal error" });

    if (redacted) {
        // eslint-disable-next-line no-console -- log internal errors server-side; never echo raw details to the client
        console.error("[lunora] unhandled stream handler error:", error);
    }
    ```

- `packages/errors/src/catalog.ts` — the `internal` flag exists on the
  INTERNAL family (lines 80-84: `INTERNAL`, `INTERNAL_SERVER_ERROR`,
  `RPC_FAILED` all `internal: true, status: 500`) but these four 500s lack it
  (lines 104-107):

    ```ts
    CODEGEN_DIAGNOSTIC: { status: 500, title: "Codegen diagnostic" },
    SCHEMA_SNAPSHOT_PARSE: { status: 500, title: "Schema snapshot parse error" },
    ENV_INVALID: { status: 500, title: "Invalid environment" },
    AUTH_HEADERS_MISSING: { status: 500, title: "Auth headers missing" },
    ```

    `ENV_INVALID` is thrown at `packages/server/src/env.ts:203-212`
    (`LunoraEnvError`) with a message **enumerating failing env keys**;
    `AUTH_HEADERS_MISSING` at `packages/auth/src/middleware.ts:108+`
    (`LunoraAuthHeadersError`) with server-wiring guidance. Both are
    runtime-reachable. `CODEGEN_DIAGNOSTIC`/`SCHEMA_SNAPSHOT_PARSE` are
    build-time only.

- `packages/errors/src/catalog.ts:58-67` — the wrong hint:

    ```ts
    NOT_UNIQUE: {
        hint: [
            "A row with the same value already exists in a `unique` index.",
            "",
            "- If you meant to upsert, use `ctx.db.<table>().upsert(...)` (or `.patch(...)` an existing row) instead of `.insert(...)`.",
            '- Otherwise pick a value that isn\'t already taken, and consider surfacing a friendly "already exists" message to the user.',
        ],
        status: 400,
        title: "Unique constraint violation",
    },
    ```

    The **only** producers of `NOT_UNIQUE` in the codebase are read-side:
    `packages/do/src/ctx-db.ts:1325` and `packages/sql-store/src/ctx-db.ts:3180`,
    both `throw new NotUniqueError(`unique() on table "…" matched N documents;
    expected at most one`)`. Write-side unique-index breaches throw
    `ConflictError` → code `CONFLICT` instead.

- `packages/lunora/package.json` — the umbrella's `exports` map has `./server`,
  `./values`, `./runtime`, `./do`, `./client`, `./flags`, … but **no
  `./errors`**, and `dependencies` has no `@lunora/errors`. Subpath source
  files are one-liners, e.g. `packages/lunora/src/values.ts`:

    ```ts
    export * from "@lunora/values";
    ```

Conventions: TypeScript ESM, `moduleResolution: "bundler"` → **no `.js`
extensions** in relative imports; named exports only when a file has >1
export; `dist/` is gitignored (build deps before typecheck/tests). Enforced
commit types: `build, chore, ci, deps, docs, feat, fix, perf, refactor,
revert, security, style, test, translation`.

## Commands you will need

| Purpose             | Command                                         | Expected on success              |
| ------------------- | ----------------------------------------------- | -------------------------------- |
| Build deps of a pkg | `pnpm --filter "@lunora/<pkg>..." run build`    | exit 0                           |
| Server tests        | `pnpm --filter "@lunora/server" run test`       | all pass                         |
| Errors tests        | `pnpm --filter "@lunora/errors" run test`       | all pass                         |
| Umbrella build      | `pnpm --filter "lunorash" run build`            | exit 0, `dist/errors.mjs` exists |
| Types               | `pnpm --filter "@lunora/<pkg>" run lint:types`  | exit 0                           |
| ESLint              | `pnpm --filter "@lunora/<pkg>" run lint:eslint` | exit 0                           |

## Scope

**In scope** (the only files you should modify):

- `packages/server/src/http.ts`
- `packages/server/__tests__/http.test.ts` (add tests)
- `packages/errors/src/catalog.ts`
- `packages/errors/__tests__/` (update/add hint + internal-flag tests)
- `packages/lunora/package.json`, `packages/lunora/src/errors.ts` (create)
- Any test that asserts the old NOT_UNIQUE hint text or the un-redacted
  http error body (fix expectations only).

**Out of scope** (do NOT touch):

- `packages/errors/src/guards.ts` (`isLunoraError` looseness is plan 119).
- The hand-rolled `{ error: { code } }` envelopes in do/runtime/scheduler
  (plan 118).
- The streaming path in `http.ts` (already correct).
- `ValidationError` handling in `errorResponse` (a 400 echoing the validation
  message is intended client feedback).
- The wire shape `{ code, error }` of the non-streaming response — clients
  parse it; only the _message value_ changes for internal codes.

## Git workflow

- Branch: `advisor/117-errors-redaction-quick-wins`
- Suggested commits: `security(server): redact internal errors on the http-action path`
  (commitlint accepts `security`), `fix(errors): mark runtime 500 codes internal + fix NOT_UNIQUE hint`,
  `feat(lunora): add lunorash/errors subpath`.

## Steps

### Step 1: Route `errorResponse` through `toErrorBody`

In `packages/server/src/http.ts`, replace the `instanceof LunoraError` branch
of `errorResponse` with the streaming path's pattern (keep the
`ValidationError` branch and the final `throw error` fall-through exactly as
they are):

```ts
if (error instanceof LunoraError) {
    const { body, redacted, status } = toErrorBody(error, { fallbackCode: "INTERNAL_SERVER_ERROR", redactedMessage: "Internal error" });

    if (redacted) {
        // eslint-disable-next-line no-console -- log internal errors server-side; never echo raw details to the client
        console.error("[lunora] http action error (redacted on the wire):", error);
    }

    return Response.json({ code: body.code, error: body.message }, { status });
}
```

`toErrorBody` is already exported from `@lunora/errors`; check the file's
existing imports (the streaming code at line ~465 already uses it, so the
import exists). Preserve the response shape `{ code, error }` — do not add
`hint`/`docsUrl` keys to this path in this plan.

**Verify**: `pnpm --filter "@lunora/server..." run build && pnpm --filter "@lunora/server" run test` → all pass (some existing tests may assert the old
echoed message for internal codes — fix those expectations to `"Internal error"`).

### Step 2: Mark the runtime-reachable 500 codes internal

In `packages/errors/src/catalog.ts`, change:

```ts
ENV_INVALID: { internal: true, status: 500, title: "Invalid environment" },
AUTH_HEADERS_MISSING: { internal: true, status: 500, title: "Auth headers missing" },
```

Add a one-line comment above `CODEGEN_DIAGNOSTIC` and `SCHEMA_SNAPSHOT_PARSE`
noting they are build-time-only and never cross the wire (deliberately not
`internal`), so the posture is documented rather than accidental.

Before committing, run `grep -rn "isInternalCode" packages/*/src shared/` and
confirm every consumer is a wire seam (`to-error-body.ts` and transport
mappers). If any CLI/terminal renderer branches on `isInternalCode` to decide
what to _display locally_, STOP — flipping these flags would hide local error
detail.

**Verify**: `pnpm --filter "@lunora/errors" run test` → all pass;
`pnpm --filter "@lunora/auth" run test` and
`pnpm --filter "@lunora/server" run test` → all pass (fix any test asserting
these codes' messages echo across `toErrorBody`).

### Step 3: Rewrite the NOT_UNIQUE hint for its actual producer

Replace the `NOT_UNIQUE` hint array with read-side guidance, e.g.:

```ts
NOT_UNIQUE: {
    hint: [
        "`.unique()` matched more than one document — it expects the query to identify at most one row.",
        "",
        "- If several matches are legitimate, use `.first()` (take one) or `.collect()` (take all) instead.",
        "- Otherwise tighten the query (e.g. filter on a unique/indexed field) so it can only match one row.",
    ],
    status: 400,
    title: "Query matched more than one document",
},
```

Keep the code and status unchanged. Update any test asserting the old hint or
title text (`grep -rn "NOT_UNIQUE" packages/*/__tests__` to find them).

**Verify**: `pnpm --filter "@lunora/errors" run test` and
`pnpm --filter "@lunora/do" run test` → all pass.

### Step 4: Add the `lunorash/errors` subpath

1. `packages/lunora/src/errors.ts` (create): `export * from "@lunora/errors";`
2. `packages/lunora/package.json`: add `"@lunora/errors": "<current version>"`
   to `dependencies` (read the exact version from
   `packages/errors/package.json` `version` field — the umbrella pins exact
   versions, e.g. `"@lunora/do": "1.0.0-alpha.23"`), and add the export entry
   mirroring `./values`:

    ```json
    "./errors": {
     "types": "./dist/errors.d.ts",
     "import": "./dist/errors.mjs"
    }
    ```

3. Check `pnpm-workspace.yaml` `overrides` already maps
   `"@lunora/errors": "workspace:*"` (it should — 37 packages depend on it);
   if missing, add it (known requirement for workspace linking).
4. `pnpm install`, then build.

**Verify**: `pnpm --filter "lunorash" run build` → exit 0 and
`ls packages/lunora/dist/errors.mjs packages/lunora/dist/errors.d.ts` → both
exist. `pnpm --filter "lunorash" run lint:types` → exit 0.

## Test plan

New tests in `packages/server/__tests__/http.test.ts`, modeled on the file's
existing route-invocation tests:

1. A handler that throws `new LunoraError("INTERNAL_SERVER_ERROR", "leaky details")`
   → response status 500, body `{ code: "INTERNAL_SERVER_ERROR", error: "Internal error" }`
   (assert the string `"leaky details"` does NOT appear in the body).
2. A route with `.output()` whose handler returns a non-conforming value →
   500 and the body's `error` is `"Internal error"` (the schema-mismatch
   details stay server-side).
3. A handler that throws `new LunoraError("BAD_REQUEST", "user-facing reason")`
   → 400 and `error === "user-facing reason"` (non-internal codes still echo —
   regression guard for the intended behavior).

If `packages/errors/__tests__/errors.test.ts` has a table of internal codes,
extend it with `ENV_INVALID` and `AUTH_HEADERS_MISSING`.

## Done criteria

- [ ] `pnpm --filter "@lunora/server" run test` → all pass incl. the 3 new tests
- [ ] `pnpm --filter "@lunora/errors" run test` → all pass
- [ ] `grep -n 'error.message' packages/server/src/http.ts` shows no hit inside
      the `LunoraError` branch of `errorResponse` (the `ValidationError` branch
      may keep one)
- [ ] `grep -A1 'ENV_INVALID' packages/errors/src/catalog.ts` shows `internal: true`
- [ ] `packages/lunora/dist/errors.mjs` exists after build
- [ ] `lint:types` + `lint:eslint` exit 0 for server, errors, lunora
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `errorResponse` or `applyOutput` in `http.ts` no longer match the excerpts.
- Any consumer of `isInternalCode` outside the wire seams branches on it for
  local display (Step 2 grep).
- A client-package test asserts it can _read_ the `ENV_INVALID` or
  `AUTH_HEADERS_MISSING` message from a wire response (that would mean some
  flow intentionally surfaces them — report which).
- The umbrella build fails to emit `dist/errors.mjs` (packem entry discovery
  may need a config entry — report rather than guessing at packem config).

## Maintenance notes

- Rule going forward (worth a future advisor lint): **any catalog code with
  `status: 500` must either set `internal: true` or carry a comment explaining
  why not.** Plan 119 (guard hardening) and plan 118 (envelope consolidation)
  build on this posture.
- Reviewers should scrutinize Step 1's log line: it must log the **raw** error
  server-side exactly when `redacted` is true, mirroring the streaming path.
- Deferred: exposing `hint`/`docsUrl` on the non-streaming HTTP error body
  (shape change; needs client-side consumers first).
