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

const canonicalize = (key: string, exp: number, method: "GET" | "PUT"): string => `${method}\n${key}\n${exp}`;

/**
 * Worker-signed URL: `${publicBaseUrl}/${key}?exp=<unix>&method=<GET|PUT>&sig=<base64url-hmac>`.
 *
 * The Worker handling `GET /storage/:key` should call {@link verifySignedUrl}
 * to validate the signature + expiry before streaming the R2 body.
 */
export const buildSignedUrl = async (
    args: {
        baseUrl: string;
        secret: string;
        key: string;
    } & SignedUrlOptions,
): Promise<string> => {
    const method = args.method ?? "GET";
    const expiresInSeconds = args.expiresInSeconds ?? 60 * 60;
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const cryptoKey = await importHmacKey(args.secret);
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(canonicalize(args.key, exp, method)));
    const sig = toBase64Url(new Uint8Array(signature));

    const base = args.baseUrl.endsWith("/") ? args.baseUrl.slice(0, -1) : args.baseUrl;
    const safeKey = args.key.split("/").map(encodeURIComponent).join("/");

    return `${base}/${safeKey}?exp=${exp}&method=${method}&sig=${sig}`;
};

export interface VerifyResult {
    valid: boolean;
    reason?: "expired" | "bad_signature" | "malformed";
    key?: string;
    method?: "GET" | "PUT";
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
    const key = url.pathname.replace(/^\//, "").split("/").map(decodeURIComponent).join("/");
    const cryptoKey = await importHmacKey(secret);
    const sigBytes = fromBase64Url(sig);
    const valid = await crypto.subtle.verify(
        "HMAC",
        cryptoKey,
        sigBytes as unknown as BufferSource,
        textEncoder.encode(canonicalize(key, exp, method)),
    );

    if (!valid) {
        return { valid: false, reason: "bad_signature" };
    }

    return { valid: true, key, method };
};
