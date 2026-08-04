/**
 * Address + header validation shared by every transport (Resend, Cloudflare,
 * the dev capture transport) and the queue path. Extracted from `create-mailer`
 * so a transport built in its own module reuses the exact same length +
 * CR/LF/comma + bracket checks rather than re-implementing them.
 */
import { LunoraError } from "@lunora/errors";

/** RFC 5321 caps the entire mailbox path at 320 chars; reject anything longer. */
const MAX_EMAIL_LENGTH = 320;
const MAX_NAME_LENGTH = 256;

// `name <email>` form. Disjoint character classes ([^<] / [^>]) with no adjacent
// `\s*` so there's no quantifier ambiguity to backtrack on; surrounding whitespace
// is trimmed from the captures in code instead.
const ADDRESS_PATTERN = /^([^<]*)<([^>]*)>\s*$/;

/**
 * Reject CR/LF (the classic SMTP header-injection vector — splits the header
 * into attacker-controlled extra headers) and commas (separate the address in
 * SMTP `To:`/`Cc:` lists, so a single field with a `,` smuggles a second
 * recipient past `to:` validation).
 */
const assertSafeAddressField = (field: "email" | "name", value: string): void => {
    if (value.includes("\r") || value.includes("\n") || value.includes(",")) {
        throw new LunoraError("INTERNAL", `@lunora/mail: address ${field} must not contain CR, LF, or comma`);
    }
};

/**
 * Reject CR/LF in a free-form header value (subject, custom header keys/values).
 * Same header-injection vector as the address fields, but commas are legal here
 * so only the line terminators are forbidden — a smuggled CR/LF would split the
 * value into attacker-controlled extra headers.
 */
const assertSafeHeaderValue = (label: string, value: string): void => {
    if (value.includes("\r") || value.includes("\n")) {
        throw new LunoraError("INTERNAL", `@lunora/mail: ${label} must not contain CR or LF`);
    }
};

/** Validate the bracketed `name <email>` form captured by `ADDRESS_PATTERN`. */
const toBracketedAddress = (name: string, email: string): { email: string; name?: string } => {
    if (name.length > MAX_NAME_LENGTH) {
        throw new LunoraError("INTERNAL", `@lunora/mail: address name must be <= ${String(MAX_NAME_LENGTH)} characters`);
    }

    if (email.length > MAX_EMAIL_LENGTH) {
        throw new LunoraError("INTERNAL", `@lunora/mail: address email must be <= ${String(MAX_EMAIL_LENGTH)} characters`);
    }

    if (name) {
        assertSafeAddressField("name", name);
    }

    assertSafeAddressField("email", email);

    return name ? { email, name } : { email };
};

/** Validate a bare `addr@host` address (no display name). */
const toBareAddress = (input: string): { email: string } => {
    const email = input.trim();

    if (email.length > MAX_EMAIL_LENGTH) {
        throw new LunoraError("INTERNAL", `@lunora/mail: address email must be <= ${String(MAX_EMAIL_LENGTH)} characters`);
    }

    assertSafeAddressField("email", email);

    return { email };
};

/** `@visulima/email` models addresses as `{ email, name? }`. Accept either shape. */
const toAddress = (input: string): { email: string; name?: string } => {
    const match = ADDRESS_PATTERN.exec(input);
    const email = (match?.[2] ?? "").trim();

    // An angle-bracket form was supplied. Trust the captured address even
    // when the display name is empty (`<a@b.c>`) — otherwise the bare-email
    // fallback below would treat the whole `<a@b.c>` literal as the address
    // and forward an invalid bracketed mailbox to the provider.
    if (match && email) {
        return toBracketedAddress((match[1] ?? "").trim(), email);
    }

    return toBareAddress(input);
};

const toAddressList = (input: string | string[] | undefined): { email: string; name?: string }[] | undefined => {
    if (input === undefined) {
        return undefined;
    }

    const list = Array.isArray(input) ? input : [input];

    return list.map((entry) => toAddress(entry));
};

/**
 * Run every address field through the same parse + length + CR/LF/comma
 * rejection that the transports apply, but discard the parsed result. Called
 * from `buildPayload` so custom transports and the queue path get the exact same
 * validation — without changing the string wire shape the payload carries.
 */
const assertSafeAddresses = (payload: { bcc?: string | string[]; cc?: string | string[]; from?: string; replyTo?: string; to?: string | string[] }): void => {
    toAddressList(payload.to);
    toAddressList(payload.cc);
    toAddressList(payload.bcc);

    if (payload.from !== undefined) {
        toAddress(payload.from);
    }

    if (payload.replyTo !== undefined) {
        toAddress(payload.replyTo);
    }
};

export { assertSafeAddresses, assertSafeHeaderValue, MAX_EMAIL_LENGTH, MAX_NAME_LENGTH, toAddress, toAddressList };
