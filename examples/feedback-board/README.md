# @lunora-example/feedback-board

A public feature-request board: post an idea, upvote it, argue about it in the
comments, and ask a model to read the room.

## Deploy it

> [!WARNING]
> **This example has no authentication, and the identity is client-supplied.** Deployed as-is, anyone with the URL can delete any post, set any status, post comments badged as official team replies, vote as any email address, and read any address's voting history. That is deliberate — it keeps the example about indexes, counters and `ctx.ai` — but it means every write here is a pattern to replace, not to copy. See `examples/auth-playground`.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/anolilab/lunora/tree/alpha/examples/feedback-board)

One click clones the repo, provisions the Durable Object namespace and the Workers AI binding, prompts for the secrets in
`.dev.vars.example`, and deploys. Or from a checkout:

```bash
pnpm --filter @lunora-example/feedback-board run deploy
```

## What it demonstrates

- **A unique index as the constraint, not a check.** `votes` is indexed on
  `["feedbackId", "voterEmail"]` with `{ unique: true }`. The mutation's
  "have you voted already" lookup is a fast path; the index is what actually
  makes a double-submit fail instead of double-counting.
- **Denormalised counters read through an index.** `upvoteCount` lives on the
  post, so "top requests" is an ordered index scan (`by_upvotes`) rather than
  counting vote rows per card.
- **Multi-query optimistic updates.** A vote changes two subscriptions — the
  board and "which posts have I voted on". `withOptimisticUpdate` patches both
  in one callback, and `getAllQueries` reaches every filter/sort variant of the
  board without enumerating their args.
- **`ctx.ai` from an action.** `summaries.generate` reads the top posts, calls
  Workers AI through the Vercel AI SDK, and writes the result back with an
  internal mutation. Inference is a network call, so it lives in an `action`,
  outside the shard transaction.

## Run it

```bash
pnpm install
pnpm --filter @lunora-example/feedback-board dev
```

Open <http://localhost:5173>.

Everything works offline in Miniflare **except** the ✨ Summarise button:
`wrangler dev` proxies the `AI` binding to Cloudflare, so that one path needs an
authenticated account (`wrangler login`).

## Key snippets

### One vote per person (`lunora/schema.ts`)

```ts
votes: defineTable({
    feedbackId: v.id("feedback"),
    voterEmail: v.string(),
})
    .index("by_feedback_and_voter", ["feedbackId", "voterEmail"], { unique: true })
    .index("by_voter", ["voterEmail"]),
```

### Summarising the board (`lunora/summaries.ts`)

```ts
export const generate = action.input({ limit: v.optional(v.number()) }).action(async ({ args: { limit }, ctx }) => {
    const top = (await ctx.runQuery(api.feedback.list, { sortBy: "votes" })).slice(0, limit ?? 10);
    const { text } = await generateText({ model: ctx.ai.model("@cf/meta/llama-3.3-70b-instruct-fp8-fast"), prompt });

    return ctx.runMutation(internal.summaries.store, { feedbackIds: top.map((p) => p._id), summary: text, title: "…" });
});
```

`ctx.ai` appears on the action context because this file imports `@lunora/ai` —
codegen wires the binding. Workers AI is the default; pass any other AI SDK
model to `generateText` to switch providers.

## Not included

There is no auth: `VOTER_EMAIL` in `src/client/App.tsx` stands in for a signed-in
identity, and anyone can change a post's status. Wire `@lunora/auth` and read
`ctx.auth.userId` to make votes and moderation real — see
`examples/auth-playground`.
