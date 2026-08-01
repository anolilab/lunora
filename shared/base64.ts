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

/** Base64 (from {@link toBase64}) -> URL-safe, unpadded base64url. */
const toBase64Url = (bytes: Uint8Array): string => toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/** URL-safe base64url -> bytes, via {@link fromBase64} (which expects standard padded base64). */
const fromBase64Url = (value: string): Uint8Array => {
    const restored = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = restored + "=".repeat((4 - (restored.length % 4)) % 4);

    return fromBase64(padded);
};

export { fromBase64, fromBase64Url, toBase64, toBase64Url };
