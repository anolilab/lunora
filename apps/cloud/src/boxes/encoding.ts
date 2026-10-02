/**
 * Byte encodings for box identity (plan 458 D4): the box's Ed25519 public key
 * and every signature travel as base64url without padding, the form
 * `@lunora/hostd/protocol` specifies (`protocol/hostd/README.md` §4.1, §6).
 */

const BASE64URL_PATTERN = /^[\w-]*$/u;

/** A raw Ed25519 public key is 32 bytes: 43 base64url characters without padding. */
const RAW_PUBLIC_KEY_PATTERN = /^[\w-]{43}$/u;

/** An Ed25519 signature is 64 bytes: 86 base64url characters without padding. */
const SIGNATURE_PATTERN = /^[\w-]{86}$/u;

/** Encode bytes as base64url without padding. */
export const toBase64Url = (bytes: Uint8Array): string => {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

/** Decode base64url (padding optional), or `null` when it is not base64url. */
export const fromBase64Url = (text: string): null | Uint8Array<ArrayBuffer> => {
    if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) {
        return null;
    }

    try {
        const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4));

        return Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
    } catch {
        return null;
    }
};

/** Whether `value` is a raw Ed25519 public key as `boxes.publicKey` stores it. */
export const isBoxPublicKey = (value: unknown): value is string =>
    typeof value === "string" && RAW_PUBLIC_KEY_PATTERN.test(value) && fromBase64Url(value)?.length === 32;

/** Whether `value` has the shape of an Ed25519 signature. Shape only — {@link verifyBoxSignature} checks it. */
export const isSignatureShape = (value: unknown): value is string => typeof value === "string" && SIGNATURE_PATTERN.test(value);

/** `byteCount` random bytes as base64url — a challenge or replay nonce (≥ 16 bytes → ≥ 22 characters). */
export const randomBase64Url = (byteCount = 24): string => {
    const bytes = new Uint8Array(byteCount);

    crypto.getRandomValues(bytes);

    return toBase64Url(bytes);
};

/**
 * Verify an Ed25519 signature made by a box over `payload`, with WebCrypto —
 * the one Ed25519 implementation both workerd and Node ship. Never throws: a
 * malformed key or signature is a failed verification.
 * @param publicKey the box's raw public key, base64url (`boxes.publicKey`)
 * @param signature the signature, base64url without padding
 */
export const verifyBoxSignature = async (publicKey: string, signature: string, payload: Uint8Array): Promise<boolean> => {
    const keyBytes = isBoxPublicKey(publicKey) ? fromBase64Url(publicKey) : null;
    const signatureBytes = isSignatureShape(signature) ? fromBase64Url(signature) : null;

    if (keyBytes === null || signatureBytes?.length !== 64) {
        return false;
    }

    try {
        const key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);

        // A copy: WebCrypto takes an ArrayBuffer-backed view, and the protocol's payload builders type theirs loosely.
        return await crypto.subtle.verify({ name: "Ed25519" }, key, signatureBytes, Uint8Array.from(payload));
    } catch {
        return false;
    }
};
