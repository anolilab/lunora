# Plan 078 — Custom scalar types (`v.custom`) — PowerSync-style extension types in shapes

> Closes the gap a user raised: _"custom shapes don't let you define custom types
> from extensions (PowerSync does); I'd like to use my SQLite extensions inside those
> shapes."_ We can't load real workerd SQLite extensions (see §0), so this gives the
> **type-system half** of that ask: a registration hook for custom scalar columns
> (vector / geometry / decimal / branded) that encode to a native affinity, parse on
> write, decode on read, ride `defineShape` projections unchanged, and flow through
> codegen + studio. The **storage-engine half** (real pgvector/PostGIS columns riding
> the op-log) is plan **077**'s Hyperdrive→DO shape ingest — referenced, not duplicated.
>
> All code anchors are at HEAD; re-verify before trusting.

## 0. The hard constraint this works around

Lunora's DO store is workerd's embedded SQLite, reached **only** through
`SqlStorage.exec` (`packages/do/src/do-exec.ts`, `shard-do.ts:2478`). There is no
`load_extension` / `sqlite3_load_extension` seam anywhere in the repo, and workerd's
sandbox does not expose loadable extensions. So "use my loaded SQLite extension type
inside a shape" is **not achievable on the DO**. What a user actually wants from such
an extension type is three things, all of which we _can_ deliver without the extension:

1. a **distinct app-side type** (`Float32Array`, a `Geometry`, a `Decimal`) instead of
   a bare string/blob;
2. **validation** on write;
3. the value **riding the sync engine** (shapes, deltas, offline) like any column.

This plan delivers all three by encoding the custom type onto one of the four native
affinities (`BLOB`/`TEXT`/`INTEGER`/`REAL`) with a registered codec. The genuinely
extension-backed path (real pgvector column, queried with `<->`) is **077**: that DB
is your own Postgres behind Hyperdrive, materialized into a tracked DO table, after
which `defineShape` + `@lunora/db` carry it to clients with zero new client code.

## 1. The existing seam we extend — `v.storage()` is the template

`v.storage()` (`packages/values/src/v.ts:516`) already proves the exact shape of a
custom scalar: a **distinct `kind`** that _parses like a string_ but carries extra
`_meta` (`bucket`) which codegen/studio/SQL read to treat it specially. It is a custom
type in everything but extensibility — the kind list is closed (`ValidatorKind`,
`v.ts:49`) and only the framework can add to it.

`v.custom` generalizes `v.storage`'s pattern into a **user-registerable** factory.
Nothing about the parser/codec machinery is new; we expose it.

## 2. Public API

```ts
// lunora/types/vector.ts  (user code)
import { defineScalar } from "lunorash/values";

export const vector = (dims: number) =>
    defineScalar<Float32Array>({
        name: "vector", // stable id → _meta.scalarName, discovered by codegen
        affinity: "BLOB", // physical SQLite affinity it encodes to
        parse: (x) => {
            // app value → validated app value (write boundary)
            if (!(x instanceof Float32Array) || x.length !== dims) throw new Error(`expected Float32Array(${dims})`);
            return x;
        },
        encode: (x) => x.buffer, // app value → storable primitive (ArrayBuffer)
        decode: (b) => new Float32Array(b as ArrayBuffer), // stored → app value (read)
        meta: { dims }, // arbitrary JSON, surfaced to codegen/studio
    });
```

```ts
// lunora/schema.ts
import { vector } from "./types/vector";
defineTable({
    embedding: vector(1536), // a custom column
    body: v.string(),
});
```

```ts
// lunora/shapes.ts — rides projections with ZERO new shape API
defineShape({
    table: "docs",
    args: { tenant: v.string() },
    columns: ["body", "embedding"], // custom column included by name, unchanged
    where: (ctx, { tenant }) => ({ tenant }),
});
```

The shape layer needs **no change**: a custom column is a real column, so the
`columns` projection (`shapes.ts:50`), the RLS where-merge, CDC op-log, deltas, and
the offline outbox all carry it automatically. That is the whole point of encoding to
a native affinity rather than inventing a storage type.

## 3. Where it plugs in (insertion points, all anchored)

| #   | Concern            | File / anchor                                                          | Change                                                                                                                                                                                                                          |
| --- | ------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Kind union         | `packages/values/src/v.ts:49`                                          | Add `"custom"` to `ValidatorKind`.                                                                                                                                                                                              |
| 2   | Factory            | `packages/values/src/v.ts:299` (`createValidator`)                     | New `defineScalar(spec)` → `createValidator<T>("custom", spec.parse-wrapped, { scalar: {...spec} })`, then `asColumn(...)`. Mirrors `storage()` at `:516`. Persist `affinity`, `encode`/`decode` ids, `meta` on `_meta.scalar`. |
| 3   | Export             | `packages/values/src/v.ts:903` (`v` object) + index                    | Export `defineScalar` (standalone, not on `v.*`, since it's a user-facing constructor like `defineTable`). Re-export through `lunorash/values`.                                                                                 |
| 4   | Affinity           | `packages/d1/src/dialect.ts:32` (`sqlAffinityForKind`)                 | `case "custom": return meta.scalar.affinity`. Needs the meta, so thread the validator (not just `kind`) — or add `sqlAffinityForValidator(v)` wrapper that falls back to `sqlAffinityForKind(v.kind)`.                          |
| 5   | DO write codec     | `packages/do/src/ctx-db.ts` (insert/patch path)                        | On write, run `scalar.encode(parsed)` before binding the param. The encoded primitive must match the declared affinity.                                                                                                         |
| 6   | DO read codec      | `packages/do/src/ctx-db.ts` (row hydration)                            | On read, run `scalar.decode(rawCell)` per custom column before the row enters the reactive/JSON path.                                                                                                                           |
| 7   | Codegen scalar set | `packages/codegen/src/parse-validator.ts:56` (`SCALAR_KINDS`) + `:172` | Treat `"custom"` as a scalar; emit the app-side TS type (`spec.__type`) into `dataModel.ts`, carry `scalarName`/`meta`.                                                                                                         |
| 8   | Codegen emit       | `packages/codegen/src/emit.ts:3885` / `:3926` (kind switch)            | Emit the custom column's select/insert type from the registered scalar's TS type (parallel to the `storage`→`string` case).                                                                                                     |
| 9   | Studio             | data-model introspection                                               | Show `scalarName` + `meta.dims` as the column type (like the storage badge). Read-only; no new write path.                                                                                                                      |
| 10  | Advisor            | `@lunora/advisor`                                                      | Optional lint: custom column with no index used in a shape `where` (same family as `filter-without-index`).                                                                                                                     |

## 4. The codec contract (the one genuinely new concept)

A scalar is a 4-tuple over a base affinity:

- **`parse(app) → app`** — validation at the write boundary (throws `ValidationError`).
  Runs in the existing `_parse` slot, so `safeParse`/Standard-Schema/args all work.
- **`encode(app) → primitive`** — app value → a value the affinity can store
  (`ArrayBuffer` for BLOB, `string` for TEXT, `number` for REAL/INTEGER). Pure, sync.
- **`decode(primitive) → app`** — inverse, run on read. Pure, sync.
- **`affinity`** — which of `BLOB/TEXT/INTEGER/REAL` `encode` targets.

Invariants (enforced by a test harness, §6): `decode(encode(parse(x)))` deep-equals
`parse(x)`; `encode`'s output `typeof`/instance matches `affinity`. `encode`/`decode`
are **sync and pure** (same rule as `v.from`, `v.ts:774`) — they run inside the DO's
serialized mutation critical section and the reactive read path, so no I/O, no Promise.

**Determinism note:** `encode`/`decode` run on every write/read but are pure, so they
don't violate the query/mutation determinism guard (memory: determinism-not-enforced).
`parse` already runs today for every validator; we're only adding the codec hop.

## 5. What this does _not_ do (scope fence)

- **No real SQLite extension.** No `sqlite-vec` distance ops, no PostGIS `ST_*` inside
  the DO. A `vector` column is an opaque BLOB to SQLite — you cannot `ORDER BY
embedding <-> $1` on the DO. Nearest-neighbour stays **Vectorize** (`ctx.vectors`)
  or **Hyperdrive+pgvector** (077). `v.custom` gives you the _typed, synced column_,
  not in-DB similarity search. Call this out in docs so the gap is honest.
- **No custom indexes / operators.** Indexes remain over native affinities.
- **No async codecs.** Sync-only (see §4).
- **Hyperdrive-backed shapes** (real extension types streamed in) = **plan 077**, not
  here. 078 is the client-of-077: once 077 materializes a pgvector slice into a DO
  table, a `v.custom` column decodes it app-side.

## 6. Verification plan

1. `@lunora/values`: unit-test `defineScalar` round-trip (`decode∘encode∘parse = parse`),
   affinity/typeof match, sync-only rejection, `_meta.scalar` shape.
2. `@lunora/codegen`: golden fixture — a schema with a `vector(4)` column emits the
   right `dataModel.ts` TS type + `scalarName`/`meta` and the right affinity in DDL.
3. `@lunora/do` (workerd gate `LUNORA_WORKERD_TESTS=1`, see memory): insert a
   `Float32Array`, read it back as a `Float32Array`; subscribe via a shape projecting
   the custom column, mutate, assert the delta carries the decoded value; reconnect
   resume carries it; `@lunora/db` offline outbox round-trips it.
4. Advisor lint test (if §3 #10 included).

## 7. Effort

Contained. ~1 new exported factory + a codec contract in `@lunora/values`, an
affinity-by-validator wrapper in `@lunora/d1`, two codec hops in `ctx-db.ts`, and the
codegen scalar plumbing (the largest piece — mirror the `storage` kind end-to-end).
No shape API change, no client change, no protocol change. The bulk of risk is in the
codegen type emission and the `ctx-db.ts` read/write hops landing on the same column
ordering.

## 8. Open decisions (need sign-off before code)

1. **`defineScalar` vs `v.custom(...)`** — standalone constructor (like `defineTable`,
   recommended: it's a type _definition_, reused across tables) or a `v.*` member?
2. **Affinity threading** — add `sqlAffinityForValidator(v)` everywhere `sqlAffinityForKind`
   is called, or store the resolved affinity on `_meta.column` at construction so the
   existing `kind`-keyed callers keep working? (Latter is less invasive — recommended.)
3. **Codec registry location** — codecs are functions, not serializable; they live on
   the in-memory validator. Codegen only needs `name`/`affinity`/`meta`/TS-type (static).
   Confirm the DO resolves the live codec from the schema module at runtime (it imports
   `schema.ts` already), not from generated artifacts.
4. **Studio decode** — does studio render decoded values (needs the codec in the studio
   host) or raw primitives with a type badge? Recommend raw + badge for v1.
