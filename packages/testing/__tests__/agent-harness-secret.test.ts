import { agentComponent, defineAgent, defineAgentTool, requestSecretTool, withSecret } from "@lunora/agent";
import { redactArgs } from "@lunora/observability";
import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { agentHarness, finalTurn, toolCallTurn } from "../src/agent-harness";
import { createFakeSecretValues } from "../src/fake-secret-values";

const SECRET = "sk_live_correct-horse-battery-staple";
const TTL = 15 * 60 * 1000;
const TOOL_FAILED = /failed and will not be retried\. the secret is no longer available/u;

/** A billing agent: asks for a key, then charges with it through `withSecret`. */
const billingAgent = (used: string[]) =>
    defineAgent({
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        tools: {
            charge: defineAgentTool({
                description: "Charge the card with the stored key.",
                execute: (input, context) =>
                    withSecret(context, (input as { secretRef: string }).secretRef, (secret) => {
                        used.push(secret);

                        return "charged";
                    }),
                inputSchema: jsonSchema({ properties: { secretRef: { type: "string" } }, required: ["secretRef"], type: "object" }) as never,
            }),
            requestKey: requestSecretTool({ description: "Ask the user for the payment API key." }),
        },
    });

describe("agentHarness — requestSecretTool", () => {
    it("pauses for the human, consumes the value once, and keeps it out of every record the harness keeps", async () => {
        expect.assertions(7);

        const used: string[] = [];
        const secrets = createFakeSecretValues();
        const ref = await secrets.put(SECRET, { scope: "thread-1", ttlMs: TTL });
        const harness = agentHarness(billingAgent(used), {
            script: [toolCallTurn("call_1", "requestKey", { label: "API key" }), toolCallTurn("call_2", "charge", { secretRef: ref }), finalTurn("done")],
            secrets,
        });

        const run = harness.run({ input: "charge my card", threadKey: "thread-1" });

        await harness.awaitWait("secret:call_1");
        harness.deliver("secret:call_1", { ref });

        await expect(run).resolves.toStrictEqual({ stopped: "final", text: "done", turns: 3 });
        expect(used).toStrictEqual([SECRET]);
        expect(harness.messages("thread-1").find((message) => message.toolCallId === "call_1")?.content).toBe(JSON.stringify({ secretRef: ref }));
        expect(harness.journalEntries()).toContainEqual(expect.objectContaining({ kind: "wait", name: "secret:call_1", payload: { ref } }));
        expect(harness.dispatches.filter((dispatch) => dispatch.path === "agents:agentTakeSecret").map((dispatch) => dispatch.args)).toStrictEqual([
            { claimant: "tool:charge:call_2", ref, threadKey: "thread-1" },
        ]);
        expect(JSON.stringify([harness.messages("thread-1"), harness.dispatches, harness.journalEntries()])).not.toContain(SECRET);
        await expect(secrets.take(ref, { claimant: "tool:charge:call_9", scope: "thread-1" })).resolves.toBeUndefined();
    });

    it("resolves a declined request as a deterministic tool result and takes nothing", async () => {
        expect.assertions(3);

        const used: string[] = [];
        const harness = agentHarness(billingAgent(used), {
            script: [toolCallTurn("call_1", "requestKey", { label: "API key" }), finalTurn("no key, stopping")],
        });

        const run = harness.run({ input: "charge my card", threadKey: "thread-1" });

        await harness.awaitWait("secret:call_1");
        harness.deliver("secret:call_1", { declined: true });

        await expect(run).resolves.toMatchObject({ stopped: "final" });
        expect(used).toStrictEqual([]);
        expect(harness.dispatches.some((dispatch) => dispatch.path === "agents:agentTakeSecret")).toBe(false);
    });

    it("fails a consuming call deterministically, with one take, once the value has expired", async () => {
        expect.assertions(3);

        const used: string[] = [];
        const secrets = createFakeSecretValues();
        const ref = await secrets.put(SECRET, { scope: "thread-1", ttlMs: TTL });
        const harness = agentHarness(billingAgent(used), {
            script: [toolCallTurn("call_1", "requestKey", {}), toolCallTurn("call_2", "charge", { secretRef: ref }), finalTurn("could not charge")],
            secrets,
        });

        const run = harness.run({ input: "charge my card", threadKey: "thread-1" });

        await harness.awaitWait("secret:call_1");
        secrets.advanceClock(TTL);
        harness.deliver("secret:call_1", { ref });

        await expect(run).resolves.toMatchObject({ stopped: "final", text: "could not charge" });
        expect(harness.dispatches.filter((dispatch) => dispatch.path === "agents:agentTakeSecret")).toHaveLength(1);
        expect(harness.messages("thread-1").find((message) => message.toolCallId === "call_2")?.content).toMatch(TOOL_FAILED);
    });

    it("treats an elapsed wait as no value supplied", async () => {
        expect.assertions(2);

        const harness = agentHarness(billingAgent([]), {
            script: [toolCallTurn("call_1", "requestKey", {}), finalTurn("no key")],
        });

        const run = harness.run({ input: "charge my card", threadKey: "thread-1" });

        await harness.awaitWait("secret:call_1");
        harness.expire("secret:call_1");

        await expect(run).resolves.toMatchObject({ stopped: "final" });
        expect(harness.messages("thread-1").find((message) => message.toolCallId === "call_1")?.content).toContain("not supplied before the timeout");
    });
});

describe("request-log redaction of the supply mutation's arguments", () => {
    it("masks the supplied value under the argument name the mutation declares", () => {
        expect.assertions(3);

        // The redaction masks by argument NAME, so pin the name the mutation really takes.
        const { args } = agentComponent().functions.agentSupplySecret as unknown as { args: Record<string, unknown> };

        expect(Object.keys(args)).toContain("secret");

        const logged = redactArgs({ secret: SECRET, threadKey: "thread-1", toolCallId: "call_1" });

        expect(JSON.stringify(logged)).not.toContain(SECRET);
        expect(logged).toMatchObject({ threadKey: "thread-1", toolCallId: "call_1" });
    });
});
