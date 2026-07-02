# Plan 093: Durable, atomic rate limiting for `@lunora/auth` on Workers (`incrementOne` + storage)

> **Executor instructions**: Follow step by step; run every verification and
> confirm the expected result before continuing. **Step 0 is blocking** — this
> plan is built on two assumptions about better-auth `1.6.22` that were not
> verifiable when it was written (better-auth was not installed; the GitHub core
> API was rate-limited). If Step 0 disproves either, stop and reshape the plan.
> On any STOP condition, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Numbering note**: 094 is not a file — it lives as the "Follow-on 094" section
> inside `plans/092-typed-identity-layer.md`. This plan is 093.
>
> **Drift check (run first)**: `git diff --stat c490bad..HEAD -- packages/auth/src/store.ts packages/auth/src/sql-store.ts packages/auth/src/adapter.ts packages/auth/src/create-auth.ts`
> If any changed, re-verify the "Current state" excerpts before proceeding.

## Status

- **Priority**: P1 (rate limiting silently not enforced across isolates is a
  security-relevant gap, not a perf nicety)
- **Effort**: M
- **Risk**: MEDIUM (touches the auth data path + a security control)
- **Depends on**: none
- **Category**: fix (auth)
- **Planned at**: commit `c490bad`, 2026-07-01

## Why this matters

`createAuth` turns rate limiting **on by default** (`create-auth.ts:195`,
`rateLimit.enabled ?? true`) but never sets `rateLimit.storage`. So the limiter
uses better-auth's default store. On Cloudflare Workers that default is
process memory, which is **per-isolate and non-durable**: each isolate keeps its
own counter, counters vanish on isolate recycle, and traffic spread across
isolates never sums to the configured `max`. The result is the worst kind of
security control — one that reports as "enabled" while not enforcing a global
limit. Brute-force / credential-stuffing protection on `/sign-in`, OTP, and
password-reset is the exact thing this is supposed to buy.

Making the limit real means pointing better-auth at durable storage
(`rateLimit.storage: "database"` → the counter rides Lunora's adapter → `ctx.db`
over the D1 auth tables). But that exposes a second gap: better-auth #10000
("harden atomic state transitions," a breaking change **merged 2026-06-12, so
inside pinned 1.6.22**) removed the read-then-update fallback and requires custom
adapters to implement a **native atomic `incrementOne`** — "one `consume`
decision per request … the fallback read-then-update paths are removed because
they could not provide the same one-winner guarantee across processes." Lunora's
`AuthStore` implements `consumeOne` (atomically, via `DELETE … RETURNING`) but
has **no `incrementOne`**. Without it, a DB-backed counter falls back to
read-then-increment, which on Workers races: two concurrent requests both read
`count=4`, both write `5`, and a `max` of 5 passes 6+.

So the fix is one coherent change: **add native atomic `incrementOne` to the
store/adapter, and default the limiter to durable storage** — durable _and_
one-winner, the same standard `consumeOne` already meets for single-use tokens.

## Current state (verified at `c490bad`)

- `packages/auth/src/store.ts` — the `AuthStore` interface exposes
  `consumeOne, count, create, read, remove, update`. **No `incrementOne`.** Its
  `consumeOne` doc already states the principle this plan extends: implementing
  the operation natively "closes the read-then-delete race the factory's
  `findMany` + `deleteMany` fallback would otherwise leave open." The same
  argument applies to increment.
- `packages/auth/src/store.ts` — `createMemoryAuthStore` (the reference store the
  tests run better-auth against) implements the interface with a synchronous
  find-and-splice `consumeOne` ("no `await` interleaves, so this is an atomic
  single-row consume"). A memory `incrementOne` follows the same synchronous
  pattern.
- `packages/auth/src/sql-store.ts` — `createSqlAuthStore` backs the interface
  with D1 SQL and already uses `RETURNING` (the `consumeOne` `DELETE … RETURNING`
  at ~line 184). D1 supports `INSERT … ON CONFLICT … DO UPDATE … RETURNING`, so
  an atomic upsert-increment is expressible in one statement.
- `packages/auth/src/adapter.ts:44–72` — `lunoraAuthAdapter` maps the
  better-auth `CustomAdapter` methods onto the store. It wires `consumeOne`
  (line 47) but **no `incrementOne`**.
- `packages/auth/src/create-auth.ts:180–195` — fills `rateLimit.enabled: true`
  when the caller is silent, and forwards `window`/`max` verbatim. It does
  **not** set `rateLimit.storage`.

## Step 0 (blocking): verify the two better-auth `1.6.22` assumptions

Install and inspect the real types/behavior — do not trust this plan's memory of
them (the version postdates the author's reference knowledge, and #10000's exact
surface was read from a PR description, not the code):

```bash
pnpm install
# (1) The atomic increment method: name, where it lives, exact signature.
grep -rn "incrementOne\|consumeOne\|CustomAdapter" node_modules/better-auth/dist/**/*.d.ts | head
# (2) The default rate-limit storage, and whether "database" routes through the
#     custom adapter (vs. requiring a separate secondaryStorage):
grep -rn "rateLimit\|storage" node_modules/better-auth/dist/**/*.d.ts | grep -i "storage\|memory\|secondary" | head
```

Confirm and record in the PR description:

1. The atomic increment operation is named `incrementOne` (or record the real
   name), its interface (on `CustomAdapter`? optional?), and its exact
   signature/return.
2. better-auth's **default** `rateLimit.storage` (confirm it is `"memory"`), and
   that `rateLimit.storage: "database"` drives the limiter through the configured
   `database` adapter (i.e. through Lunora's store). If instead it needs
   `secondaryStorage` (KV/Redis-shaped), the storage half of this plan changes
   target — see "If Step 0 diverges."

**If (1) shows no atomic-increment method exists in 1.6.22** → the `incrementOne`
work is moot; reduce this plan to the storage default + a known-limitation note,
and STOP for re-scoping. **If (2) shows the default is already durable** → drop
the storage half; keep `incrementOne` only if the adapter path uses it.

## If Step 0 diverges (decision record)

- Increment routes through `secondaryStorage`, not the DB adapter → the durable
  target becomes a Workers-native secondary store (Durable Object or KV) with an
  atomic increment, not the D1 store. (A DO counter is the natural fit and aligns
  with better-auth #9004 "custom storage adapters for rate limiting, e.g. DO".)
  Re-scope before coding; do not force it through the SQL store.
- `max`/`window` semantics differ from a plain counter (e.g. sliding window) →
  match better-auth's expected storage contract exactly; the atomic op must
  implement whatever better-auth calls, not a counter of our own invention.

## Commands you will need

| Purpose          | Command                                       | Expected        |
| ---------------- | --------------------------------------------- | --------------- |
| Install          | `pnpm install`                                | exit 0 (Step 0) |
| Build deps first | `pnpm run build:packages`                     | exit 0 (once)   |
| Typecheck        | `pnpm --filter "@lunora/auth" run lint:types` | exit 0          |
| Unit tests       | `pnpm --filter "@lunora/auth" run test`       | pass incl. new  |
| e2e (rate limit) | `pnpm --filter e2e run test -- rate`          | see Test plan   |
| Lint             | `pnpm run lint:eslint`                        | exit 0          |

## Scope

**In scope:**

- `packages/auth/src/store.ts` — add `incrementOne` to the `AuthStore` interface
  (with a doc block mirroring `consumeOne`'s race-closing rationale) and to
  `createMemoryAuthStore` (synchronous, no `await` interleave).
- `packages/auth/src/sql-store.ts` — implement `incrementOne` as a single
  atomic `INSERT … ON CONFLICT … DO UPDATE SET count = count + ? … RETURNING`
  (match the real column/semantics from Step 0).
- `packages/auth/src/adapter.ts` — wire `incrementOne` onto the returned
  `CustomAdapter`, next to `consumeOne`.
- `packages/auth/src/create-auth.ts` — default `rateLimit.storage` to the durable
  option (per Step 0) when the caller is silent, using the **same
  caller-silence gate** as the `enabled` default; document the tradeoff and the
  opt-out.
- Tests for each (see Test plan).

**Out of scope:**

- The `jwt` path; session cookie cache (that is 091).
- Any change to `consumeOne` (already correct).
- The device-auth telemetry and ASCII-email issues — those are the companion
  doc task below, not code.

## Git workflow

- Branch: `advisor/093-auth-durable-atomic-rate-limit`.
- Commit: `fix(auth): make rate limiting durable and atomic on Workers (incrementOne + storage default)`.
- Do NOT push or open a PR unless instructed.

## Steps

1. **Step 0 above — blocking.** Do not write code until both assumptions are
   confirmed or the plan is re-scoped.
2. Add `incrementOne` to the `AuthStore` interface + doc (`store.ts`).
   **Verify**: `lint:types` exit 0 (memory + sql stores now fail to satisfy the
   interface until implemented — expected).
3. Implement memory `incrementOne` (synchronous find-or-create + bump).
4. Implement SQL `incrementOne` (atomic upsert-increment with `RETURNING`, using
   the same placeholder-guard discipline the rest of `sql-store.ts` uses).
   **Verify**: `pnpm --filter "@lunora/auth" run test` — both stores pass.
5. Wire `adapter.ts` `incrementOne`. **Verify**: `lint:types` exit 0.
6. Default `rateLimit.storage` in `create-auth.ts`, caller-silence-gated.
   **Verify**: a test asserts the default is filled when silent and forwarded
   verbatim when the caller sets `rateLimit.storage` or `rateLimit: { enabled: false }`.

## Test plan

- **Concurrency (the point of the plan)**: fire N concurrent requests that each
  `incrementOne` the same key against `createSqlAuthStore` over a real
  `node:sqlite`/D1-shaped handle; assert the final count equals N (no lost
  updates). Do the same for the memory store. This is the regression that proves
  atomicity — without it, the plan is unverified.
- Unit: memory and SQL `incrementOne` return the post-increment row; create-then-
  increment and increment-missing-key both behave per Step 0's contract.
- create-auth: storage default filled on silence; forwarded verbatim otherwise.
- e2e (if a rate-limit spec exists or is cheap to add under `tests/e2e`):
  exceeding `max` within `window` returns better-auth's 429 across repeated
  requests — the black-box confirmation that enforcement now holds.

## Done criteria

- [ ] Step 0 recorded in the PR: real increment method name/signature + real
      default storage, with the plan reshaped if either diverged.
- [ ] `incrementOne` on `AuthStore`, `createMemoryAuthStore`,
      `createSqlAuthStore`, and wired in `adapter.ts`.
- [ ] Concurrency test proves no lost updates for both stores.
- [ ] `rateLimit.storage` default is durable, caller-silence-gated, with opt-out
      documented.
- [ ] `pnpm --filter "@lunora/auth" run test`, `lint:types`, and
      `pnpm run lint:eslint` all exit 0.
- [ ] No files outside the in-scope list modified (`git status`).
- [ ] `plans/README.md` row updated.

## STOP conditions

- Step 0 disproves either assumption (no atomic-increment method; default already
  durable; increment goes through `secondaryStorage` not the DB adapter) → stop
  and re-scope per "If Step 0 diverges."
- The atomic SQL increment cannot be expressed in one statement against D1 (e.g.
  the real storage contract needs multi-row or TTL semantics `ON CONFLICT` can't
  model) → stop; a DO-backed secondary store may be the correct target instead.
- Defaulting `rateLimit.storage: "database"` breaks an existing auth test/e2e
  (e.g. a test that assumes the in-memory limiter) → stop; the default change may
  need to be opt-in-with-loud-docs rather than on-by-default.

## Maintenance notes

- Keep `incrementOne`'s doc pinned to the same invariant as `consumeOne`: it
  exists to give a **one-winner guarantee across processes/isolates**, which is
  the whole reason the read-then-update fallback is unsafe on Workers.
- If better-auth changes the rate-limit storage contract in a future minor,
  re-verify Step 0 — the atomic op must implement better-auth's operation, not a
  counter of our own shape.
- **Upgrade/release note**: flipping the `rateLimit.storage` default to `"database"`
  makes better-auth emit (and require) a `rateLimit` table it did not need under the
  old memory default. The generated worker runs `ensureMigrated(...)` before request
  handling, so lazy migration creates the table automatically — but a deployment that
  disables lazy migration must re-run `lunora migrate` after upgrading `@lunora/auth`,
  or every `/api/auth/*` request errors on the missing table (better-auth does not
  guard `onRequestRateLimit`). Call this out in the `@lunora/auth` changelog.

---

## Companion (smaller): known-limitations doc entries

Not code — a docs task, filed here because it came out of the same better-auth
audit. Add to the `@lunora/auth` docs a short, honest "Known limitations &
better-auth interactions" section covering:

1. **Device-authorization telemetry pollution (better-auth #9784, open).** The
   re-exported `deviceAuthorization` plugin (`plugins.ts:67`) throws an
   `APIError` on every `/device/token` poll for the normal `authorization_pending`
   state (~every 5s). Cloudflare Workers Logs and any exception-capturing sink —
   including Lunora's own `sentrySink` / observability sinks — record each throw,
   so one device-flow login sprays dozens of "errors" into telemetry. Document
   it; consider a sink-side filter for that endpoint's expected throws until
   fixed upstream. Note this is an upstream bug, not a Lunora defect.
2. **ASCII-only email case-folding.** `sql-store.ts` uses SQLite/D1's ASCII-only
   `LOWER()`/`LIKE` for case-insensitive matching, so non-ASCII email
   case-folding is subtly wrong versus a Unicode-aware compare. Document the
   supported matching semantics rather than leaving it implicit.
3. **Kysely on the migration path.** The runtime path avoids better-auth's Kysely
   adapter (the `$context` dynamic-import hang under the Vite worker runner —
   `adapter.ts:91–100`), but `ensureMigrated` still uses better-auth's Kysely
   migrator. That leaves `lunora migrate` exposed to the kysely-adapter breakages
   tracked upstream (#9868/#9810/#9909: `DEFAULT_MIGRATION_TABLE` moved to
   `kysely/migration`, removed runtime exports). Pin/patch kysely deliberately so
   a transitive bump can't break migrations; document the pinned version.

These are documentation + a possible one-line sink filter — keep them out of 093's
code scope so the rate-limit fix lands cleanly on its own.
