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
            script: [
                toolCallTurn("call_1", "requestKey", { label: "API key" }),
                toolCallTurn("call_2", "charge", { secretRef: "0:call_1" }),
                finalTurn("done"),
            ],
        });

        const run = harness.run({ input: "charge my card", owner: "user-1", threadKey: "thread-1" }, { instanceId: "run-1" });

        await harness.awaitWait("run-1", "secret:0:call_1");
        await harness.supply("thread-1", "call_1", SECRET);

        await expect(run).resolves.toStrictEqual({ stopped: "final", text: "done", turns: 3 });
        expect(used).toStrictEqual([SECRET]);
        expect(harness.messages("thread-1").find((message) => message.toolCallId === "call_1")?.content).toBe(JSON.stringify({ secretRef: "0:call_1" }));
        expect(harness.journalEntries()).toContainEqual(expect.objectContaining({ kind: "wait", name: "secret:0:call_1", payload: {} }));
        expect(harness.dispatches.filter((dispatch) => dispatch.path === "agents:agentTakeSecret").map((dispatch) => dispatch.args)).toStrictEqual([
            { claimant: "tool:charge:call_2", consumerCallId: "call_2", instanceId: "run-1", threadKey: "thread-1", toolCallId: "0:call_1" },
        ]);
        expect(JSON.stringify([harness.messages("thread-1"), harness.dispatches, harness.journalEntries()])).not.toContain(SECRET);
    });

    it("resumes a finished instance from its journal without waiting for the secret again", async () => {
        expect.assertions(3);

        const used: string[] = [];
        const harness = agentHarness(billingAgent(used), {
            script: [
                toolCallTurn("call_1", "requestKey", { label: "API key" }),
                toolCallTurn("call_2", "charge", { secretRef: "0:call_1" }),
                finalTurn("done"),
            ],
        });
        const input = { input: "charge my card", owner: "user-1", threadKey: "thread-1" };

        const first = harness.run(input, { instanceId: "run-1" });

        await harness.awaitWait("run-1", "secret:0:call_1");
        await harness.supply("thread-1", "call_1", SECRET);
        await first;

        // The same instance again: every step, the wait included, is served from the journal.
        await expect(harness.run(input, { instanceId: "run-1" })).resolves.toStrictEqual({ stopped: "final", text: "done", turns: 3 });
        expect(used).toStrictEqual([SECRET]);
        expect(harness.dispatches.filter((dispatch) => dispatch.path === "agents:agentTakeSecret")).toHaveLength(1);
    });

    it("resolves a declined request as a deterministic tool result and takes nothing", async () => {
        expect.assertions(3);

        const used: string[] = [];
        const harness = agentHarness(billingAgent(used), {
            script: [toolCallTurn("call_1", "requestKey", { label: "API key" }), finalTurn("no key, stopping")],
        });

        const run = harness.run({ input: "charge my card", owner: "user-1", threadKey: "thread-1" }, { instanceId: "run-1" });

        await harness.awaitWait("run-1", "secret:0:call_1");
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
            script: [
                toolCallTurn("call_1", "requestKey", { label: "API key" }),
                toolCallTurn("call_2", "charge", { secretRef: "0:call_1" }),
                finalTurn("could not charge"),
            ],
            secrets,
        });

        const run = harness.run({ input: "charge my card", owner: "user-1", threadKey: "thread-1" }, { instanceId: "run-1" });

        await harness.awaitWait("run-1", "secret:0:call_1");
        await harness.supply("thread-1", "call_1", SECRET);
        secrets.advanceClock(TTL);

        await expect(run).resolves.toMatchObject({ stopped: "final", text: "could not charge" });
        expect(harness.dispatches.filter((dispatch) => dispatch.path === "agents:agentTakeSecret")).toHaveLength(1);
        expect(harness.messages("thread-1").find((message) => message.toolCallId === "call_2")?.content).toMatch(TOOL_FAILED);
    });

    it("refuses a supply made after its wait expired, before the run settles", async () => {
        expect.assertions(2);

        const harness = agentHarness(billingAgent([]), {
            script: [toolCallTurn("call_1", "requestKey", { label: "API key" }), finalTurn("no key")],
        });

        const run = harness.run({ input: "charge my card", owner: "user-1", threadKey: "thread-1" }, { instanceId: "run-1" });

        await harness.awaitWait("run-1", "secret:0:call_1");
        harness.expire("run-1", "secret:0:call_1");

        await expect(harness.supply("thread-1", "call_1", SECRET)).rejects.toThrow(/no pending secret request/u);
        await expect(run).resolves.toMatchObject({ stopped: "final" });
    });

    it("treats an elapsed wait as no value supplied", async () => {
        expect.assertions(2);

        const harness = agentHarness(billingAgent([]), {
            script: [toolCallTurn("call_1", "requestKey", { label: "API key" }), finalTurn("no key")],
        });

        const run = harness.run({ input: "charge my card", owner: "user-1", threadKey: "thread-1" }, { instanceId: "run-1" });

        await harness.awaitWait("run-1", "secret:0:call_1");
        harness.expire("run-1", "secret:0:call_1");

        await expect(run).resolves.toMatchObject({ stopped: "final" });
        expect(harness.messages("thread-1").find((message) => message.toolCallId === "call_1")?.content).toContain("not supplied before the timeout");
    });
});

describe("agentHarness — journal order", () => {
    it("lists a step recorded after a delivered wait after that wait, in write order", async () => {
        expect.assertions(2);

        const harness = agentHarness(billingAgent([]), {
            script: [
                toolCallTurn("call_1", "requestKey", { label: "API key" }),
                toolCallTurn("call_2", "charge", { secretRef: "0:call_1" }),
                finalTurn("done"),
            ],
        });

        const run = harness.run({ input: "charge my card", owner: "user-1", threadKey: "thread-1" }, { instanceId: "run-1" });

        await harness.awaitWait("run-1", "secret:0:call_1");
        await harness.supply("thread-1", "call_1", SECRET);

        await expect(run).resolves.toMatchObject({ stopped: "final" });

        // The write order: the request step, the wait it parks on, then the steps that run after the delivery.
        expect(harness.journalEntries().map((entry) => `${(entry as { kind: string }).kind}:${(entry as { name: string }).name}`)).toStrictEqual([
            "step:llm:turn:0",
            "step:secret:request:0:call_1",
            "step:secret:await:0:call_1",
            "wait:secret:0:call_1",
            "step:secret:settle:0:call_1",
            "step:llm:turn:1",
            "step:secret:consume:tool:charge:call_2:0:call_1",
            "step:secret:discard:tool:charge:call_2:0:call_1",
            "step:tool:charge:call_2",
            "step:llm:turn:2",
        ]);
    });
});

describe("agentHarness — concurrent runs", () => {
    it("keeps two runs that wait on the same event name apart", async () => {
        expect.assertions(3);

        const harness = agentHarness(billingAgent([]), {});
        const script = [toolCallTurn("call_1", "requestKey", { label: "API key" }), finalTurn("no key")];

        const first = harness.run({ input: "charge my card", owner: "user-1", threadKey: "thread-a" }, { instanceId: "run-a", script });
        const second = harness.run({ input: "charge my card", owner: "user-1", threadKey: "thread-b" }, { instanceId: "run-b", script });

        await harness.awaitWait("run-a", "secret:0:call_1");
        await harness.awaitWait("run-b", "secret:0:call_1");

        // Declining run-a's request wakes run-a only; run-b keeps waiting until it is expired.
        harness.decline("thread-a", "call_1");

        await expect(first).resolves.toMatchObject({ stopped: "final" });

        harness.expire("run-b", "secret:0:call_1");

        await expect(second).resolves.toMatchObject({ stopped: "final" });
        expect(harness.messages("thread-b").find((message) => message.toolCallId === "call_1")?.content).toContain("not supplied before the timeout");
    });

    it("answers the request on its own thread, even when another thread's key extends it", async () => {
        expect.assertions(3);

        const harness = agentHarness(billingAgent([]), {});
        const script = [toolCallTurn("call_1", "requestKey", { label: "API key" }), finalTurn("no key")];

        const outer = harness.run({ input: "charge my card", owner: "user-1", threadKey: "team" }, { instanceId: "run-team", script });
        const inner = harness.run({ input: "charge my card", owner: "user-1", threadKey: "team:other" }, { instanceId: "run-other", script });

        await harness.awaitWait("run-team", "secret:0:call_1");
        await harness.awaitWait("run-other", "secret:0:call_1");

        // "team" has exactly one pending request; the prefix "team:" must not also match "team:other"'s.
        harness.decline("team", "call_1");

        await expect(outer).resolves.toMatchObject({ stopped: "final" });
        expect(harness.messages("team").find((message) => message.toolCallId === "call_1")?.content).toContain("was not run");

        harness.expire("run-other", "secret:0:call_1");

        await expect(inner).resolves.toMatchObject({ stopped: "final" });
    });

    it("does not let a stale run expire a request that a newer run reopened on the same slot", async () => {
        expect.assertions(4);

        const used: string[] = [];
        const harness = agentHarness(billingAgent(used), {});
        const stale = [toolCallTurn("call_1", "requestKey", { label: "API key" }), finalTurn("stale")];
        const owner = [
            toolCallTurn("call_1", "requestKey", { label: "API key" }),
            toolCallTurn("call_2", "charge", { secretRef: "0:call_1" }),
            finalTurn("charged"),
        ];

        const first = harness.run({ input: "charge my card", owner: "user-1", threadKey: "thread-1" }, { instanceId: "run-1", script: stale });

        await harness.awaitWait("run-1", "secret:0:call_1");

        // run-2 reopens the slot: run-1's row is retired and run-2 owns the pending request.
        const second = harness.run({ input: "charge my card", owner: "user-1", threadKey: "thread-1" }, { instanceId: "run-2", script: owner });

        await harness.awaitWait("run-2", "secret:0:call_1");

        // run-1's wait lapses now, so its settle runs against run-2's pending row.
        harness.expire("run-1", "secret:0:call_1");

        await expect(first).resolves.toMatchObject({ stopped: "final", text: "stale" });

        await harness.supply("thread-1", "call_1", SECRET);

        await expect(second).resolves.toStrictEqual({ stopped: "final", text: "charged", turns: 3 });
        expect(used).toStrictEqual([SECRET]);
        expect(
            harness.dispatches.filter((dispatch) => dispatch.path === "agents:agentTakeSecret").map((dispatch) => dispatch.args?.["instanceId"]),
        ).toStrictEqual(["run-2"]);
    });

    it("does not let a stale run take or discard a value that a newer run was supplied under the same slot", async () => {
        expect.assertions(4);

        const used: string[] = [];
        const harness = agentHarness(billingAgent(used), {});
        const stale = [
            toolCallTurn("call_1", "requestKey", { label: "API key" }),
            toolCallTurn("call_2", "charge", { secretRef: "0:call_1" }),
            finalTurn("stale"),
        ];
        const owner = [toolCallTurn("call_1", "requestKey", { label: "API key" }), finalTurn("owner done")];

        const first = harness.run({ input: "charge my card", owner: "user-1", threadKey: "thread-1" }, { instanceId: "run-1", script: stale });

        await harness.awaitWait("run-1", "secret:0:call_1");

        const second = harness.run({ input: "charge my card", owner: "user-1", threadKey: "thread-1" }, { instanceId: "run-2", script: owner });

        await harness.awaitWait("run-2", "secret:0:call_1");
        await harness.supply("thread-1", "call_1", SECRET);

        await expect(second).resolves.toStrictEqual({ stopped: "final", text: "owner done", turns: 2 });

        // run-1's lapsed wait settles against run-2's supplied row, which run-1 must not take from or discard.
        harness.expire("run-1", "secret:0:call_1");

        await expect(first).resolves.toMatchObject({ stopped: "final", text: "stale" });
        expect(used).toStrictEqual([]);
        expect(harness.dispatches.filter((dispatch) => dispatch.path === "agents:agentDiscardSecret")).toStrictEqual([]);
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
