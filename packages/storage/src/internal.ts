/**
 * Internal, dependency-free encoding/URL helpers shared across the storage
 * package. Not part of the public API — deliberately not re-exported from
 * `index.ts`.
 */

/**
 * Lowercase hex-encode an `ArrayBuffer`. Used both to surface R2's sha256
 * checksum (`create-storage`) and to hex-encode SigV4 signatures
 * (`presigned-url`).
 */
export const toHex = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    let out = "";

    for (const byte of bytes) {
        out += byte.toString(16).padStart(2, "0");
    }

    return out;
};

/**
 * Strip every trailing slash from a base URL — a linear scan (no regex
 * backtracking). Shared by `getUrl` and the signed-URL builder so both
 * normalise `publicBaseUrl` identically (a `https://cdn.test//` base yields a
 * clean, single-slash join from either path).
 */
export const trimTrailingSlashes = (value: string): string => {
    let end = value.length;

    while (end > 0 && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(0, end);
};
