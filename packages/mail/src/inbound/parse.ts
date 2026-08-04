/**
 * `parseInboundEmail()` — a runtime-agnostic RFC 822 parser for inbound mail.
 *
 * The host (a Cloudflare Email Worker's `email(message, env, ctx)` entry) reads
 * the raw bytes off `message.raw` and hands them here; this module never imports
 * `cloudflare:email`, so it stays unit-testable in plain Node. Parsing is
 * delegated to `postal-mime` — a pure-JS, workerd-compatible MIME parser — and
 * the result is normalised to a small, typed `InboundEmail` shape.
 *
 * Every parsed header value that we surface in the normalised shape is run
 * through `assertSafeHeaderValue` (the same CR/LF guard the outbound transports
 * use) so a crafted inbound header can't smuggle line terminators into a value a
 * downstream handler might echo back into an outbound message.
 */
import PostalMime from "postal-mime";

import { assertSafeHeaderValue } from "../address";

/** A raw RFC 822 message as accepted by the parser. */
type RawInboundEmail = ArrayBuffer | ReadableStream<Uint8Array> | string | Uint8Array;

/** One parsed attachment. `content` is preserved as the parser decoded it. */
interface InboundAttachment {
    /** Raw attachment content (base64 string or binary buffer, per `encoding`). */
    content: ArrayBuffer | string | Uint8Array;
    /** `Content-Disposition` (`"attachment"`/`"inline"`), or `null` when absent. */
    disposition: "attachment" | "inline" | null;
    /** How `content` is encoded, when the parser reported it. */
    encoding?: "base64" | "utf8";
    /** Filename, or `null` when the part declared none. */
    filename: string | null;
    /** Declared MIME type (e.g. `image/png`). */
    mimeType: string;
}

/**
 * Sender-authentication verdicts pulled from the `Authentication-Results` header
 * the receiving MX (e.g. Cloudflare Email Routing) stamped on the message.
 *
 * SECURITY: Cloudflare Email Routing authenticates only the *recipient* domain,
 * **not** the sender. The envelope `from` and message content are trivially
 * spoofable, so a downstream handler MUST NOT make trust/authorization decisions
 * on `email.from` alone — gate on these verdicts (or your own policy) instead.
 * Verdicts are best-effort: when the receiving MX did not stamp an
 * `Authentication-Results` header, every field is `null` ("unknown").
 *
 * SECURITY: verdicts are read from the **first/topmost** `Authentication-Results`
 * header in document order. The receiving MX prepends its own genuine header per
 * RFC 8601, so the topmost occurrence is the trustworthy one; any lower
 * occurrences (which an untrusted sender can inject into the raw message) are
 * ignored. As defense-in-depth a consumer may additionally verify the topmost
 * header's `authserv-id` matches its receiving MX (e.g. Cloudflare) — that needs
 * config this runtime-agnostic parser does not carry, so it is left to the host.
 */
interface InboundAuthentication {
    /** DKIM verdict (`"pass"`/`"fail"`/…), or `null` when not reported. */
    dkim: string | null;
    /** DMARC verdict (`"pass"`/`"fail"`/…), or `null` when not reported. */
    dmarc: string | null;
    /** SPF verdict (`"pass"`/`"fail"`/…), or `null` when not reported. */
    spf: string | null;
}

/** Normalised, transport-agnostic view of a received message. */
interface InboundEmail {
    /** Decoded attachments (empty array when none). */
    attachments: InboundAttachment[];

    /**
     * Sender-authentication verdicts (DKIM/SPF/DMARC) parsed from the receiving
     * MX's **first/topmost** `Authentication-Results` header. SECURITY: see
     * {@link InboundAuthentication} — `from` is spoofable; gate trust on these
     * verdicts, not on `from`. Reading the raw `headers["authentication-results"]`
     * map instead exposes last-wins (a lower, potentially attacker-injected)
     * value — trust `authentication`, not the raw map.
     */
    authentication: InboundAuthentication;
    /** Sender mailbox (`from`), CR/LF-checked. Empty string when the message omitted it. SECURITY: spoofable — do not trust for authorization. */
    from: string;
    /** Flattened `key → value` of the parsed headers (lowercase keys), each value CR/LF-checked. */
    headers: Record<string, string>;
    /** HTML body, when present. */
    html?: string;
    /** `In-Reply-To` header (threading), CR/LF-checked. */
    inReplyTo?: string;
    /** `Message-ID` of this message, CR/LF-checked. */
    messageId?: string;
    /** `References` header (threading), CR/LF-checked. */
    references?: string;
    /** Subject line, CR/LF-checked. */
    subject?: string;
    /** Plain-text body, when present. */
    text?: string;
    /** Recipient mailboxes (`to`), each CR/LF-checked. */
    to: string[];
}

/** CR/LF-guard a value and return it; `undefined` passes through untouched. */
const safe = (label: string, value: string | undefined): string | undefined => {
    if (value === undefined) {
        return undefined;
    }

    assertSafeHeaderValue(`inbound ${label}`, value);

    return value;
};

/** Render a parser `Address` (mailbox or group) as a single `name <addr>` string. */
const formatAddress = (entry: { address?: string; group?: { address?: string; name?: string }[]; name?: string }): string => {
    if (entry.address !== undefined && entry.address !== "") {
        return entry.name ? `${entry.name} <${entry.address}>` : entry.address;
    }

    // RFC 5322 group syntax (`Team: a@x, b@x;`) — flatten the members.
    if (entry.group) {
        return entry.group
            .map((member) => member.address ?? "")
            .filter((address) => address !== "")
            .join(", ");
    }

    return entry.name ?? "";
};

/**
 * Pull a single `method=result` verdict (e.g. `dkim=pass`) out of an
 * `Authentication-Results` header value. Case-insensitive on the method name;
 * returns `null` when the method isn't present.
 */
const authVerdict = (authResults: string, method: string): string | null => {
    const match = new RegExp(String.raw`\b${method}=([a-zA-Z]+)`, "i").exec(authResults);

    // eslint-disable-next-line unicorn/no-null -- `null` is the documented "method not reported" sentinel in the public `InboundAuthentication` contract (`dkim: string | null`).
    return match?.[1]?.toLowerCase() ?? null;
};

/**
 * Parse the receiving MX's `Authentication-Results` header into DKIM/SPF/DMARC
 * verdicts. Returns all-`null` ("unknown") when the header is absent.
 */
const parseAuthentication = (authResults: string | undefined): InboundAuthentication => {
    if (authResults === undefined || authResults === "") {
        // eslint-disable-next-line unicorn/no-null -- all-`null` is the documented "unknown" verdict in the public `InboundAuthentication` contract.
        return { dkim: null, dmarc: null, spf: null };
    }

    return {
        dkim: authVerdict(authResults, "dkim"),
        dmarc: authVerdict(authResults, "dmarc"),
        spf: authVerdict(authResults, "spf"),
    };
};

/**
 * Parse a raw RFC 822 message into a normalised {@link InboundEmail}. Accepts the
 * shapes a Cloudflare Email Worker can hand off — `ReadableStream`, `ArrayBuffer`,
 * `Uint8Array`, or a decoded string.
 */
const parseInboundEmail = async (raw: RawInboundEmail): Promise<InboundEmail> => {
    const parsed = await PostalMime.parse(raw);

    const headers: Record<string, string> = {};

    for (const header of parsed.headers) {
        // Last-wins on duplicate keys (documented generic contract of the flattened
        // `headers` map); values are CR/LF-checked before surfacing.
        assertSafeHeaderValue(`inbound header \`${header.key}\``, header.value);
        headers[header.key] = header.value;
    }

    // SECURITY: source the sender-auth verdicts from the FIRST/topmost
    // `Authentication-Results` header (document order), NOT the last-wins
    // flattened `headers` map. The receiving MX prepends its own genuine header
    // per RFC 8601, so the topmost occurrence is the trustworthy one; a lower
    // occurrence injected by an untrusted sender must not override it. postal-mime
    // lowercases every header key, so the literal comparison is correct. The value
    // is already CR/LF-checked by the loop above.
    const topmostAuthResults = parsed.headers.find((header) => header.key === "authentication-results")?.value;

    const to = (parsed.to ?? []).map((entry) => {
        const formatted = formatAddress(entry);

        assertSafeHeaderValue("inbound to", formatted);

        return formatted;
    });

    const from = parsed.from ? formatAddress(parsed.from) : "";

    assertSafeHeaderValue("inbound from", from);

    const attachments: InboundAttachment[] = parsed.attachments.map((attachment) => {
        return {
            content: attachment.content,
            disposition: attachment.disposition,
            ...(attachment.encoding === undefined ? {} : { encoding: attachment.encoding }),
            filename: attachment.filename,
            mimeType: attachment.mimeType,
        };
    });

    return {
        attachments,
        authentication: parseAuthentication(topmostAuthResults),
        from,
        headers,
        ...(parsed.html === undefined ? {} : { html: parsed.html }),
        ...(safe("inReplyTo", parsed.inReplyTo) === undefined ? {} : { inReplyTo: parsed.inReplyTo }),
        ...(safe("messageId", parsed.messageId) === undefined ? {} : { messageId: parsed.messageId }),
        ...(safe("references", parsed.references) === undefined ? {} : { references: parsed.references }),
        ...(safe("subject", parsed.subject) === undefined ? {} : { subject: parsed.subject }),
        ...(parsed.text === undefined ? {} : { text: parsed.text }),
        to,
    };
};

export { parseInboundEmail };
export type { InboundAttachment, InboundAuthentication, InboundEmail, RawInboundEmail };
