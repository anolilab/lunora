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

export interface SendOpts {
    bcc?: string[];
    cc?: string[];
    from?: string;
    headers?: Record<string, string>;
    html?: string;
    react?: ReactElement;
    replyTo?: string;
    subject: string;
    text?: string;
    to: string | string[];
}

export interface CirrusMailOptions {
    /** API key for the default Resend transport. Ignored when `transport` is set. */
    apiKey?: string;
    /** Default sender (`Name &lt;addr@host>` or bare email). */
    from: string;
    /** Default queue binding for `mailer.queue()`. */
    queue?: QueueLike;
    /** Override the underlying transport. Useful for tests + multi-provider setups. */
    transport?: MailTransport;
}

export interface Mailer {
    queue: (options: SendOpts) => Promise<{ queued: true }>;
    send: (options: SendOpts) => Promise<{ id: string }>;
}
