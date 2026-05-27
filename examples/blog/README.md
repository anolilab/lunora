# @cirrus-example/blog

A blogging app that exercises the full Cirrus add-on stack: email/password
auth, R2-backed featured images, and a nightly scheduler that purges stale
drafts.

## What it demonstrates

- `.global()` on the `users` table — identity lives in D1 so it's queryable
  across every shard
- Email/password auth via `@cirrus/auth` (signin + signup routes)
- Direct-to-R2 uploads via `ctx.storage.getSignedUrl(..., { method: "PUT" })`
- Cron-driven background work via `@cirrus/scheduler` + a Wrangler trigger
- A multi-route SPA (auth → dashboard) wired with `useAuth`

## Run it

```bash
# One-time setup
pnpm dlx wrangler d1 create cirrus-example-blog
pnpm dlx wrangler r2 bucket create cirrus-example-blog-files
pnpm dlx wrangler secret put AUTH_SECRET
pnpm dlx wrangler secret put STORAGE_SECRET

# Paste the D1 database_id into wrangler.jsonc, then:
pnpm install
pnpm --filter @cirrus-example/blog dev
```

The dev server listens on <http://localhost:5175>.

## Key snippets

### Multi-tier schema (`cirrus/schema.ts`)

```ts
users: defineTable({ /* ... */ })
    .global()
    .index("by_email", ["email"], { unique: true }),

posts: defineTable({ /* ... */ })
    .index("by_published", ["publishedAt"]),

drafts: defineTable({ /* ... */ })
    .index("by_updated", ["updatedAt"]),
```

`users` is `.global()` (D1, cross-shard) so signin lookups don't fan out;
`posts` and `drafts` are root-scoped (per ShardDO) so writes stay SQLite-
fast.

### Direct-to-R2 upload (`cirrus/posts.ts`)

```ts
export const requestImageUpload = mutation({
    args: { contentType: v.string() },
    handler: async (ctx, { contentType }) => {
        const key = `posts/${ctx.auth.userId}/${crypto.randomUUID()}`;
        const url = await ctx.storage.getSignedUrl(key, { expiresInSeconds: 60 });
        return { key, url };
    },
});
```

Client then does `fetch(url, { method: "PUT", body: file })` — the Worker
never touches the bytes.

### Nightly cleanup (`wrangler.jsonc` + `cirrus/cleanup.ts`)

```jsonc
"triggers": { "crons": ["0 3 * * *"] }
```

```ts
export const purgeStaleDrafts = mutation({
    args: {},
    handler: async (ctx) => {
        const cutoff = Date.now() - THIRTY_DAYS_MS;
        const stale = await ctx.db
            .query("drafts")
            .filter((d) => d.updatedAt < cutoff)
            .collect();
        for (const draft of stale) await ctx.db.delete(draft._id);
        return { deleted: stale.length };
    },
});
```

The Wrangler cron triggers the SchedulerDO at 03:00 UTC; the SchedulerDO
fans the run-out to every shard.
