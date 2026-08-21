# Plan 418: Run the auth-audit DDL once per executor, not before every append/read

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
- **Category**: perf
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`ensureAuthAuditTable` (`packages/auth/src/audit.ts:176-202`) issues a `CREATE TABLE IF NOT EXISTS` **and** an unguarded `ALTER TABLE … ADD COLUMN target_email` whose duplicate-column error is caught. After the very first call, that ALTER throws on every subsequent call. `appendAuthAuditEntry` (`:215`) and `readAuthAuditLog` (`:263`) both call it first, and the audit append is awaited inside better-auth's `hooks.after` — i.e. on the request critical path of every sign-in / sign-up / password-change. Every audited auth request therefore pays 3 D1 round trips (create + throwing alter + insert) instead of 1, one of them a guaranteed SQL error.

## Current state

- `packages/auth/src/audit.ts:176-202` — `ensureAuthAuditTable(executor)`: the CREATE, then:
  ```ts
  try {
      await executor.run(`ALTER TABLE "${AUTH_AUDIT_TABLE}" ADD COLUMN target_email TEXT`, []);
  } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : ...;
      if (!message.includes("duplicate column")) { throw error; }
  }
  ```
- Call sites: `audit.ts:215` (`appendAuthAuditEntry`), `audit.ts:263` (`readAuthAuditLog`).
- The pattern to copy — `packages/auth/src/migrate.ts:30`:
  ```ts
  const migrating = new WeakMap<object, Promise<void>>();
  ```
  with its docblock explaining the per-reference single-flight semantics (dedupes only when the same long-lived object is reused — the Workers isolate-reuse case — and that this is sufficient).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/auth..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/auth" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/auth" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/auth" run lint:eslint` | exit 0 |

## Scope

**In scope**:
- `packages/auth/src/audit.ts`
- The audit test file (find it: `ls packages/auth/__tests__ | grep -i audit`) — add the single-flight test.

**Out of scope**:
- `migrate.ts` — the exemplar, not a target.
- The DDL itself (table shape, ALTER) — unchanged; only how often it runs.

## Git workflow

- Branch: shared wave branch `improve/wave22-auth`.
- Commit: `perf(auth): memoize audit table DDL per executor`

## Steps

### Step 1: Single-flight the DDL per executor

Add a module-level `const ensured = new WeakMap<SqlExecutor, Promise<void>>();` (mirror `migrate.ts:30`'s shape and copy the spirit of its docblock — dedupe is per executor reference, which is the Workers isolate-reuse case). Wrap `ensureAuthAuditTable`'s body:

```ts
const ensureAuthAuditTable = (executor: SqlExecutor): Promise<void> => {
    const inFlight = ensured.get(executor);
    if (inFlight) { return inFlight; }
    const run = ensureAuthAuditTableUncached(executor);
    ensured.set(executor, run);
    return run;
};
```

Important: on **rejection**, delete the cache entry (`run.catch(() => ensured.delete(executor))` — without swallowing the caller's error) so a transiently-failing first call doesn't poison the executor forever.

If `SqlExecutor` is not an object type suitable for a WeakMap key, STOP and report.

**Verify**: `pnpm --filter "@lunora/auth" run lint:types` → exit 0.

### Step 2: Test

In the audit test file, add: a counting fake `SqlExecutor` (the existing audit tests already build executors — model on them) through two `appendAuthAuditEntry` calls; assert the CREATE/ALTER statements ran once and the INSERT twice. Add a second case: first ensure rejects (executor throws on CREATE) → a later call retries the DDL.

**Verify**: `pnpm --filter "@lunora/auth" run test` → all pass including 2 new tests.

## Test plan

Covered in Step 2. Existing audit tests must stay green — they prove a fresh executor still self-provisions.

## Done criteria

- [ ] `pnpm --filter "@lunora/auth" run test` exits 0 with the 2 new tests
- [ ] `lint:types` + `lint:eslint` exit 0
- [ ] `ensureAuthAuditTable` bodies show the WeakMap single-flight with rejection eviction (read the diff)
- [ ] No files outside scope modified

## STOP conditions

- `SqlExecutor` is not always the same object identity across calls in the DO wiring (check how `auth-do.ts` constructs/passes the executor to `appendAuthAuditEntry`) — if a fresh executor object is built per request there, the memo never hits and the fix needs a different key; report instead of inventing one.
- Current-state excerpts don't match live code.

## Maintenance notes

- Any future `ALTER` added to this table must go inside the uncached function; the memo means it runs once per isolate, which is still correct for additive DDL.
