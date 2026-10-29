---
name: drizzle-orm
description: "Type-safe SQL ORM for TypeScript with zero runtime overhead"
user-invocable: false
disable-model-invocation: true
progressive_disclosure:
  entry_point:
    summary: "Type-safe SQL ORM for TypeScript with zero runtime overhead"
    when_to_use: "When working with drizzle-orm or related functionality."
    quick_start: "1. Review the core concepts below. 2. Apply patterns to your use case. 3. Follow best practices for implementation."
  references:
    - advanced-schemas.md
    - performance.md
    - query-patterns.md
    - vs-prisma.md
---
# Drizzle ORM

Modern TypeScript-first ORM with zero dependencies, compile-time type safety, and SQL-like syntax. Optimized for edge runtimes and serverless environments.

## Using Drizzle in Lunora

Read this section first in a Lunora app. The rest of this file describes generic Drizzle.

- Lunora pins `drizzle-orm` to `1.0.0-rc.5` in the pnpm catalog. Pin the same version exactly (`-E`). Do not use `@rc` or caret ranges, which float to newer rc builds.
- Drizzle is the SQL layer under Lunora's own ORM. App code reads and writes through `ctx.db` in queries and mutations, not through Drizzle.
- A `ShardDO` subclass reaches Drizzle through `this.db`, a `drizzle-orm/durable-sqlite` handle over the Durable Object's SQLite storage. It is built without a `relations` option, so `this.db.query.*` is not available. Use the query builder (`this.db.select()`, `this.db.insert()`, ...) against the generated tables.
- Tables come from `_generated/drizzle.shard.ts` and `_generated/drizzle.global.ts`, which codegen writes with `sqliteTable` re-exported from `lunorash/server/drizzle`. Do not edit them by hand. Run `lunora codegen`.
- Lunora owns schema codegen and migrations. Do not add a `drizzle.config.ts` or run `drizzle-kit` against a Lunora app. The drizzle-kit sections below do not apply there.
- Lunora declares relations with `defineTable(...).relations(...)`. Do not use Drizzle's `defineRelations` for Lunora tables.
- rc.5 behaviour that reaches `this.db`: `.get()` on the durable-sqlite handle returns the first row, or `undefined` when there are no rows. It no longer throws when the row count is not exactly one, so a call that expected exactly one row can now get the first of several. Check for `undefined` and use `.all()` when you need every row.

## Quick Start

### Installation

```bash
# Core ORM, pinned exactly to the release Lunora uses
npm install -E drizzle-orm@1.0.0-rc.5

# Database driver (choose one)
npm install pg            # PostgreSQL
npm install mysql2        # MySQL
npm install better-sqlite3 # SQLite

# Drizzle Kit (migrations), pinned to the same release
npm install -D -E drizzle-kit@1.0.0-rc.5
```

### Basic Setup

```typescript
// db/schema.ts
import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// db/client.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle({ client: pool });
```

Drivers take either a connection string or an object: `drizzle(url)`, `drizzle(url, config)`, or `drizzle({ client })` / `drizzle({ connection })`. Passing the client positionally is accepted only by some drivers (D1, Durable Object storage); for the others, use `{ client }`.

### First Query

```typescript
import { db } from './db/client';
import { users } from './db/schema';
import { eq } from 'drizzle-orm';

// Insert
const newUser = await db.insert(users).values({
  email: 'user@example.com',
  name: 'John Doe',
}).returning();

// Select
const allUsers = await db.select().from(users);

// Where
const user = await db.select().from(users).where(eq(users.id, 1));

// Update
await db.update(users).set({ name: 'Jane Doe' }).where(eq(users.id, 1));

// Delete
await db.delete(users).where(eq(users.id, 1));
```

## Schema Definition

### Column Types Reference

| PostgreSQL | MySQL | SQLite | TypeScript |
|------------|-------|--------|------------|
| `serial()` | `serial()` | `integer()` | `number` |
| `text()` | `text()` | `text()` | `string` |
| `integer()` | `int()` | `integer()` | `number` |
| `boolean()` | `boolean()` | `integer()` | `boolean` |
| `timestamp()` | `datetime()` | `integer()` | `Date` |
| `json()` | `json()` | `text()` | `unknown` |
| `uuid()` | `varchar(36)` | `text()` | `string` |

### Common Schema Patterns

```typescript
import { pgTable, serial, text, varchar, integer, boolean, timestamp, json, unique } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  role: text('role', { enum: ['admin', 'user', 'guest'] }).default('user'),
  metadata: json('metadata').$type<{ theme: string; locale: string }>(),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  emailIdx: unique('email_unique_idx').on(table.email),
}));

// Infer TypeScript types
type User = typeof users.$inferSelect;
type NewUser = typeof users.$inferInsert;
```

## Relations

Relations are declared once with `defineRelations(schema, callback)`. The callback receives `r`, with `r.one.<table>(...)` and `r.many.<table>(...)`, and returns the config keyed by table name. Options: `from` and `to` (formerly `fields` and `references`), `alias` (formerly `relationName`). Pass the result to `drizzle()` as `relations`. The `schema` option and per-table `relations()` from v0 are gone.

### One-to-Many

```typescript
// db/schema.ts
import { pgTable, serial, text, integer } from 'drizzle-orm/pg-core';

export const authors = pgTable('authors', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id').notNull().references(() => authors.id),
});

// db/relations.ts
import { defineRelations } from 'drizzle-orm';
import * as schema from './schema';

export const relations = defineRelations(schema, (r) => ({
  authors: {
    posts: r.many.posts({
      from: r.authors.id,
      to: r.posts.authorId,
    }),
  },
  posts: {
    author: r.one.authors({
      from: r.posts.authorId,
      to: r.authors.id,
    }),
  },
}));

// db/client.ts: relations must be passed to drizzle() for db.query
// export const db = drizzle({ client: pool, relations });

// Query with relations
const authorsWithPosts = await db.query.authors.findMany({
  with: { posts: true },
});
```

With explicit `from` and `to`, a `many` relation does not need a matching `one` on the other side. `one` describes the loading direction, not cardinality: a one-to-one relation needs `one` on both sides plus a unique constraint in the database.

### Many-to-Many

```typescript
// db/schema.ts
import { pgTable, serial, text, integer, primaryKey } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});

export const groups = pgTable('groups', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});

export const usersToGroups = pgTable('users_to_groups', {
  userId: integer('user_id').notNull().references(() => users.id),
  groupId: integer('group_id').notNull().references(() => groups.id),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.groupId] }),
}));

// db/relations.ts
import { defineRelations } from 'drizzle-orm';
import * as schema from './schema';

export const relations = defineRelations(schema, (r) => ({
  users: {
    groups: r.many.groups({
      from: r.users.id.through(r.usersToGroups.userId),
      to: r.groups.id.through(r.usersToGroups.groupId),
    }),
  },
  groups: {
    users: r.many.users({
      from: r.groups.id.through(r.usersToGroups.groupId),
      to: r.users.id.through(r.usersToGroups.userId),
    }),
  },
}));

// Joined rows come back nested; no manual mapping over the join table
const usersWithGroups = await db.query.users.findMany({
  with: { groups: { orderBy: { id: 'asc' } } },
});
```

Join tables still work without `through` when the link table carries extra data, such as a timestamp.

## Queries

### Filtering

```typescript
import { eq, ne, gt, gte, lt, lte, like, ilike, inArray, isNull, isNotNull, and, or, between } from 'drizzle-orm';

// Equality
await db.select().from(users).where(eq(users.email, 'user@example.com'));

// Comparison
await db.select().from(users).where(gt(users.id, 10));

// Pattern matching
await db.select().from(users).where(like(users.name, '%John%'));

// Multiple conditions
await db.select().from(users).where(
  and(
    eq(users.role, 'admin'),
    gt(users.createdAt, new Date('2024-01-01'))
  )
);

// IN clause
await db.select().from(users).where(inArray(users.id, [1, 2, 3]));

// NULL checks
await db.select().from(users).where(isNull(users.deletedAt));
```

In rc.5 an `undefined` value in a filter throws instead of being ignored. Leave the clause out when the value is optional. In relational `where`, empty `OR` and `AND` arrays also throw, so omit the key when the list is empty. Relational `where` accepts `EmptyFilter` (exported from `drizzle-orm`) for an optional filter.

### Joins

```typescript
import { eq } from 'drizzle-orm';

// Inner join
const result = await db
  .select({
    user: users,
    post: posts,
  })
  .from(users)
  .innerJoin(posts, eq(users.id, posts.authorId));

// Left join
const result = await db
  .select({
    user: users,
    post: posts,
  })
  .from(users)
  .leftJoin(posts, eq(users.id, posts.authorId));

// Multiple joins with aggregation
import { count, sql } from 'drizzle-orm';

const result = await db
  .select({
    authorName: authors.name,
    postCount: count(posts.id),
  })
  .from(authors)
  .leftJoin(posts, eq(authors.id, posts.authorId))
  .groupBy(authors.id);
```

### Pagination & Sorting

```typescript
import { desc, asc } from 'drizzle-orm';

// Order by
await db.select().from(users).orderBy(desc(users.createdAt));

// Limit & offset
await db.select().from(users).limit(10).offset(20);

// Pagination helper
function paginate(page: number, pageSize: number = 10) {
  return db.select().from(users)
    .limit(pageSize)
    .offset(page * pageSize);
}
```

## Transactions

```typescript
// Auto-rollback on error
await db.transaction(async (tx) => {
  await tx.insert(users).values({ email: 'user@example.com', name: 'John' });
  await tx.insert(posts).values({ title: 'First Post', authorId: 1 });
  // If any query fails, entire transaction rolls back
});

// Conditional rollback: throwing from the callback rolls back and rethrows
await db.transaction(async (tx) => {
  const [user] = await tx.insert(users).values({ email: 'user@example.com', name: 'John' }).returning();

  if (!user) {
    throw new Error('insert returned no row');
  }

  await tx.insert(posts).values({ title: 'First Post', authorId: user.id });
});
```

## Migrations

### Drizzle Kit Configuration

```typescript
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

### Migration Workflow

```bash
# Generate a migration folder from schema changes
npx drizzle-kit generate

# Apply pending migrations
npx drizzle-kit migrate

# Check migrations for conflicts with other branches (no database needed)
npx drizzle-kit check

# Pull the schema of an existing database (replaces `introspect`)
npx drizzle-kit pull

# Apply schema changes directly, without migration files
npx drizzle-kit push

# Convert a pre-1.0 migrations folder (see below)
npx drizzle-kit up

# Drizzle Studio (database GUI)
npx drizzle-kit studio
```

### Migration Folders

In drizzle-kit v1 each migration is its own folder, `drizzle/<timestamp>_<name>/`, holding `migration.sql` and `snapshot.json`. There is no shared `meta/_journal.json`, so branches that each add a migration no longer conflict on one file. `generate` and `migrate` run the conflict check; `check` runs it on its own.

- `drizzle-kit up` converts a pre-1.0 folder. It deletes the old `.sql` files and `meta/`, so commit first; Git is the only way back.
- Two migrations conflict when running them in either order gives different schemas, for example one drops a table while the other adds a column to it. Fix by deleting your unapplied migration and regenerating it. On PostgreSQL, `generate --fix-conflicts` deletes both branches' conflicting migrations, plus every migration after them, and writes one new migration. Check first that the deleted migrations have not run on a database you need, and copy out any custom SQL you still need.
- Changing a column's type, default, or `NOT NULL` on SQLite or Turso rebuilds the table, so it conflicts with other column changes on that table.

### Example Migration

```sql
-- drizzle/<timestamp>_initial/migration.sql
CREATE TABLE IF NOT EXISTS "users" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" varchar(255) NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "users_email_unique" UNIQUE("email")
);
```

## Navigation

### Detailed References

- **[🏗️ Advanced Schemas](./references/advanced-schemas.md)** - Custom types, composite keys, indexes, constraints, multi-tenant patterns. Load when designing complex database schemas.

- **[🔍 Query Patterns](./references/query-patterns.md)** - Subqueries, CTEs, raw SQL, prepared statements, batch operations. Load when optimizing queries or handling complex filtering.

- **[⚡ Performance](./references/performance.md)** - Connection pooling, query optimization, N+1 prevention, prepared statements, edge runtime integration. Load when scaling or optimizing database performance.

- **[🔄 vs Prisma](./references/vs-prisma.md)** - Feature comparison, migration guide, when to choose Drizzle over Prisma. Load when evaluating ORMs or migrating from Prisma.

## Red Flags

**Stop and reconsider if:**
- Using `any` or `unknown` for JSON columns without type annotation
- Building raw SQL strings without using `sql` template (SQL injection risk)
- Not using transactions for multi-step data modifications
- Fetching all rows without pagination in production queries
- Missing indexes on foreign keys or frequently queried columns
- Using `select()` without specifying columns for large tables

## Performance Benefits vs Prisma

| Metric | Drizzle | Prisma |
|--------|---------|--------|
| **Bundle Size** | ~35KB | ~230KB |
| **Cold Start** | ~10ms | ~250ms |
| **Query Speed** | Baseline | ~2-3x slower |
| **Memory** | ~10MB | ~50MB |
| **Type Generation** | Runtime inference | Build-time generation |

## Integration

- **typescript-core**: Type-safe schema inference with `satisfies`
- **nextjs-core**: Server Actions, Route Handlers, Middleware integration
- **Database Migration**: Safe schema evolution patterns

## Related Skills

When using Drizzle, these skills enhance your workflow:
- **prisma**: Alternative ORM comparison: Drizzle vs Prisma trade-offs
- **typescript**: Advanced TypeScript patterns for type-safe queries
- **nextjs**: Drizzle with Next.js Server Actions and API routes
- **sqlalchemy**: SQLAlchemy patterns for Python developers learning Drizzle

[Full documentation available in these skills if deployed in your bundle]
