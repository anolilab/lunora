/**
 * Mail functions — added by `lunora registry add mail`.
 *
 * This file is YOURS: it's a normal Lunora module, copied into your project so
 * you own and edit it. Re-export these from your `lunora/` entry (or rely on
 * file-based discovery) so codegen picks them up — they surface in the generated
 * `internal` (server-only) namespace as `mail/sendEmail` and `mail/queueEmail`,
 * i.e. `internal.mail.sendEmail` (reachable from server handlers, never the client).
 *
 *   - **sendEmail** (internalAction) — render + deliver an email *now*. Awaits
 *     the transport and returns the message `id`. Use it for low-volume,
 *     latency-tolerant sends (a verification link, a receipt).
 *   - **queueEmail** (internalAction) — hand the send off to a Cloudflare Queue
 *     and return immediately, so the request isn't blocked. Requires a Queue
 *     binding passed as `createMailerFromEnv(env, { queue })` in `mailer()` below
 *     (see the README).
 *
 * **These are `internalAction`s, not public RPC, on purpose.** A general-purpose
 * mailer that lets the caller pick recipients, subject, and body is an open
 * relay if exposed to the client — anyone who can reach your RPC API could send
 * phishing/spam through your verified domain and burn your provider quota. So
 * these are *server-only*: call them from your own `mutation`/`action`
 * handlers (`ctx.runAction(internal.mail.sendEmail, …)` / `ctx.scheduler`) AFTER
 * you've authenticated the caller and decided the recipient — don't forward
 * client-chosen `to`/`from`/`html` straight through. If you genuinely need a
 * client-callable send, write a *purpose-specific* `action` that takes only safe
 * business inputs (e.g. `{ orderId }`), checks `ctx.auth`/RBAC, derives the
 * recipient server-side, and rate-limits it (`lunorash/ratelimit`).
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
 * `WORKER_ENV` set to `development`) or when `LUNORA_MAIL_CAPTURE` is set; production
 * always delivers (and fails loudly if `SEND_EMAIL` is missing rather than
 * silently capturing).
 *
 * Config is read from `cloudflare:workers`' `env` — the one canonical source
 * every Lunora registry item uses for bindings, vars, and secrets.
 */
import type { SendOptions } from "@lunora/mail";

import { internalAction, v } from "#lunora/_generated/server.js";

import { mailer } from "./transport";

/**
 * Validator for the email payload. Mirrors `@lunora/mail`'s `SendOptions` minus
 * the React `react` field (React elements aren't JSON-serializable, so they
 * can't cross the RPC boundary as args). To send a React template, render it in
 * a server-side wrapper and pass `html`/`text`, or call `mailer.send({ react })`
 * directly from your own action.
 *
 * One `to` and no `cc`/`bcc`: the Cloudflare Email Workers binding (the default
 * transport) delivers to a single recipient and rejects the rest. Accepting
 * them here would fail only at send time in production. Fan out one call per
 * recipient instead.
 */
const emailArguments = {
    from: v.optional(v.string()),
    idempotencyKey: v.optional(v.string().max(256)),
    headers: v.optional(v.record(v.string(), v.string())),
    html: v.optional(v.string()),
    replyTo: v.optional(v.string()),
    subject: v.string(),
    text: v.optional(v.string()),
    to: v.string(),
} as const;

/**
 * Project the validated args onto the `SendOptions` shape `@lunora/mail` expects.
 * Optional fields are passed through as-is (`undefined` is meaningful — it means
 * "use the mailer default", e.g. the configured `from`).
 */
const toSendOptions = (args: {
    from?: string;
    headers?: Record<string, string>;
    html?: string;
    idempotencyKey?: string;
    replyTo?: string;
    subject: string;
    text?: string;
    to: string;
}): SendOptions => {
    return {
        from: args.from,
        idempotencyKey: args.idempotencyKey,
        headers: args.headers,
        html: args.html,
        replyTo: args.replyTo,
        subject: args.subject,
        text: args.text,
        to: args.to,
    };
};

/**
 * Render (if needed) and deliver an email synchronously. Returns the message
 * `id` on success; throws a generic `@lunora/mail: send failed` if the transport
 * rejects (the raw provider error is logged server-side only). In dev the send
 * is captured into the studio Mail inbox instead of delivered.
 */
export const sendEmail = internalAction.input(emailArguments).action(async ({ args }): Promise<{ id: string }> => mailer().send(toSendOptions(args)));

/**
 * Enqueue an email onto a Cloudflare Queue and return immediately, so the caller
 * isn't blocked on the provider round-trip. Requires a Queue binding wired into
 * `mailer()` above; until then `@lunora/mail` throws "queue binding is required".
 *
 * Your queue consumer Worker should call `consumeQueuedSend(mailer, message.body)`
 * (from `@lunora/mail`) for each message — see the README.
 */
export const queueEmail = internalAction.input(emailArguments).action(async ({ args }): Promise<{ queued: true }> => mailer().queue(toSendOptions(args)));
