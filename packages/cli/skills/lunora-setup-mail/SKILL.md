---
name: lunora-setup-mail
description: Adds transactional email to a Lunora app with the `mail` registry item (`@lunora/mail`). Covers the server-only `internal.mail.sendEmail` / `queueEmail` actions, the `SEND_EMAIL` Cloudflare Email Workers binding, Resend via `RESEND_API_KEY`, `react-email` templates via `renderEmail`, the dev mail catcher (Studio Mail tab), E2E inbox helpers, and inbound mail. Use when the user wants to send verification, password-reset, invite or notification email, runs `lunora add email` or `lunora registry add mail`, edits `lunora/mail/index.ts`, asks why mail isn't delivered or doesn't show up in the Studio, or wants to receive email.
---

# Lunora Setup Mail

The `mail` registry item wraps `@lunora/mail`, which validates addresses against
header injection before sending. It exposes two `internalAction`s, `sendEmail`
and `queueEmail`. Both are server-only on purpose: a mailer that lets the client
pick the recipient, subject and body is an open relay for phishing through your
verified domain. In dev, every send is captured into the Studio Mail tab and
nothing is delivered.

If the project has no Lunora backend yet, start with `lunora-quickstart`.

## Step 1: Add the item

```bash
lunora add email                          # asks for the verified destination address
lunora add email --mail-to ops@example.com
lunora registry add mail                  # low-level: leaves the REPLACE_ME@example.com placeholder
```

Then run `pnpm install` and `lunora codegen`. The item does the following:

1. Adds `@lunora/mail` and `@lunora/server`.
2. Copies `lunora/mail/index.ts` into the project. The project owns this file. It defines `sendEmail`, which returns `{ id }`, and `queueEmail`, which returns `{ queued: true }`.
3. Adds a `send_email` binding named `SEND_EMAIL` (with `destination_address`) to `wrangler.jsonc`.
4. Writes `MAIL_FROM` to `.dev.vars`.

Codegen emits the two functions as `internal.mail.sendEmail` and
`internal.mail.queueEmail`. They are not in the client-reachable `api`. A client
call to them returns `FUNCTION_NOT_FOUND`.

## Step 2: Choose the delivery path

The copied file builds its mailer with `createMailerFromEnv`. That function
picks the transport in this order:

| Condition                                             | Transport                                           |
| ----------------------------------------------------- | --------------------------------------------------- |
| `LUNORA_MAIL_CAPTURE=1`, or a dev environment (below) | **Capture** into the Studio Mail tab                |
| `SEND_EMAIL` binding present                          | Cloudflare Email Workers                            |
| no binding, `RESEND_API_KEY` secret set               | Resend                                              |
| none of the above                                     | throws on send (production never captures silently) |

- **Cloudflare Email Workers.** The binding sends to a single recipient, and only to verified [Email Routing](https://developers.cloudflare.com/email-routing/) destinations. That fits app-to-operator mail. Verify the address and replace the placeholder.
- **Resend.** Use this to send to arbitrary users. Run `wrangler secret put RESEND_API_KEY` and remove the `send_email` binding. While the binding exists it takes precedence over Resend.
- **Capture.** Capture turns on when every env-name var (`WORKER_ENV`, `NODE_ENV`, …) looks like dev. `lunora dev` sets `WORKER_ENV=development`, so capture is on in dev. Capture writes to the root shard. If `SHARD` or `LUNORA_ADMIN_TOKEN` is missing, captured mail is discarded and a one-time warning is logged. To deliver for real from dev, set `LUNORA_MAIL_CAPTURE=0`.

`MAIL_FROM` is required on every path. It accepts `Name <addr@host>` or a bare
address.

## Step 3: Send from a server function

`sendEmail` is an action because sending is non-transactional network I/O. From
a mutation, schedule it so the send runs only after the mutation commits:

```ts
import { internal } from "#lunora/_generated/internal.js";
import { mutation, v } from "#lunora/_generated/server.js";

export const inviteMember = mutation.input({ teamId: v.id("teams"), email: v.string() }).mutation(async ({ ctx, args }) => {
    // Authorize the caller and persist the invite first. The server decides
    // the recipient and the content: never forward a client-chosen to/from/html.
    await ctx.scheduler.runAfter(0, internal.mail.sendEmail, {
        to: args.email,
        subject: "You're invited",
        html: "<p>Click the link to join.</p>",
    });
});
```

Sending to an arbitrary `args.email` needs the Resend path in production: the
`SEND_EMAIL` binding only reaches its verified destination.

From an action, call `await ctx.runAction(internal.mail.sendEmail, { … })`.

If a client needs to trigger a send, write a public action for that one purpose.
It should take only business inputs (for example `{ orderId }`), check
`ctx.auth`, derive the recipient on the server, rate-limit the call
(`@lunora/ratelimit`), and then call `internal.mail.sendEmail`.

### React templates

A React element can't be serialized across the RPC boundary, so render it to
`html` and `text` first. Rendering this way keeps dev capture working:

```tsx
import { renderEmail } from "@lunora/mail"; // needs `react` installed

import { WelcomeEmail } from "./emails/welcome";

const { html, text } = await renderEmail(<WelcomeEmail name={name} />);
await ctx.runAction(internal.mail.sendEmail, { to, subject: "Welcome", html, text });
```

For the auth flows, `lunora add auth-emails` adds ready-made templates.

### Queueing (optional)

`queueEmail` requires a Cloudflare Queue producer binding passed as
`createMailerFromEnv(env, { queue })` in `mailer()`, and the item doesn't add one. Without it, the call
throws `` `queue` binding is required for mailer.queue() ``, except under
capture, where it sends straight to the capture inbox so dev flows keep working.
A consumer builds its mailer with `createMailerFromEnv` too, drains the queue
with `consumeQueuedSend(mailer, message.body)` and then calls `message.ack()`
for each message. With a queue bound in dev, the message still goes through the
queue and the consumer's mailer captures it into the inbox. Queues deliver at least once: with
per-message acks a later throw retries only the unacknowledged messages, while
without them a single throw resends the whole batch. The full wiring is in the "Queueing"
section of the item README.

## Testing and inbound

- **E2E.** `@lunora/mail/testing` exports `waitForMail({ baseUrl, adminToken, to, subjectMatch })` and `extractLink(mail, { match })`. Together they let you read the captured inbox and pull out a verification or reset link.
- **Receiving mail.** `@lunora/mail/inbound` provides `createInboundEmailHandler`, `parseInboundEmail` and `dispatchToLunoraFunction`. They route Email Routing messages into a Lunora function. Mount them with the generated builder's `.onEmail(...)`.

## Verify

1. Run `lunora dev` and trigger a send. With `SHARD` and `LUNORA_ADMIN_TOKEN` set, the message should appear in the Studio Mail tab; if either is missing, capture discards it and logs a warning.
2. Before deploying, run `lunora doctor`. It flags the placeholder destination. Confirm that `MAIL_FROM` is set, and that either the binding uses a verified destination or `RESEND_API_KEY` is set with the binding removed.
