/**
 * Test-only helpers for end-to-end flows that depend on transactional email —
 * sign-up verification, forgot-password, magic links. In dev the mail registry
 * scaffold swaps in the capture transport, so every send lands in the studio's
 * root-shard mailbox instead of a real provider. These helpers read that mailbox
 * over the admin RPC so a Playwright test can drive "request reset → read the
 * email → follow the link → set a new password" deterministically.
 *
 * Import from `@lunora/mail/testing` (a dev/test-only entry — it pulls in
 * nothing from the runtime bundle, just `fetch`).
 */
import { LunoraError } from "@lunora/errors";

import type { CapturedMail } from "./capture-transport";

/** Reserved admin RPC path that reads the captured-mail inbox from the root shard. */
const GET_CAPTURED_MAIL_OP = "__lunora_admin__:getCapturedMail";

/** Default worker RPC endpoint (`POST /_lunora/rpc`). */
const DEFAULT_RPC_PATH = "/_lunora/rpc";

/** Minimal `fetch` projection so a test can inject a stub. */
type FetchLike = (
    input: string,
    init?: { body?: string; headers?: Record<string, string>; method?: string },
) => Promise<{ json: () => Promise<unknown>; ok: boolean; status: number }>;

interface InboxOptions {
    /** Admin bearer token (`LUNORA_ADMIN_TOKEN`) the worker gates introspection behind. */
    adminToken: string;
    /** App base URL, e.g. `http://localhost:8787`. */
    baseUrl: string;
    /** Inject a `fetch` implementation (defaults to the global). */
    fetch?: FetchLike;
    /** Newest-N to read (default 50). */
    limit?: number;
}

interface WaitForMailOptions extends InboxOptions {
    /** Poll interval in ms (default 250). */
    pollMs?: number;
    /** Only match a message whose subject contains this substring. */
    subjectMatch?: string;
    /** Give up after this many ms (default 10000). */
    timeoutMs?: number;
    /** Recipient address the message must be addressed to. */
    to: string;
}

/** Trailing slash to strip from a base URL before appending the RPC path. */
const TRAILING_SLASH = /\/$/;

const sleep = async (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

const recipients = (mail: CapturedMail): string[] => (Array.isArray(mail.to) ? mail.to : [mail.to]);

/** Read the captured-mail inbox (newest first). */
const listCapturedMail = async (options: InboxOptions): Promise<CapturedMail[]> => {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const endpoint = `${options.baseUrl.replace(TRAILING_SLASH, "")}${DEFAULT_RPC_PATH}`;

    const response = await fetchImpl(endpoint, {
        body: JSON.stringify({ args: { limit: options.limit ?? 50 }, functionPath: GET_CAPTURED_MAIL_OP }),
        headers: { authorization: `Bearer ${options.adminToken}`, "content-type": "application/json" },
        method: "POST",
    });

    if (!response.ok) {
        throw new LunoraError("INTERNAL", `@lunora/mail/testing: getCapturedMail failed (HTTP ${String(response.status)})`);
    }

    const body = (await response.json()) as { result?: { entries?: CapturedMail[] } };

    return body.result?.entries ?? [];
};

/**
 * Poll the captured-mail inbox until a message addressed to `to` (optionally
 * matching `subjectMatch`) appears, then return it. Throws on timeout. Entries
 * are newest-first, so the most recent matching message wins.
 */
const waitForMail = async (options: WaitForMailOptions): Promise<CapturedMail> => {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollMs = options.pollMs ?? 250;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- polling: each round must read, then wait, before the next read.
        const entries = await listCapturedMail(options);
        const match = entries.find(
            (mail) => recipients(mail).includes(options.to) && (options.subjectMatch === undefined || mail.subject.includes(options.subjectMatch)),
        );

        if (match) {
            return match;
        }

        if (Date.now() >= deadline) {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/mail/testing: no mail to "${options.to}"${options.subjectMatch === undefined ? "" : ` matching "${options.subjectMatch}"`} within ${String(timeoutMs)}ms`,
            );
        }

        // eslint-disable-next-line no-await-in-loop -- polling backoff between inbox reads.
        await sleep(pollMs);
    }
};

// http(s) URL up to the first whitespace, quote, or angle bracket.
const URL_PATTERN = /https?:\/\/[^\s"'<>)]+/g;

/** Ampersand entity (named + numeric decimal/hex forms) an HTML renderer escapes `&` to. */
const AMPERSAND_ENTITY = /&(?:amp|#0*38|#x0*26);/giu;

/**
 * Decode the ampersand entity in an extracted URL. `@react-email/render` (the
 * package's own render path) escapes `&` as `&` inside `href` attributes, so
 * a multi-query-param link (`?uid=1&token=abc`) is captured as
 * `?uid=1&token=abc` — following it would send a param literally named
 * `amp;token`. Text bodies are not entity-escaped, so this only affects html.
 */
const decodeUrlEntities = (url: string): string => url.replaceAll(AMPERSAND_ENTITY, "&");

/**
 * Pull the first link out of a captured message — html first, then text. Pass
 * `match` to require the URL contain a substring (e.g. `"/reset-password"`),
 * which disambiguates the action link from a logo/footer URL.
 */
const extractLink = (mail: CapturedMail, options: { match?: string } = {}): string => {
    for (const source of [mail.html, mail.text]) {
        if (source === undefined) {
            continue;
        }

        const matches = source.match(URL_PATTERN) ?? [];
        const link = matches.find((candidate) => options.match === undefined || candidate.includes(options.match));

        if (link !== undefined) {
            return decodeUrlEntities(link);
        }
    }

    throw new LunoraError(
        "INTERNAL",
        `@lunora/mail/testing: no link${options.match === undefined ? "" : ` containing "${options.match}"`} found in the captured message`,
    );
};

export { extractLink, listCapturedMail, waitForMail };
export type { InboxOptions, WaitForMailOptions };
