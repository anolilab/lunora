import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildPresignedUrl } from "../src/presigned-url.js";
import type { R2S3Credentials } from "../src/types.js";

const CREDENTIALS: R2S3Credentials = {
    accessKeyId: "AKIAEXAMPLE",
    accountId: "acc123",
    bucket: "uploads",
    secretAccessKey: "secretEXAMPLE",
};

// Fixed clock so the signature is deterministic. 2026-06-07T08:30:00Z.
const FIXED_NOW = Date.UTC(2026, 5, 7, 8, 30, 0);

/**
 * Independent SigV4 query-presign reimplementation using `node:crypto` (a
 * different crypto API than the WebCrypto impl under test). If both agree on the
 * full URL, the canonicalization in `buildPresignedUrl` is correct.
 */
const referenceUrl = (key: string, method: "GET" | "PUT", expires: number, host = `${CREDENTIALS.accountId}.r2.cloudflarestorage.com`): string => {
    const date = new Date(FIXED_NOW);
    const amzDate = `${date.toISOString().replaceAll(/[:-]/gu, "").slice(0, 15)}Z`;
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/auto/s3/aws4_request`;
    const enc = (value: string): string => encodeURIComponent(value).replaceAll(/[!'()*]/gu, (c) => `%${c.codePointAt(0)!.toString(16).toUpperCase()}`);
    const compare = (a: [string, string], b: [string, string]): number => {
        if (a[0] < b[0]) {
            return -1;
        }

        return a[0] > b[0] ? 1 : 0;
    };
    const canonicalUri = `/${enc(CREDENTIALS.bucket)}/${key
        .split("/")
        .map((segment) => enc(segment))
        .join("/")}`;
    const canonicalQuery = (
        [
            ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
            ["X-Amz-Credential", `${CREDENTIALS.accessKeyId}/${scope}`],
            ["X-Amz-Date", amzDate],
            ["X-Amz-Expires", String(expires)],
            ["X-Amz-SignedHeaders", "host"],
        ] as [string, string][]
    )
        .map(([n, v]): [string, string] => [enc(n), enc(v)])
        .toSorted(compare)
        .map(([n, v]) => `${n}=${v}`)
        .join("&");
    const canonicalRequest = [method, canonicalUri, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
    const hashedRequest = createHash("sha256").update(canonicalRequest).digest("hex");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hashedRequest].join("\n");
    const kDate = createHmac("sha256", `AWS4${CREDENTIALS.secretAccessKey}`).update(dateStamp).digest();
    const kRegion = createHmac("sha256", kDate).update("auto").digest();
    const kService = createHmac("sha256", kRegion).update("s3").digest();
    const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

    return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
};

describe("buildPresignedUrl", () => {
    it("matches an independent node:crypto SigV4 reference (GET)", async () => {
        expect.assertions(1);

        const url = await buildPresignedUrl({ credentials: CREDENTIALS, expiresInSeconds: 900, key: "photos/cat.png", method: "GET", now: () => FIXED_NOW });

        expect(url).toBe(referenceUrl("photos/cat.png", "GET", 900));
    });

    it("matches the reference for a PUT and differs from the GET signature", async () => {
        expect.assertions(2);

        const put = await buildPresignedUrl({ credentials: CREDENTIALS, expiresInSeconds: 900, key: "photos/cat.png", method: "PUT", now: () => FIXED_NOW });
        const get = await buildPresignedUrl({ credentials: CREDENTIALS, expiresInSeconds: 900, key: "photos/cat.png", method: "GET", now: () => FIXED_NOW });

        expect(put).toBe(referenceUrl("photos/cat.png", "PUT", 900));
        expect(put).not.toBe(get);
    });

    it("encodes special characters in the key per RFC 3986 (and keeps path separators)", async () => {
        expect.assertions(2);

        const url = await buildPresignedUrl({ credentials: CREDENTIALS, key: "a b/c+d (1).png", now: () => FIXED_NOW });

        expect(url).toContain("/uploads/a%20b/c%2Bd%20%281%29.png?");
        expect(url).toBe(referenceUrl("a b/c+d (1).png", "GET", 900));
    });

    it("targets the jurisdiction-specific endpoint host", async () => {
        expect.assertions(2);

        const url = await buildPresignedUrl({ credentials: { ...CREDENTIALS, jurisdiction: "eu" }, key: "x.bin", now: () => FIXED_NOW });

        expect(url.startsWith("https://acc123.eu.r2.cloudflarestorage.com/")).toBe(true);
        expect(url).toBe(referenceUrl("x.bin", "GET", 900, "acc123.eu.r2.cloudflarestorage.com"));
    });

    it("clamps the expiry to the 1..604800 second window", async () => {
        expect.assertions(2);

        const tooLong = await buildPresignedUrl({ credentials: CREDENTIALS, expiresInSeconds: 999_999, key: "x", now: () => FIXED_NOW });
        const tooShort = await buildPresignedUrl({ credentials: CREDENTIALS, expiresInSeconds: 0, key: "x", now: () => FIXED_NOW });

        expect(tooLong).toContain("X-Amz-Expires=604800");
        expect(tooShort).toContain("X-Amz-Expires=1");
    });

    it("defaults the expiry to 900 seconds", async () => {
        expect.assertions(1);

        const url = await buildPresignedUrl({ credentials: CREDENTIALS, key: "x", now: () => FIXED_NOW });

        expect(url).toContain("X-Amz-Expires=900");
    });
});
