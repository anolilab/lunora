<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="queue" />

</a>

<h3 align="center">Cloudflare Queues for Lunora: defineQueue producers + consumers, the ctx.queues surface, and the generated queue() worker handler</h3>

<!-- END_PACKAGE_OG_IMAGE_PLACEHOLDER -->

# @lunora/queue

Cloudflare Queues for Lunora: declare a queue with `defineQueue`, enqueue from a
mutation or action via `ctx.queues.<name>.send(...)`, and process delivered
batches in a push handler (or expose the queue to an external HTTP pull
consumer).

```ts
// lunora/queues.ts
import { defineQueue } from "@lunora/queue";

import { api } from "./_generated/api";

export const emailQueue = defineQueue<{ to: string }>({
    handler: async (ctx, batch) => {
        for (const message of batch.messages) {
            await ctx.run(api.email.send, { to: message.body.to });
            message.ack();
        }
    },
});
```

```ts
// inside a mutation/action
await ctx.queues.emailQueue.send({ to: user.email });
```

Codegen emits the typed `ctx.queues` producer and the worker `queue()` dispatch;
`@lunora/config` reconciles the wrangler `queues.producers[]` /
`queues.consumers[]` entries from the same definition. Scaffold a new queue with
`vis generate lunora-queue --name=email`.

## License

The lunora `@lunora/queue` package is open-sourced software licensed under the
[FSL-1.1-Apache-2.0 license](./LICENSE.md).
