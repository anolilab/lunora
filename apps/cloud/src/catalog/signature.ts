/**
 * Ed25519 signatures and SHA-256 digests for the app catalog, on WebCrypto so the
 * same check runs in the control plane's workerd and in the tests. Every signed
 * payload starts with a domain tag naming what it is, so a signature over a
 * catalog index can never be replayed as an artifact manifest, or the reverse.
 */

/** Domain tag for a signed artifact manifest. */
export const ARTIFACT_SIGNING_DOMAIN = "lunora-catalog-artifact:v1";

/** Domain tag for a signed catalog index. */
export const INDEX_SIGNING_DOMAIN = "lunora-catalog-index:v1";

/** A trusted catalog key: the raw 32-byte Ed25519 public key, filed under its id. */
export interface TrustedCatalogKey {
    keyId: string;
    publicKey: Uint8Array;
}

/** A detached signature as published next to a manifest or an index. */
export interface DetachedSignature {
    keyId: string;
    /** Standard base64 of the 64-byte Ed25519 signature. */
    signature: string;
}

const ED25519_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

const encoder = new TextEncoder();

/** Standard base64 → bytes, or `undefined` when the text is not base64. */
export const decodeBase64 = (text: string): Uint8Array | undefined => {
    try {
        return Uint8Array.from(atob(text), (character) => character.codePointAt(0) ?? 0);
    } catch {
        return undefined;
    }
};

/** SHA-256 of `bytes` as lowercase hex. */
export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);

    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** The bytes a signature covers: the domain tag, a newline, then the payload. */
const signedBytes = (domain: string, payload: Uint8Array): Uint8Array => {
    const tag = encoder.encode(`${domain}\n`);
    const bytes = new Uint8Array(tag.byteLength + payload.byteLength);

    bytes.set(tag, 0);
    bytes.set(payload, tag.byteLength);

    return bytes;
};

/**
 * Whether `signature` is a valid Ed25519 signature by `key` over `payload` under
 * `domain`. Never throws: a malformed key or signature is simply not valid.
 */
export const verifySignature = async (key: TrustedCatalogKey, domain: string, payload: Uint8Array, signature: Uint8Array): Promise<boolean> => {
    if (key.publicKey.byteLength !== ED25519_KEY_BYTES || signature.byteLength !== ED25519_SIGNATURE_BYTES) {
        return false;
    }

    try {
        const cryptoKey = await crypto.subtle.importKey("raw", key.publicKey as BufferSource, { name: "Ed25519" }, false, ["verify"]);

        return await crypto.subtle.verify("Ed25519", cryptoKey, signature as BufferSource, signedBytes(domain, payload) as BufferSource);
    } catch {
        return false;
    }
};

/**
 * Sign `payload` under `domain` with the catalog's private key, the way its CI
 * does. Returns the standard base64 of the 64-byte signature. Only the publishing
 * side holds the private key; the control plane verifies with the public half.
 */
export const signPayload = async (privateKey: CryptoKey, domain: string, payload: Uint8Array): Promise<string> => {
    const signed = signedBytes(domain, payload);
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, signed as BufferSource));

    return btoa(String.fromCodePoint(...signature));
};

/** The most bytes a detached signature file may take. */
export const MAX_SIGNATURE_FILE_BYTES = 4 * 1024;

/** A detached signature file (`{ keyId, signature }`), or `undefined` when it is not one. */
export const parseDetachedSignature = (bytes: Uint8Array): DetachedSignature | undefined => {
    let raw: unknown;

    try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return undefined;
    }

    if (typeof raw !== "object" || raw === null) {
        return undefined;
    }

    const record = raw as Record<string, unknown>;

    return typeof record["keyId"] === "string" && typeof record["signature"] === "string"
        ? { keyId: record["keyId"], signature: record["signature"] }
        : undefined;
};

/**
 * Verify a detached signature against the trusted keys, under one domain. A key
 * the control plane does not trust, a malformed signature and a bad signature are
 * distinct refusals, so the caller can say which it was.
 */
export const verifyDetached = async (
    keys: TrustedCatalogKey[],
    domain: string,
    payload: Uint8Array,
    detached: DetachedSignature,
): Promise<{ code: "BAD_SIGNATURE" | "UNKNOWN_KEY"; message: string; ok: false } | { ok: true }> => {
    const key = keys.find((candidate) => candidate.keyId === detached.keyId);

    if (key === undefined) {
        return { code: "UNKNOWN_KEY", message: `no trusted catalog key is named ${detached.keyId}`, ok: false };
    }

    const signature = decodeBase64(detached.signature);

    if (signature === undefined || !(await verifySignature(key, domain, payload, signature))) {
        return { code: "BAD_SIGNATURE", message: "the signature does not verify under the named key", ok: false };
    }

    return { ok: true };
};
