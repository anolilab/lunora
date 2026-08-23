# Plan 384: Align TTL and base-path validation across the three URL-signing helpers

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/storage/src/signed-url.ts packages/storage/src/presigned-url.ts packages/bindings/src/images/signed-delivery-url.ts shared/hmac-url.ts`
> On any drift, compare the "Current state" excerpts against live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

Three helpers sign URLs; they disagree on what a valid input is. `packages/storage/src/signed-url.ts` **throws** `VALIDATION_ERROR` on a non-positive or over-ceiling `expiresInSeconds`; `packages/storage/src/presigned-url.ts` (the S3 presign path) **silently clamps** the same input — a caller asking for a 30-day URL gets 7 days with no signal (an availability surprise mid-transfer), and `expiresInSeconds: 0` mints a 1-second URL instead of erroring. Separately, the images signed-delivery helper and the storage signed-url helper share a byte-for-byte canonical but diverge on the base-path guard: storage accepts `https://cdn.test//` (its `ONLY_SLASHES_RE` comment explains the URL builder collapses trailing slashes, so it MUST be accepted), while the images copy checks `basePath !== "/"` only, so the same legal input throws there. Divergent validation on security-adjacent twins is how the next copy-paste picks the wrong one.

## Current state

- `packages/storage/src/signed-url.ts:84-90` — the posture to converge on:
    ```ts
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/storage: expiresInSeconds must be a positive finite number");
    }
    if (expiresInSeconds > MAX_SIGNED_URL_TTL_SECONDS) {
        throw new LunoraError("VALIDATION_ERROR", `...must not exceed ... (7 days)`);
    }
    ```
    and `:38-42` + `:108-114` — `ONLY_SLASHES_RE = /^\/+$/u` base-path guard with the collapse rationale.
- `packages/storage/src/presigned-url.ts:108-118`:
    ```ts
    const requested = parameters.expiresInSeconds ?? DEFAULT_EXPIRES_SECONDS;
    const normalised = Number.isFinite(requested) ? requested : DEFAULT_EXPIRES_SECONDS;
    const expires = Math.min(Math.max(MIN_EXPIRES_SECONDS, Math.floor(normalised)), MAX_EXPIRES_SECONDS);
    ```
    An **absent** value defaulting to `DEFAULT_EXPIRES_SECONDS` is fine and stays; the silent clamp/NaN-fallback for **explicit** values is the defect.
- `packages/bindings/src/images/signed-delivery-url.ts:96-106` — the divergent guard:
    ```ts
    if (basePath !== "" && basePath !== "/") {
        throw new TypeError(`...baseUrl must not carry a path...`);
    }
    ```
    (`https://cdn.test//` → pathname `"//"` → throws here, accepted by storage.)
- `shared/hmac-url.ts` — the shared canonical home: exports `MAX_SIGNED_URL_TTL_SECONDS` (`:33`), `extractHost`, `signCanonical`, `verifyCanonical`, etc. Both packages import it already, so a shared validator adds no new dependency edge. NOTE: the images helper throws `TypeError` while storage throws `LunoraError` — `shared/` must stay zero-dep, so the shared validator cannot construct a `LunoraError`. Shape it as a predicate/normalizer that RETURNS a problem description, with each caller throwing its own error type.

## Commands you will need

| Purpose   | Command                                                                                             | Expected on success |
| --------- | --------------------------------------------------------------------------------------------------- | ------------------- |
| Install   | `pnpm install`                                                                                      | exit 0              |
| Build     | `pnpm --filter "@lunora/storage..." run build && pnpm --filter "@lunora/bindings..." run build`     | exit 0              |
| Tests     | `pnpm --filter "@lunora/storage" run test && pnpm --filter "@lunora/bindings" run test`             | all pass            |
| Typecheck | `pnpm --filter "@lunora/storage" run lint:types && pnpm --filter "@lunora/bindings" run lint:types` | exit 0              |
| Lint      | both packages `run lint:eslint`                                                                     | exit 0              |

## Scope

**In scope**:

- `shared/hmac-url.ts` (add the two shared validators)
- `packages/storage/src/signed-url.ts` (switch to shared validators — behavior unchanged)
- `packages/storage/src/presigned-url.ts` (explicit-invalid → throw; absent → default, unchanged)
- `packages/bindings/src/images/signed-delivery-url.ts` (adopt the `ONLY_SLASHES_RE` guard via shared helper)
- `packages/storage/__tests__/presigned-url.test.ts`, `signed-url.test.ts`; `packages/bindings/__tests__/images/` signed-delivery tests

**Out of scope**:

- `MAX_EXPIRES_SECONDS` for S3 (7 days is AWS SigV4's own ceiling — the ceiling value is correct, only the silent clamp goes).
- The HMAC canonical itself — signatures must remain byte-identical; this plan touches validation only.

## Git workflow

- Branch: `improve/wave22-storage`
- Commit: `fix(storage): validate signed-url ttl and base path uniformly`

## Steps

### Step 1: Shared validators in `shared/hmac-url.ts`

- `validateTtlSeconds(value: number, maxSeconds: number): string | undefined` — returns a human-readable problem ("must be a positive finite number" / "must not exceed N seconds") or `undefined` when valid. Pure, zero-dep.
- `isOnlySlashesPath(path: string): boolean` — the `/^\/+$/u` test with the collapse-rationale comment moved here.
  Export both (named), keeping the existing export list style at `:157`.

### Step 2: Converge the three callers

- `signed-url.ts`: replace its two inline checks with `validateTtlSeconds` + keep throwing the same `LunoraError`s (messages may consolidate; keep the "(7 days)" hint). Base-path guard switches to `isOnlySlashesPath`.
- `presigned-url.ts`: for an EXPLICIT `expiresInSeconds`, run `validateTtlSeconds(value, MAX_EXPIRES_SECONDS)` and throw `LunoraError("VALIDATION_ERROR", ...)` on a problem (this removes the NaN→default and over-ceiling→clamp behaviors); absent value keeps `DEFAULT_EXPIRES_SECONDS`. `MIN_EXPIRES_SECONDS` floor for valid small values (e.g. 0.5 → floor 0?) — a positive sub-1 value: `Math.floor` yields 0, which S3 rejects; treat `< 1` as invalid in the same throw. Delete the now-dead clamp comment; write one line saying explicit invalid input throws, matching `signed-url.ts`.
- `signed-delivery-url.ts`: replace `basePath !== "/"` with `!isOnlySlashesPath(basePath)` (keep throwing `TypeError` with its existing message).

**Verify**: `pnpm --filter "@lunora/storage" run lint:types && pnpm --filter "@lunora/bindings" run lint:types` → exit 0.

### Step 3: Tests

- `presigned-url.test.ts`: explicit `0`, `-5`, `NaN`, `MAX+1` each throw `VALIDATION_ERROR`; absent still defaults (existing test); `MAX_EXPIRES_SECONDS` exactly is accepted.
- `signed-url.test.ts`: unchanged assertions keep passing (the refactor is behavior-preserving there).
- images tests: `https://cdn.test//` base URL now signs successfully AND its signed URL verifies (the storage suite has the equivalent case to model on).

**Verify**: both packages `run test` → all pass, ~6 new cases.

## Test plan

Covered in Step 3; pattern files: `packages/storage/__tests__/presigned-url.test.ts` and the images signed-delivery test file.

## Done criteria

- [ ] `grep -n "Math.min(Math.max" packages/storage/src/presigned-url.ts` → no matches (clamp gone)
- [ ] `grep -n 'basePath !== "/"' packages/bindings/src/images/signed-delivery-url.ts` → no matches
- [ ] All commands in the table exit 0
- [ ] No files outside the in-scope list modified

## STOP conditions

- Any existing caller in-repo passes an over-ceiling or zero TTL and relied on the clamp (grep call sites of `buildPresignedUrl` first; report if one does).
- Changing the images guard alters any signed-URL byte output (it must not — validation only).

## Maintenance notes

- The two validators are now the single source; the fourth future signing helper must import them. Reviewer: confirm signatures/canonicals are untouched (run both packages' full signing test suites, not just the new cases).
