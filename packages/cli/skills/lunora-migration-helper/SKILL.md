---
name: lunora-migration-helper
description: Plans Lunora schema and data migrations with widen-migrate-narrow. Use for
    breaking schema changes, backfills, table reshaping, online data migrations
    (`defineMigration` + `lunora migrate up`), the `.global()` D1 / Hyperdrive
    structural flows, and the
    pre-deploy schema-drift gate.
---

# Lunora Migration Helper

Safely change a Lunora schema and migrate data when making breaking changes.

## When to Use

- Adding required fields to existing tables.
- Changing field types or structure.
- Splitting/merging tables, renaming/removing fields.
- Reshaping `.global()` tables (D1- or Hyperdrive-backed).

## When Not to Use

- Greenfield schema with no data at rest.
- Adding **optional** fields that need no backfill.
- Adding new tables or indexes with no correctness concern.

## Storage Layers — Know Which You Are Migrating

Lunora tables live in one of three backends, and they migrate differently:

- **ShardDO SQLite (default `root`, and `.shardBy(key)` tables).** State lives in
  the per-app / per-shard Durable Object. Data is reshaped with **online data
  migrations** — `defineMigration` declarations run by `lunora migrate up`,
  resumable per shard.
- **`.global()` on D1 (the default global backend).** Replicated to D1 for
  cross-region reads. Structural DDL gets versioned **SQL migrations** via
  `lunora migrate generate`, applied by `@lunora/d1`'s runner at deploy time.
- **`.global({ backend: "hyperdrive" })` on Postgres/MySQL.** The same reactive
  `.global()` contract served over Cloudflare Hyperdrive. Structural DDL works
  differently here: tables **auto-provision on first use** — the runtime applies
  the DDL through the dialect — so there is no `lunora migrate generate` step
  and no versioned SQL file to commit. See `lunora-setup-hyperdrive-global`.

So: a breaking structural change to a **D1-backed** `.global()` table needs a
generated SQL migration; the Hyperdrive-backed equivalent provisions itself. A
data backfill (any layer) is always an online `defineMigration`. All three
follow the same **widen → migrate → narrow** discipline — check the table's
backend before assuming which structural path applies.

> **Moving an existing dataset between global backends.** To move a `.global()`
> dataset from D1 onto Hyperdrive, use
> `lunora migrate d1-to-hyperdrive --from-url <d1-worker> --to-url <hd-worker>`
> (`--tables` scopes it; `--out` keeps the intermediate NDJSON dump). This is a
> backend move, not a schema change — the widen → migrate → narrow discipline
> below still governs any reshaping you do on either side of it.

## Key Principle: Widen, Migrate, Narrow

The schema-drift gate (and D1 itself) will not let a breaking change deploy
without an accompanying migration. So every breaking change is staged:

1. **Widen** — make the schema accept both old and new shapes (add the new field
   as `v.optional`, keep the old one). Update reads to handle both; start writing
   the new shape for new rows. Deploy.
2. **Migrate** — backfill existing rows to the new shape (an online
   `defineMigration` run with `lunora migrate up`; plus `lunora migrate generate`
   for `.global()` structural DDL). Verify completeness with `lunora migrate
status`.
3. **Narrow** — make the field required / drop the old field, remove the
   both-shapes read code. Deploy.

### Prefer new fields over changing types

When changing a field's shape, add a new field rather than mutating the existing
one — safer transition, easier rollback.

### Don't delete data prematurely

Prefer deprecating: mark the old field `v.optional` with a `// deprecated:` code
comment explaining why it existed. Delete only once you are sure nothing reads
it.

## Safe Changes (No Migration Needed)

```ts
// Adding an optional field — safe.
users: defineTable({
    name: v.string(),
    bio: v.optional(v.string()),
});

// Adding a new table — safe.
posts: defineTable({ userId: v.id("users"), title: v.string() }).index("by_user", ["userId"]);

// Adding an index — safe.
users: defineTable({ name: v.string(), email: v.string() }).index("by_email", ["email"]);
```

## Online Data Migrations (the backfill workhorse)

For backfilling/reshaping rows, declare a migration with `defineMigration` from
`@lunora/server`. It transforms one document at a time, runs **inside each
shard's** Durable Object in keyset batches, and is **resumable** — per-shard
progress is tracked in a reserved `__lunora_migrations` table, so an interrupted
run resumes where it stopped. Codegen discovers declarations and emits them into
the registry the DO and CLI look up by `id`.

```ts
// lunora/migrations/backfill-display-name.ts
import { defineMigration } from "@lunora/server";

export default defineMigration({
    id: "backfill-display-name",
    table: "users",
    batchSize: 200, // optional; defaults to the runner's batch size
    up: (doc) => {
        if (typeof doc.displayName === "string") {
            return; // already migrated — return undefined to skip (not counted as changed)
        }
        return { ...doc, displayName: doc.name ?? "Anonymous" };
    },
    // optional reverse transform applied by `lunora migrate down`
    down: (doc) => {
        const { displayName, ...rest } = doc as Record<string, unknown>;
        return rest;
    },
});
```

The transform must preserve row identity — the runner always keeps the original
`_id` / `_creationTime`, so do not change them.

### Reading another table

The transform's second argument is a **shard-scoped reader** (`ctx.db` with
`get` / `findFirst` / `findMany` / `count`), so the common backfill — read the
parent, copy a field down onto its children — is expressible. It may be `async`.

```ts
up: async (doc, ctx) => {
    const thread = await ctx.db.get(String(doc.threadId), "threads");

    return thread ? { ...doc, userId: thread.userId } : undefined;
},
```

It is a reader, not a writer: the runner accounts for exactly one rewrite per
row read, and a transform writing directly would make that count describe
something other than what happened. To touch a second table, run a second
migration over that table.

### A shard key cannot be backfilled by a migration

If the field you are backfilling **is** the table's `.shardBy()` key, this is the
wrong tool, and no amount of reader access fixes it:

- a row whose shard key is unset does not belong to any shard, so a shard-scoped
  query will never enumerate it; and
- writing the key would have to **move the row to a different Durable Object**,
  which a per-shard runner has no way to do.

Re-keying is an export → transform → import (`lunora export`, rewrite the NDJSON,
`lunora import` — ids are preserved, so foreign keys survive), not a migration.
So the rule elsewhere in this skill that a data backfill is always an online
`defineMigration` has this one exception.

### Run it

```bash
lunora migrate create backfill-display-name   # scaffold the migration file
lunora codegen                                 # discover + register it
lunora migrate up backfill-display-name --dry-run   # preview, no rows rewritten
lunora migrate up backfill-display-name        # run across shards (keyset batches)
lunora migrate status backfill-display-name    # per-shard progress
lunora migrate down backfill-display-name      # revert (if `down` defined)
```

Useful flags: `--batch-size <n>`, `--steps <n>` (cap batches this run), and
`--prod --url <worker> --yes` to target production (with `LUNORA_ADMIN_TOKEN`).

## `.global()` on D1 — Structural Migration Flow

This flow is **D1-specific**. Hyperdrive-backed globals auto-provision their DDL
at runtime and skip it entirely.

```bash
# 1. Edit lunora/schema.ts (widen: add the optional new field to the .global() table).
lunora codegen

# 2. Generate the SQL migration by diffing schema against the snapshot baseline.
lunora migrate generate --name=add_user_status

# Writes lunora/migrations/<timestamp>_add_user_status.sql and updates
# lunora/migrations/.snapshot.json. Review the SQL before committing.

# 3. Deploy — @lunora/d1's runner applies pending migrations.
lunora deploy
```

`lunora migrate generate` only considers `.global()` tables (root/sharded tables
live in ShardDO SQLite, not D1). Run it after each schema edit in the widen and
narrow steps; backfill data with an online migration between them.

## The Schema-Drift Gate

`lunora deploy` (and `verify` / `prepare`) run a **pre-deploy schema-drift gate**:
it compares the committed structural baseline (`lunora/.lunora-schema.json`)
against the snapshot codegen produced this run. Breaking drift **without an
accompanying data migration blocks the deploy**. The baseline is only re-blessed
_after_ the deploy succeeds, so a failed deploy never advances it past a change
that never shipped.

If the gate blocks you: that is the signal to stage the change (widen first) or
add the migration — not to bypass it.

## Common Pitfalls

1. **Making a field required before backfilling.** The drift gate / D1 rejects
   the deploy because existing rows lack it. Widen first.
2. **Reshaping rows by hand instead of `defineMigration`.** A hand-rolled
   `internalMutation` that `.collect()`s a large table hits transaction limits
   and is not resumable. Use `defineMigration` — it batches and tracks per-shard
   progress.
3. **Not writing the new shape during the migration window.** Rows created mid-
   migration get missed, leaving unmigrated data after it "completes." Start
   dual-writing in the widen step.
4. **Skipping the dry run.** `lunora migrate up <id> --dry-run` validates the
   transform before it touches real rows.
5. **Deleting a field prematurely.** Deprecate with `v.optional` + a comment;
   delete only once nothing references it.
6. **Migrating the wrong layer.** A D1-backed `.global()` structural change needs
   `lunora migrate generate` (SQL); a Hyperdrive-backed one auto-provisions; a
   data backfill needs a `defineMigration`. Check the table's `.global()` /
   `.shardBy()` modifier — and, for `.global()`, its `backend` — first.

## Checklist

- [ ] Identified the change and which layer it touches (ShardDO vs `.global()`).
- [ ] Widened the schema to accept both shapes; `lunora codegen` clean.
- [ ] Updated reads to handle both shapes; started writing the new shape.
- [ ] Deployed the widened schema.
- [ ] Authored a `defineMigration`; previewed with `lunora migrate up <id> --dry-run`.
- [ ] Ran `lunora migrate up <id>`; `lunora migrate generate` + deploy for
      `.global()` structural changes.
- [ ] Verified completion with `lunora migrate status <id>`.
- [ ] Narrowed the schema (required / drop old field); removed both-shapes code.
- [ ] Deployed the final schema; schema-drift gate passed.
