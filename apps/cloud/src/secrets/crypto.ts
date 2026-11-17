/**
 * Tenant-secret envelope encryption. Secret values are
 * AES-256-GCM encrypted at the Worker edge before they're stored — the
 * control-plane D1 only ever holds ciphertext + a per-secret random IV, so a
 * database leak doesn't expose tenant env vars. The 256-bit master key lives in
 * `SECRET_ENCRYPTION_KEY` (64 hex chars), out of the database. (A full envelope
 * scheme would wrap a per-secret data key under a KMS master key; this is the
 * single-key form, with the same at-rest property and a clear upgrade seam.)
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HEX_DIGITS = /^[\da-f]*$/iu;

const hexToBytes = (hex: string): Uint8Array => {
    // `parseInt` maps a non-hex pair to NaN, and `Uint8Array` stores that as 0, so a
    // malformed key would import silently as a different key. Reject it here.
    if (hex.length % 2 !== 0 || !HEX_DIGITS.test(hex)) {
        throw new Error("SECRET_ENCRYPTION_KEY must be hex");
    }

    const bytes = new Uint8Array(hex.length / 2);

    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }

    return bytes;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => Uint8Array.from(atob(value), (character) => character.codePointAt(0) ?? 0);

const importKey = async (keyHex: string): Promise<CryptoKey> => {
    if (keyHex.length !== 64) {
        throw new Error("SECRET_ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
    }

    const raw = hexToBytes(keyHex);

    return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["decrypt", "encrypt"]);
};

export interface EncryptedSecret {
    ciphertext: string;
    iv: string;
}

/** The AES-GCM parameters, binding `additionalData` when there is any. */
const gcmParameters = (iv: Uint8Array, additionalData: string | undefined): AesGcmParams =>
    additionalData === undefined
        ? { iv: iv as BufferSource, name: "AES-GCM" }
        : { additionalData: encoder.encode(additionalData), iv: iv as BufferSource, name: "AES-GCM" };

/**
 * AES-256-GCM encrypt a plaintext secret. Returns base64 ciphertext + IV.
 *
 * `additionalData` is authenticated but not stored: decrypting needs the same
 * value, so a ciphertext bound to one row cannot be replayed into another.
 */
export const encryptSecret = async (keyHex: string, plaintext: string, additionalData?: string): Promise<EncryptedSecret> => {
    const key = await importKey(keyHex);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(gcmParameters(iv, additionalData), key, encoder.encode(plaintext));

    return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
};

/** AES-256-GCM decrypt a stored secret back to plaintext; `additionalData` must be what it was encrypted with. */
export const decryptSecret = async (keyHex: string, secret: EncryptedSecret, additionalData?: string): Promise<string> => {
    const key = await importKey(keyHex);
    const plaintext = await crypto.subtle.decrypt(
        gcmParameters(base64ToBytes(secret.iv), additionalData),
        key,
        base64ToBytes(secret.ciphertext) as BufferSource,
    );

    return decoder.decode(plaintext);
};
