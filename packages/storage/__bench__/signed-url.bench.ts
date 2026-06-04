import { bench, describe } from "vitest";

import { buildSignedUrl, verifySignedUrl } from "../src/signed-url.js";

/**
 * `verifySignedUrl` sits on the serve-signed-URL hot path: a Worker fronting R2
 * runs it on every GET/PUT before streaming a body. The signing secret is
 * effectively constant per process, so the optimization memoizes the imported
 * (non-extractable) HMAC `CryptoKey` by secret value, removing one
 * `crypto.subtle.importKey` per request.
 *
 * This bench contrasts the cached verify path (the shipped implementation,
 * which reuses a process-resident key) against an uncached baseline that
 * imports the key on every call — the pre-optimization behavior — so the win is
 * demonstrable. `crypto.subtle` is the Web Crypto API exposed by node:crypto in
 * modern Node, so this runs in plain Node with no workerd.
 */

const SECRET = "bench-signing-secret";
const textEncoder = new TextEncoder();

const importUncached = async (secret: string): Promise<CryptoKey> =>
    crypto.subtle.importKey("raw", textEncoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign", "verify"]);

// Pre-mint a valid URL once so both benches measure only the verify cost.
const signedUrl = await buildSignedUrl({ baseUrl: "https://cdn.test", expiresInSeconds: 7 * 24 * 60 * 60, key: "uploads/x.png", secret: SECRET });
const url = new URL(signedUrl);
const exp = Number(url.searchParams.get("exp"));
const method = url.searchParams.get("method") ?? "GET";
const sig = url.searchParams.get("sig") ?? "";

// Reproduce verify's canonicalize + fromBase64Url inline for the uncached
// baseline so the only difference vs the cached path is the key import.
const canonical = `${method}\n${url.host.toLowerCase()}\nuploads/x.png\n${String(exp)}`;
const fromBase64Url = (input: string): Uint8Array => {
    const padded = input.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((input.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.codePointAt(index) ?? 0;
    }

    return bytes;
};
const sigBytes = fromBase64Url(sig);

describe("verifySignedUrl", () => {
    bench("cached key import (shipped)", async () => {
        await verifySignedUrl(signedUrl, SECRET);
    });

    bench("uncached key import (baseline)", async () => {
        const key = await importUncached(SECRET);

        await crypto.subtle.verify("HMAC", key, sigBytes as unknown as BufferSource, textEncoder.encode(canonical));
    });
});
