/**
 * PBKDF2-HMAC-SHA256 password hashing via the Web Crypto API. Runs natively in
 * the Workers runtime (no `node:crypto` dependency) and is usable from Node /
 * Vitest because Node exposes `globalThis.crypto.subtle` since v20.
 *
 * Hash format: `pbkdf2$<iterations>$<salt-b64>$<hash-b64>` (constant-time
 * comparable, self-describing for future algorithm swaps).
 */

// OWASP 2023 minimum for PBKDF2-HMAC-SHA256.
const DEFAULT_ITERATIONS = 600_000;

// Minimum iteration count we accept on verify. Hashes with fewer iterations
// are treated as invalid so we never validate against weak legacy material.
const MIN_VERIFY_ITERATIONS = 100_000;

const KEY_LENGTH_BITS = 256;

const SALT_BYTES = 16;

const textEncoder = new TextEncoder();

const toBase64 = (bytes: Uint8Array): string => {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary);
};

const fromBase64 = (input: string): Uint8Array => {
    const binary = atob(input);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.codePointAt(index) ?? 0;
    }

    return bytes;
};

const deriveBits = async (password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> => {
    const passwordKey = await crypto.subtle.importKey("raw", textEncoder.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);

    const bits = await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            // `salt` is a Uint8Array (ArrayBufferView) — accepted by WebCrypto.
            salt: salt as unknown as BufferSource,
            iterations,
            hash: "SHA-256",
        },
        passwordKey,
        KEY_LENGTH_BITS,
    );

    return new Uint8Array(bits);
};

export const hashPassword = async (password: string, iterations: number = DEFAULT_ITERATIONS): Promise<string> => {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const hash = await deriveBits(password, salt, iterations);

    return `pbkdf2$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
};

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
    const parts = stored.split("$");

    if (parts.length !== 4 || parts[0] !== "pbkdf2") {
        return false;
    }

    const iterations = Number.parseInt(parts[1] ?? "", 10);

    if (!Number.isFinite(iterations) || iterations < MIN_VERIFY_ITERATIONS) {
        return false;
    }

    const salt = fromBase64(parts[2] ?? "");
    const expected = fromBase64(parts[3] ?? "");
    const actual = await deriveBits(password, salt, iterations);

    if (actual.length !== expected.length) {
        return false;
    }

    let mismatch = 0;

    for (let index = 0; index < actual.length; index += 1) {
        mismatch |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
    }

    return mismatch === 0;
};

/**
 * Lazily-generated dummy hash used to equalize timing on the signin path
 * when no user row matches an email. Computed once per process from a fixed
 * placeholder password + random salt; the value never validates because the
 * salt is unique to this process.
 */
let dummyHashPromise: Promise<string> | undefined;

export const getDummyPbkdf2Hash = (): Promise<string> => {
    if (!dummyHashPromise) {
        dummyHashPromise = hashPassword("placeholder");
    }

    return dummyHashPromise;
};
