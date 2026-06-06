# mail

Transactional email for Cirrus. Wraps [`@cirrus/mail`](../../packages/mail)'s `createMailer` — a [Resend](https://resend.com)-backed transport built on [`@visulima/email`](https://github.com/visulima/visulima) — and exposes it as a `sendEmail` action so you can deliver mail from any mutation/action via `ctx.runAction(api.mail.sendEmail, …)` or straight from a client.

Address fields are validated for length and CR/LF/comma (the classic SMTP header-injection vectors) by `@cirrus/mail` before they ever reach the provider, and provider errors are logged server-side but surfaced to callers as a generic message — so this isn't just a thin `fetch` wrapper.

## Install

```bash
cirrus registry add mail
```

This:

1. Adds `@cirrus/mail` and `@cirrus/server` to your `package.json` (run `pnpm install` afterwards).
2. Copies `cirrus/mail/index.ts` (the `sendEmail` / `queueEmail` actions) into your project — this is **yours** to edit.
3. Scaffolds two env vars into `.dev.vars`: `RESEND_API_KEY` (a secret placeholder) and `MAIL_FROM` (a non-secret default sender). Set the secret with `wrangler secret put RESEND_API_KEY`.

Then regenerate types:

```bash
cirrus codegen
```

The functions surface in the generated `api` as `mail/sendEmail` and `mail/queueEmail` — i.e. `api.mail.sendEmail` and friends.

## How it works

- **sendEmail** (action) builds a mailer from env (`RESEND_API_KEY` + `MAIL_FROM`) and calls `mailer.send(opts)`, which validates every address, optionally renders a React template, and awaits the Resend round-trip. It returns the provider message `{ id }`. It's an **action** — not a mutation/query — because sending mail is non-transactional network I/O, and actions are the only Cirrus function kind allowed to do that.
- **queueEmail** (action) calls `mailer.queue(opts)`, which serializes the (pre-rendered) payload onto a Cloudflare Queue and returns `{ queued: true }` immediately, so the request isn't blocked on the provider. It needs a Queue binding (see below); until you wire one up, `@cirrus/mail` throws `` `queue` binding is required for mailer.queue() ``.

Config is read from `cloudflare:workers`' `env` at call time — the one canonical source every Cirrus registry item uses for bindings, vars, and secrets, so the same code works in `cirrus dev` and on the edge. A missing var throws a clear `missing env var …` error instead of an opaque provider failure.

## Use it

### From another function

```ts
// cirrus/users.ts
import { mutation } from "@cirrus/server";

import { api } from "./_generated/api";

export const inviteUser = mutation({
    args: { email: v.string() },
    handler: async (ctx, { email }) => {
        // ...persist the invite, then send the mail as a follow-up action
        await ctx.scheduler.runAfter(0, api.mail.sendEmail, {
            to: email,
            subject: "You're invited",
            html: "<p>Click the link to join.</p>",
        });
    },
});
```

### From a client

```ts
await client.action("mail/sendEmail", {
    to: "alice@example.com",
    subject: "Welcome",
    text: "Thanks for signing up!",
});
```

### With a React email template

The args validator can't carry a React element across the RPC boundary (React elements aren't JSON-serializable), so `sendEmail` takes `html`/`text`. To use a [`react-email`](https://react.email) template, render it where you call the mailer — e.g. edit `cirrus/mail/index.ts` to import `renderEmail` from `@cirrus/mail` (or pass `react` straight into `mailer.send({ react: <Welcome /> })` from your own action):

```ts
import { createMailer } from "@cirrus/mail";
import { env } from "cloudflare:workers";

import { WelcomeEmail } from "./emails/Welcome.js";

await createMailer({ apiKey: env.RESEND_API_KEY as string, from: env.MAIL_FROM as string }).send({
    to: "alice@example.com",
    subject: "Welcome",
    react: <WelcomeEmail name="Alice" />,
});
```

## Queueing (optional)

`queueEmail` decouples the send from the request by pushing it onto a Cloudflare Queue. To enable it:

1. Add a Queue producer + consumer binding to your `wrangler.jsonc`:

    ```jsonc
    {
        "queues": {
            "producers": [{ "queue": "cirrus-mail", "binding": "MAIL_QUEUE" }],
            "consumers": [{ "queue": "cirrus-mail" }],
        },
    }
    ```

2. Pass the binding into the mailer in `cirrus/mail/index.ts` (uncomment the `queue:` line and supply `env.MAIL_QUEUE`).
3. In your Worker's `queue()` handler, drain the batch with `consumeQueuedSend` from `@cirrus/mail`:

    ```ts
    import { consumeQueuedSend, createMailer } from "@cirrus/mail";

    export default {
        queue: async (batch, env) => {
            const mailer = createMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM });
            for (const message of batch.messages) {
                await consumeQueuedSend(mailer, message.body);
            }
        },
    };
    ```

The registry item doesn't add the Queue binding for you — a queue is an opt-in piece of infrastructure with a name you choose, so it's documented here rather than guessed into your `wrangler.jsonc`.

## What you own

Everything under `cirrus/mail/` is copied into your repo — change the args, swap Resend for another `@visulima/email` provider via `createMailer({ transport })`, add per-tenant `from` addresses, wire in templates, or split `sendEmail` into typed per-template actions however you like. `@cirrus/mail` provides the transport + address/header validation; this component is the idiomatic Cirrus glue that turns it into `api.mail.*`.
