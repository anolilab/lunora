/**
 * Mail functions — added by `lunora registry add mail`.
 *
 * This file is YOURS: it's a normal Lunora module, copied into your project so
 * you own and edit it. Re-export these from your `lunora/` entry (or rely on
 * file-based discovery) so codegen picks them up — they surface in the generated
 * `api` as `mail/sendEmail` and `mail/queueEmail`, i.e. `api.mail.sendEmail`.
 *
 *   - **sendEmail** (action) — render + deliver an email *now*. Awaits the
 *     transport and returns the message `id`. Use it for low-volume,
 *     latency-tolerant sends (a verification link, a receipt).
 *   - **queueEmail** (action) — hand the send off to a Cloudflare Queue and
 *     return immediately, so the request isn't blocked. Requires a Queue binding
 *     wired into `createMailer({ queue })` (see the README).
 *
 * **Provider.** The default transport is **Cloudflare Email Workers** — it sends
 * a raw RFC 822 message through your Worker's `send_email` binding. Cloudflare's
 * binding is single-recipient and only delivers to **verified Email Routing
 * destination addresses**, so set up Email Routing (verify a destination, add
 * the `send_email` binding to `wrangler.jsonc`) before relying on it in prod. To
 * use a hosted provider instead, set `RESEND_API_KEY` (Resend) or pass a custom
 * `transport` to `createMailer` — see `@lunora/mail`.
 *
 * **Dev mail catcher.** In local dev there's nothing to deliver to, so the
 * transport selection (`createMailerFromEnv`) swaps in `@lunora/mail`'s capture
 * transport: every send is intercepted and persisted to the studio's Mail inbox
 * instead of going out — including `@lunora/auth`'s verification /
 * forgot-password mail. Capture is on in a dev environment (`lunora dev` sets
 * `WORKER_ENV=development`) or when `LUNORA_MAIL_CAPTURE` is set; production
 * always delivers (and fails loudly if `SEND_EMAIL` is missing rather than
 * silently capturing).
 *
 * Config is read from `cloudflare:workers`' `env` — the one canonical source
 * every Lunora registry item uses for bindings, vars, and secrets.
 */
import { createMailerFromEnv } from "@lunora/mail";
import type { Mailer, SendOptions } from "@lunora/mail";
import { action, v } from "@lunora/server";
import { env } from "cloudflare:workers";

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
 * Pass a `queue` binding to `createMailer` (edit `@lunora/mail` usage) to enable
 * {@link queueEmail}.
 */
const mailer = (): Mailer => createMailerFromEnv(env, { cloudflareSend });

/**
 * Validator for the email payload. Mirrors `@lunora/mail`'s `SendOptions` minus
 * the React `react` field (React elements aren't JSON-serializable, so they
 * can't cross the RPC boundary as args). To send a React template, render it in
 * a server-side wrapper and pass `html`/`text`, or call `mailer.send({ react })`
 * directly from your own action.
 */
const emailArgs = {
    bcc: v.optional(v.array(v.string())),
    cc: v.optional(v.array(v.string())),
    from: v.optional(v.string()),
    headers: v.optional(v.record(v.string(), v.string())),
    html: v.optional(v.string()),
    replyTo: v.optional(v.string()),
    subject: v.string(),
    text: v.optional(v.string()),
    to: v.union(v.string(), v.array(v.string())),
} as const;

/**
 * Project the validated args onto the `SendOptions` shape `@lunora/mail` expects.
 * Optional fields are passed through as-is (`undefined` is meaningful — it means
 * "use the mailer default", e.g. the configured `from`).
 */
const toSendOptions = (args: {
    bcc?: string[];
    cc?: string[];
    from?: string;
    headers?: Record<string, string>;
    html?: string;
    replyTo?: string;
    subject: string;
    text?: string;
    to: string | string[];
}): SendOptions => ({
    bcc: args.bcc,
    cc: args.cc,
    from: args.from,
    headers: args.headers,
    html: args.html,
    replyTo: args.replyTo,
    subject: args.subject,
    text: args.text,
    to: args.to,
});

/**
 * Render (if needed) and deliver an email synchronously. Returns the message
 * `id` on success; throws a generic `@lunora/mail: send failed` if the transport
 * rejects (the raw provider error is logged server-side only). In dev the send
 * is captured into the studio Mail inbox instead of delivered.
 */
export const sendEmail = action({
    args: emailArgs,
    handler: async (_ctx, args): Promise<{ id: string }> => mailer().send(toSendOptions(args)),
});

/**
 * Enqueue an email onto a Cloudflare Queue and return immediately, so the caller
 * isn't blocked on the provider round-trip. Requires a Queue binding wired into
 * `mailer()` above; until then `@lunora/mail` throws "queue binding is required".
 *
 * Your queue consumer Worker should call `consumeQueuedSend(mailer, message.body)`
 * (from `@lunora/mail`) for each message — see the README.
 */
export const queueEmail = action({
    args: emailArgs,
    handler: async (_ctx, args): Promise<{ queued: true }> => mailer().queue(toSendOptions(args)),
});
