---
name: lunora-migration-helper
description: Plans and runs Lunora schema and data migrations with the widen → migrate → narrow pattern. Covers online data migrations (`defineMigration` in `lunora/migrations.ts`, `lunora migrate create | up | down | status`), what the pre-deploy schema-drift gate treats as breaking and how a migration covers it, `.global()` table DDL on D1 (`lunora migrate generate`) and Hyperdrive, moving a dataset with `lunora migrate d1-to-hyperdrive`, and re-keying a `.shardBy()` table. Use when the user wants to make a field required, rename or drop a field or table, change a field's type, add a unique index to a populated table, backfill data, switch a table between root / `.shardBy()` / `.global()`, or when `lunora deploy` reports "schema drift gate blocked".
---

# Lunora Migration Helper

Change a Lunora schema that already has data in it without breaking the deploy
or losing rows.

Not needed for a greenfield schema with no data, a new optional field, a new
table, or a new non-unique index. Those are additive and deploy as-is.

## Which storage layer are you migrating?

Check the table's modifier in `lunora/schema.ts` first; the tools differ.

| Table                                | Where rows live                      | Structural DDL                                                 | Data backfill                          |
| ------------------------------------ | ------------------------------------ | -------------------------------------------------------------- | -------------------------------------- |
| default (root) or `.shardBy(key)`    | SQLite in the root / per-key ShardDO | Applied by the runtime from the schema                         | `defineMigration` + `lunora migrate`   |
| `.global()`                          | D1 (`DB` binding)                    | Additive DDL auto-provisioned; destructive SQL applied by hand | SQL `UPDATE` via `wrangler d1 execute` |
| `.global({ backend: "hyperdrive" })` | Postgres/MySQL via Hyperdrive        | Additive DDL auto-provisioned; no `migrate generate` support   | SQL `UPDATE` against the database      |

## The pattern: widen, migrate, narrow

The schema-drift gate blocks a breaking change; one that needs a backfill is
let through once a new migration on that table covers it (the rest are listed
below). Stage every such change across deploys:

1. **Widen.** Make the schema accept both shapes: add the new field as
   `v.optional(...)`, keep the old one. Make reads handle both, and start
   writing the new shape on every insert/patch so rows created during the
   migration aren't missed. Deploy.
2. **Migrate.** Backfill existing rows with a `defineMigration`, run it with
   `lunora migrate up`, and confirm with `lunora migrate status`. On a
   `.global()` table, backfill with SQL instead (see below).
3. **Narrow.** Make the field required / drop the old one, remove the
   both-shapes code. Deploy.

Prefer adding a new field to changing an existing field's type: it rolls back
cleanly. Keep a deprecated field as `v.optional` with a `// deprecated:` comment
until nothing reads it.

## What the drift gate considers breaking

The gate (run by `lunora deploy`, `prepare`, `build` and, read-only, `verify`)
diffs the schema against the committed `lunora/.lunora-schema.json`.

- **Safe:** new table, new optional field, new non-unique index or relation, a
  required field made optional.
- **Breaking, fixable by a migration:** dropped field or table, changed field
  type, optional → required, new required field on an existing table, a new
  unique index or `.unique()` column (existing duplicates would make the shard
  fail to open).
- **Breaking, not fixable by a migration:** changing a table's shard mode
  (root ↔ `.shardBy()` ↔ `.global()`, or the `.global()` backend) moves rows to
  other storage; use export → import. A dropped index or relation needs call
  sites changed, then `--update-schema-baseline`.

A migration covers a change only if it is new since the baseline and its
`table` is a string literal naming the affected table. The baseline advances
only after a successful deploy.

## Online data migrations

A migration transforms one document at a time, runs inside each shard's Durable
Object in keyset batches, and is resumable: per-shard progress is kept in a
reserved `__lunora_migrations` table.

Scaffold it rather than writing the file from scratch:

```bash
lunora migrate create backfill-display-name --table users
```

This appends to `lunora/migrations.ts`. Codegen only discovers
`export const x = defineMigration({...})` with a literal `id`. An
`export default` is silently skipped, and `lunora migrate up` then can't find it.

```ts
// lunora/migrations.ts
import { defineMigration } from "@lunora/server"; // or "lunorash/server"

export const backfillDisplayName = defineMigration({
    id: "backfill-display-name",
    table: "users",
    batchSize: 200, // optional
    up: (doc) => {
        if (typeof doc.displayName === "string") {
            return undefined; // skip: not rewritten, not counted as changed
        }

        return { ...doc, displayName: doc.name ?? "Anonymous" };
    },
    // optional; applied by `lunora migrate down`
    down: (doc) => {
        const { displayName, ...rest } = doc;

        return rest;
    },
});
```

The runner keeps each row's original `_id` and `_creationTime`.

### Reading another table

The transform's second argument is a shard-scoped, read-only `ctx.db`
(`get`, `findFirst`, `findMany`, `count`), and the transform may be `async`.
That covers the common case of copying a field down from a parent:

```ts
up: async (doc, ctx) => {
    const thread = await ctx.db.get(String(doc.threadId), "threads");

    return thread ? { ...doc, userId: thread.userId } : undefined;
},
```

To change rows in a second table, write a second migration over that table.

### A shard key can't be backfilled

If the field is the table's `.shardBy()` key, a migration can't help: a row with
no shard key belongs to no shard (so the runner never sees it), and setting the
key would mean moving the row to another Durable Object. Re-key with
`lunora export` → rewrite the NDJSON → `lunora import`. Ids are preserved, so
foreign keys survive. The same route applies to any shard-mode change.

### Run it

```bash
lunora migrate up backfill-display-name --dry-run   # preview, rewrites nothing
lunora migrate up backfill-display-name             # against the dev worker (localhost:8787)
lunora migrate status backfill-display-name         # per-shard progress
lunora migrate down backfill-display-name           # only if `down` is defined
```

Options: `--batch-size <n>`, `--steps <n>` (cap batches per run), `--format json`.

Production runs rewrite live data, so they require an explicit confirmation:

```bash
LUNORA_ADMIN_TOKEN=… lunora migrate up backfill-display-name --prod --url https://app.example.com --yes
```

`--url` can be omitted when the checkout is linked to production. Alternatively,
`lunora deploy --migrate --migrate-yes --migrate-url <url>` runs every declared
migration right after the deploy (`up` is idempotent, so finished ones no-op).

## `.global()` tables

The runtime provisions `.global()` tables itself on first use, on both D1 and
Hyperdrive: `CREATE TABLE IF NOT EXISTS`, additive `ADD COLUMN`, and declared
indexes. Additive changes therefore need no DDL step.

For **D1-backed** global tables, `lunora migrate generate` diffs the schema
against `lunora/migrations/.snapshot.json` and writes a reviewable
`lunora/migrations/<timestamp>_<name>.sql`:

```bash
lunora migrate generate --name add_user_status
```

No command applies that file, `lunora deploy` included. Its value is the
statements the runtime never issues (`DROP TABLE`, `DROP INDEX`) plus a comment
block of changes it couldn't generate (renames, backfilling `UPDATE`s), which you
write yourself. Apply it deliberately, after review:

```bash
wrangler d1 execute DB --remote --file=lunora/migrations/<file>.sql
```

The file is multi-statement, so it is not a `@lunora/d1` `Migration`. Commit
`.snapshot.json` with it, or the next diff won't see a dropped table.

Hyperdrive-backed tables are left out of `migrate generate` (it emits SQLite
DDL). Write destructive DDL for them by hand against your database. See
`lunora-setup-hyperdrive-global`.

`defineMigration` does not reach `.global()` rows on either backend: it runs
inside each shard's Durable Object against that shard's SQLite, never D1 or
Hyperdrive. Backfill a global table with a SQL `UPDATE` (D1: `wrangler d1
execute`; Hyperdrive: your Postgres/MySQL client). The drift gate still keys on
a migration naming the table, so once the SQL backfill is done, deploy the
narrowing change with `--allow-schema-drift` rather than a no-op migration.

### Moving a dataset from D1 to Hyperdrive

```bash
lunora migrate d1-to-hyperdrive --from-url https://old-worker --to-url https://new-worker
```

`--tables a,b` limits it to some tables, and `--out <path>` keeps the
intermediate NDJSON dump. This moves the data to another backend; any
reshaping still follows widen → migrate → narrow.

## Common pitfalls

1. **Making a field required before backfilling.** The gate blocks it unless a
   new migration on that table is part of the same deploy. Widen first.
2. **Backfilling with a hand-written mutation.** A mutation that `.collect()`s
   a large table runs into transaction limits and can't resume.
   `defineMigration` batches per shard and resumes.
3. **Not dual-writing during the window.** Rows inserted mid-migration keep the
   old shape. Write the new shape from the widen step on.
4. **A non-literal `table`.** `table: TABLE_NAME` covers nothing in the gate.
5. **Bypassing the gate.** `--allow-schema-drift` / `--update-schema-baseline`
   ship the shape without touching data; use them only when existing rows are
   already compatible.

## Checklist

- [ ] Identified the layer (root / `.shardBy()` / `.global()` D1 / Hyperdrive).
- [ ] Widened the schema; reads handle both shapes; writes use the new shape. Deployed.
- [ ] `lunora migrate create <id> --table <t>`; transform filled in; `--dry-run` looks right.
- [ ] `lunora migrate up <id>` (prod: `--prod --yes`); `lunora migrate status <id>` complete on every shard.
- [ ] D1 destructive DDL: `migrate generate` output reviewed and applied with `wrangler d1 execute`.
- [ ] Narrowed the schema and removed both-shapes code; drift gate green on deploy.
