# Plan 415: Validate every import envelope with its line number, not only when a remap is configured

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/cli/src/commands/data-transfer/import-rows.ts`
> On any change, compare the "Current state" excerpts against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug | dx
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`lunora import`'s row transform validates each NDJSON envelope — with a line-numbered error ("line N: import envelope is not valid JSON…", "line N: … missing a string `table`") — **only** on the remap path. Its own comment explains why the validation exists: "Without this the operator gets a bare `Unexpected token …` with no way to find the offending line in a multi-GB NDJSON file." But the most common invocation (plain `lunora import`, no `--with-storage`, no `--table`, no remap) forwards the raw line to the server unparsed, so a corrupted file fails as a whole-batch server error with no line number — exactly the diagnosis problem the remap path solved.

## Current state

- `packages/cli/src/commands/data-transfer/import-rows.ts:102-117` — the transform's tail:
    ```ts
    // Every envelope is parsed when a rewrite is configured — a storage id or
    // an object path can sit in a plain column, which no substring of the
    // line announces. With neither, the line goes through untouched.
    return storageIdMap === undefined && remapDocument === undefined ? trimmed : remapEnvelope(trimmed, lineNumber);
    ```
- `:60-80` — `remapEnvelope` does `JSON.parse` (throwing the line-numbered `LunoraError`), then the `typeof parsed["table"] !== "string"` check, then the optional rewrites, then `JSON.stringify(parsed)`.

Design note: on the no-remap path the output must stay the **original trimmed line**, not a re-`stringify` — re-encoding a line that wasn't modified would churn key order/whitespace for no reason and cost a serialization per line. Parse for validation, forward the original string.

## Commands you will need

| Purpose    | Command                                       | Expected on success |
| ---------- | --------------------------------------------- | ------------------- |
| Install    | `pnpm install`                                | exit 0              |
| Build deps | `pnpm --filter "@lunora/cli..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/cli" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/cli" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/cli" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/cli/src/commands/data-transfer/import-rows.ts`
- The existing import-rows test file (find: `grep -rln "import-rows\|remapEnvelope\|import envelope" packages/cli/__tests__ | head`)

**Out of scope**:

- The server-side `/_lunora/admin/import` endpoint.
- The `--table` bare-document path (`wrapBareDocument`) — it already parses and line-numbers.
- Streaming/perf restructuring of the import pipeline.

## Git workflow

- Branch: `improve/wave22-cli`
- Commit: `fix(cli): name the line for invalid import envelopes`

## Steps

### Step 1: Split validation from rewriting

Refactor `remapEnvelope` into `parseEnvelope(trimmed, lineNumber)` (the JSON.parse + `table` string check, returning the parsed object — the two thrown `LunoraError`s move here verbatim) and the rewrite half that takes the parsed object. The transform tail becomes: always `parseEnvelope`; if no remap configured, return `trimmed` (the original string); else run the rewrite on the already-parsed object and return `JSON.stringify(parsed)` as today. No line is parsed twice.

**Verify**: `pnpm --filter "@lunora/cli" run lint:types` → exit 0.

### Step 2: Tests

In the existing import-rows test file, add: (a) no-remap transform of an invalid-JSON line → throws with `line 3:` (use line 3) and "not valid JSON"; (b) no-remap transform of `{"doc":{}}` (no `table`) → throws the missing-`table` message with the line number; (c) no-remap transform of a valid envelope returns the **identical original string** (assert `toBe`, not `toEqual` after reparse — the no-restringify property).

**Verify**: `pnpm --filter "@lunora/cli" run test` → all pass including the 3 new tests.

## Test plan

The 3 cases above, modeled on the existing remap-path tests in the same file.

## Done criteria

- [ ] `pnpm --filter "@lunora/cli" run test` exits 0 with the 3 new tests
- [ ] `pnpm --filter "@lunora/cli" run lint:types` and `lint:eslint` exit 0
- [ ] The no-remap valid-envelope path returns the original string (test c)
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The "Current state" excerpts don't match the live code.
- A profiling-motivated comment or test elsewhere asserts the no-remap path must NOT parse (a deliberate perf trade-off with a recorded rationale) — report the conflict instead of overriding it.

## Maintenance notes

- If import throughput on huge files ever matters, the parse-per-line here is the knob — measure before optimizing; the operator-diagnosis property is worth a lot.
- Reviewer: confirm error messages match the remap path's exact phrasing so docs/tooling matching on them see one format.
