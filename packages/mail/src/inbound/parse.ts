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
 * A CFWS comment or a quoted-string, whichever opens first — matched in ONE
 * left-to-right scan by {@link neutralizeClauseSeparators}. Both alternatives
 * honour `\` quoted-pairs and both accept an unterminated run (`|$`).
 */
const CFWS_OR_QUOTED_STRING = /"(?:[^"\\]|\\.)*(?:"|$)|\((?:[^()\\]|\\.)*(?:\)|$)/g;

/**
 * Blind the clause splitter to every `;` that is not a clause separator.
 *
 * SECURITY: a `;` inside a **quoted-string** belongs to a value, not to the
 * grammar. RFC 8601 lets a property value be a quoted-string and RFC 5321 lets a
 * local part be quoted, so the receiving MX echoes sender-chosen bytes —
 * semicolons included — into `smtp.mailfrom=` verbatim. Splitting there
 * manufactures a whole extra clause the MX never asserted: a crafted `MAIL FROM`
 * of `"x;spf=pass smtp.mailfrom=root@victim.example"@evil.example` turns one
 * `spf=fail` into a `fail` plus a `pass` that vouches for the forged `From`
 * domain, and a consumer asking "does ANY clause pass and align?" then accepts a
 * message that authenticated nothing.
 *
 * Comments are dropped (they are pure CFWS) and a quoted-string's `;` becomes a
 * space (the value itself must survive so the property reader still finds it).
 * ONE scan, not two passes: parens inside a quoted-string are literal and quotes
 * inside a comment are literal, so stripping either kind first can unbalance the
 * other and re-expose the `;` it was about to protect. Whichever token opens
 * first wins, exactly as an RFC 5322 lexer reads it.
 *
 * An unterminated comment or quote runs to the end of the header. That swallows
 * any clause after it, which is the safe direction: clauses are LOST, never
 * manufactured, and this only happens on a header no conformant MX emits.
 */
const neutralizeClauseSeparators = (authResults: string): string =>
    authResults.replaceAll(CFWS_OR_QUOTED_STRING, (token) => (token.startsWith('"') ? token.replaceAll(";", " ") : " "));

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
 * reliably the first one. Case-insensitive; comments and quoted-strings are
 * neutralised first (see {@link neutralizeClauseSeparators}) so a `;` or `=`
 * inside either cannot split a clause, and the remaining CFWS (optional
 * whitespace) is accepted around both `=` separators, since RFC 8601 permits
 * `dkim = pass header.d = sender.example` just as much as the tight form.
 *
 * The identifier read back out of a quoted value stops at the quote
 * (`"?([^\s;"]+)`), so a crafted local part yields a garbage domain rather than a
 * real one — which is the point: garbage aligns with nothing.
 */
const authVerdicts = (authResults: string, method: string, property: string): InboundAuthResult[] => {
    const clauses = neutralizeClauseSeparators(authResults).matchAll(new RegExp(String.raw`(?:^|;)\s*${method}\s*=\s*([a-z]+)([^;]*)`, "gi"));
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

/**
 * The angle-bracketed mailbox in a rendered `from` string. {@link formatAddress}
 * puts the mailbox LAST (`name <address>`), so anchoring at the end stops a
 * display name that itself contains `<ceo@victim.example>` standing in for it.
 */
const FROM_MAILBOX = /<([^<>]*)>$/;

/**
 * Domain of the `From` mailbox (`Name <local@domain>` or a bare address),
 * lowercased. `undefined` when there is no single mailbox to align against — an
 * empty `From`, or an RFC 5322 group the parser flattened to a comma list — so
 * the caller fails closed.
 */
const fromDomain = (from: string): string | undefined => {
    const address = FROM_MAILBOX.exec(from)?.[1] ?? from;
    const at = address.indexOf("@");

    if (at === -1 || at !== address.lastIndexOf("@")) {
        return undefined;
    }

    return address
        .slice(at + 1)
        .trim()
        .toLowerCase();
};

/**
 * THE inbound sender-authentication gate: does the receiving MX vouch for this
 * message's `From` domain? Pass it as the `verify` hook of
 * `createInboundEmailHandler` (or call it from your own) — it is one exported
 * helper precisely so the insecure variants cannot be hand-rolled again.
 *
 * True when ANY reported DMARC, SPF or DKIM clause both **passes** and names a
 * `domain` equal to the `From` address's domain. False otherwise — including for
 * an empty verdict list (the MX stamped no `Authentication-Results` header at
 * all, which is "unknown", not "fine") and for a `From` with no single mailbox
 * to align against.
 *
 * SECURITY — the two halves are each load-bearing.
 *
 * **Alignment.** A bare `pass` proves nothing about `From`. SPF authenticates the
 * envelope `MAIL FROM` domain and DKIM the signing `d=`, both attacker-chosen, so
 * `spf=pass`+`dkim=pass` for `evil.example` is routine on a message whose `From`
 * says `ceo@victim.example`. Only a clause whose own `domain` equals the `From`
 * domain vouches for it. Alignment is STRICT (RFC 7489): there is no
 * public-suffix list here, so `mail.example.com` does not vouch for
 * `example.com`. A pass reporting no domain (`null`) cannot be aligned and is
 * rejected. A DMARC pass already checked alignment at the MX.
 *
 * **Every clause, not the first.** One header legitimately reports a method more
 * than once (an ESP-relayed message is DKIM-signed by both the relay and the
 * author domain), and the aligned clause is not reliably the first, so reading
 * only the first bounced fully authenticated mail. "Any clause passes AND aligns"
 * stays strictly narrower than a bare pass: a clause vouching for some other
 * domain contributes nothing.
 */
const authenticatesFrom = (email: InboundEmail): boolean => {
    const from = fromDomain(email.from);

    if (from === undefined) {
        return false;
    }

    const alignedPass = (results: ReadonlyArray<InboundAuthResult>): boolean => results.some((entry) => entry.result === "pass" && entry.domain === from);

    const { dkim, dmarc, spf } = email.authentication;

    return alignedPass(dmarc) || alignedPass(spf) || alignedPass(dkim);
};

export { authenticatesFrom, parseInboundEmail };
export type { InboundAttachment, InboundAuthentication, InboundAuthResult, InboundEmail, RawInboundEmail };
