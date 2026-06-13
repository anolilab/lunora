# Plan 007: Build the `@cirrus/testing` in-memory function harness (convex-test equivalent, v1)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. This is a SPIKE: a minimal, correct first version
> beats a broad half-working one. The dispatcher maintains `plans/README.md` —
> do NOT edit it.
>
> **Drift check (run first)**: `git diff --stat c865cfa6..HEAD -- packages/testing packages/do/src/index.ts packages/server/src`
> If any in-scope file changed since this plan was written, compare the
> "Current state" facts against the live code before proceeding.

## Status

- **Priority**: P2 (direction / spike)
- **Effort**: M (scoped v1; full parity is L and out of scope)
- **Risk**: MED (new public API; the in-memory ctx must faithfully match what the real DO builds)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `c865cfa6`, 2026-06-13

## Why this matters

`@cirrus/testing` today is a 16-line re-export of `@cirrus/mail/testing`, yet
its own `package.json` already advertises *"an in-memory harness for queries,
mutations, and actions."* Convex's `convex-test` is the reference: it runs the
user's `query`/`mutation`/`action` functions against an in-memory mock backend
so business logic can be unit-tested with no Durable Object, no `wrangler`, no
network — fast and deterministic. Cirrus can do the same cheaply because its
database context (`createShardCtxDb`) already runs on plain `node:sqlite` in
this repo's own `@cirrus/do` tests. This plan ports the **core** of that idea:
`cirrusTest(schema)` returning a harness with `run` / `query` / `mutation` /
`action` / `withIdentity`.

## Reference: the convex-test API we are porting (for shape, not copy)

`convexTest(schema)` returns an object with:
- `query(ref | inlineFn, args?)` — run a query, or an inline `async (ctx) => …`
- `mutation(ref | inlineFn, args?)` — run a mutation
- `action(ref | inlineFn, args?)` — run an action
- `run(async (ctx) => …)` — direct db access (mutation-level ctx)
- `withIdentity(identity)` — returns a scoped `t` whose `ctx.auth` reflects it
- (deferred in Cirrus v1: `fetch` for HTTP actions, scheduled-function
  draining, component registration)

We mirror the **first five**. Name the entry `cirrusTest`.

## Current state (verified facts — confirm before building)

- `packages/testing/src/index.ts` (16 LOC) re-exports `@cirrus/mail/testing`;
  keep those exports. `packages/testing/package.json` deps: only
  `@cirrus/mail`. It builds with `packem`, tests with `vitest`.
- **Function definition surface** (`packages/server/src/functions.ts`,
  ~lines 71–127): `query`/`mutation`/`action` each return a registered object
  shaped `{ args, handler, kind: "query"|"mutation"|"action", visibility? }`.
  The handler signature is `(ctx, args) => Promise<R> | R`.
- **Ctx types** (`packages/server/src/types.ts`, ~lines 837–898):
  - `QueryCtx`: `auth`, `db` (DatabaseReader), `log`, `runQuery`, `storage`
    (read-only), `vectors`.
  - `MutationCtx`: adds `db` (DatabaseWriter), `runMutation`, `scheduler`.
  - `ActionCtx`: adds `fetch`, `runAction`, write `storage`.
  - `auth` is `{ userId: string | null, getIdentity(): Promise<Record<string, unknown> | null> }`.
  - `log` is a `CirrusLogger` (`info`/`debug`/`warn`/`error`/`log`).
- **ctx.db factory** (`packages/do/src/ctx-db.ts`): `createShardCtxDb(options)`
  where `options` includes `{ schema, sql, clock?, idGenerator?, broadcast?,
  scheduler?, storage?, onRead?, onWrite?, … }` and returns a
  `DatabaseWriterLike` (the concrete `ctx.db`). `SqlExec` is
  `{ exec<Row>(sql, ...params): SqlCursor<Row> }` with
  `SqlCursor = { one(), toArray(), [Symbol.iterator]() }`.
- **DDL**: `runShardMigrations(sql, schema)` (in `packages/do/src/ctx-db.ts`)
  creates the tables + indexes from the schema. **Tables are NOT auto-created
  by the writer** — you MUST call this first.
- **node:sqlite adapter PATTERN** lives at
  `packages/do/__tests__/_helpers/node-sqlite.ts` — but it is a TEST helper in
  another package; you CANNOT import it. Re-implement the same ~50-line adapter
  inside `@cirrus/testing` (Node's `node:sqlite` `DatabaseSync` → `SqlExec`).
  **Constraint from that file's header**: never call `DatabaseSync#exec` (the
  repo's secret-scan hook flags it); route every statement through
  `prepare(...).all(...)`.
- **No existing off-the-shelf runner** builds a full Ctx and invokes a
  registered function outside a DO. The closest patterns are the ctx-db tests
  (`packages/do/__tests__/ctx-db*.test.ts`, `data-migration.test.ts`) — read
  one to see `createSqliteExec()` → `runShardMigrations` → `createShardCtxDb`.
- **Export check**: confirm `createShardCtxDb` and `runShardMigrations` are
  exported from `@cirrus/do`'s public entry. Run:
  `grep -rn "createShardCtxDb\|runShardMigrations" packages/do/src/index.ts`.
  If they are NOT exported, adding the two names to `packages/do/src/index.ts`
  as additive named exports is **in scope** (see Scope).
- Conventions: TypeScript ESM, **no `.js` extensions** on relative imports,
  **named exports only** (no mixing default+named), Vitest, `catalog:` deps.

## Commands you will need

| Purpose   | Command                                              | Expected on success |
|-----------|------------------------------------------------------|---------------------|
| Install   | `pnpm install`                                       | exit 0              |
| Tests     | `pnpm --filter "@cirrus/testing" run test`           | all pass            |
| Typecheck | `pnpm --filter "@cirrus/testing" run lint:types`     | exit 0              |
| Lint      | `pnpm --filter "@cirrus/testing" run lint:eslint`    | exit 0              |
| do tests  | `pnpm --filter "@cirrus/do" run test` (only if you edited do/src/index.ts) | all pass |

## Scope

**In scope** (the only files you should modify/create):
- `packages/testing/src/node-sqlite.ts` (create — the `SqlExec` adapter)
- `packages/testing/src/harness.ts` (create — `cirrusTest` + ctx construction)
- `packages/testing/src/index.ts` (add the new named exports; keep mail re-exports)
- `packages/testing/package.json` (add deps: `@cirrus/server`, `@cirrus/do`,
  and `@cirrus/values` if needed — all `workspace:*`; add `@cirrus/do` and any
  peer needs to devDependencies as the sibling packages do)
- `packages/testing/vitest.config.ts` (create if absent — copy a sibling's
  Node-only config; do NOT add a workerd project)
- `packages/testing/__tests__/harness.test.ts` (create)
- `packages/testing/README.md` (create or update — short usage example)
- `packages/do/src/index.ts` (ONLY if needed — additive export of
  `createShardCtxDb` / `runShardMigrations`)

**Out of scope** (do NOT touch):
- `@cirrus/server` / `@cirrus/do` source beyond the optional additive export
  line in `do/src/index.ts`. Do NOT change ctx-db internals or function defs.
- HTTP-action `fetch`, scheduled-function draining, component registration —
  deferred to v2.
- Real R2 storage, real scheduler/alarms, Workers AI, D1 `.global()` tables,
  Vectorize — these need real bindings; v1 provides clearly-throwing stubs.
- `plans/README.md` — the dispatcher owns it.

## Git workflow

- You are in an isolated worktree on branch **`impl/testing-harness`** (the
  dispatcher created it). Commit your work on this branch; do NOT push.
- Conventional commits, e.g. `feat(testing): add in-memory cirrusTest harness`.

## Steps

### Step 1: Read the exemplars

Read `packages/do/__tests__/_helpers/node-sqlite.ts` (the adapter to port) and
ONE ctx-db test (e.g. `packages/do/__tests__/ctx-db.test.ts`, first ~80 lines)
to see the `createSqliteExec → runShardMigrations → createShardCtxDb` flow.
Read `packages/server/src/functions.ts` (~71–127) and `types.ts` (~837–898) to
confirm the registered-function shape and the three Ctx shapes. Run the export
check grep from "Current state".

**Verify**: you can state (a) the exact `createShardCtxDb` option keys you'll
pass and (b) whether you must add exports to `do/src/index.ts`. If
`createShardCtxDb`/`runShardMigrations` exist but under different names, use
the real names and note it.

### Step 2: Port the `SqlExec` adapter

Create `packages/testing/src/node-sqlite.ts`: a `createSqlExec()` returning
`{ sql: SqlExec, close(): void }` backed by `new DatabaseSync(":memory:")`,
every statement via `prepare(...).all(...)` (never `.exec`). Implement the
`SqlCursor` contract (`one()` throws unless exactly one row; `toArray()`;
`[Symbol.iterator]()`). Import `SqlExec`/`SqlCursor` types from `@cirrus/do`
if exported, else define a local structural type matching them.

**Verify**: `pnpm --filter "@cirrus/testing" run lint:types` → exit 0.

### Step 3: Build `cirrusTest` and ctx construction

Create `packages/testing/src/harness.ts` exporting `cirrusTest`:

```ts
export const cirrusTest = (schema: SchemaLike): TestHarness => { … }
```

Internally:
1. `const { sql, close } = createSqlExec();`
2. `runShardMigrations(sql, schema);`
3. `const db = createShardCtxDb({ schema, sql, /* deterministic clock + idGenerator are fine to omit or fix */ });`
4. Build a ctx factory that, given a current identity (`userId: string | null`),
   produces the right Ctx per kind:
   - `auth`: `{ userId, getIdentity: async () => identity ?? null }`
   - `db`: the shared `db` writer (queries get the same writer; that's fine for
     an in-memory harness — do NOT try to enforce read-only at runtime in v1,
     just type it).
   - `log`: a no-op or capturing `CirrusLogger`.
   - `runQuery`/`runMutation`/`runAction`: re-enter the harness
     (`(ref, args) => this.query(ref, args)` etc.) so nested calls share the
     same db.
   - `storage`, `scheduler`, `vectors`, action `fetch`: **throwing stubs** with
     a clear message, e.g. `throw new Error("ctx.storage is not available in the in-memory @cirrus/testing harness (v1)")`. Make them lazily throw on
     use (a Proxy or getter), not on ctx construction, so functions that don't
     touch them still run.
5. The five methods:
   - `query(refOrFn, args?)`: if a registered function, assert
     `kind === "query"`, build a QueryCtx, `await fn.handler(ctx, args ?? {})`;
     if an inline `async (ctx) => …`, call it with a QueryCtx.
   - `mutation(...)`: same with MutationCtx, `kind === "mutation"`.
   - `action(...)`: same with ActionCtx, `kind === "action"`.
   - `run(fn)`: call `fn(ctx)` with a MutationCtx (db read+write).
   - `withIdentity(identity)`: return a new harness view sharing the SAME
     `sql`/`db` but with the given identity (so writes persist across the
     scoped accessor).
6. Argument validation: if validating against `fn.args` via the values
   validators is straightforward (check what `@cirrus/values` exposes — e.g. a
   `parse`/`validate` entry), do it and throw on mismatch. If it is not
   obviously available, SKIP validation in v1 and add a `// v1: args validation
   deferred` comment — do NOT block the spike on it.

Export `cirrusTest` and the `TestHarness` type from `index.ts` (named exports),
keeping the existing `@cirrus/mail/testing` re-exports.

**Verify**: `pnpm --filter "@cirrus/testing" run lint:types` → exit 0.

### Step 4: Tests

Create `packages/testing/__tests__/harness.test.ts`. Define a tiny schema with
`defineSchema`/`defineTable` from `@cirrus/server` (read a sibling test or the
server package for the exact import) — e.g. a `messages` table with `body:
v.string()`, `author: v.string()`. Define a `query` that lists messages and a
`mutation` that inserts one. Cover:

1. **mutation then query**: insert via `t.mutation(send, {…})`, read back via
   `t.query(list, {})` → the inserted row is present.
2. **run**: `await t.run(async (ctx) => ctx.db.insert("messages", {…}))` then a
   query sees it.
3. **withIdentity**: a query/mutation whose handler reads `ctx.auth.userId`
   sees the injected id under `t.withIdentity({ userId: "u1" })` and `null`
   without it. Persisted writes are visible across the scoped accessor.
4. **inline function**: `await t.query(async (ctx) => (await ctx.db.query("messages").collect()).length)` returns the count.
5. **stub boundary**: a mutation that touches `ctx.scheduler` (or `ctx.storage`)
   throws the clear "not available in the in-memory harness (v1)" error —
   assert the message.

**Verify**: `pnpm --filter "@cirrus/testing" run test` → all pass.

### Step 5: README + full gates

Add a short `## Usage` block to `packages/testing/README.md` showing the
`cirrusTest` flow (mutation → query). Then:

**Verify**:
- `pnpm --filter "@cirrus/testing" run test` → all pass
- `pnpm --filter "@cirrus/testing" run lint:types` → exit 0
- `pnpm --filter "@cirrus/testing" run lint:eslint` → exit 0
- If you edited `packages/do/src/index.ts`:
  `pnpm --filter "@cirrus/do" run lint:types` → exit 0 (a pure export addition
  should not break anything; if it does, STOP).

## Test plan

Enumerated in Step 4. Pattern for schema/handler setup: the ctx-db tests in
`packages/do/__tests__/`. Engine: the new `node-sqlite.ts` adapter (never a
workerd project — this harness is Node-only by design).

## Done criteria

- [ ] `cirrusTest` exported from `@cirrus/testing` with `query`/`mutation`/`action`/`run`/`withIdentity`
- [ ] `packages/testing/__tests__/harness.test.ts` exists with the 5 cases above, all passing
- [ ] Existing `@cirrus/mail/testing` re-exports still present in `index.ts`
- [ ] `pnpm --filter "@cirrus/testing" run test` exits 0
- [ ] `pnpm --filter "@cirrus/testing" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/testing" run lint:eslint` exits 0
- [ ] Work committed on branch `impl/testing-harness`; `plans/README.md` NOT modified

## STOP conditions

Stop and report back (do not improvise) if:

- `createShardCtxDb` / `runShardMigrations` do not exist or cannot be made to
  build a working in-memory `ctx.db` from a `defineSchema` schema + a
  node:sqlite `SqlExec` (this disproves the spike's core assumption — report
  exactly where it breaks).
- The registered-function shape `{ handler, args, kind }` differs materially
  from the excerpt (e.g. handlers are not directly callable).
- Building a Ctx that the real handlers accept requires importing
  DO-runtime-only modules that pull in `cloudflare:workers` (which won't load
  under Node/vitest) — report the offending import; do NOT stub out
  `cloudflare:workers` globally in this spike.
- Making `node:sqlite` work under the package's vitest config fails (e.g.
  Node version) after a genuine attempt.

## Maintenance notes

- This is v1. Deferred to follow-ups: HTTP-action `t.fetch`, scheduled-function
  draining (`finishAllScheduledFunctions`), real-ish storage (an in-memory R2
  double), `.global()`/D1 tables, and Vectorize. Each stub throws today so the
  boundary is explicit.
- Reviewer should scrutinize: that the in-memory ctx matches what the generated
  DO builds (same `createShardCtxDb` options) so a function passing in tests
  behaves the same in production; and that `withIdentity` shares the same
  underlying SQLite handle (writes must persist across scoped accessors).
- If `@cirrus/do` had to export `createShardCtxDb`/`runShardMigrations`, note
  that those are now public API of `@cirrus/do` and changing their signatures
  becomes a breaking change.
