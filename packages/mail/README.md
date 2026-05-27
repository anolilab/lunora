# @cirrus/mail

Transactional email for the Cirrus framework. Built on [`@visulima/email`](https://github.com/visulima/visulima) — Resend is the bundled provider, but the underlying library supports failover/round-robin across SES, Postmark, SendGrid, Mailgun, etc. by swapping the transport in `createMailer({ transport })`.

```ts
import { createMailer } from "@cirrus/mail";
import { WelcomeEmail } from "./emails/Welcome.js";

const mailer = createMailer({
    apiKey: env.RESEND_API_KEY,
    from: "Acme <noreply@acme.test>",
});

await mailer.send({
    to: "alice@example.com",
    subject: "Welcome",
    react: <WelcomeEmail name="Alice" />,
});
```

## Queueing

`mailer.queue(opts)` enqueues a send onto a Cloudflare Queues binding so the
HTTP request can return immediately. Configure `bindings.queue` with the queue
binding name; the consumer Worker calls `mailer.send(payload)` from the queue
batch.
