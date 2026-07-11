/* eslint-disable n/no-unsupported-features/node-builtins -- Web Crypto (crypto.subtle) is a Workers/Node-23+ global; the test runs on Node 24 */
import { describe, expect, it } from "vitest";

import { dispatchAgentChannel, verifyDiscord, verifyGithub, verifySlack } from "../src/channels";

const encoder = new TextEncoder();

const bytesToHex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA256 hex of `message` under `secret` (the signing side of Slack/GitHub). */
const hmacHex = async (secret: string, message: string): Promise<string> => {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

    return bytesToHex(new Uint8Array(signature));
};

describe(verifySlack, () => {
    const secret = "slack-signing-secret";
    const body = '{"type":"event_callback"}';

    it("accepts a valid signature and rejects a tampered one / wrong secret / stale timestamp", async () => {
        const timestamp = "1700000000";
        const signature = `v0=${await hmacHex(secret, `v0:${timestamp}:${body}`)}`;
        const now = 1_700_000_010; // 10s later — fresh

        await expect(verifySlack({ body, now, signature, signingSecret: secret, timestamp })).resolves.toBe(true);
        // Wrong secret.
        await expect(verifySlack({ body, now, signature, signingSecret: "nope", timestamp })).resolves.toBe(false);
        // Tampered body.
        await expect(verifySlack({ body: `${body} `, now, signature, signingSecret: secret, timestamp })).resolves.toBe(false);
        // Stale timestamp (> 300s) is a replay — rejected even with a valid HMAC.
        await expect(verifySlack({ body, now: now + 10_000, signature, signingSecret: secret, timestamp })).resolves.toBe(false);
        // Missing/!v0 signature.
        await expect(verifySlack({ body, now, signature: undefined, signingSecret: secret, timestamp })).resolves.toBe(false);
    });
});

describe(verifyGithub, () => {
    const secret = "gh-webhook-secret";
    const body = '{"action":"opened"}';

    it("accepts a valid sha256= signature and rejects a tampered body", async () => {
        const signature = `sha256=${await hmacHex(secret, body)}`;

        await expect(verifyGithub({ body, secret, signature })).resolves.toBe(true);
        await expect(verifyGithub({ body: `${body} `, secret, signature })).resolves.toBe(false);
        await expect(verifyGithub({ body, secret, signature: "sha256=deadbeef" })).resolves.toBe(false);
        await expect(verifyGithub({ body, secret, signature: undefined })).resolves.toBe(false);
    });
});

describe(verifyDiscord, () => {
    it("accepts an Ed25519 signature over timestamp+body and rejects a wrong key", async () => {
        const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
        const publicKey = bytesToHex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
        const timestamp = "1700000000";
        const body = '{"type":1}';
        const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, encoder.encode(timestamp + body))));

        await expect(verifyDiscord({ body, publicKey, signature, timestamp })).resolves.toBe(true);
        // Tampered body.
        await expect(verifyDiscord({ body: '{"type":2}', publicKey, signature, timestamp })).resolves.toBe(false);

        // A different public key.
        const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
        const otherKey = bytesToHex(new Uint8Array(await crypto.subtle.exportKey("raw", other.publicKey)));

        await expect(verifyDiscord({ body, publicKey: otherKey, signature, timestamp })).resolves.toBe(false);
    });
});

/** A fake `AGENT_*` Workflow binding recording `create()` params. */
const fakeBinding = (): { binding: { create: (options?: { params?: unknown }) => Promise<{ id: string }>; get: () => Promise<never> }; created: unknown[] } => {
    const created: unknown[] = [];

    return {
        binding: {
            create: async (options) => {
                created.push(options?.params);

                return { id: "wf-1" };
            },
            get: async () => {
                throw new Error("unused");
            },
        },
        created,
    };
};

const slackRequest = async (secret: string, body: string): Promise<Request> => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${await hmacHex(secret, `v0:${timestamp}:${body}`)}`;

    return new Request("https://app/webhooks/agent", {
        body,
        headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
        method: "POST",
    });
};

describe(dispatchAgentChannel, () => {
    const secret = "app-slack-secret";

    it("verifies a Slack request then starts a run for the claiming agent", async () => {
        const { binding, created } = fakeBinding();
        const agent = {
            onInbound: {
                channel: "slack" as const,
                map: () => {
                    return { input: "hi from slack", owner: "team-42", threadKey: "t-1" };
                },
                secret: "SLACK_SECRET",
            },
        };
        const handler = dispatchAgentChannel([{ agent, binding: "AGENT_SUPPORT" }]);

        const response = await handler(await slackRequest(secret, '{"event":{}}'), { AGENT_SUPPORT: binding, SLACK_SECRET: secret });

        expect(response.status).toBe(200);
        expect(created).toStrictEqual([{ input: "hi from slack", owner: "team-42", threadKey: "t-1" }]);
    });

    it("rejects an invalid signature with 401 and never calls the mapper", async () => {
        const { binding, created } = fakeBinding();
        let mapped = false;
        const agent = {
            onInbound: {
                channel: "slack" as const,
                map: () => {
                    mapped = true;

                    return { input: "x", threadKey: "t" };
                },
                secret: "SLACK_SECRET",
            },
        };
        const handler = dispatchAgentChannel([{ agent, binding: "AGENT_SUPPORT" }]);

        // Signed with the wrong secret.
        const response = await handler(await slackRequest("WRONG", '{"event":{}}'), { AGENT_SUPPORT: binding, SLACK_SECRET: secret });

        expect(response.status).toBe(401);
        expect(mapped).toBe(false);
        expect(created).toStrictEqual([]);
    });

    it("returns 204 when the (verified) event is declined", async () => {
        const { binding, created } = fakeBinding();
        const agent = { onInbound: { channel: "slack" as const, map: () => null, secret: "SLACK_SECRET" } };
        const handler = dispatchAgentChannel([{ agent, binding: "AGENT_SUPPORT" }]);

        const response = await handler(await slackRequest(secret, '{"event":{}}'), { AGENT_SUPPORT: binding, SLACK_SECRET: secret });

        expect(response.status).toBe(204);
        expect(created).toStrictEqual([]);
    });
});
