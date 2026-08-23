# Plan 426: Degrade one malformed audit `detail` cell to one incomplete entry, not an empty page

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. Your reviewer maintains
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/auth/src/audit.ts`
> On any change, compare the "Current state" excerpts; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`readAuthAuditLog` parses each row's `detail` cell with a bare `JSON.parse` inside `rows.map` (`packages/auth/src/audit.ts:310-314`). The table (`__lunora_auth_audit__`) is a plain SQL table an operator can also write to, and `appendAuthAuditEntry` accepts `redactDetail: false` for "trusted, pre-scrubbed" payloads — so `detail` is not guaranteed to be this function's own `JSON.stringify` output. One malformed cell throws out of the whole read: the Studio's Security/audit page 500s and shows **nothing** — the forensic surface fails closed on the one row most likely to be interesting. The request side of this route was already hardened (`auth-do.ts:237-268`); the row side was not.

## Current state

- `packages/auth/src/audit.ts:308-314` (inside the `rows.map` of `readAuthAuditLog`):
    ```ts
    const detail = text(row["detail"]);

    if (detail !== undefined) {
        base.detail = JSON.parse(detail) as Record<string, unknown>;
    }

    return base;
    ```

## Commands you will need

| Purpose    | Command                                        | Expected on success |
| ---------- | ---------------------------------------------- | ------------------- |
| Install    | `pnpm install`                                 | exit 0              |
| Build deps | `pnpm --filter "@lunora/auth..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/auth" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/auth" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/auth" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/auth/src/audit.ts` (the parse site only)
- The audit test file (find: `ls packages/auth/__tests__ | grep -i audit`)

**Out of scope**:

- `auth-do.ts` — the request-side hardening is done.
- The `AuthAuditEntry` type — `detail` is already optional; degrading to "absent" needs no type change. (If you instead choose a `{ raw }` marker, that WOULD change the type and the api snapshot — don't; absent is simpler and sufficient.)

## Git workflow

- Branch: shared wave branch `improve/wave22-auth`.
- Commit: `fix(auth): tolerate malformed audit detail rows`

## Steps

### Step 1: Guard the parse

```ts
if (detail !== undefined) {
    try {
        base.detail = JSON.parse(detail) as Record<string, unknown>;
    } catch {
        // A hand-written or truncated cell must not take down the whole read;
        // the entry stays, minus its detail payload.
    }
}
```

Also guard the non-object case: `JSON.parse("42")` succeeds but is not a `Record` — after parsing, keep the value only if it is a non-null object (`typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)`), else leave `detail` absent.

**Verify**: `pnpm --filter "@lunora/auth" run lint:types` → exit 0.

### Step 2: Test

In the audit test file (model on the existing `readAuthAuditLog` cases): insert one well-formed entry via `appendAuthAuditEntry`, then write one row with `detail = "{not json"` directly through the executor (the tests already run raw SQL through their executor — copy that), and one with `detail = "42"`. Assert the read returns all rows, the malformed/non-object ones without `detail`, the good one with it.

**Verify**: `pnpm --filter "@lunora/auth" run test` → all pass including the new case.

## Test plan

Covered in Step 2.

## Done criteria

- [ ] `pnpm --filter "@lunora/auth" run test` exits 0 with the new test
- [ ] `lint:types` + `lint:eslint` exit 0
- [ ] The bare `JSON.parse` at the read site is guarded (read the diff)
- [ ] No files outside scope modified

## STOP conditions

- Current-state excerpts don't match live code.

## Maintenance notes

- If a `{ raw }` fallback is ever wanted for forensics, that's an API-surface change (type + snapshot); this plan deliberately chose "absent".
