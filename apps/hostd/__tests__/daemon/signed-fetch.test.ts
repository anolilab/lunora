import { generateKeyPairSync, sign, verify } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { BoxIdentity } from "../../src/daemon/identity";
import type { JobError } from "../../src/daemon/job-error";
import { createSignedFetch } from "../../src/daemon/signed-fetch";
import { HOSTD_REQUEST_HEADERS, requestSigningPayload } from "../../src/wire/signing";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const NONCE = Buffer.from("request-nonce-0123456789").toString("base64url");

const identity: BoxIdentity = {
    publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64url"),
    sign: (payload) => sign(undefined, payload, privateKey).toString("base64url"),
};

const capture = () => {
    const calls: { init: RequestInit; url: string }[] = [];
    const fetcher = vi.fn<(url: URL | string, init?: RequestInit) => Promise<Response>>(async (url: URL | string, init?: RequestInit) => {
        calls.push({ init: init ?? {}, url: String(url) });

        return new Response("{}");
    });

    return { calls, fetcher: fetcher as unknown as typeof fetch };
};

describe(createSignedFetch, () => {
    it("signs a GET with box id, nonce, timestamp and an Ed25519 signature over §6.2", async () => {
        expect.assertions(4);

        const { calls, fetcher } = capture();
        const signedFetch = createSignedFetch({
            boxId: "box_1",
            controlPlane: "https://cloud.example",
            fetch: fetcher,
            identity,
            nonce: () => NONCE,
            now: () => 1_790_000_000_000,
        });

        await signedFetch("https://cloud.example/v1/boxes/releases/dep_1?attempt=2");

        const headers = calls[0]?.init.headers as Record<string, string>;

        expect(headers[HOSTD_REQUEST_HEADERS.timestamp]).toBe("1790000000000");
        expect(headers[HOSTD_REQUEST_HEADERS.boxId]).toBe("box_1");
        expect(calls[0]?.init.redirect).toBe("error");

        const payload = requestSigningPayload({
            boxId: "box_1",
            method: "GET",
            nonce: NONCE,
            path: "/v1/boxes/releases/dep_1?attempt=2",
            timestamp: 1_790_000_000_000,
        });

        expect(verify(undefined, payload, publicKey, Buffer.from(headers[HOSTD_REQUEST_HEADERS.signature] as string, "base64url"))).toBe(true);
    });

    it("uses a fresh nonce for every request", async () => {
        expect.assertions(1);

        const { calls, fetcher } = capture();
        const signedFetch = createSignedFetch({ boxId: "box_1", controlPlane: "https://cloud.example", fetch: fetcher, identity });

        await signedFetch("https://cloud.example/a");
        await signedFetch("https://cloud.example/a");

        const nonces = calls.map((call) => (call.init.headers as Record<string, string>)[HOSTD_REQUEST_HEADERS.nonce]);

        expect(new Set(nonces).size).toBe(2);
    });

    it.each([
        "https://evil.example/v1/boxes/releases/dep_1",
        "http://cloud.example/v1/boxes/releases/dep_1",
        "https://cloud.example:8443/v1/boxes/releases/dep_1",
        "https://someone@cloud.example/v1/boxes/releases/dep_1",
        "not a url",
    ])("refuses %s without signing or sending anything", async (url) => {
        expect.assertions(2);

        const { calls, fetcher } = capture();
        const signedFetch = createSignedFetch({ boxId: "box_1", controlPlane: "https://cloud.example", fetch: fetcher, identity });

        await expect(signedFetch(url)).rejects.toMatchObject({ code: "ORIGIN_REFUSED" } satisfies Partial<JobError>);
        expect(calls).toHaveLength(0);
    });
});
