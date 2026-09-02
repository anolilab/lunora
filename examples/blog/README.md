# @lunora-example/blog

A blogging app that exercises the full Lunora add-on stack: email/password
auth, R2-backed featured images, and a nightly scheduler that purges stale
drafts.

## What it demonstrates

- Email/password auth via `@lunora/auth` (signin + signup routes), with
  better-auth's own D1 tables as the single identity store
- Semantic search: `.vectorize()` on `posts.body` keeps a Vectorize index in
  sync on every write, and `posts.search` queries it
- Direct-to-R2 uploads via `ctx.storage.generateUploadUrl(key, { contentType })`
  from an **action**
- Code-first crons: `lunora/crons.ts` → the generated `LUNORA_CRONS` map → the
  worker's `scheduled()` entry, running an `internalMutation` nightly
- A multi-route SPA (auth → dashboard) wired with `authClient.useSession()`

There is no `.global()` table here. Identity is better-auth's, in D1, so a
hand-rolled `users` table would be a second credential store nothing writes.
For a `.global()` table with rows in it, read `profiles` in
[`../team-chat`](../team-chat).

## Run it

```bash
# One-time setup
pnpm dlx wrangler d1 create lunora-example-blog
pnpm dlx wrangler r2 bucket create lunora-example-blog-files
pnpm dlx wrangler secret put AUTH_SECRET
pnpm dlx wrangler secret put STORAGE_SECRET

# Paste the D1 database_id into wrangler.jsonc, then:
pnpm install
pnpm --filter @lunora-example/blog dev
```

The dev server listens on <http://localhost:5175>.

## Key snippets

### Schema (`lunora/schema.ts`)

```ts
posts: defineTable({ /* ... */ })
    .index("by_published", ["publishedAt"])
    .vectorize("body", { index: "posts_search", embed: embedText, /* ... */ }),

drafts: defineTable({ /* ... */ })
    // equality prefix + sort key, so one author's drafts come back ordered
    .index("by_author_updated", ["authorId", "updatedAt"])
    .index("by_updated", ["updatedAt"]),
```

Both tables are root-scoped: no `.shardBy()`, so every row lives in the single
default ShardDO and its SQLite. That is the right default — reach for
`.shardBy("authorId")` when one DO's write throughput or storage becomes the
ceiling. `authorId` holds the better-auth user id as a plain string; there is no
`users` table to point a `v.id(...)` at.

### Direct-to-R2 upload (`lunora/posts.ts`)

```ts
export const requestImageUpload = action
    .input({ contentType: v.string().max(128) })
    .use(rateLimit(actionLimiter, "upload", byUser))
    .action(async ({ args: { contentType }, ctx }) => {
        const key = `posts/${ctx.auth.userId}/${crypto.randomUUID()}`;
        const url = await ctx.storage.generateUploadUrl(key, { contentType, expiresInSeconds: 60 });

        return { key, url };
    });
```

Three things worth copying:

- It is an **`action`**, not a mutation. Minting a PUT URL is a write-side
  storage capability, and queries/mutations only get the read-only storage
  surface.
- `generateUploadUrl` is the **upload** signer. `getSignedUrl` signs a
  _download_; handing its URL to a `PUT` fails.
- Signing needs `STORAGE_SECRET` (see `.dev.vars.example`) — without it
  `@lunora/storage` throws on the first upload.

Client then does `fetch(url, { method: "PUT", body: file })` — the Worker
never touches the bytes.

### Nightly cleanup (`lunora/crons.ts` + `lunora/cleanup.ts`)

The schedule is declared in code, once:

```ts
// lunora/crons.ts
const crons = cronJobs();

crons.daily("purge stale drafts", { hourUTC: 3, minuteUTC: 0 }, internal.cleanup.purgeStaleDrafts, {});

export default crons;
```

`lunora codegen` turns that into `_generated/crons.ts` — `LUNORA_CRON_TRIGGERS`
(mirrored into `wrangler.jsonc`'s `triggers.crons`) and `LUNORA_CRONS` (the
dispatcher map). `src/server/index.ts` passes the map to `createWorker` and
re-exports `scheduled()`; without that export the trigger fires into nothing.

The job itself is an **`internalMutation`**:

```ts
// lunora/cleanup.ts
export const purgeStaleDrafts = internalMutation.mutation(async ({ ctx }) => {
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    const stale = await ctx.db
        .query("drafts")
        .withIndex("by_updated", (range) => range.lt("updatedAt", cutoff))
        .collect();

    for (const draft of stale) await ctx.db.delete(draft._id);

    return { deleted: stale.length };
});
```

`internalMutation`, not `mutation`: it deletes every author's stale rows, so it
must not appear on the public `api` where any client could call it.
