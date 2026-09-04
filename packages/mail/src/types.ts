import type { ReactElement } from "react";

/**
 * Minimal projection of a Cloudflare Queue binding — accepts a JSON payload
 * via `.send()`. Declared structurally so callers can pass either the real
 * `Queue` binding or a unit-test double.
 */
export interface QueueLike {
    send: (payload: unknown, options?: Record<string, unknown>) => Promise<void>;
}

/**
 * Minimal projection of a transport adapter. Returning `{ id }` follows
 * Resend's response shape; the real `@visulima/email` `MailManager` flattens
 * provider responses to the same field for us.
 */
export interface MailTransport {
    send: (payload: SendPayload) => Promise<{ id: string }>;
}

export interface SendPayload {
    bcc?: string[];
    cc?: string[];
    from?: string;
    headers?: Record<string, string>;
    html?: string;
    replyTo?: string;
    subject: string;
    text?: string;
    to: string | string[];
}

export interface SendOptions {
    bcc?: string[];
    cc?: string[];
    from?: string;
    headers?: Record<string, string>;
    html?: string;

    /**
     * Stable key for deduping a queued send across Cloudflare Queues' at-least-once
     * redelivery. Only meaningful for `mailer.queue()` — `mailer.send()` ignores it.
     * When omitted, `queue()` generates one at enqueue time so it survives redelivery
     * (a key minted in the consumer would change on every retry, defeating the point).
     * Not forwarded to the mail provider, and no transport can: Resend dedupes on an
     * `Idempotency-Key` REQUEST header, and the provider client exposes no hook for
     * one (its own `headers` field becomes message headers in the JSON body). So a
     * consumer that wants to collapse redeliveries MUST dedupe against its own store
     * using this key — see `consumeQueuedSend` for the shape, and for why that is a
     * narrowed at-least-once rather than exactly-once.
     */
    idempotencyKey?: string;
    react?: ReactElement;
    replyTo?: string;
    subject: string;
    text?: string;
    to: string | string[];
}

export interface LunoraMailOptions {
    /** API key for the Resend transport (bring-your-own-provider). Ignored when `transport` or `cloudflareSend` is set. */
    apiKey?: string;

    /**
     * RFC 822 send callback bound to the Worker's `send_email` binding. When set
     * (and no explicit `transport` is supplied) the default transport is
     * Cloudflare Email Workers — Lunora's default provider. Ignored when
     * `transport` is set.
     */
    cloudflareSend?: (from: string, to: string, raw: string) => Promise<void>;
    /** Default sender (`Name <addr@host>` or bare email). */
    from: string;
    /** Default queue binding for `mailer.queue()`. */
    queue?: QueueLike;
    /** Override the underlying transport. Useful for tests, the dev capture transport, + multi-provider setups. */
    transport?: MailTransport;
}

export interface Mailer {
    queue: (options: SendOptions) => Promise<{ queued: true }>;
    send: (options: SendOptions) => Promise<{ id: string }>;
}
