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
    to: string | string[];
    subject: string;
    from?: string;
    html?: string;
    text?: string;
    cc?: string[];
    bcc?: string[];
    replyTo?: string;
    headers?: Record<string, string>;
}

export interface SendOpts {
    to: string | string[];
    subject: string;
    react?: ReactElement;
    html?: string;
    text?: string;
    cc?: string[];
    bcc?: string[];
    replyTo?: string;
    headers?: Record<string, string>;
    from?: string;
}

export interface CirrusMailOptions {
    /** API key for the default Resend transport. Ignored when `transport` is set. */
    apiKey?: string;
    /** Default sender (`Name <addr@host>` or bare email). */
    from: string;
    /** Override the underlying transport. Useful for tests + multi-provider setups. */
    transport?: MailTransport;
    /** Default queue binding for `mailer.queue()`. */
    queue?: QueueLike;
}

export interface Mailer {
    send: (opts: SendOpts) => Promise<{ id: string }>;
    queue: (opts: SendOpts) => Promise<{ queued: true }>;
}
