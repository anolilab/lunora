<div align="center">
  <h3>@cirrus/seed</h3>
  <p>Schema-driven, deterministic database seeding for Cirrus.</p>
</div>

---

`@cirrus/seed` populates a Cirrus database with realistic, production-like fake
data derived from your `defineSchema`. It introspects every table, maps each
field to a generator (field-name aware — a `string` column called `email`
becomes an email address, `firstName` a first name, and so on), resolves
foreign keys by inserting parent tables before their children, and lets you
override any value.

Generation is **deterministic**: it is built on a vendored, input-hashed
generator (a rebuilt [`copycat`](https://github.com/supabase-community/copycat))
layered over [`@faker-js/faker`](https://fakerjs.dev). The same `seed` value and
schema always produce the same rows, so fixtures are reproducible across runs
and machines.

## Usage

### Generate a plan

```ts
import { seedPlan } from "@cirrus/seed";
import schema from "./cirrus/schema";

const plan = seedPlan(schema, {
    counts: { users: 10, posts: 30 },
    seed: 1,
    overrides: {
        users: { email: (ctx) => `user${ctx.index}@example.com` },
    },
});

// plan === [{ table: "users", rows: [...] }, { table: "posts", rows: [...] }]
// (parents before children; every post.authorId points at a generated user)
```

### Seed an in-memory test harness

```ts
import { cirrusTest } from "@cirrus/testing";
import { seed } from "@cirrus/seed/testing";
import schema from "./cirrus/schema";

const harness = cirrusTest(schema);
const ids = await seed(harness, schema, { counts: { users: 5, posts: 20 } });
// ids.users / ids.posts — the inserted document ids, for assertions
```

### Typed client

For a Snaplet-style, one-table-at-a-time DX, `createSeedClient` exposes each
table as a method. Foreign keys connect to whatever was seeded earlier in the
run, FK parents are pulled in automatically, and state accumulates on
`$store`/`$ids` (clear it with `$reset()`):

```ts
import { createSeedClient } from "@cirrus/seed";
import schema from "./cirrus/schema";

const seed = createSeedClient(schema, { seed: 1 });

const { users } = await seed.users(5);
const { posts } = await seed.posts((x) => x([10, 20])); // a deterministic count in [10, 20]

// Explicit partial rows — omitted columns are still generated:
await seed.users([{ name: "Alice" }, { email: "bob@example.com", name: "Bob" }]);

seed.$ids.users; // every user id generated this run
```

Pass your generated `InsertModel` type — `createSeedClient<InsertModel>(schema)`
— for autocomplete on each table's columns. Supply a `persist` hook to write
each batch as it is generated (parents first).

### Seed a running dev worker

```bash
cirrus seed --count 25                  # 25 rows per table
cirrus seed --table posts --count 100   # one table (FK parents seeded automatically)
cirrus seed --seed 42                    # reproducible run
cirrus seed --reset                      # wipe local .wrangler/state first (local dev only)
cirrus seed --dry-run                    # print NDJSON, write nothing
```

## Limitations

- **`.unique()` columns are not enforced.** Each value is hashed independently,
  so a unique column over a small value space (a bounded integer, a boolean, a
  short enum) can collide across rows. Strings such as emails and uuids are
  effectively unique in practice. Colliding rows are rejected by the import path
  rather than silently overwritten.
- **Seeding is deterministic by design.** Re-running with the same `--seed`
  regenerates identical `_id`s, which the import path skips as conflicts. Use a
  different `--seed` for fresh rows, or `--reset` to wipe local state first.

## License

The Cirrus framework is open-sourced software licensed under the
[FSL-1.1-Apache-2.0 license](./LICENSE.md).
