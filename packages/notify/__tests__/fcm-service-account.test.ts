import { describe, expect, it, vi } from "vitest";

import { fromBase64Url } from "../../../shared/base64";
import { fcmServiceAccountTokenSource, parseServiceAccount } from "../src/fcm-service-account";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const toPem = (der: ArrayBuffer): string => {
    const base64 = btoa(String.fromCodePoint(...new Uint8Array(der)));
    const lines = base64.match(/.{1,64}/g) ?? [];

    // secret-scanner:allow -- PEM armour of a throwaway key generated in this test run
    return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
};

/** A throwaway RSA key pair, generated per test run — no key material is committed. */
const generateKeys = async (): Promise<{ privateKeyPem: string; publicKey: CryptoKey }> => {
    const pair = await crypto.subtle.generateKey(
        { hash: "SHA-256", modulusLength: 2048, name: "RSASSA-PKCS1-v1_5", publicExponent: new Uint8Array([1, 0, 1]) },
        true,
        ["sign", "verify"],
    );
    const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);

    return { privateKeyPem: toPem(der), publicKey: pair.publicKey };
};

const tokenResponse = (accessToken: string, expiresIn: number): Response =>
    Response.json({ access_token: accessToken, expires_in: expiresIn, token_type: "Bearer" });

const serviceAccountJson = (clientEmail: string, privateKeyPem: string): string => JSON.stringify({ client_email: clientEmail, private_key: privateKeyPem });

describe("fcmServiceAccountTokenSource", () => {
    it("exchanges one signed assertion and serves many sends from a single token", async () => {
        expect.hasAssertions();

        const { privateKeyPem } = await generateKeys();
        const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(tokenResponse("tok-once", 3600)));
        const getAccessToken = fcmServiceAccountTokenSource(serviceAccountJson("once@proj.iam", privateKeyPem), { fetch: fetchMock, now: () => 0 });

        const tokens = await Promise.all([getAccessToken(), getAccessToken(), getAccessToken()]);
        await getAccessToken();

        expect(tokens).toStrictEqual(["tok-once", "tok-once", "tok-once"]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("signs an RS256 assertion scoped to FCM and the Google token endpoint", async () => {
        expect.hasAssertions();

        const { privateKeyPem, publicKey } = await generateKeys();
        const fetchMock = vi.fn<typeof fetch>(async () => tokenResponse("tok-claims", 3600));
        const getAccessToken = fcmServiceAccountTokenSource(serviceAccountJson("claims@proj.iam", privateKeyPem), { fetch: fetchMock, now: () => 1_000_000 });

        await getAccessToken();

        const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
        const [header = "", payload = "", signature = ""] = (body.get("assertion") ?? "").split(".");
        const decoder = new TextDecoder();
        const signedInput = new TextEncoder().encode(`${header}.${payload}`);
        const signatureValid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, new Uint8Array(fromBase64Url(signature)), signedInput);
        const claims = JSON.parse(decoder.decode(fromBase64Url(payload))) as Record<string, unknown>;

        expect(JSON.parse(decoder.decode(fromBase64Url(header)))).toStrictEqual({ alg: "RS256", typ: "JWT" });
        expect(signatureValid).toBe(true);
        expect(claims).toMatchObject({
            aud: TOKEN_URL,
            iss: "claims@proj.iam",
            scope: "https://www.googleapis.com/auth/firebase.messaging",
            sub: "claims@proj.iam",
        });
        expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    });

    it("refreshes the token shortly before it expires, not after", async () => {
        expect.hasAssertions();

        const { privateKeyPem } = await generateKeys();
        let clock = 0;
        let mints = 0;
        const fetchMock = vi.fn<typeof fetch>(() => {
            mints += 1;

            return Promise.resolve(tokenResponse(`tok-${String(mints)}`, 3600));
        });
        const getAccessToken = fcmServiceAccountTokenSource(serviceAccountJson("refresh@proj.iam", privateKeyPem), { fetch: fetchMock, now: () => clock });

        await expect(getAccessToken()).resolves.toBe("tok-1");

        // Expires at 3600s minus the 60s refresh margin, so 3500s is still fresh.
        clock = 3_500_000;

        await expect(getAccessToken()).resolves.toBe("tok-1");
        expect(fetchMock).toHaveBeenCalledTimes(1);

        clock = 3_541_000;

        await expect(getAccessToken()).resolves.toBe("tok-2");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("keys the cache by the key itself, so a rotated key under the same email mints its own token", async () => {
        expect.hasAssertions();

        const first = await generateKeys();
        const second = await generateKeys();
        let mints = 0;
        const fetchMock = vi.fn<typeof fetch>(() => {
            mints += 1;

            return Promise.resolve(tokenResponse(`tok-${String(mints)}`, 3600));
        });
        const options = { fetch: fetchMock, now: () => 0 };
        const beforeRotation = fcmServiceAccountTokenSource(serviceAccountJson("rotate@proj.iam", first.privateKeyPem), options);
        const afterRotation = fcmServiceAccountTokenSource(serviceAccountJson("rotate@proj.iam", second.privateKeyPem), options);

        await expect(beforeRotation()).resolves.toBe("tok-1");
        await expect(afterRotation()).resolves.toBe("tok-2");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("parses the key lazily: a malformed key rejects the token call and never reaches the network", async () => {
        expect.hasAssertions();

        const fetchMock = vi.fn<typeof fetch>();
        const getAccessToken = fcmServiceAccountTokenSource("{oops", { fetch: fetchMock, now: () => 0 });

        await expect(getAccessToken()).rejects.toThrow("not valid JSON");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not cache a failed exchange, so the next send retries", async () => {
        expect.hasAssertions();

        const { privateKeyPem } = await generateKeys();
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
            .mockResolvedValueOnce(tokenResponse("tok-recovered", 3600));
        const getAccessToken = fcmServiceAccountTokenSource(serviceAccountJson("retry@proj.iam", privateKeyPem), { fetch: fetchMock, now: () => 0 });

        await expect(getAccessToken()).rejects.toThrow("HTTP 503");
        await expect(getAccessToken()).resolves.toBe("tok-recovered");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe("parseServiceAccount", () => {
    it("reads client_email, private_key and project_id from a key file", () => {
        expect.hasAssertions();

        const raw = JSON.stringify({ client_email: "a@p.iam", private_key: "PEM", project_id: "p", type: "service_account" });

        expect(parseServiceAccount(raw)).toStrictEqual({ client_email: "a@p.iam", private_key: "PEM", project_id: "p" });
    });

    it(String.raw`restores newlines escaped as \n in the private key`, () => {
        expect.hasAssertions();

        const raw = JSON.stringify({ client_email: "a@p.iam", private_key: String.raw`line1\nline2\n` });

        expect(parseServiceAccount(raw).private_key).toBe("line1\nline2\n");
    });

    it("throws on malformed JSON, without the parser's cause that would quote the key", () => {
        expect.hasAssertions();

        let caught: unknown;

        try {
            parseServiceAccount("{not json");
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(TypeError);
        expect((caught as Error).cause).toBeUndefined();
    });

    it("throws when client_email or private_key is missing", () => {
        expect.hasAssertions();

        expect(() => parseServiceAccount(JSON.stringify({ client_email: "a@p.iam" }))).toThrow("must contain client_email and private_key");
    });
});
