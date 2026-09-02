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

/** One reported `method=result [ptype.property=value]` clause of an `Authentication-Results` header. */
interface InboundAuthResult {
    /**
     * The identifier the result is about, lowercased — DKIM's signing domain
     * (`header.d=`), SPF's envelope `MAIL FROM` domain (`smtp.mailfrom=`, local
     * part dropped) or DMARC's `header.from=`. `null` when the clause reported
     * none, in which case it cannot be aligned and vouches for nothing.
     */
    domain: string | null;
    /** The result token, lowercased (`"pass"`, `"fail"`, `"none"`, …). */
    result: string;
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
 * `Authentication-Results` header, every list is empty ("unknown").
 *
 * Each method holds a LIST, because RFC 8601 lets one header report the same
 * method more than once and real mail does. An ESP-relayed message carries two
 * DKIM signatures — the relay's and the author domain's — and the MX stamps a
 * clause per signature in whatever order it verified them. Keeping only the
 * first threw the aligned one away whenever it was not the one that happened to
 * come first, and the message was rejected as unauthenticated. A consumer
 * therefore asks "does ANY reported clause pass and align?", not "did the first
 * one?".
 *
 * SECURITY: a bare `"pass"` is NOT proof the `From` header is genuine. SPF
 * authenticates the envelope `MAIL FROM` domain and DKIM the signing domain
 * (`d=`), and an attacker controls both — `spf=pass smtp.mailfrom=evil.example;
 * dkim=pass header.d=evil.example` is routine for a message whose `From` says
 * `ceo@victim.example`. Each verdict therefore carries the identifier it is
 * about ({@link InboundAuthResult.domain}): an SPF or DKIM pass only vouches for
 * `from` when that domain equals the `From` address's domain (RFC 7489 strict
 * alignment). Only a DMARC pass already checked alignment for you. A pass with
 * no identifier reported cannot be aligned and must be treated as
 * unauthenticated.
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
    /** Every DKIM clause the header reported, in header order; empty when the method was not reported. */
    dkim: InboundAuthResult[];
    /** Every DMARC clause the header reported, in header order; empty when the method was not reported. */
    dmarc: InboundAuthResult[];
    /** Every SPF clause the header reported, in header order; empty when the method was not reported. */
    spf: InboundAuthResult[];
}

/** Normalised, transport-agnostic view of a received message. */
interface InboundEmail {
    /** Decoded attachments (empty array when none). */
    attachments: InboundAttachment[];

    /**
     * Sender-authentication verdicts (DKIM/SPF/DMARC) and the domain each is
     * about, parsed from the receiving MX's **first/topmost**
     * `Authentication-Results` header. SECURITY: see
     * {@link InboundAuthentication} — `from` is spoofable, and an SPF/DKIM pass
     * vouches for it only when that clause's `domain` equals the `From` domain (a
     * DMARC pass checked that already). Reading the raw `headers["authentication-results"]`
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
 * Pull EVERY one of a method's `method=result [ptype.property=value …]` clauses
 * out of an `Authentication-Results` header value (RFC 8601: clauses are
 * `;`-separated, the first being the `authserv-id`). Each entry carries the
 * lowercased result and the domain of the named property (the part after the
 * last `@`, so `smtp.mailfrom` may be a full address), the domain `null` when
 * the clause reported none.
 *
 * All of them, not the first: one header may report a method repeatedly — an
 * ESP-relayed message is DKIM-signed twice — and the aligned clause is not
 * reliably the first one. Case-insensitive; CFWS comments are dropped first so a
 * `;` or `=` inside one cannot split a clause, and the remaining CFWS (optional
 * whitespace) is accepted around both `=` separators, since RFC 8601 permits
 * `dkim = pass header.d = sender.example` just as much as the tight form.
 */
const authVerdicts = (authResults: string, method: string, property: string): InboundAuthResult[] => {
    const clauses = authResults.replaceAll(/\([^()]*\)/g, "").matchAll(new RegExp(String.raw`(?:^|;)\s*${method}\s*=\s*([a-z]+)([^;]*)`, "gi"));
    const propertyRe = new RegExp(String.raw`\b${property.replaceAll(".", String.raw`\.`)}\s*=\s*"?([^\s;"]+)`, "i");

    return [...clauses].map((clause) => {
        const value = propertyRe.exec(clause[2] ?? "")?.[1];

        return {
            // eslint-disable-next-line unicorn/no-null -- documented "property not reported" sentinel
            domain: value === undefined ? null : value.slice(value.lastIndexOf("@") + 1).toLowerCase(),
            result: (clause[1] ?? "").toLowerCase(),
        };
    });
};

/**
 * Parse the receiving MX's `Authentication-Results` header into the DKIM/SPF/DMARC
 * clauses it reported, each with the identifier it is about. Returns empty lists
 * ("unknown") when the header is absent.
 */
const parseAuthentication = (authResults: string | undefined): InboundAuthentication => {
    if (authResults === undefined || authResults === "") {
        return { dkim: [], dmarc: [], spf: [] };
    }

    return {
        dkim: authVerdicts(authResults, "dkim", "header.d"),
        dmarc: authVerdicts(authResults, "dmarc", "header.from"),
        spf: authVerdicts(authResults, "spf", "smtp.mailfrom"),
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
export type { InboundAttachment, InboundAuthentication, InboundAuthResult, InboundEmail, RawInboundEmail };
