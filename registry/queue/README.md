# queue

Cloudflare Queues for Lunora. Declare push or pull consumers with `defineQueue` in `lunora/queues.ts`, and `@lunora/codegen` discovers them — generating typed `ctx.queues.<name>.send(...)` producers on Mutation/ActionCtx, a `queue()` export in the Worker entry, and the matching `queues.producers[]` / `queues.consumers[]` entries in `wrangler.jsonc`.

Built on [`@lunora/queue`](../../packages/queue) — the shared dispatch runner that bundles the consumer handler into your Worker.

## Install

```bash
lunora registry add queue
```

This:

1. Adds `@lunora/queue` and `@lunora/server` to your `package.json` (run `pnpm install` afterwards).
2. Copies `lunora/queues.ts` (the `emailQueue` declaration) into your project — this is **yours** to edit.

Then regenerate types:

```bash
lunora codegen
```

Codegen discovers the `defineQueue()` calls and emits:

- **`ctx.queues.<name>.send(...)`** — typed producer on Mutation and Action contexts.
- **`queue()`** — a Worker entry export that drains push consumer batches.
- **`queues.producers[]` / `queues.consumers[]`** — wrangler bindings.

## How it works

`lunora/queues.ts` exports queue declarations built with `defineQueue`:

```ts
export const emailQueue = defineQueue<{ to: string; subject: string; body: string }>({
    handler: async (ctx, batch) => {
        for (const message of batch.messages) {
            console.log(`sending to ${message.body.to}: ${message.body.subject}`);
            message.ack();
        }
    },
    maxRetries: 3,
});
```

- **Push consumer** — the `handler` runs inside your Worker when messages arrive. No external service needed.
- **`message.ack()`** — acknowledges the message after processing. Unacknowledged messages are retried up to `maxRetries`.
- **Typed producers** — codegen emits typed `send()` methods on `ctx.queues`:

    ```ts
    // From a mutation or action
    await ctx.queues.emailQueue.send({ to: "alice@example.com", subject: "Hello", body: "World" });
    ```

### Pull consumers

Set `mode: "pull"` when declaring the queue to make it HTTP-pull instead of push:

```ts
export const emailQueue = defineQueue<{ to: string; subject: string; body: string }>({
    mode: "pull",
    maxRetries: 3,
});
```

`ctx.queues.<name>` is a **producer only** (`send` / `sendBatch`) — there is no `pull()`. `lunora dev` / `lunora deploy` write a `type: "http_pull"` consumer into `wrangler.jsonc`, and a pull queue is drained from **outside** the Worker: your consumer process calls Cloudflare's Queues HTTP pull API (`POST /accounts/:id/queues/:qid/messages/pull`, then `.../ack`) with an API token. Use pull mode when the consumer is not this Worker; otherwise keep the default push mode and write a `handler`.

## Configuration

Each `defineQueue()` call accepts:

| Option         | Type               | Default  | Description                                                                                      |
| -------------- | ------------------ | -------- | ------------------------------------------------------------------------------------------------ |
| `handler`      | Function           | —        | Push consumer handler (required for push mode).                                                  |
| `maxRetries`   | `number`           | `3`      | Retries AFTER the first delivery before a message is dead-lettered — `3` means up to 4 attempts. |
| `maxBatchSize` | `number`           | `10`     | Max messages per batch delivered to the consumer (1–100; `10` is Cloudflare's default).          |
| `mode`         | `"push" \| "pull"` | `"push"` | Whether the Worker pushes messages or you pull them via HTTP.                                    |

Wrangler-level config (queue name, max concurrency, retry delay) is managed via the generated `wrangler.jsonc` — edit it directly for fine-grained tuning.

## Adding more queues

Each `defineQueue()` export in `lunora/queues.ts` is discovered independently. Add as many as you need:

```ts
export const emailQueue = defineQueue<EmailPayload>({ handler: ..., maxRetries: 3 });
export const webhookQueue = defineQueue<WebhookPayload>({ handler: ..., maxRetries: 5 });
export const auditLogQueue = defineQueue<AuditEntry>({ mode: "pull" });
```

Codegen generates a separate `ctx.queues.<name>` producer for each and syncs all wrangler bindings.

## What you own

`lunora/queues.ts` is copied into your repo — change the handler, add or remove queues, switch between push and pull, tune retries and batch sizes, or wire in different message processing logic however you like. `@lunora/queue` provides the queue framework and dispatch runner; this component is the idiomatic Lunora glue that turns it into `ctx.queues.*`.
