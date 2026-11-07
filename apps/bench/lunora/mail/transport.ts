/**
 * The mail transport for this Worker: capture in dev, the `SEND_EMAIL` binding or
 * Resend in production, and the `QUEUE_MAIL` producer for `mailer.queue()`. Shared
 * by the mail functions and the mail queue consumer, so both deliver the same way.
 */
import type { Mailer, QueueLike } from "@lunora/mail";
import { createMailerFromEnv } from "@lunora/mail";
import { env as workerEnv } from "cloudflare:workers";

import type { CloudflareBindings } from "#lunora/_generated/server.js";

/**
 * The Worker's bindings, narrowed so they can be looked up by name.
 *
 * `cloudflare:workers` types `env` as `Cloudflare.Env`, which
 * `@cloudflare/workers-types` declares EMPTY until the project runs
 * `wrangler types` — so indexing it, or handing it to `createMailerFromEnv`
 * (whose `MailEnv` is a `Record<string, unknown>`), is a `tsc` error in a fresh
 * scaffold. The generated `CloudflareBindings` is the open index signature both
 * want.
 */
const env = workerEnv as CloudflareBindings;

/**
 * The Cloudflare Email Workers send callback: serialize the RFC 822 message
 * through the `SEND_EMAIL` binding. Kept here (not in `@lunora/mail`) because it
 * needs the `cloudflare:email` runtime module. Ignored in dev (capture instead).
 */
const cloudflareSend = async (from: string, to: string, raw: string): Promise<void> => {
    const { EmailMessage } = await import("cloudflare:email");
    const binding = env["SEND_EMAIL"] as { send: (message: InstanceType<typeof EmailMessage>) => Promise<void> };

    await binding.send(new EmailMessage(from, to, raw));
};

/**
 * Build a mailer from env on each invocation: capture into the studio inbox in
 * dev, deliver via the `SEND_EMAIL` binding (or `RESEND_API_KEY`) in production.
 * The capture-vs-deliver decision + the inbox wiring live in `@lunora/mail`'s
 * `createMailerFromEnv`, so the same logic backs `@lunora/auth`'s email too.
 *
 * `queue` is the `QUEUE_MAIL` producer binding and backs {@link queueEmail}.
 * Without it, `queue()` throws outside dev capture mode even though the Worker
 * declares the queue.
 *
 * `cloudflareSend` is passed only when the `SEND_EMAIL` binding exists:
 * `createMailerFromEnv` prefers it whenever it is supplied, so a Resend-only
 * deployment would otherwise fail inside it instead of using `RESEND_API_KEY`.
 */
export const mailer = (): Mailer => {
    const queue = env["QUEUE_MAIL"] as QueueLike | undefined;

    return createMailerFromEnv(env, {
        ...(env["SEND_EMAIL"] === undefined ? {} : { cloudflareSend }),
        ...(queue === undefined ? {} : { queue }),
    });
};
