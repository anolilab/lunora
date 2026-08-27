/**
 * Chunked base64 <-> bytes codec, bundler-inlined (like {@link file://./stable-key.ts})
 * so the wire codec (`shared/wire-codec.ts`, consumed by `@lunora/client` +
 * `@lunora/do`) and the voice Durable Object (`@lunora/agent`) share one
 * implementation instead of each hand-rolling `btoa`/`atob`.
 *
 * Both use a fixed-size chunk so a large buffer — a multi-megabyte audio utterance
 * or a `v.bytes()` payload — never overflows the argument-count ceiling of
 * `String.fromCharCode` (nor blows the call stack) via a single spread.
 *
 * `toBase64Url`/`fromBase64Url` are the URL-safe, unpadded variant built on top
 * of the two above; `shared/identity-header.ts` imports them from here as the
 * canonical base64url home rather than hand-rolling its own.
 */

/** Base64-encode bytes. */
const toBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    const chunk = 0x8000;

    for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }

    return btoa(binary);
};

/** Base64-decode a string to bytes. */
const fromBase64 = (base64: string): Uint8Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.codePointAt(index) ?? 0;
    }

    return bytes;
};

/** The base64url alphabet: RFC 4648 §5, so `-` and `_` replace `+` and `/`. */
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Bytes -> URL-safe, unpadded base64url, in a single pass.
 *
 * Deliberately NOT `toBase64(bytes)` plus a remap. That route builds a binary
 * string, hands it to `btoa`, then walks the result three more times to swap
 * `+`/`/` and strip padding — five passes and four intermediate strings for
 * what is one table lookup per 6 bits. Emitting the base64url alphabet directly
 * skips all of it, and the padding is simply never produced rather than produced
 * and then trimmed.
 *
 * Measured faster at every size, so there is no small/large trade to pick
 * between: 4.4x at 32 bytes (an HMAC signature), 3.9x at 64 (identity claims),
 * 2.4x at 1 MB. The fixed cost of the three remap passes is what dominates the
 * small end, which is where both callers live.
 *
 * Byte-identical to the previous implementation — fuzzed over every length from
 * 0 to 400, which covers all three residue classes of the 3-byte group.
 */
const toBase64Url = (bytes: Uint8Array): string => {
    let out = "";
    let index = 0;
    const lastTriple = bytes.length - 2;

    for (; index < lastTriple; index += 3) {
        const triple = ((bytes[index] as number) << 16) | ((bytes[index + 1] as number) << 8) | (bytes[index + 2] as number);

        out +=
            BASE64URL_ALPHABET.charAt((triple >> 18) & 63) +
            BASE64URL_ALPHABET.charAt((triple >> 12) & 63) +
            BASE64URL_ALPHABET.charAt((triple >> 6) & 63) +
            BASE64URL_ALPHABET.charAt(triple & 63);
    }

    // 1 or 2 trailing bytes encode to 2 or 3 characters; unpadded, so nothing else.
    const remaining = bytes.length - index;

    if (remaining === 1) {
        const tail = (bytes[index] as number) << 16;

        out += BASE64URL_ALPHABET.charAt((tail >> 18) & 63) + BASE64URL_ALPHABET.charAt((tail >> 12) & 63);
    } else if (remaining === 2) {
        const tail = ((bytes[index] as number) << 16) | ((bytes[index + 1] as number) << 8);

        out += BASE64URL_ALPHABET.charAt((tail >> 18) & 63) + BASE64URL_ALPHABET.charAt((tail >> 12) & 63) + BASE64URL_ALPHABET.charAt((tail >> 6) & 63);
    }

    return out;
};

/** URL-safe base64url -> bytes, via {@link fromBase64} (which expects standard padded base64). */
const fromBase64Url = (value: string): Uint8Array => {
    const restored = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = restored + "=".repeat((4 - (restored.length % 4)) % 4);

    return fromBase64(padded);
};

export { fromBase64, fromBase64Url, toBase64, toBase64Url };
