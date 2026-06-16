---
name: lunora-setup-mail
description: Adds transactional email to a Lunora app. Use for sending mail (verification, password reset, invites, notifications) via `lunora registry add mail`, the `sendEmail` / `queueEmail` actions, the `SEND_EMAIL` Cloudflare Email Workers binding, Resend, React email templates, and the dev mail catcher.
---

# Lunora Setup Mail

Wire transactional email into a Lunora app using the `mail` registry item, which
is built on `@lunora/mail` (a Cloudflare Email Workers transport with
header-injection-safe address handling) and exposes a `sendEmail` action plus a
fire-and-forget `queueEmail` action. In dev, every send is captured into the
Studio Mail tab instead of going out.

## When to Use

- Sending app→user mail: invites, notifications, receipts.
- Delivering verification / password-reset mail from `@lunora/auth`.
- Using a React (`react-email`) template or a hosted provider (Resend).

## When Not to Use

- The project has no Lunora backend yet — use `lunora-quickstart` first.
- Mail is already installed and you just want to send — call
  `ctx.runAction(api.mail.sendEmail, …)` or `client.action("mail/sendEmail", …)`.

## Workflow

1. Add the `mail` item.
2. Configure the `SEND_EMAIL` binding (or a provider) and `MAIL_FROM`.
3. Regenerate types with `lunora codegen`.
4. Send mail from a function (or the client); render a React template if needed.

## Step 1: Add the item

```bash
lunora registry add mail
```

This:

1. Adds `@lunora/mail` and `@lunora/server` to `package.json` (run
   `pnpm install` afterwards).
2. Copies `lunora/mail/index.ts` (the `sendEmail` / `queueEmail` actions) into
   your project — it is **yours** to edit.
3. Adds a `send_email` binding (`SEND_EMAIL`, with a `destination_address`
   placeholder) to `wrangler.jsonc` and scaffolds `MAIL_FROM` (the default
   sender) into `.dev.vars`.

## Step 2: Configure delivery

| Name             | Where                                | Notes                                                                             |
| ---------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| `SEND_EMAIL`     | `wrangler.jsonc` → `send_email[]`    | Cloudflare Email Workers binding. Single-recipient; only verified destinations.   |
| `MAIL_FROM`      | var (`.dev.vars` / `wrangler.jsonc`) | Default sender address.                                                           |
| `RESEND_API_KEY` | secret (optional)                    | Use a hosted provider instead — pass `apiKey` to `createMailer` in `lunora/mail`. |

For production with Cloudflare Email Workers, set up
[Email Routing](https://developers.cloudflare.com/email-routing/): verify a
destination address and replace the `REPLACE_ME@example.com` placeholder. Prefer
Resend? Pass `apiKey` (or a custom `transport`) to `createMailer` in your copied
`lunora/mail/index.ts`.

In `lunora dev` (`WORKER_ENV=development`) the scaffold swaps in `@lunora/mail`'s
**capture transport** automatically: every send — including `@lunora/auth`'s
verification and forgot-password mail — is intercepted and surfaced in the
**Studio Mail tab**. Nothing leaves your machine and no provider setup is needed.

## Step 3: Regenerate types

```bash
lunora codegen
```

The functions surface in the generated `api` as `api.mail.sendEmail` and
`api.mail.queueEmail`.

## Step 4: Send mail

### From another function

`sendEmail` is an **action** (sending is non-transactional network I/O). From a
mutation, schedule it as a follow-up so the request is not blocked:

```ts
import { mutation, v } from "@lunora/server";

import { api } from "./_generated/api";

export const inviteUser = mutation.input({ email: v.string() }).mutation(async ({ ctx, args: { email } }) => {
    // ...persist the invite, then send the mail as a follow-up action
    await ctx.scheduler.runAfter(0, api.mail.sendEmail, {
        to: email,
        subject: "You're invited",
        html: "<p>Click the link to join.</p>",
    });
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

React elements are not JSON-serializable across the RPC boundary, so the
`sendEmail` args take `html` / `text`. To use a `react-email` template, render it
where you call the mailer — edit `lunora/mail/index.ts` to pass `react` straight
into `mailer.send`:

```ts
import { createMailer } from "@lunora/mail";
import { env } from "cloudflare:workers";

import { WelcomeEmail } from "./emails/Welcome";

await createMailer({ apiKey: env.RESEND_API_KEY as string, from: env.MAIL_FROM as string }).send({
    to: "alice@example.com",
    subject: "Welcome",
    react: <WelcomeEmail name="Alice" />,
});
```

## Common Pitfalls

1. **Expecting prod email to "just work".** Dev captures into the Studio;
   production needs the `SEND_EMAIL` binding (a verified destination) or
   `RESEND_API_KEY`.
2. **Calling `sendEmail` as a query/mutation.** It is an action — invoke it via
   `ctx.runAction` / `ctx.scheduler.runAfter` / `client.action`, never `ctx.db`.
3. **Using `queueEmail` without a Queue binding.** It requires a Cloudflare
   Queue producer binding; until you add one, `@lunora/mail` throws
   `` `queue` binding is required for mailer.queue() ``. The item does not add
   the Queue for you — see the `mail` README's "Queueing" section.
4. **Passing a React element through the action args.** Render it inside the
   mailer (`mailer.send({ react })`), not across the RPC boundary.

## Checklist

- [ ] `lunora registry add mail` run, `pnpm install` done.
- [ ] `SEND_EMAIL` binding configured (verified destination) or
      `RESEND_API_KEY` set; `MAIL_FROM` set.
- [ ] `lunora codegen` run so `api.mail.*` is generated.
- [ ] Mail sent from a function (`ctx.scheduler.runAfter`/`ctx.runAction` with
      `api.mail.sendEmail`) or the client (`client.action("mail/sendEmail", …)`).
- [ ] Verified the send appears in the Studio Mail tab in dev.
