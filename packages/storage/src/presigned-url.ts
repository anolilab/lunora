/**
 * Native R2 (S3-compatible) presigned URLs via AWS Signature Version 4.
 *
 * Unlike the worker-signed URL helper (`buildSignedUrl`, which signs URLs that
 * resolve back through your Worker so the app can gate the request), a presigned
 * URL is a self-contained S3 credential: the holder hits R2's S3 endpoint host
 * directly, bypassing the Worker. Prefer this for large downloads/uploads where
 * you don't need per-request app logic and want the bytes to flow straight off
 * R2 instead of through the Worker's CPU/bandwidth budget.
 *
 * The signature is computed with WebCrypto (HMAC-SHA256) — no AWS SDK, no
 * bundled dependency. R2's region is always `auto`; the payload is signed as
 * `UNSIGNED-PAYLOAD` (the standard for presigned GET/PUT). Requires R2 S3 API
 * credentials (an R2 API token's Access Key ID / Secret Access Key).
 * @see https://developers.cloudflare.com/r2/api/s3/presigned-urls/
 */
import type { R2S3Credentials } from "./types.js";

/** R2's S3 region alias — always `auto`. */
const REGION = "auto";
const SERVICE = "s3";
const ALGORITHM = "AWS4-HMAC-SHA256";

/** S3 presigned-URL expiry bounds (seconds): 1 second to 7 days. */
const MIN_EXPIRES_SECONDS = 1;
const MAX_EXPIRES_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_EXPIRES_SECONDS = 900;

const textEncoder = new TextEncoder();

/** Lexical comparator for `[name, value]` query entries (canonical query is sorted by name). */
const compareEntries = (a: [string, string], b: [string, string]): number => {
    if (a[0] < b[0]) {
        return -1;
    }

    return a[0] > b[0] ? 1 : 0;
};

/** Lowercase hex-encode an `ArrayBuffer`. */
const toHex = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    let out = "";

    for (const byte of bytes) {
        out += byte.toString(16).padStart(2, "0");
    }

    return out;
};

/**
 * RFC 3986 encoding as AWS SigV4 requires it: `encodeURIComponent` plus the
 * four characters it leaves unescaped (`!'()*`). Unreserved chars
 * (`A-Za-z0-9-_.~`) stay literal — which is exactly what `encodeURIComponent`
 * already guarantees.
 */
const encodeRfc3986 = (value: string): string =>
    encodeURIComponent(value).replaceAll(/[!'()*]/gu, (char) => `%${char.codePointAt(0)?.toString(16).toUpperCase() ?? ""}`);

/** Encode an object key for the canonical URI, preserving `/` between segments. */
const encodeKey = (key: string): string =>
    key
        .split("/")
        .map((segment) => encodeRfc3986(segment))
        .join("/");

const sha256Hex = async (input: string): Promise<string> => toHex(await crypto.subtle.digest("SHA-256", textEncoder.encode(input)));

const hmac = async (key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> => {
    const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);

    return crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(message));
};

/** Derive the SigV4 signing key: HMAC chain over date → region → service → "aws4_request". */
const deriveSigningKey = async (secretAccessKey: string, dateStamp: string): Promise<ArrayBuffer> => {
    const dateKey = await hmac(textEncoder.encode(`AWS4${secretAccessKey}`), dateStamp);
    const regionKey = await hmac(dateKey, REGION);
    const serviceKey = await hmac(regionKey, SERVICE);

    return hmac(serviceKey, "aws4_request");
};

/** Resolve the R2 S3 endpoint host for an optional jurisdiction. */
const endpointHost = (credentials: R2S3Credentials): string => {
    const infix = credentials.jurisdiction === undefined ? "" : `${credentials.jurisdiction}.`;

    return `${credentials.accountId}.${infix}r2.cloudflarestorage.com`;
};

/** Format a `Date` as the two SigV4 stamps: `YYYYMMDDTHHMMSSZ` and `YYYYMMDD`. */
const formatAmzDate = (date: Date): { amzDate: string; dateStamp: string } => {
    const amzDate = `${date.toISOString().replaceAll(/[:-]/gu, "").slice(0, 15)}Z`;

    return { amzDate, dateStamp: amzDate.slice(0, 8) };
};

/** Parameters accepted by {@link buildPresignedUrl}. */
export interface PresignedUrlParams {
    /** R2 S3 API credentials + bucket/account. */
    credentials: R2S3Credentials;
    /** Seconds the URL stays valid; clamped to [1, 604800]. Default 900. */
    expiresInSeconds?: number;
    /** Object key (path-style; not URL-encoded by the caller). */
    key: string;
    /** HTTP method the URL authorizes. Default `GET`. */
    method?: "GET" | "PUT";
    /** Injectable clock (epoch ms) for deterministic tests. Defaults to `Date.now`. */
    now?: () => number;
}

/**
 * Build a native S3 presigned URL for an R2 object using SigV4 query-string
 * auth. The returned URL points at R2's S3 endpoint and carries the full
 * signature, so it authorizes a single `GET`/`PUT` on `key` until it expires —
 * no Worker round-trip.
 */
export const buildPresignedUrl = async (parameters: PresignedUrlParams): Promise<string> => {
    const { credentials, key } = parameters;
    const method = parameters.method ?? "GET";
    const requested = parameters.expiresInSeconds ?? DEFAULT_EXPIRES_SECONDS;
    const expires = Math.min(Math.max(MIN_EXPIRES_SECONDS, Math.floor(requested)), MAX_EXPIRES_SECONDS);

    const host = endpointHost(credentials);
    const date = new Date(parameters.now?.() ?? Date.now());
    const { amzDate, dateStamp } = formatAmzDate(date);
    const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

    const canonicalUri = `/${encodeRfc3986(credentials.bucket)}/${encodeKey(key)}`;

    // Query parameters must be sorted by key and individually RFC 3986-encoded.
    const query: [string, string][] = [
        ["X-Amz-Algorithm", ALGORITHM],
        ["X-Amz-Credential", `${credentials.accessKeyId}/${credentialScope}`],
        ["X-Amz-Date", amzDate],
        ["X-Amz-Expires", expires.toString()],
        ["X-Amz-SignedHeaders", "host"],
    ];
    const canonicalQuery = query
        .map(([name, value]): [string, string] => [encodeRfc3986(name), encodeRfc3986(value)])
        .toSorted(compareEntries)
        .map(([name, value]) => `${name}=${value}`)
        .join("&");

    const canonicalRequest = [method, canonicalUri, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
    const stringToSign = [ALGORITHM, amzDate, credentialScope, await sha256Hex(canonicalRequest)].join("\n");

    const signingKey = await deriveSigningKey(credentials.secretAccessKey, dateStamp);
    const signature = toHex(await hmac(signingKey, stringToSign));

    return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
};
