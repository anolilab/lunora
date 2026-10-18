import type { SecretValueHost, SecretValuePutOptions, SecretValueStore, SecretValueTakeOptions } from "./secret-value-host";
import { assertSecretValueSize } from "./secret-value-host";

/**
 * Application-layer authenticated encryption for a {@link SecretValueStore}.
 *
 * What a store keeps is `{ keyId, iv, ciphertext }`, never the plaintext. The
 * ciphertext is AES-256-GCM over the value, with the ref and the scope bound as
 * additional authenticated data, so a record moved to another ref or read under
 * another scope fails to open. This protects stored and restored bytes only: the
 * key lives in the Worker's secret store, so a restore alone does not defeat it.
 * Erasure is `discard` plus rotating the key.
 *
 * Everything here is WebCrypto, so the package stays dependency-free and every
 * host inherits the same implementation.
 */

/** AES-256 key length in bytes. */
const KEY_BYTES = 32;

/** GCM nonce length in bytes. A fresh one is drawn for every `put`. */
const IV_BYTES = 12;

/** Domain separator in the AAD, so a future format cannot be confused with this one. */
const AAD_DOMAIN = "lunora.secret-value.v1";

/**
 * Thrown by a wrapped {@link SecretValueHost} when its encryption key is absent
 * or unusable. `put` and `take` both refuse with it: a host without a key must
 * never fall back to storing or returning plaintext. The message names the
 * failure, never the key material.
 */
class SecretValueKeyError extends Error {
    public readonly code = "SECRET_VALUE_KEY_UNAVAILABLE";

    public constructor(reason: "missing" | "malformed") {
        super(
            reason === "missing"
                ? "secret value encryption key is not configured"
                : "secret value encryption key is malformed: expected base64 of exactly 32 bytes",
        );
        this.name = "SecretValueKeyError";
    }
}

/** Strict shape of a standard base64 string that decodes to 32 bytes (44 chars, one `=`). */
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/u;

/** Key material the host encrypts and decrypts with. */
interface SecretValueKeyOptions {
    /**
     * Base64 of exactly 32 bytes, the AES-256 key. Absent or malformed makes
     * `put` and `take` throw {@link SecretValueKeyError}.
     */
    key: string | undefined;

    /**
     * The retired key during rotation. `take` still opens values sealed under
     * it; `put` never uses it. An empty string counts as absent.
     */
    previousKey?: string;
}

/** One loaded key: its stamp and the non-extractable CryptoKey. */
interface KeySlot {
    id: string;
    key: CryptoKey;
}

/** The loaded keys. `previous` is present only during rotation. */
interface KeyRing {
    current: KeySlot;
    previous: KeySlot | undefined;
}

/** The record a store holds: the stamp, the nonce and the sealed bytes, all base64 except the stamp. */
interface SealedEnvelope {
    ciphertext: string;
    iv: string;
    keyId: string;
}

const toBase64 = (bytes: Uint8Array): string => {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary);
};

const fromBase64 = (encoded: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(encoded), (char) => char.codePointAt(0) ?? 0);

/**
 * Load one key from its base64 form. The stamp is the first 8 bytes of
 * SHA-256 over the raw key, so it is computed before the bytes are imported
 * into a non-extractable CryptoKey.
 */
const loadKeySlot = async (material: string): Promise<KeySlot> => {
    if (!BASE64_KEY.test(material)) {
        throw new SecretValueKeyError("malformed");
    }

    const bytes = fromBase64(material);

    if (bytes.byteLength !== KEY_BYTES) {
        throw new SecretValueKeyError("malformed");
    }

    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const id = [...digest.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const key = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

    return { id, key };
};

/** Load the ring, failing closed on a missing current key or any malformed one. */
const loadKeyRing = async (options: SecretValueKeyOptions): Promise<KeyRing> => {
    if (options.key === undefined || options.key === "") {
        throw new SecretValueKeyError("missing");
    }

    const current = await loadKeySlot(options.key);
    const previous = options.previousKey === undefined || options.previousKey === "" ? undefined : await loadKeySlot(options.previousKey);

    return { current, previous };
};

/**
 * The AAD binds the ref and the scope. A JSON array keeps the two fields
 * unambiguous, so no ref/scope pair can serialize to the same bytes as another.
 */
const additionalData = (ref: string, scope: string): Uint8Array<ArrayBuffer> =>
    new Uint8Array(new TextEncoder().encode(JSON.stringify([AAD_DOMAIN, ref, scope])));

/** Parse a stored record, or `undefined` when it is not one of ours. Never throws. */
const parseEnvelope = (stored: string): SealedEnvelope | undefined => {
    try {
        const parsed: unknown = JSON.parse(stored);

        if (typeof parsed !== "object" || parsed === null) {
            return undefined;
        }

        const { ciphertext, iv, keyId } = parsed as Record<string, unknown>;

        return typeof ciphertext === "string" && typeof iv === "string" && typeof keyId === "string" ? { ciphertext, iv, keyId } : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Wrap a raw {@link SecretValueStore} so the value is encrypted before it is
 * stored and decrypted only on a successful `take`.
 *
 * `put` and `take` refuse with {@link SecretValueKeyError} when the key is missing
 * or malformed, before any record is touched. A take whose record cannot be
 * opened (tampered, moved to another ref or scope, or sealed under a key that is
 * no longer configured) reads `undefined`; it never throws with the plaintext in
 * the error.
 *
 * The key is validated on first use, not at construction, so an app that never
 * uses the feature boots without a key.
 */
const encryptingSecretValueHost = (raw: SecretValueStore, options: SecretValueKeyOptions): SecretValueHost => {
    let ring: Promise<KeyRing> | undefined;
    const keys = (): Promise<KeyRing> => {
        ring ??= loadKeyRing(options);

        return ring;
    };

    const open = async (stored: string, ref: string, scope: string, candidates: KeyRing): Promise<string | undefined> => {
        const envelope = parseEnvelope(stored);

        if (envelope === undefined) {
            return undefined;
        }

        const slot = [candidates.current, candidates.previous].find((candidate) => candidate?.id === envelope.keyId);

        if (slot === undefined) {
            return undefined;
        }

        try {
            const plaintext = await crypto.subtle.decrypt(
                { additionalData: additionalData(ref, scope), iv: fromBase64(envelope.iv), name: "AES-GCM" },
                slot.key,
                fromBase64(envelope.ciphertext),
            );

            return new TextDecoder().decode(plaintext);
        } catch {
            return undefined;
        }
    };

    return {
        discard: async (ref) => raw.discard(ref),
        put: async (value: string, putOptions: SecretValuePutOptions) => {
            const { current } = await keys();

            assertSecretValueSize(value);

            const plaintext = new Uint8Array(new TextEncoder().encode(value));

            return raw.put(async (ref) => {
                const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
                const ciphertext = await crypto.subtle.encrypt(
                    { additionalData: additionalData(ref, putOptions.scope), iv, name: "AES-GCM" },
                    current.key,
                    plaintext,
                );

                const envelope: SealedEnvelope = {
                    ciphertext: toBase64(new Uint8Array(ciphertext)),
                    iv: toBase64(iv),
                    keyId: current.id,
                };

                return JSON.stringify(envelope);
            }, putOptions);
        },
        take: async (ref: string, take: SecretValueTakeOptions) => {
            const candidates = await keys();
            const stored = await raw.take(ref, take);

            return stored === undefined ? undefined : open(stored, ref, take.scope, candidates);
        },
    };
};

export type { SecretValueKeyOptions };
export { encryptingSecretValueHost, SecretValueKeyError };
