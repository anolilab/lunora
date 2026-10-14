/* eslint-disable n/no-unsupported-features/node-builtins -- Web Crypto (crypto.subtle) is a Workers/Node-23+ global; the test runs on Node 24 */
import { describe, expect, it } from "vitest";

import { dispatchAgentChannel, verifyDiscord, verifyGithub, verifySlack } from "../src/channels";

/** The Worker ctx the handler takes; these tests bind agents on env, so it carries no exports. */
const NO_CONTEXT = {};

const encoder = new TextEncoder();

const NO_BINDING_PATTERN = /on ctx.exports or env/u;
const TRANSIENT_FAILURE_PATTERN = /temporarily unavailable/u;
const BRANCH_MARKER_PATTERN = /reserved workflow branch-marker key/u;
const HASHED_SLACK_ID_PATTERN = /^slack-[0-9a-f]{16}$/u;

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

        const now = 1_700_000_010; // 10s later — fresh

        await expect(verifyDiscord({ body, now, publicKey, signature, timestamp })).resolves.toBe(true);
        // Tampered body.
        await expect(verifyDiscord({ body: '{"type":2}', now, publicKey, signature, timestamp })).resolves.toBe(false);

        // A different public key.
        const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
        const otherKey = bytesToHex(new Uint8Array(await crypto.subtle.exportKey("raw", other.publicKey)));

        await expect(verifyDiscord({ body, now, publicKey: otherKey, signature, timestamp })).resolves.toBe(false);
    });

    // The timestamp is inside the signed message, so a captured request verifies
    // forever unless its age is bounded — the same 300s window Slack gets.
    it.each([
        ["exactly at the window edge (300s old)", 1_700_000_300, true],
        ["exactly at the window edge (300s ahead)", 1_699_999_700, true],
        ["stale (301s old)", 1_700_000_301, false],
        ["future-skewed (301s ahead)", 1_699_999_699, false],
        ["a day old", 1_700_086_400, false],
    ])("verifies a validly signed timestamp %s (now=%i) as %s", async (_label, now, expected) => {
        const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
        const publicKey = bytesToHex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
        const timestamp = "1700000000";
        const body = '{"type":2}';
        const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, encoder.encode(timestamp + body))));

        await expect(verifyDiscord({ body, now, publicKey, signature, timestamp })).resolves.toBe(expected);
    });

    it("rejects a validly signed non-numeric timestamp", async () => {
        const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
        const publicKey = bytesToHex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
        const timestamp = "soon";
        const body = '{"type":2}';
        const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, encoder.encode(timestamp + body))));

        await expect(verifyDiscord({ body, publicKey, signature, timestamp })).resolves.toBe(false);
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

const discordRequest = async (privateKey: CryptoKey, body: string, timestamp = String(Math.floor(Date.now() / 1000))): Promise<Request> => {
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
        const handler = dispatchAgentChannel([{ agent, className: "SupportAgentWorkflow" }]);

        const response = await handler(await slackRequest(secret, '{"event":{}}'), { SupportAgentWorkflow: binding, SLACK_SECRET: secret }, NO_CONTEXT);

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
        const handler = dispatchAgentChannel([{ agent, className: "SupportAgentWorkflow" }]);

        // Signed with the wrong secret.
        const response = await handler(await slackRequest("WRONG", '{"event":{}}'), { SupportAgentWorkflow: binding, SLACK_SECRET: secret }, NO_CONTEXT);

        expect(response.status).toBe(401);
        expect(mapped).toBe(false);
        expect(created).toStrictEqual([]);
    });

    it("returns 204 when the (verified) event is declined", async () => {
        const { binding, created } = fakeBinding();
        const agent = { onInbound: { channel: "slack" as const, map: () => null, secret: "SLACK_SECRET" } };
        const handler = dispatchAgentChannel([{ agent, className: "SupportAgentWorkflow" }]);

        const response = await handler(await slackRequest(secret, '{"event":{}}'), { SupportAgentWorkflow: binding, SLACK_SECRET: secret }, NO_CONTEXT);

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
            { agent: agentOne, className: "AGENT_ONE" },
            { agent: agentTwo, className: "AGENT_TWO" },
        ]);

        // Signed with tenant TWO's secret — only tenant two verifies and claims.
        const response = await handler(
            await slackRequest("secret-two", '{"event":{}}'),
            {
                AGENT_ONE: one.binding,
                AGENT_TWO: two.binding,
                SECRET_ONE: "secret-one",
                SECRET_TWO: "secret-two",
            },
            NO_CONTEXT,
        );

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
        const handler = dispatchAgentChannel([{ agent, className: "AGENT_GH" }]);

        const response = await handler(await githubRequest("gh-secret", '{"action":"opened"}'), { AGENT_GH: binding, GH_SECRET: "gh-secret" }, NO_CONTEXT);

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
        const handler = dispatchAgentChannel([{ agent, className: "AGENT_D" }]);

        const response = await handler(await discordRequest(pair.privateKey, '{"type":1}'), { AGENT_D: binding, DISCORD_KEY: publicKey }, NO_CONTEXT);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ type: 1 });
        expect(created).toStrictEqual([]);
    });

    it.each([
        ["fresh", 0, 200, 1],
        ["stale (10 minutes old)", -600, 401, 0],
        ["future-skewed beyond the window (10 minutes ahead)", 600, 401, 0],
    ])("dispatches a validly signed Discord interaction only when its timestamp is fresh: %s", async (_label, skewSeconds, status, runs) => {
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
        const handler = dispatchAgentChannel([{ agent, className: "AGENT_D" }]);
        const timestamp = String(Math.floor(Date.now() / 1000) + skewSeconds);

        const response = await handler(
            await discordRequest(pair.privateKey, '{"id":"i-1","type":2}', timestamp),
            { AGENT_D: binding, DISCORD_KEY: publicKey },
            NO_CONTEXT,
        );

        expect(response.status).toBe(status);
        expect(created).toHaveLength(runs);
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
        const handler = dispatchAgentChannel([{ agent, className: "SupportAgentWorkflow" }]);
        const env = { SupportAgentWorkflow: binding, SLACK_SECRET: secret };
        const body = JSON.stringify({ event: {}, event_id: "Ev123" });

        const first = await handler(await slackRequest(secret, body), env, NO_CONTEXT);
        const second = await handler(await slackRequest(secret, body), env, NO_CONTEXT);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        // The redelivery's duplicate instance id is rejected → no second run.
        expect(created).toStrictEqual([{ input: "hi", threadKey: "t" }]);
    });

    it("keys long ids by hash: same first 60 chars but different tails stay distinct, identical ids dedupe", async () => {
        const receivedIds: (string | undefined)[] = [];
        const binding = {
            create: async (options?: { id?: string; params?: unknown }): Promise<{ id: string }> => {
                receivedIds.push(options?.id);

                return { id: options?.id ?? "wf-1" };
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
        const handler = dispatchAgentChannel([{ agent, className: "SupportAgentWorkflow" }]);
        const env = { SupportAgentWorkflow: binding, SLACK_SECRET: secret };
        // 70-char ids sharing their first 60 chars — the old sanitize-then-truncate
        // scheme collapsed these to one key, silently swallowing the second event.
        const shared = "E".repeat(60);
        const bodyA = JSON.stringify({ event: {}, event_id: `${shared}AAAAAAAAAA` });
        const bodyB = JSON.stringify({ event: {}, event_id: `${shared}BBBBBBBBBB` });

        await handler(await slackRequest(secret, bodyA), env, NO_CONTEXT);
        await handler(await slackRequest(secret, bodyB), env, NO_CONTEXT);
        await handler(await slackRequest(secret, bodyA), env, NO_CONTEXT);

        expect(receivedIds).toHaveLength(3);
        // `slack-` + 16 hex chars, distinct across distinct ids, stable across redeliveries.
        expect(receivedIds[0]).toMatch(HASHED_SLACK_ID_PATTERN);
        expect(receivedIds[1]).toMatch(HASHED_SLACK_ID_PATTERN);
        expect(receivedIds[0]).not.toBe(receivedIds[1]);
        expect(receivedIds[2]).toBe(receivedIds[0]);
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
        const handler = dispatchAgentChannel([{ agent, className: "SupportAgentWorkflow" }]);
        const env = { SupportAgentWorkflow: binding, SLACK_SECRET: secret };
        const body = JSON.stringify({ event: {}, event_id: "Ev-transient" });

        await expect(handler(await slackRequest(secret, body), env, NO_CONTEXT)).rejects.toThrow(TRANSIENT_FAILURE_PATTERN);
    });

    it("keys an empty event id on the body: distinct events both run, a replay does not", async () => {
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
        const handler = dispatchAgentChannel([{ agent, className: "SupportAgentWorkflow" }]);
        const env = { SupportAgentWorkflow: binding, SLACK_SECRET: secret };
        // An empty (but present) event_id must not collapse every such event to
        // one "slack-" id; the body hash keys it instead.
        const bodyA = JSON.stringify({ event: { ts: "1" }, event_id: "" });
        const bodyB = JSON.stringify({ event: { ts: "2" }, event_id: "" });

        const responses = [
            await handler(await slackRequest(secret, bodyA), env, NO_CONTEXT),
            await handler(await slackRequest(secret, bodyB), env, NO_CONTEXT),
            await handler(await slackRequest(secret, bodyA), env, NO_CONTEXT),
        ];

        expect(responses.map((response) => response.status)).toStrictEqual([200, 200, 200]);
        expect(created).toHaveLength(2);
    });

    it("keys a GitHub run on the signed body, so a replay under a new or missing delivery header starts no run", async () => {
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
        const handler = dispatchAgentChannel([{ agent, className: "AGENT_GH" }]);
        const env = { AGENT_GH: binding, GH_SECRET: "gh-secret" };
        const body = '{"action":"opened","number":1}';
        const signature = `sha256=${await hmacHex("gh-secret", body)}`;
        // The delivery header is NOT covered by GitHub's HMAC — any value (or none) verifies.
        const send = async (delivery?: string): Promise<Response> =>
            handler(
                new Request("https://app/webhooks/agent", {
                    body,
                    headers:
                        delivery === undefined ? { "x-hub-signature-256": signature } : { "x-github-delivery": delivery, "x-hub-signature-256": signature },
                    method: "POST",
                }),
                env,
                NO_CONTEXT,
            );

        // Honest redelivery, replay under a fresh header, replay with the header dropped.
        const responses = [await send("d-1"), await send("d-1"), await send("d-2"), await send()];

        expect(responses.map((response) => response.status)).toStrictEqual([200, 200, 200, 200]);
        expect(created).toStrictEqual([{ input: "gh", threadKey: "pr-1" }]);
    });

    it("starts one run per distinct GitHub event", async () => {
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
        const handler = dispatchAgentChannel([{ agent, className: "AGENT_GH" }]);
        const env = { AGENT_GH: binding, GH_SECRET: "gh-secret" };

        await handler(await githubRequest("gh-secret", '{"action":"opened","number":1}'), env, NO_CONTEXT);
        await handler(await githubRequest("gh-secret", '{"action":"opened","number":2}'), env, NO_CONTEXT);

        expect(created).toHaveLength(2);
    });

    it("dedupes a replayed Slack payload that carries no event_id", async () => {
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
        const handler = dispatchAgentChannel([{ agent, className: "SupportAgentWorkflow" }]);
        const env = { SupportAgentWorkflow: binding, SLACK_SECRET: secret };
        // Interactive payloads and slash commands carry no event_id.
        const body = JSON.stringify({ trigger_id: "t-1", type: "block_actions" });

        await handler(await slackRequest(secret, body), env, NO_CONTEXT);
        await handler(await slackRequest(secret, body), env, NO_CONTEXT);
        await handler(await slackRequest(secret, JSON.stringify({ trigger_id: "t-2", type: "block_actions" })), env, NO_CONTEXT);

        expect(created).toHaveLength(2);
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
        const handler = dispatchAgentChannel([{ agent, className: "SupportAgentWorkflow" }]);

        const response = await handler(
            new Request("https://app/webhooks/agent", { body: "{}", method: "POST" }),
            {
                SupportAgentWorkflow: binding,
                SLACK_SECRET: secret,
            },
            NO_CONTEXT,
        );

        expect(response.status).toBe(400);
    });

    it("throws when a claimed event has no agent on ctx.exports or env", async () => {
        const agent = {
            onInbound: {
                channel: "slack" as const,
                map: () => {
                    return { input: "x", threadKey: "t" };
                },
                secret: "SLACK_SECRET",
            },
        };
        const handler = dispatchAgentChannel([{ agent, className: "AGENT_MISSING" }]);

        // Verified + claimed, but AGENT_MISSING is absent from env.
        await expect(handler(await slackRequest(secret, '{"event":{}}'), { SLACK_SECRET: secret }, NO_CONTEXT)).rejects.toThrow(NO_BINDING_PATTERN);
    });

    it("rejects (throws, does not ack) a claimed run whose mapper injects the reserved branch-marker key", async () => {
        const { binding, created } = fakeBinding();
        const agent = {
            onInbound: {
                channel: "slack" as const,
                map: () => {
                    return {
                        input: "x",
                        threadKey: "t",
                        __lunoraBranch: { eventType: "lunora:branch:x", index: 0, parentBinding: "WORKFLOW_X", parentId: "p" },
                    };
                },
                secret: "SLACK_SECRET",
            },
        };
        const handler = dispatchAgentChannel([{ agent, className: "SupportAgentWorkflow" }]);

        // Verified + claimed, but the mapper's run carries a forged marker — must
        // throw (surfacing as non-2xx so the provider redelivers), never be acked
        // as handled, and never reach `create()`.
        await expect(handler(await slackRequest(secret, '{"event":{}}'), { SupportAgentWorkflow: binding, SLACK_SECRET: secret }, NO_CONTEXT)).rejects.toThrow(
            BRANCH_MARKER_PATTERN,
        );
        expect(created).toStrictEqual([]);
    });
});
