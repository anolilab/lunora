# @lunora-example/team-chat

Channels, live messages, presence, per-channel full-text search, and file
uploads straight to R2 — with each channel running as its own Durable Object.

## Deploy it

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/anolilab/lunora/tree/alpha/examples/team-chat)

One click clones the repo, provisions the Durable Object namespace, the D1 database and the R2 bucket, prompts for the secrets in
`.dev.vars.example`, and deploys. Or from a checkout:

```bash
pnpm --filter @lunora-example/team-chat run deploy
```

## What it demonstrates

- **A shard per channel.** `messages` and `presence` are `.shardBy("channelId")`.
  Sending a message is one serialized commit inside one Durable Object, and the
  poke reaches the sockets subscribed to that channel and nobody else. Adding
  channels adds objects, not contention.
- **All three data tiers in one schema.** Sharded (`messages`, `presence`),
  root-scoped (`channels` — small, listed before you know which channel you
  want), and `.global()` (`profiles` — identity has to resolve from inside any
  shard, so it lives in D1).
- **The join that sharding costs you.** A query runs inside one shard, so
  `messages.list` cannot join `profiles`. It returns author ids and the client
  joins against one directory subscription. That trade is the point.
- **`defineApp()` for worker composition.** The generated builder wires each
  capability's `ctx.*` surface and its admin/studio surface together — see the
  note below on what going hand-rolled costs you.
- **`authorizeShard`.** Shard keys come from the client, so the Worker decides
  who may address which shard. Here: any signed-in user, no anonymous caller.
  That boundary admits every signed-in user, so membership is enforced inside
  each procedure that reads or writes channel data. A signed-in non-member can
  open a socket to a channel's shard and subscribe, but every query there is
  refused with `FORBIDDEN` and every mutation too, so they receive no channel data.
- **Membership, checked in the shard.** `members` lives in each channel's own
  shard, so the check and the data it protects sit in one serialized place, and a
  `leave` is a write there that re-runs the subscriptions of anyone still listening.
  The creator becomes a member through the client's create-then-join flow, not
  inside `channels.create`: the client calls `channels.join` right after
  `channels.create`, with that channel's shard key. `create` itself does not write
  a membership row, so a creator who closes the tab between create and join is not
  a member until they join. `channels.join` is idempotent,
  and `channels.leave` removes the caller's row; removing the last member is
  allowed and the channel stays. `channels.membership` (any signed-in user) reports
  whether the caller is in a channel and how many members it has, and
  `channels.members` lists them, to members only.
- **Presence without a sweeper.** Tabs heartbeat; the query returns every row and
  the client applies the TTL. Nothing runs on an alarm, and no `Date.now()`
  filter sits inside a live query waiting for someone else to write.
- **Uploads the Worker never touches.** An action mints a signed `PUT`, the
  browser streams the file into R2, and only the key travels through the
  mutation. `/files/*` verifies the signature on the way back out.
- **Search inside a shard.** `.searchIndex()` lives in the channel's own SQLite,
  so search is scoped to a channel — searching everywhere would fan out across
  every channel DO.

## Setup

This example needs D1 (auth + `profiles`) and R2 (attachments).

```bash
pnpm install

cp examples/team-chat/.dev.vars.example examples/team-chat/.dev.vars   # then fill in both secrets

wrangler d1 create lunora-example-team-chat        # paste the id into wrangler.jsonc
wrangler r2 bucket create lunora-example-team-chat-files

pnpm --filter @lunora-example/team-chat dev
```

Open the URL the dev server prints (<http://localhost:5173> in the main checkout), create an account, create a channel, then open a
second browser profile and watch the roster and the messages move.

better-auth's tables are created on the first request by the builder's `.auth()`
declaration. For production, prefer `compileMigrationsSql` + `wrangler d1 execute`
at deploy time.

## Two things that only fail at runtime

Both of these compile cleanly and throw on the first request. They are worth
knowing before you copy this schema into your own app.

**A `.global()` table needs a global backend, and it is not `ctx.db.query()`.**
`.global()` tables live in D1, not in a shard's SQLite. Two consequences:

1. The worker has to declare the binding — `.global({ d1: (env) => env.DB })`.
   Without it every read throws _"no global backend configured"_.
2. D1 does not serve the legacy `ctx.db.query(...).withIndex(...)` reader at all.
   Read global tables through the per-table facade instead:

```ts
// ✗ throws: "the legacy query()/withIndex() reader is not available on the D1 (global) backend"
await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();

// ✓ the facade compiles to SQL
await ctx.db.profiles.findFirst({ where: { userId } });
const { page } = await ctx.db.profiles.findMany({});
```

**Signed URLs need somewhere to land.** `generateUploadUrl` mints a URL against
the origin the action's request arrived on (no `publicBaseUrl` is configured,
so there is no per-environment value to ship); R2 is not on the internet, so something must verify the
signature and move the bytes. That is the `/files/*` route in
`src/server/index.ts` (`verifySignedUrl` → `PUT`/`GET` on the bucket). Storage
keys are prefixed `files/` so the signed pathname matches that route.

## Key snippets

### Tiers (`lunora/schema.ts`)

```ts
channels: defineTable({ name: v.string(), createdBy: v.string() }).index("by_name", ["name"], { unique: true }),

messages: defineTable({ channelId: v.string(), authorId: v.string(), content: v.string() })
    .shardBy("channelId")
    .index("by_channel", ["channelId"])
    .searchIndex("search_content", { field: "content", filterFields: ["channelId"] }),

profiles: defineTable({ userId: v.string(), name: v.string() }).global().index("by_user", ["userId"], { unique: true }),
```

### Composing the worker (`src/server/index.ts`)

```ts
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    .adminRevocations((env) => env.ADMIN_REVOCATIONS)
    .global({ d1: (env) => env.DB })
    .auth({ d1: (env) => env.DB, options: authOptions })
    .storage({ bucket: (env) => env.FILES, signingSecret: (env) => env.STORAGE_SECRET })
    .extend(() => ({ authorizeShard: ({ identity }) => Boolean(identity?.userId) }))
    .build();
```

### Pinning the shard (`src/client/Channel.tsx`)

```ts
const messages = useQuery(api.messages.list, { channelId }, { shardKey: channelId });

await send({ channelId, content }, { shardKey: channelId });
```

Drop `shardKey` and the runtime has to fan out across every channel's DO.

## Not included

No private channels, no threads, no rate limits. Every channel is listed to every
signed-in user, and any of them can join one. A private channel needs an
invite flow and a list that hides channels from non-members; `join` alone is not
enough. Joining also does not check that the channel exists in the root
`channels` table, because a shard cannot read that table. A membership row for
an unknown name grants access to nothing, and `messages.send` already accepts any
channel id a signed-in caller names. For write limits, add `.use(rateLimit(...))`
from `@lunora/ratelimit` to `messages.send`.
