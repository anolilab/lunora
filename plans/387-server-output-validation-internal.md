# Plan 387: Re-tag `.output()` validation failures as internal errors on the RPC path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/server/src/builder/index.ts packages/server/src/http.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

When a builder-defined `query`/`mutation`/`action` declares `.output(...)` and the handler's return value drifts from that schema, the raw `ValidationError` escapes to the client. `ValidationError` carries code `VALIDATION_ERROR`, which the error catalog registers as a plain 400 (`packages/errors/src/catalog.ts:81` — `{ status: 400, title: "Validation failed" }`, no internal flag), so `toErrorBody` echoes the message verbatim — and that message contains the concrete offending server-side value (`describeValue` with `literal: true` embeds up to 80 chars of the primitive, e.g. `string "admin"`). A server contract bug is thus (a) leaked to an unauthenticated client and (b) misreported as a client 400, invisible to 5xx alerting. The REST path already does the right thing: `applyOutput` in `http.ts` catches the same error and rethrows it as `INTERNAL_SERVER_ERROR` with the explicit rationale "a mismatch here is a server contract bug, not a client error". This plan makes the RPC path match.

## Current state

- `packages/server/src/builder/index.ts:81-94` — `makeHandler` ends with:
    ```ts
    const result = await userHandler({ args: parsed, ctx: resolvedContext });

    return (output ? output.parse(result) : result) as Awaited<R>;
    ```
    The `ValidationError` from `output.parse` escapes untagged.
- `packages/server/src/http.ts:353-366` — the exemplar to mirror:
    ```ts
    /**
     * Parse the handler result through `.output()`. A mismatch here is a server
     * contract bug, not a client error, so re-tag it as a 500.
     */
    const applyOutput = (output: Validator, result: unknown): unknown => {
        try {
            return output.parse(result);
        } catch (error: unknown) {
            if (error instanceof ValidationError) {
                throw new LunoraError("INTERNAL_SERVER_ERROR", `Response did not match the declared output schema: ${error.message}`);
            }

            throw error;
        }
    };
    ```
    `applyOutput` is module-private (not exported).
- `packages/errors/src/to-error-body.ts` — an internal-coded `LunoraError` gets its message replaced with `redactedMessage` and `redacted: true`; the DO edge (`packages/do/src/shard-do.ts` around line 5930) then `console.error`s the raw error server-side. `INTERNAL_SERVER_ERROR` is internal-coded, so re-tagging automatically gets redaction + server-side logging.
- `LunoraError` in `@lunora/server` is imported from `packages/server/src/error.ts` (see `http.ts:8`).
- There is also `makeStreamHandler` directly below `makeHandler` in `builder/index.ts` — check whether it applies an output validator; if it does not parse output, leave it alone.

## Commands you will need

| Purpose    | Command                                          | Expected on success |
| ---------- | ------------------------------------------------ | ------------------- |
| Install    | `pnpm install`                                   | exit 0              |
| Build deps | `pnpm --filter "@lunora/server..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/server" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/server" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/server" run lint:eslint` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `packages/server/src/builder/index.ts`
- `packages/server/src/http.ts` (only to export/move the shared helper)
- A new shared-helper module inside `packages/server/src/` if you extract one (e.g. `packages/server/src/apply-output.ts`)
- `packages/server/__tests__/builder.test.ts` (add regression test)

**Out of scope**:

- `packages/errors/*` — the catalog entry for `VALIDATION_ERROR` stays a 400; args validation failures ARE client errors.
- `packages/do/*` — the DO edge already handles internal codes correctly.
- `makeStreamHandler`'s streaming semantics — only touch it if it parses output the same way (it likely does not).

## Git workflow

- Branch: `improve/wave22-server`
- Commit: `fix(server): re-tag output mismatches as internal`

## Steps

### Step 1: Extract the shared helper

Move `applyOutput` from `http.ts` into a small module (e.g. `packages/server/src/apply-output.ts`) with a named export, keeping its docstring. Import it back into `http.ts` (delete the local copy) and into `builder/index.ts`. Named exports only (repo convention); no `.js` extension on the import specifiers.

**Verify**: `pnpm --filter "@lunora/server" run lint:types` → exit 0.

### Step 2: Use it in `makeHandler`

Replace the final line of `makeHandler`:

```ts
return (output ? applyOutput(output, result) : result) as Awaited<R>;
```

**Verify**: `pnpm --filter "@lunora/server" run test` → existing suite passes (if an existing test asserted a 400/`VALIDATION_ERROR` from an output mismatch, that test encoded the bug — update it to expect `INTERNAL_SERVER_ERROR` and note it in the commit body).

### Step 3: Regression test

In `packages/server/__tests__/builder.test.ts`, add a test: a builder function with `.output(v.object({ n: v.number() }))` whose handler returns `{ n: "not-a-number" }` — calling the handler rejects with a `LunoraError` whose `code` is `"INTERNAL_SERVER_ERROR"` (not `ValidationError`/`VALIDATION_ERROR`), and whose message does **not** contain `"not-a-number"`... note: the re-tagged message DOES embed `error.message` (which contains the value) — that is fine because `toErrorBody` redacts internal codes at the wire; assert the code, not the message. Model the test on the existing `.output()` tests in the same file (search for `output` in the file).

**Verify**: `pnpm --filter "@lunora/server" run test -- builder` → all pass including the new test.

## Test plan

- New test in `builder.test.ts`: output mismatch → thrown error is `LunoraError` with `code === "INTERNAL_SERVER_ERROR"`.
- Existing `.output()` happy-path tests stay green.
- Existing args-validation tests stay green (args failures must remain `ValidationError`/400 — only the output path changes).

## Done criteria

- [ ] `grep -n "output.parse" packages/server/src/builder/index.ts` → no matches (routed through the shared helper)
- [ ] Exactly one definition of `applyOutput` in `packages/server/src/` (`grep -rn "const applyOutput" packages/server/src/ | wc -l` → 1)
- [ ] `pnpm --filter "@lunora/server" run test` exits 0 with the new test
- [ ] `pnpm --filter "@lunora/server" run lint:types` and `lint:eslint` exit 0
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The `makeHandler` excerpt doesn't match the live code.
- `@lunora/client` (or any in-repo consumer) has a test asserting a 400 `VALIDATION_ERROR` from an output mismatch that cannot be updated within `packages/server`'s scope — report which one.
- `makeStreamHandler` turns out to parse per-frame output through the same path and re-tagging would change streaming error frames — stop and report rather than deciding stream semantics alone.

## Maintenance notes

- Any future result-parsing site (new transport, new builder verb) must use `applyOutput`, never bare `output.parse` — that's the reviewable invariant.
- Reviewer: confirm args-path errors still surface as 400s; only the output path may change.
