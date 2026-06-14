/**
 * Tenant-secret envelope encryption (CLOUD-PLAN.md §7). Secret values are
 * AES-256-GCM encrypted at the Worker edge before they're stored — the
 * control-plane D1 only ever holds ciphertext + a per-secret random IV, so a
 * database leak doesn't expose tenant env vars. The 256-bit master key lives in
 * `SECRET_ENCRYPTION_KEY` (64 hex chars), out of the database. (A full envelope
 * scheme would wrap a per-secret data key under a KMS master key; this is the
 * single-key form, with the same at-rest property and a clear upgrade seam.)
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const hexToBytes = (hex: string): Uint8Array => {
    if (hex.length % 2 !== 0) {
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
    const raw = hexToBytes(keyHex);

    if (raw.length !== 32) {
        throw new Error("SECRET_ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
    }

    return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["decrypt", "encrypt"]);
};

export interface EncryptedSecret {
    ciphertext: string;
    iv: string;
}

/** AES-256-GCM encrypt a plaintext secret. Returns base64 ciphertext + IV. */
export const encryptSecret = async (keyHex: string, plaintext: string): Promise<EncryptedSecret> => {
    const key = await importKey(keyHex);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ iv: iv as BufferSource, name: "AES-GCM" }, key, encoder.encode(plaintext));

    return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
};

/** AES-256-GCM decrypt a stored secret back to plaintext. */
export const decryptSecret = async (keyHex: string, secret: EncryptedSecret): Promise<string> => {
    const key = await importKey(keyHex);
    const plaintext = await crypto.subtle.decrypt(
        { iv: base64ToBytes(secret.iv) as BufferSource, name: "AES-GCM" },
        key,
        base64ToBytes(secret.ciphertext) as BufferSource,
    );

    return decoder.decode(plaintext);
};
