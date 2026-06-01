import type { SignedUrlOptions } from "./types.js";

const textEncoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string => {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const fromBase64Url = (input: string): Uint8Array => {
    const padded = input.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((input.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.codePointAt(index) ?? 0;
    }

    return bytes;
};

const importHmacKey = async (secret: string): Promise<CryptoKey> =>
    crypto.subtle.importKey("raw", textEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

// Host is lowercased so a signature minted for `Example.com` verifies against
// `example.com` — DNS is case-insensitive, but the URL parser preserves case.
const canonicalize = (method: "GET" | "PUT", host: string, key: string, exp: number): string => `${method}\n${host.toLowerCase()}\n${key}\n${exp}`;

const extractHost = (input: string): string => {
    // Tolerate a bare host-or-base by trying URL first; fall back to splitting
    // off the path. Either way, the canonical form is just `host[:port]`.
    try {
        return new URL(input).host;
    } catch {
        const noScheme = input.replace(/^[a-z][a-z0-9+\-.]*:\/\//i, "");

        return noScheme.split("/")[0] ?? "";
    }
};

/**
 * Worker-signed URL: `${publicBaseUrl}/${key}?exp=<unix>&method=<GET|PUT>&sig=<base64url-hmac>`.
 *
 * The HMAC canonical includes the URL host so a signature minted for one bucket
 * cannot be replayed against another host on the same signing secret. Even so,
 * the signing secret MUST NOT be shared across buckets/tenants — host binding
 * narrows replay surface but is not a substitute for per-tenant key isolation.
 *
 * The Worker handling `GET /storage/:key` should call {@link verifySignedUrl}
 * to validate the signature + expiry before streaming the R2 body.
 */
export const buildSignedUrl = async (
    args: SignedUrlOptions & {
        baseUrl: string;
        key: string;
        secret: string;
    },
): Promise<string> => {
    const method = args.method ?? "GET";
    const expiresInSeconds = args.expiresInSeconds ?? 60 * 60;
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const host = extractHost(args.baseUrl);
    const cryptoKey = await importHmacKey(args.secret);
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(canonicalize(method, host, args.key, exp)));
    const sig = toBase64Url(new Uint8Array(signature));

    const base = args.baseUrl.endsWith("/") ? args.baseUrl.slice(0, -1) : args.baseUrl;
    const safeKey = args.key.split("/").map(encodeURIComponent).join("/");

    return `${base}/${safeKey}?exp=${exp}&method=${method}&sig=${sig}`;
};

export interface VerifyResult {
    key?: string;
    method?: "GET" | "PUT";
    /**
     * Internal-only failure reason for server logs/diagnostics. **Do not echo
     * to clients** — a precise reason ("expired" vs "bad_signature") is a
     * signing oracle. Public responses should expose only `valid`.
     */
    reason?: "bad_signature" | "expired" | "malformed";
    valid: boolean;
}

export const verifySignedUrl = async (input: string | URL, secret: string): Promise<VerifyResult> => {
    let url: URL;

    try {
        url = input instanceof URL ? input : new URL(input);
    } catch {
        return { valid: false, reason: "malformed" };
    }

    const exp = Number.parseInt(url.searchParams.get("exp") ?? "", 10);
    const sig = url.searchParams.get("sig");
    const method = (url.searchParams.get("method") ?? "GET") as "GET" | "PUT";

    if (!sig || !Number.isFinite(exp)) {
        return { valid: false, reason: "malformed" };
    }

    if (exp < Math.floor(Date.now() / 1000)) {
        return { valid: false, reason: "expired" };
    }

    if (method !== "GET" && method !== "PUT") {
        return { valid: false, reason: "malformed" };
    }

    // Pathname is `/<key>`. Strip the leading slash and decode each segment.
    // A malformed percent-escape (decodeURIComponent) or a non-base64url `sig`
    // (atob) throws — treat either as `malformed` rather than letting it
    // propagate as an uncaught rejection.
    let key: string;
    let sigBytes: Uint8Array;

    try {
        key = url.pathname.replace(/^\//, "").split("/").map(decodeURIComponent).join("/");
        sigBytes = fromBase64Url(sig);
    } catch {
        return { valid: false, reason: "malformed" };
    }

    const cryptoKey = await importHmacKey(secret);
    const valid = await crypto.subtle.verify(
        "HMAC",
        cryptoKey,
        sigBytes as unknown as BufferSource,
        textEncoder.encode(canonicalize(method, url.host, key, exp)),
    );

    if (!valid) {
        return { valid: false, reason: "bad_signature" };
    }

    return { valid: true, key, method };
};
