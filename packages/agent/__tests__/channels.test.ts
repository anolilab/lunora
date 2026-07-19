/* eslint-disable n/no-unsupported-features/node-builtins -- Web Crypto (crypto.subtle) is a Workers/Node-23+ global; the test runs on Node 24 */
import { describe, expect, it } from "vitest";

import { dispatchAgentChannel, verifyDiscord, verifyGithub, verifySlack } from "../src/channels";

const encoder = new TextEncoder();

const NO_BINDING_PATTERN = /no Workflow binding/u;
const TRANSIENT_FAILURE_PATTERN = /temporarily unavailable/u;

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

/** A fake `AGENT_*` Workflow binding recording `create()` params; rejects a duplicate `id` like CF Workflows. */
const fakeBinding = (): {
    binding: { create: (options?: { id?: string; params?: unknown }) => Promise<{ id: string }>; get: () => Promise<never> };
    created: unknown[];
} => {
    const created: unknown[] = [];
    const ids = new Set<string>();

    return {
        binding: {
            create: async (options) => {
                if (options?.id !== undefined) {
                    if (ids.has(options.id)) {
                        throw new Error("instance already exists");
                    }

                    ids.add(options.id);
                }

                created.push(options?.params);

                return { id: options?.id ?? "wf-1" };
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

const githubRequest = async (secret: string, body: string): Promise<Request> =>
    new Request("https://app/webhooks/agent", {
        body,
        headers: { "x-github-delivery": "abc-123", "x-hub-signature-256": `sha256=${await hmacHex(secret, body)}` },
        method: "POST",
    });

const discordRequest = async (privateKey: CryptoKey, body: string): Promise<Request> => {
    const timestamp = "1700000000";
    const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, encoder.encode(timestamp + body))));

    return new Request("https://app/webhooks/agent", {
        body,
        headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
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

    it("verifies each target against its OWN secret (no cross-tenant trigger)", async () => {
        const one = fakeBinding();
        const two = fakeBinding();
        let mappedOne = false;
        const agentOne = {
            onInbound: {
                channel: "slack" as const,
                map: () => {
                    mappedOne = true;

                    return { input: "one", threadKey: "t1" };
                },
                secret: "SECRET_ONE",
            },
        };
        const agentTwo = {
            onInbound: {
                channel: "slack" as const,
                map: () => {
                    return { input: "two", threadKey: "t2" };
                },
                secret: "SECRET_TWO",
            },
        };
        const handler = dispatchAgentChannel([
            { agent: agentOne, binding: "AGENT_ONE" },
            { agent: agentTwo, binding: "AGENT_TWO" },
        ]);

        // Signed with tenant TWO's secret — only tenant two verifies and claims.
        const response = await handler(await slackRequest("secret-two", '{"event":{}}'), {
            AGENT_ONE: one.binding,
            AGENT_TWO: two.binding,
            SECRET_ONE: "secret-one",
            SECRET_TWO: "secret-two",
        });

        expect(response.status).toBe(200);
        expect(mappedOne).toBe(false); // tenant one's secret never verified → its mapper never ran
        expect(one.created).toStrictEqual([]);
        expect(two.created).toStrictEqual([{ input: "two", threadKey: "t2" }]);
    });

    it("verifies and dispatches a GitHub webhook", async () => {
        const { binding, created } = fakeBinding();
        const agent = {
            onInbound: {
                channel: "github" as const,
                map: () => {
                    return { input: "gh", threadKey: "pr-1" };
                },
                secret: "GH_SECRET",
            },
        };
        const handler = dispatchAgentChannel([{ agent, binding: "AGENT_GH" }]);

        const response = await handler(await githubRequest("gh-secret", '{"action":"opened"}'), { AGENT_GH: binding, GH_SECRET: "gh-secret" });

        expect(response.status).toBe(200);
        expect(created).toStrictEqual([{ input: "gh", threadKey: "pr-1" }]);
    });

    it("answers a verified Discord PING with a PONG and starts no run", async () => {
        const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
        const publicKey = bytesToHex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
        const { binding, created } = fakeBinding();
        const agent = {
            onInbound: {
                channel: "discord" as const,
                map: () => {
                    return { input: "x", threadKey: "t" };
                },
                secret: "DISCORD_KEY",
            },
        };
        const handler = dispatchAgentChannel([{ agent, binding: "AGENT_D" }]);

        const response = await handler(await discordRequest(pair.privateKey, '{"type":1}'), { AGENT_D: binding, DISCORD_KEY: publicKey });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ type: 1 });
        expect(created).toStrictEqual([]);
    });

    it("dedupes a redelivered webhook (same delivery id) to a single run", async () => {
        const { binding, created } = fakeBinding();
        const agent = {
            onInbound: {
                channel: "slack" as const,
                map: () => {
                    return { input: "hi", threadKey: "t" };
                },
                secret: "SLACK_SECRET",
            },
        };
        const handler = dispatchAgentChannel([{ agent, binding: "AGENT_SUPPORT" }]);
        const env = { AGENT_SUPPORT: binding, SLACK_SECRET: secret };
        const body = JSON.stringify({ event: {}, event_id: "Ev123" });

        const first = await handler(await slackRequest(secret, body), env);
        const second = await handler(await slackRequest(secret, body), env);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        // The redelivery's duplicate instance id is rejected → no second run.
        expect(created).toStrictEqual([{ input: "hi", threadKey: "t" }]);
    });

    it("rethrows a non-duplicate create failure so the provider redelivers (not a silent 200)", async () => {
        // A binding whose create() always fails with a transient/service error —
        // NOT a duplicate-instance rejection. The handler must surface it (reject)
        // so the webhook answers non-2xx and the provider retries the delivery.
        const binding = {
            create: async (): Promise<{ id: string }> => {
                throw new Error("workflows service temporarily unavailable");
            },
            get: async (): Promise<never> => {
                throw new Error("unused");
            },
        };
        const agent = {
            onInbound: {
                channel: "slack" as const,
                map: () => {
                    return { input: "hi", threadKey: "t" };
                },
                secret: "SLACK_SECRET",
            },
        };
        const handler = dispatchAgentChannel([{ agent, binding: "AGENT_SUPPORT" }]);
        const env = { AGENT_SUPPORT: binding, SLACK_SECRET: secret };
        const body = JSON.stringify({ event: {}, event_id: "Ev-transient" });

        await expect(handler(await slackRequest(secret, body), env)).rejects.toThrow(TRANSIENT_FAILURE_PATTERN);
    });

    it("does not dedupe deliveries with an empty event id (falls back to a non-idempotent create)", async () => {
        const { binding, created } = fakeBinding();
        const agent = {
            onInbound: {
                channel: "slack" as const,
                map: () => {
                    return { input: "hi", threadKey: "t" };
                },
                secret: "SLACK_SECRET",
            },
        };
        const handler = dispatchAgentChannel([{ agent, binding: "AGENT_SUPPORT" }]);
        const env = { AGENT_SUPPORT: binding, SLACK_SECRET: secret };
        // An empty (but present) event_id sanitizes to no dedup key — each delivery
        // must start its own run rather than collapsing to a single "slack-" id.
        const body = JSON.stringify({ event: {}, event_id: "" });

        const first = await handler(await slackRequest(secret, body), env);
        const second = await handler(await slackRequest(secret, body), env);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(created).toStrictEqual([
            { input: "hi", threadKey: "t" },
            { input: "hi", threadKey: "t" },
        ]);
    });

    it("returns 400 for a request with no recognized signature headers", async () => {
        const { binding } = fakeBinding();
        const agent = {
            onInbound: {
                channel: "slack" as const,
                map: () => {
                    return { input: "x", threadKey: "t" };
                },
                secret: "SLACK_SECRET",
            },
        };
        const handler = dispatchAgentChannel([{ agent, binding: "AGENT_SUPPORT" }]);

        const response = await handler(new Request("https://app/webhooks/agent", { body: "{}", method: "POST" }), {
            AGENT_SUPPORT: binding,
            SLACK_SECRET: secret,
        });

        expect(response.status).toBe(400);
    });

    it("throws when a claimed event has no Workflow binding on env", async () => {
        const agent = {
            onInbound: {
                channel: "slack" as const,
                map: () => {
                    return { input: "x", threadKey: "t" };
                },
                secret: "SLACK_SECRET",
            },
        };
        const handler = dispatchAgentChannel([{ agent, binding: "AGENT_MISSING" }]);

        // Verified + claimed, but AGENT_MISSING is absent from env.
        await expect(handler(await slackRequest(secret, '{"event":{}}'), { SLACK_SECRET: secret })).rejects.toThrow(NO_BINDING_PATTERN);
    });
});
