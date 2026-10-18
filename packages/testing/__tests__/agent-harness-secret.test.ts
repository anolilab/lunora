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
            requestKey: requestSecretTool({ consumer: "charge", description: "Ask the user for the payment API key." }),
        },
    });

describe("agentHarness — requestSecretTool", () => {
    it("pauses for the human, consumes the value once, and keeps it out of every record the harness keeps", async () => {
        expect.assertions(6);

        const used: string[] = [];
        const harness = agentHarness(billingAgent(used), {
            script: [toolCallTurn("call_1", "requestKey", { label: "API key" }), toolCallTurn("call_2", "charge", { secretRef: "call_1" }), finalTurn("done")],
        });

        const run = harness.run({ input: "charge my card", threadKey: "thread-1" }, { instanceId: "run-1" });

        await harness.awaitWait("run-1", "secret:call_1");
        await harness.supply("thread-1", "call_1", SECRET);

        await expect(run).resolves.toStrictEqual({ stopped: "final", text: "done", turns: 3 });
        expect(used).toStrictEqual([SECRET]);
        expect(harness.messages("thread-1").find((message) => message.toolCallId === "call_1")?.content).toBe(JSON.stringify({ secretRef: "call_1" }));
        expect(harness.journalEntries()).toContainEqual(expect.objectContaining({ kind: "wait", name: "secret:call_1", payload: {} }));
        expect(harness.dispatches.filter((dispatch) => dispatch.path === "agents:agentTakeSecret").map((dispatch) => dispatch.args)).toStrictEqual([
            { claimant: "tool:charge:call_2", consumerCallId: "call_2", threadKey: "thread-1", toolCallId: "call_1" },
        ]);
        expect(JSON.stringify([harness.messages("thread-1"), harness.dispatches, harness.journalEntries()])).not.toContain(SECRET);
    });

    it("resolves a declined request as a deterministic tool result and takes nothing", async () => {
        expect.assertions(3);

        const used: string[] = [];
        const harness = agentHarness(billingAgent(used), {
            script: [toolCallTurn("call_1", "requestKey", { label: "API key" }), finalTurn("no key, stopping")],
        });

        const run = harness.run({ input: "charge my card", threadKey: "thread-1" }, { instanceId: "run-1" });

        await harness.awaitWait("run-1", "secret:call_1");
        harness.decline("thread-1", "call_1");

        await expect(run).resolves.toMatchObject({ stopped: "final" });
        expect(used).toStrictEqual([]);
        expect(harness.dispatches.some((dispatch) => dispatch.path === "agents:agentTakeSecret")).toBe(false);
    });

    it("fails a consuming call deterministically, with one take, once the value has expired", async () => {
        expect.assertions(3);

        const used: string[] = [];
        const secrets = createFakeSecretValues();
        const harness = agentHarness(billingAgent(used), {
            script: [toolCallTurn("call_1", "requestKey", {}), toolCallTurn("call_2", "charge", { secretRef: "call_1" }), finalTurn("could not charge")],
            secrets,
        });

        const run = harness.run({ input: "charge my card", threadKey: "thread-1" }, { instanceId: "run-1" });

        await harness.awaitWait("run-1", "secret:call_1");
        await harness.supply("thread-1", "call_1", SECRET);
        secrets.advanceClock(TTL);

        await expect(run).resolves.toMatchObject({ stopped: "final", text: "could not charge" });
        expect(harness.dispatches.filter((dispatch) => dispatch.path === "agents:agentTakeSecret")).toHaveLength(1);
        expect(harness.messages("thread-1").find((message) => message.toolCallId === "call_2")?.content).toMatch(TOOL_FAILED);
    });

    it("treats an elapsed wait as no value supplied", async () => {
        expect.assertions(2);

        const harness = agentHarness(billingAgent([]), {
            script: [toolCallTurn("call_1", "requestKey", {}), finalTurn("no key")],
        });

        const run = harness.run({ input: "charge my card", threadKey: "thread-1" }, { instanceId: "run-1" });

        await harness.awaitWait("run-1", "secret:call_1");
        harness.expire("run-1", "secret:call_1");

        await expect(run).resolves.toMatchObject({ stopped: "final" });
        expect(harness.messages("thread-1").find((message) => message.toolCallId === "call_1")?.content).toContain("not supplied before the timeout");
    });
});

describe("agentHarness — journal order", () => {
    it("lists a step recorded after a delivered wait after that wait, in write order", async () => {
        expect.assertions(2);

        const harness = agentHarness(billingAgent([]), {
            script: [toolCallTurn("call_1", "requestKey", {}), toolCallTurn("call_2", "charge", { secretRef: "call_1" }), finalTurn("done")],
        });

        const run = harness.run({ input: "charge my card", threadKey: "thread-1" }, { instanceId: "run-1" });

        await harness.awaitWait("run-1", "secret:call_1");
        await harness.supply("thread-1", "call_1", SECRET);

        await expect(run).resolves.toMatchObject({ stopped: "final" });

        // The write order: the request step, the wait it parks on, then the steps that run after the delivery.
        expect(harness.journalEntries().map((entry) => `${(entry as { kind: string }).kind}:${(entry as { name: string }).name}`)).toStrictEqual([
            "step:llm:turn:0",
            "step:secret:request:call_1",
            "wait:secret:call_1",
            "step:secret:settle:call_1",
            "step:llm:turn:1",
            "step:secret:consume:tool:charge:call_2:call_1",
            "step:secret:discard:tool:charge:call_2:call_1",
            "step:tool:charge:call_2",
            "step:llm:turn:2",
        ]);
    });
});

describe("agentHarness — concurrent runs", () => {
    it("keeps two runs that wait on the same event name apart", async () => {
        expect.assertions(3);

        const harness = agentHarness(billingAgent([]), {});
        const script = [toolCallTurn("call_1", "requestKey", {}), finalTurn("no key")];

        const first = harness.run({ input: "charge my card", threadKey: "thread-a" }, { instanceId: "run-a", script });
        const second = harness.run({ input: "charge my card", threadKey: "thread-b" }, { instanceId: "run-b", script });

        await harness.awaitWait("run-a", "secret:call_1");
        await harness.awaitWait("run-b", "secret:call_1");

        // Declining run-a's request wakes run-a only; run-b keeps waiting until it is expired.
        harness.decline("thread-a", "call_1");

        await expect(first).resolves.toMatchObject({ stopped: "final" });

        harness.expire("run-b", "secret:call_1");

        await expect(second).resolves.toMatchObject({ stopped: "final" });
        expect(harness.messages("thread-b").find((message) => message.toolCallId === "call_1")?.content).toContain("not supplied before the timeout");
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
