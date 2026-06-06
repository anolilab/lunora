/**
 * Mail functions — added by `cirrus registry add mail`.
 *
 * This file is YOURS: it's a normal Cirrus module, copied into your project so
 * you own and edit it. Re-export these from your `cirrus/` entry (or rely on
 * file-based discovery) so codegen picks them up — they surface in the generated
 * `api` as `mail/sendEmail` and `mail/queueEmail`, i.e. `api.mail.sendEmail`.
 *
 *   - **sendEmail** (action) — render + deliver an email *now* via the default
 *     Resend transport. Awaits the provider and returns the message `id`. Use it
 *     for low-volume, latency-tolerant sends (a verification link, a receipt).
 *   - **queueEmail** (action) — hand the send off to a Cloudflare Queue and
 *     return immediately, so the request isn't blocked on the provider. Requires
 *     a Queue binding wired into `createMailer({ queue })` (see the README) —
 *     left throwing-by-default until you wire one up.
 *
 * Both are **actions** (not mutations/queries) because sending email is a
 * non-transactional side effect that talks to the network: actions are the only
 * function kind allowed to do arbitrary I/O like `fetch` to Resend.
 *
 * The heavy lifting lives in `@cirrus/mail`:
 *   - `createMailer({ apiKey, from, queue? })` builds a Resend-backed mailer.
 *   - `mailer.send(opts)` validates addresses (length + CR/LF + comma /
 *     header-injection checks), optionally renders a React template, and calls
 *     the provider.
 * This file is just the idiomatic Cirrus glue that exposes those as `api.mail.*`.
 *
 * Config comes from env vars/secrets (scaffolded into `.dev.vars` on add; set the
 * secret with `wrangler secret put RESEND_API_KEY`). Bindings, vars, and secrets
 * are read from `cloudflare:workers`' `env` — the one canonical source every
 * Cirrus registry item uses.
 */
import { env } from "cloudflare:workers";

import { createMailer } from "@cirrus/mail";
import type { Mailer, SendOptions } from "@cirrus/mail";
import { action, v } from "@cirrus/server";

/**
 * Read a required string env var/secret or throw a clear, actionable error.
 * Keeps the failure mode "you forgot to set RESEND_API_KEY" rather than an
 * opaque provider error. (`env` values are typed `unknown`, so we narrow here.)
 */
const requireEnv = (name: string): string => {
    const value = env[name];

    if (typeof value !== "string" || value === "") {
        throw new Error(`@cirrus/mail registry item: missing env var \`${name}\` — set it in .dev.vars (and \`wrangler secret put ${name}\` for secrets).`);
    }

    return value;
};

/**
 * Build a mailer from env on each invocation. Cheap to construct (no network in
 * the constructor — the Resend provider is initialized lazily on first `send`),
 * and per-call construction keeps it stateless across hibernation/eviction.
 *
 * Pass a `queue` binding here once you've added one (see the README) to enable
 * {@link queueEmail}.
 */
const mailer = (): Mailer =>
    createMailer({
        apiKey: requireEnv("RESEND_API_KEY"),
        from: requireEnv("MAIL_FROM"),
        // queue: <your Queue binding>, // enable queueEmail — see README
    });

/**
 * Validator for the email payload. Mirrors `@cirrus/mail`'s `SendOptions` minus
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
 * Project the validated args onto the `SendOptions` shape `@cirrus/mail` expects.
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
 * Render (if needed) and deliver an email synchronously via Resend. Returns the
 * provider message `id` on success; throws a generic `@cirrus/mail: send failed`
 * if the provider rejects (the raw provider error is logged server-side only, to
 * avoid leaking provider internals to callers).
 */
export const sendEmail = action({
    args: emailArgs,
    handler: async (_ctx, args): Promise<{ id: string }> => mailer().send(toSendOptions(args)),
});

/**
 * Enqueue an email onto a Cloudflare Queue and return immediately, so the caller
 * isn't blocked on the provider round-trip. Requires a Queue binding wired into
 * `mailer()` above; until then `@cirrus/mail` throws "queue binding is required".
 *
 * Your queue consumer Worker should call `consumeQueuedSend(mailer, message.body)`
 * (from `@cirrus/mail`) for each message — see the README.
 */
export const queueEmail = action({
    args: emailArgs,
    handler: async (_ctx, args): Promise<{ queued: true }> => mailer().queue(toSendOptions(args)),
});
